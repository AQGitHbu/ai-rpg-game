import "server-only";
import {
  BoundedLogQueue,
  JsonlLogSink,
  createLogSink,
  createLogger,
  type LogContext,
  type Logger,
  type LogSink
} from "@ai-game/logging";
import type { GameLogDetails, GameLogger } from "./logTypes";

export const GAME_LOG_DB_PATH_ENV = "GAME_LOG_DB_PATH";
export const GAME_LOG_FALLBACK_DIR_ENV = "GAME_LOG_FALLBACK_DIR";
export const GAME_LOG_MAX_EVENT_BYTES_ENV = "GAME_LOG_MAX_EVENT_BYTES";
export const DEFAULT_GAME_LOG_DB_PATH = "data/logs.db";
export const DEFAULT_GAME_LOG_FALLBACK_DIR = "logs";

type RuntimeEnvironment = Record<string, string | undefined>;

function runtimeEnvironment(): RuntimeEnvironment {
  const processLike = (globalThis as typeof globalThis & {
    process?: { env?: RuntimeEnvironment };
  }).process;
  return processLike?.env ?? {};
}

export type ServerLogRuntime = Readonly<{
  logger: GameLogger;
  flush(): Promise<void>;
  close(): Promise<void>;
}>;

type SharedMethod = "info" | "warn" | "error";

export function resolveGameLogDatabasePath(
  env: Record<string, string | undefined>
): string {
  return env[GAME_LOG_DB_PATH_ENV]?.trim() || DEFAULT_GAME_LOG_DB_PATH;
}

function resolveFallbackDirectory(env: Record<string, string | undefined>): string {
  return env[GAME_LOG_FALLBACK_DIR_ENV]?.trim() || DEFAULT_GAME_LOG_FALLBACK_DIR;
}

function resolveMaxEventBytes(env: Record<string, string | undefined>): number | undefined {
  const raw = env[GAME_LOG_MAX_EVENT_BYTES_ENV]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 512 ? value : undefined;
}

function diagnostic(level: "warn" | "error", event: string): void {
  const line = JSON.stringify({ level, category: "logging", event });
  if (level === "error") console.error(line);
  else console.warn(line);
}

async function initializeSharedLogger(
  env: Record<string, string | undefined>
): Promise<Logger> {
  let sink: LogSink;
  let fallbackSink: JsonlLogSink | undefined;
  try {
    sink = await createLogSink({
      backend: "sqlite",
      sqlitePath: resolveGameLogDatabasePath(env)
    });
    fallbackSink = new JsonlLogSink(resolveFallbackDirectory(env));
  } catch {
    diagnostic("error", "sqlite_log_sink_initialization_failed");
    sink = new JsonlLogSink(resolveFallbackDirectory(env));
  }
  const durableSink = fallbackSink === undefined
    ? sink
    : new BoundedLogQueue({ delegate: sink, fallbackSink });
  return createLogger({
    sink: durableSink,
    maxEventBytes: resolveMaxEventBytes(env),
    context: { scope: "system", source: "rpg.server" }
  });
}

function stringField(details: GameLogDetails, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function eventContext(details: GameLogDetails): LogContext {
  const requestedScope = stringField(details, "scope");
  const scope = requestedScope === "request" || requestedScope === "system" ||
    requestedScope === "migration" || requestedScope === "legacy"
    ? requestedScope
    : "system";
  return {
    scope,
    source: stringField(details, "source") ?? "rpg.server",
    gameId: stringField(details, "gameId"),
    saveId: stringField(details, "saveId"),
    sessionId: stringField(details, "sessionId"),
    scenarioId: stringField(details, "scenarioId")
  };
}

const CONTEXT_FIELDS = new Set([
  "traceId", "scope", "source", "gameId", "saveId", "sessionId", "scenarioId", "durationMs"
]);

function eventData(details: GameLogDetails): GameLogDetails {
  return Object.fromEntries(
    Object.entries(details).filter(([key]) => !CONTEXT_FIELDS.has(key))
  );
}

/**
 * Synchronous RPG facade backed by a lazily initialized shared async logger.
 * Calls never wait for SQLite and all pending writes are drained by close().
 */
export function createServerLogRuntime(
  env: Record<string, string | undefined>
): ServerLogRuntime {
  let shared: Promise<Logger> | undefined;
  let closed = false;
  const pending = new Set<Promise<void>>();

  const getShared = (): Promise<Logger> => {
    shared ??= initializeSharedLogger(env);
    return shared;
  };

  const schedule = (level: SharedMethod, event: string, details: GameLogDetails = {}): void => {
    if (closed) return;
    const duration = details.durationMs;
    const task = getShared()
      .then((logger) => logger[level]({
        category: "rpg",
        event,
        traceId: stringField(details, "traceId"),
        durationMs: typeof duration === "number" && Number.isFinite(duration) ? duration : undefined,
        context: eventContext(details),
        data: eventData(details)
      }))
      .catch(() => diagnostic("warn", "log_write_failed"));
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => undefined);
  };

  const logger: GameLogger = Object.freeze({
    info: (event, details) => schedule("info", event, details),
    warn: (event, details) => schedule("warn", event, details),
    error: (event, details) => schedule("error", event, details)
  });

  const flush = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
    if (shared !== undefined) await (await shared).flush();
  };

  return Object.freeze({
    logger,
    flush,
    async close() {
      if (closed) return;
      schedule("info", "server_runtime_stopped", { scope: "system", source: "rpg.server" });
      await flush();
      closed = true;
      if (shared !== undefined) await (await shared).close();
    }
  });
}

/** Backward-compatible factory for callers that do not own lifecycle hooks. */
export function createServerConsoleLogger(
  env: RuntimeEnvironment = runtimeEnvironment()
): GameLogger {
  return createServerLogRuntime(env).logger;
}
