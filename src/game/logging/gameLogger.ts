import type { GameLogDetails, GameLogEntry, GameLogLevel, GameLogSink, GameLogger } from "./logTypes";
import { redactLogDetails } from "./redactLogData";

export type CreateGameLoggerOptions = Readonly<{
  write: GameLogSink;
}>;

export const NOOP_GAME_LOGGER: GameLogger = Object.freeze({
  info() {},
  warn() {},
  error() {}
});

export function createGameLogger(options: CreateGameLoggerOptions): GameLogger {
  return Object.freeze({
    info: (event, details) => write(options.write, "info", event, details),
    warn: (event, details) => write(options.write, "warn", event, details),
    error: (event, details) => write(options.write, "error", event, details)
  });
}

function write(
  sink: GameLogSink,
  level: GameLogLevel,
  event: string,
  details: GameLogDetails | undefined
): void {
  const entry: GameLogEntry = {
    level,
    event,
    details: redactLogDetails(details ?? {})
  };
  try {
    sink(entry);
  } catch {
    // Observability must never change the deterministic game result.
  }
}
