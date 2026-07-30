import type { GameLogDetails } from "./logTypes";

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;
const SENSITIVE_KEY = /(?:api.?key|authorization|cookie|password|secret|token|prompt|model.?output|database(?:url|path)?|connection|string|save|state)/i;

/**
 * Applies a conservative, recursive key-based redaction policy before data
 * leaves the game process. Callers must still provide whitelisted metadata.
 */
export function redactLogDetails(details: GameLogDetails): GameLogDetails {
  return redactValue(details, 0) as GameLogDetails;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[UNDEFINED]";
  if (value instanceof Error) return { name: value.name };
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value !== "object") return `[${typeof value}]`;

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(nested, depth + 1);
  }
  return redacted;
}
