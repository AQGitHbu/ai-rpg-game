// Offline regression child: fresh files only, actual adapter, no provider/composition imports.
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as immediate } from "node:timers/promises";

if (typeof globalThis.gc !== "function") throw Error("Run with --expose-gc");
const count = 300;
const [modulePath, sourceSha256] = process.argv.slice(2);
if (!modulePath || !sourceSha256) throw Error("Supervisor must provide the compiled actual adapter and source hash");
mkdirSync(resolve("tmp"), { recursive: true });
const directory = mkdtempSync(resolve("tmp/sqlite-adapter-gc-"));
const { createSqliteClient } = await import(pathToFileURL(modulePath).href);
const report = value => process.stdout.write(JSON.stringify(value) + "\n");
report({ phase: "start", sourceSha256, node: process.version, directory, count });
const client = createSqliteClient(join(directory, "owned.sqlite"));
await client.executeMultiple("PRAGMA journal_mode=WAL; CREATE TABLE records(id INTEGER PRIMARY KEY, text TEXT);");
const text = "offline diagnostic data ".repeat(2000);
async function transaction(index) {
  const tx = await client.transaction("write");
  try {
    await tx.execute({ sql: "INSERT OR REPLACE INTO records VALUES (?, ?)", args: [index % 20, text] });
    await tx.execute("SELECT id,length(text) AS len FROM records");
    if (index % 3 === 0) await tx.rollback();
    else await tx.commit();
  } finally { await tx.close(); }
}
try {
  for (let i = 0; i < count; i++) await transaction(i);
} finally { client.close(); }
report({ phase: "closed", memory: process.memoryUsage() });
for (let i = 0; i < 5; i++) { globalThis.gc(); await immediate(); }
report({ phase: "complete", count, memory: process.memoryUsage() });
