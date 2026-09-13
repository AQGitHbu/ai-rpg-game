import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

if (typeof window !== "undefined") throw new Error("sqliteClient 只允许在 server 端加载，禁止进入客户端 bundle");

export type SqliteValue = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer;
export type SqliteStatement = string | Readonly<{ sql: string; args?: readonly SqliteValue[] }>;
export type SqliteResult = Readonly<{ rows: Array<Record<string, unknown>>; rowsAffected: number; lastInsertRowid?: number | bigint }>;
export type SqliteTransactionMode = "write" | "read" | "deferred";

export interface SqliteTransaction {
  execute(statement: SqliteStatement, args?: readonly SqliteValue[]): Promise<SqliteResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void;
}

export interface SqliteClient {
  execute(statement: SqliteStatement, args?: readonly SqliteValue[]): Promise<SqliteResult>;
  batch(statements: readonly SqliteStatement[], mode?: SqliteTransactionMode): Promise<SqliteResult[]>;
  transaction(mode?: SqliteTransactionMode): Promise<SqliteTransaction>;
  close(): void;
}

export type SqliteClientFactory = () => SqliteClient;
export const GAME_DB_PATH_ENV = "GAME_DB_PATH";
export const DEFAULT_SQLITE_DATABASE_PATH = "db/rpg.sqlite";

export function resolveSqliteDatabasePath(env: Record<string, string | undefined> = process.env): string {
  const overridden = env[GAME_DB_PATH_ENV]?.trim();
  return overridden ? overridden : DEFAULT_SQLITE_DATABASE_PATH;
}

class AsyncMutex {
  private locked = false;
  private readonly waiters: Array<{ grant: (release: () => void) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  acquire(timeoutMs = 5000): Promise<() => void> {
    if (!this.locked) { this.locked = true; return Promise.resolve(this.releaseOnce()); }
    return new Promise((grant, reject) => {
      const waiter = { grant, reject, timer: setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Timed out waiting for SQLite ownership"));
      }, timeoutMs) };
      this.waiters.push(waiter);
    });
  }
  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) { this.locked = false; return; }
      clearTimeout(next.timer);
      next.grant(this.releaseOnce());
    };
  }
}

// DatabaseSync must never synchronously wait on a lock held by an async task in
// this process. Every adapter for one file therefore shares an async owner queue.
const databaseLocks = new Map<string, AsyncMutex>();
function lockFor(databasePath: string): AsyncMutex {
  let lock = databaseLocks.get(databasePath);
  if (lock === undefined) { lock = new AsyncMutex(); databaseLocks.set(databasePath, lock); }
  return lock;
}

type NativeBinding = string | number | bigint | null | Uint8Array;
function bindings(values: readonly SqliteValue[]): NativeBinding[] {
  return values.map((value) => {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return value;
  });
}

function unpack(statement: SqliteStatement, args?: readonly SqliteValue[]): { sql: string; args: readonly SqliteValue[] } {
  return typeof statement === "string" ? { sql: statement, args: args ?? [] } : { sql: statement.sql, args: statement.args ?? [] };
}

function executeSync(db: DatabaseSync, statement: SqliteStatement, args?: readonly SqliteValue[]): SqliteResult {
  const input = unpack(statement, args);
  const prepared = db.prepare(input.sql);
  const bound = bindings(input.args);
  const metadata = (prepared as typeof prepared & { columns(): unknown[] }).columns();
  if (metadata.length > 0) {
    return { rows: prepared.all(...bound) as Array<Record<string, unknown>>, rowsAffected: 0 };
  }
  const changed: StatementResultingChanges = prepared.run(...bound);
  return { rows: [], rowsAffected: Number(changed.changes), lastInsertRowid: changed.lastInsertRowid };
}

function isBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: unknown }).code === "ERR_SQLITE_ERROR")
    && /(?:SQLITE_BUSY|database is locked)/i.test(String((error as { message?: unknown }).message));
}

async function retryBusy<T>(work: () => T): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return work(); } catch (error) {
      if (!isBusy(error) || attempt >= 8) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5 * (attempt + 1)));
    }
  }
}

function beginSql(mode: SqliteTransactionMode): string {
  return mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED";
}

class NativeSqliteTransaction implements SqliteTransaction {
  private closed = false;
  private readonly db: DatabaseSync;
  private readonly release: () => void;
  private readonly onClose: () => void;
  constructor(db: DatabaseSync, release: () => void, onClose: () => void) {
    this.db = db;
    this.release = release;
    this.onClose = onClose;
  }
  async execute(statement: SqliteStatement, args?: readonly SqliteValue[]): Promise<SqliteResult> {
    if (this.closed) throw new Error("SQLite transaction is closed");
    return executeSync(this.db, statement, args);
  }
  async commit(): Promise<void> {
    if (this.closed) throw new Error("SQLite transaction is closed");
    this.db.exec("COMMIT");
    this.finish();
  }
  async rollback(): Promise<void> {
    if (this.closed) return;
    try { this.db.exec("ROLLBACK"); } finally { this.finish(); }
  }
  close(): void {
    if (this.closed) return;
    try { this.db.exec("ROLLBACK"); } finally { this.finish(); }
  }
  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    this.release();
  }
}

class NativeSqliteClient implements SqliteClient {
  private closed = false;
  private activeTransaction: NativeSqliteTransaction | null = null;
  private readonly db: DatabaseSync;
  private readonly lock: AsyncMutex;
  constructor(db: DatabaseSync, lock: AsyncMutex) {
    this.db = db;
    this.lock = lock;
  }
  async execute(statement: SqliteStatement, args?: readonly SqliteValue[]): Promise<SqliteResult> {
    this.assertOpen();
    const release = await this.lock.acquire();
    try { this.assertOpen(); return await retryBusy(() => executeSync(this.db, statement, args)); } finally { release(); }
  }
  async batch(statements: readonly SqliteStatement[], mode: SqliteTransactionMode = "write"): Promise<SqliteResult[]> {
    const tx = await this.transaction(mode);
    try {
      const results: SqliteResult[] = [];
      for (const statement of statements) results.push(await tx.execute(statement));
      await tx.commit();
      return results;
    } finally { tx.close(); }
  }
  async transaction(mode: SqliteTransactionMode = "write"): Promise<SqliteTransaction> {
    this.assertOpen();
    const release = await this.lock.acquire();
    try {
      this.assertOpen();
      await retryBusy(() => this.db.exec(beginSql(mode)));
      const tx = new NativeSqliteTransaction(this.db, release, () => { if (this.activeTransaction === tx) this.activeTransaction = null; });
      this.activeTransaction = tx;
      return tx;
    } catch (error) { release(); throw error; }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.activeTransaction?.close();
    this.db.close();
  }
  private assertOpen(): void { if (this.closed) throw new Error("SQLite client is closed"); }
}

export function createSqliteClient(databasePath: string): SqliteClient {
  const absolutePath = resolve(databasePath);
  const db = new DatabaseSync(absolutePath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
  const canonicalPath = join(realpathSync(dirname(absolutePath)), basename(absolutePath)).toLowerCase();
  return new NativeSqliteClient(db, lockFor(canonicalPath));
}

export function createServerSqliteClientFactory(env: Record<string, string | undefined> = process.env): SqliteClientFactory {
  return () => {
    const databasePath = resolve(resolveSqliteDatabasePath(env));
    mkdirSync(dirname(databasePath), { recursive: true });
    return createSqliteClient(databasePath);
  };
}
