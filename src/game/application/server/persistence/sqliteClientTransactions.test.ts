/** @vitest-environment node */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteClient, type SqliteClient } from "./sqliteClient";

const root = resolve("tmp", `sqlite-tx-lifecycle-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
const clients: SqliteClient[] = [];
const transactions: Awaited<ReturnType<SqliteClient["transaction"]>>[] = [];
function open(path = join(root, `${clients.length}.sqlite`)) {
  const client = createSqliteClient(path);
  clients.push(client);
  return client;
}
afterEach(async () => {
  for (const tx of transactions.splice(0)) await tx.close();
  for (const client of clients) client.close();
});
async function begin(client: SqliteClient, mode?: "write" | "read" | "deferred") {
  const tx = await client.transaction(mode);
  transactions.push(tx);
  return tx;
}

describe("owned SQLite transaction lifecycle", () => {
  it("commit keeps parameterized values atomic through the client wrapper", async () => {
    const client = open();
    await client.execute("CREATE TABLE records(id INTEGER PRIMARY KEY, text TEXT)");
    const tx = await begin(client);
    const value = "引号 ' ; DROP TABLE records; --";
    await tx.execute({ sql: "INSERT INTO records VALUES (?, ?)", args: [1, value] });
    expect((await client.execute("SELECT * FROM records")).rows).toEqual([]);
    const committing = tx.commit();
    const closing = tx.close();
    expect(tx.closed).toBe(true);
    await expect(tx.execute("SELECT 1")).rejects.toMatchObject({ code: "TRANSACTION_CLOSED" });
    await Promise.all([committing, closing]);
    expect((await client.execute("SELECT * FROM records")).rows).toMatchObject([{ id: 1, text: value }]);
    expect(tx.closed).toBe(true);
    await tx.close();
    await tx.close();
    await expect(tx.execute("SELECT 1")).rejects.toMatchObject({ code: "TRANSACTION_CLOSED" });
    await expect(tx.commit()).rejects.toMatchObject({ code: "TRANSACTION_CLOSED" });
  });

  it.each(["rollback", "close"] as const)("%s discards prepared writes and immediately releases the writer lock", async end => {
    const client = open();
    await client.execute("CREATE TABLE records(id INTEGER)");
    const tx = await begin(client);
    await tx.execute({ sql: "INSERT INTO records VALUES (?)", args: [1] });
    await tx[end]();
    const next = await begin(client);
    await next.execute({ sql: "INSERT INTO records VALUES (?)", args: [2] });
    await next.commit();
    expect((await client.execute("SELECT * FROM records")).rows).toMatchObject([{ id: 2 }]);
    expect(tx.closed).toBe(true);
    await tx.close();
    await expect(tx.rollback()).rejects.toMatchObject({ code: "TRANSACTION_CLOSED" });
  });

  it("read mode and concurrent transactions keep independent lifetimes", async () => {
    const client = open();
    await client.execute("CREATE TABLE records(id INTEGER)");
    const first = await begin(client, "read");
    const second = await begin(client, "read");
    await first.execute("SELECT * FROM records");
    await first.close();
    expect(second.closed).toBe(false);
    await second.execute("SELECT * FROM records");
    await second.commit();
  });

  it("parent close leaves an already started transaction owned and usable, but forbids new ones", async () => {
    const path = join(root, "parent-close.sqlite");
    const client = open(path);
    await client.execute("CREATE TABLE records(id INTEGER)");
    const tx = await begin(client, "deferred");
    await tx.execute("INSERT INTO records VALUES (7)");
    client.close();
    expect(client.closed).toBe(true);
    await tx.commit();
    expect((await open(path).execute("SELECT * FROM records")).rows).toMatchObject([{ id: 7 }]);
    await expect(client.transaction("read")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });

  it("a real deferred-constraint COMMIT failure rolls back and releases its lock before returning", async () => {
    const client = open();
    await client.executeMultiple("CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);");
    const tx = await begin(client);
    await tx.execute({ sql: "INSERT INTO children VALUES (?)", args: [1] });
    await expect(tx.commit()).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT" });
    expect(tx.closed).toBe(true);
    const next = await begin(client);
    await next.execute("INSERT INTO parents VALUES (1)");
    await next.execute("INSERT INTO children VALUES (1)");
    await next.commit();
    expect((await client.execute("SELECT count(*) AS total FROM children")).rows[0]?.total).toBe(1);
  });

  it("BEGIN failure does not abort another writer or prevent the next transaction", async () => {
    const client = open();
    await client.execute("CREATE TABLE records(id INTEGER)");
    const first = await begin(client);
    await first.execute("INSERT INTO records VALUES (1)");
    await expect(client.transaction("write")).rejects.toThrow();
    expect(first.closed).toBe(false);
    await first.commit();
    const next = await begin(client);
    await next.execute("INSERT INTO records VALUES (2)");
    await next.commit();
    expect((await client.execute("SELECT count(*) AS total FROM records")).rows[0]?.total).toBe(2);
  });
});
