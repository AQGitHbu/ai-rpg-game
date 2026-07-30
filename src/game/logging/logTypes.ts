export type GameLogLevel = "info" | "warn" | "error";

export type GameLogDetails = Readonly<Record<string, unknown>>;

export type GameLogEntry = Readonly<{
  level: GameLogLevel;
  event: string;
  details: GameLogDetails;
}>;

export type GameLogSink = (entry: GameLogEntry) => void;

/** Cross-layer port. Game code supplies only stable, whitelisted metadata. */
export type GameLogger = Readonly<{
  info(event: string, details?: GameLogDetails): void;
  warn(event: string, details?: GameLogDetails): void;
  error(event: string, details?: GameLogDetails): void;
}>;
