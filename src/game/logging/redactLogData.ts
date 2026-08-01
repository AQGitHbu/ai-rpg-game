import { redactSensitiveData } from "@ai-game/logging/redaction";
import type { GameLogDetails } from "./logTypes";

/**
 * RPG compatibility facade over the shared redaction policy. Callers must
 * still provide whitelisted metadata; the shared package owns recursion and
 * sensitive-key classification.
 */
export function redactLogDetails(details: GameLogDetails): GameLogDetails {
  return redactSensitiveData(details) as GameLogDetails;
}
