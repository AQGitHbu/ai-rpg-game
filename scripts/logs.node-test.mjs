import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { createLogSink, createLogger } from "@ai-game/logging";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runCli(dbPath, args) {
  const output = execFileSync(process.execPath, ["--preserve-symlinks", "scripts/logs.mjs", ...args], {
    cwd: ROOT,
    env: { ...process.env, GAME_LOG_DB_PATH: dbPath },
    encoding: "utf8",
  });
  return JSON.parse(output);
}

test("日志 CLI 支持 trace 查询、健康检查和分层保留", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rpg-logs-cli-"));
  const dbPath = join(directory, "logs.db");
  const old = Date.now() - 40 * 86_400_000;

  try {
    const sink = await createLogSink({ backend: "sqlite", sqlitePath: dbPath });
    const logger = createLogger({ sink });
    await logger.info({
      category: "rpg",
      event: "http_request_completed",
      traceId: "trace_cli_test",
      context: { scope: "request", source: "rpg.http.get.test" },
      data: { httpStatus: 200 },
    });
    await logger.info({
      category: "rpg",
      event: "standard.old",
      occurredAtMs: old,
      context: { scope: "request", source: "rpg.test" },
    });
    await logger.info({
      category: "rpg",
      event: "audit.old",
      occurredAtMs: old,
      context: { scope: "system", source: "rpg.test" },
    });
    await logger.close();

    const traceQuery = runCli(dbPath, ["query", "--trace", "trace_cli_test"]);
    assert.equal(traceQuery.count, 1);
    assert.equal(traceQuery.events[0].event, "http_request_completed");

    const health = runCli(dbPath, ["health"]);
    assert.equal(health.ok, true);
    assert.equal(health.eventCount, 3);

    const retention = runCli(dbPath, ["retention"]);
    assert.equal(retention.deleted, 1);
    assert.equal(retention.auditProtected, 1);

    const standardQuery = runCli(dbPath, ["query", "--event", "standard.old"]);
    assert.equal(standardQuery.count, 0);
    const auditQuery = runCli(dbPath, ["query", "--event", "audit.old"]);
    assert.equal(auditQuery.count, 1);
  } finally {
    try {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    } catch {
      // Windows 上 libsql 句柄可能在子进程结束后短暂释放；留给系统临时目录清理。
    }
  }
});
