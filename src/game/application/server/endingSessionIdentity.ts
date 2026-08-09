import { createHash } from "node:crypto";

/**
 * Derives the browser-visible restart identity without exposing the persisted
 * game ID. The revision is included so the identity denotes one ended save,
 * rather than merely one game record.
 */
export function deriveEndingSessionIdentity(gameId: string, revision: number): string {
  const digest = createHash("sha256")
    .update(gameId, "utf8")
    .update(":", "utf8")
    .update(String(revision), "utf8")
    .digest("base64url");
  return `ending_${digest}`;
}

export function matchesEndingSessionIdentity(
  gameId: string,
  revision: number,
  candidate: string,
): boolean {
  return deriveEndingSessionIdentity(gameId, revision) === candidate;
}
