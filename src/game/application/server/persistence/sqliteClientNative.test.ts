/** @vitest-environment node */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import ts from "typescript";

const directory = resolve("tmp", `sqlite-adapter-supervisor-${Date.now()}-${process.pid}`);
mkdirSync(directory, { recursive: true });
const source = readFileSync("src/game/application/server/persistence/sqliteClient.ts", "utf8");
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const adapterPath = resolve(directory, "adapter.mjs");
writeFileSync(adapterPath, ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText);
// Child isolation preserves the native OS exit code instead of killing the test runner.
it.each([0, 1, 2, 3, 4, 5, 6, 7])("actual adapter survives 300 transactions and concentrated native GC, trial %s", trial => {
  const child = spawnSync(process.execPath, ["--expose-gc", "scripts/sqliteTransactionGc.mjs", adapterPath, sourceSha256], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  const result = { status: child.status, unsignedStatus: child.status === null ? null : child.status >>> 0,
    hexStatus: child.status === null ? null : `0x${(child.status >>> 0).toString(16)}`,
    signal: child.signal, error: child.error?.message, stdout: child.stdout, stderr: child.stderr };
  writeFileSync(resolve(directory, `${trial}.json`), JSON.stringify(result, null, 2));
  expect(result, `native supervisor evidence: ${directory}/${trial}.json`).toMatchObject({ status: 0, signal: null });
  expect(child.error).toBeUndefined();
  expect(child.stdout).toContain('"phase":"complete"');
}, 35_000);
