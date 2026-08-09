import { describe, expect, it } from "vitest";
import { deriveEndingSessionIdentity, matchesEndingSessionIdentity } from "./endingSessionIdentity";

describe("ending session identity", () => {
  it("is opaque, stable for one ended record, and changes across the ABA dimensions", () => {
    const identity = deriveEndingSessionIdentity("internal-game-id-a", 9);

    expect(identity).toBe(deriveEndingSessionIdentity("internal-game-id-a", 9));
    expect(identity).not.toContain("internal-game-id-a");
    expect(identity).not.toBe(deriveEndingSessionIdentity("internal-game-id-b", 9));
    expect(identity).not.toBe(deriveEndingSessionIdentity("internal-game-id-a", 10));
  });

  it("rejects a stale ended page after another game reaches the same revision", () => {
    const staleIdentity = deriveEndingSessionIdentity("old-ended-game", 9);

    expect(matchesEndingSessionIdentity("newer-ended-game", 9, staleIdentity)).toBe(false);
    expect(matchesEndingSessionIdentity("old-ended-game", 9, staleIdentity)).toBe(true);
  });
});
