/** @vitest-environment node */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { SqliteLogSink, createLogSink } from "@ai-game/logging";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_GAME_LOG_DB_PATH,
  createServerLogRuntime,
  resolveGameLogDatabasePath
} from "./serverConsoleLogger";

const RUN_ROOT = resolve("tmp", `shared-logging-${Date.now()}-${process.pid}`);
mkdirSync(RUN_ROOT, { recursive: true });

afterAll(() => {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may retain a SQLite handle briefly; the next run uses a unique directory. */
  }
});

async function queryByEvent(databasePath: string, event: string) {
  const sink = await createLogSink({ backend: "sqlite", sqlitePath: databasePath });
  expect(sink).toBeInstanceOf(SqliteLogSink);
  try {
    return await (sink as SqliteLogSink).queryByEvent(event);
  } finally {
    await sink.close();
  }
}

describe("RPG shared logging adapter", () => {
  it("defaults to a dedicated data/logs.db instead of the game database", () => {
    expect(resolveGameLogDatabasePath({})).toBe(DEFAULT_GAME_LOG_DB_PATH);
    expect(DEFAULT_GAME_LOG_DB_PATH).toBe("data/logs.db");
    expect(DEFAULT_GAME_LOG_DB_PATH).not.toBe("db/rpg.sqlite");
  });

  it("creates an independent SQLite log database and exposes queryable context", async () => {
    const databasePath = join(RUN_ROOT, "queryable-logs.db");
    const runtime = createServerLogRuntime({ GAME_LOG_DB_PATH: databasePath });

    runtime.logger.info("save_command_completed", {
      traceId: "trace_queryable_1",
      scope: "request",
      source: "rpg.test.save",
      gameId: "game-1",
      saveId: "save-1",
      sessionId: "session-1",
      ok: true,
      apiKey: "sk-secret",
      prompt: "private prompt"
    });
    await runtime.close();

    expect(existsSync(databasePath)).toBe(true);
    const events = await queryByEvent(databasePath, "save_command_completed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      traceId: "trace_queryable_1",
      scope: "request",
      source: "rpg.test.save",
      gameId: "game-1",
      saveId: "save-1",
      sessionId: "session-1",
      data: {
        ok: true,
        apiKey: "[redacted]",
        prompt: "[redacted]"
      }
    });
  });

  it("uses the shared truncation policy before persisting oversized events", async () => {
    const databasePath = join(RUN_ROOT, "truncated-logs.db");
    const runtime = createServerLogRuntime({
      GAME_LOG_DB_PATH: databasePath,
      GAME_LOG_MAX_EVENT_BYTES: "512"
    });

    runtime.logger.warn("oversized_diagnostic", {
      traceId: "trace_truncated_1",
      scope: "system",
      source: "rpg.test.truncation",
      payload: "x".repeat(8_000),
      token: "must-not-survive"
    });
    await runtime.close();

    const [event] = await queryByEvent(databasePath, "oversized_diagnostic");
    expect(event.payloadTruncated).toBe(true);
    expect(event.originalBytes).toBeGreaterThan(512);
    expect(event.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(event)).not.toContain("must-not-survive");
  });

  it("falls back to shared JSONL without throwing when SQLite initialization fails", async () => {
    const fallbackDir = join(RUN_ROOT, "fallback-jsonl");
    const runtime = createServerLogRuntime({
      GAME_LOG_DB_PATH: RUN_ROOT,
      GAME_LOG_FALLBACK_DIR: fallbackDir
    });

    expect(() => runtime.logger.error("fallback_probe", {
      traceId: "trace_fallback_1",
      scope: "system",
      source: "rpg.test.fallback"
    })).not.toThrow();
    await expect(runtime.close()).resolves.toBeUndefined();

    const files = readdirSync(fallbackDir).filter((file) => file.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(fallbackDir, files[0]), "utf8")).toContain("fallback_probe");
  });
});
