import { describe, expect, it } from "vitest";
import {
  advanceNarrativeGenerationEpoch,
  createNarrativeGenerationAttempt,
  parseNarrativeGenerationAttempt,
  reserveNextNarrativeCandidate,
} from "./narrativeGenerationAttempt";

describe("narrative generation attempt", () => {
  it("starts with an uncharged idle attempt and reserves candidates monotonically", () => {
    const initial = createNarrativeGenerationAttempt();
    expect(initial).toEqual({
      epoch: 0,
      candidateVersion: 0,
      candidateHash: null,
      leaseId: null,
      leaseExpiresAt: null,
      httpAttempts: 0,
      status: "idle",
    });

    const reserved = reserveNextNarrativeCandidate(initial, "lease-1", "2026-09-13T00:10:00.000Z");
    expect(reserved).toMatchObject({
      epoch: 0,
      candidateVersion: 1,
      candidateHash: null,
      leaseId: "lease-1",
      status: "running",
    });
    expect(() => reserveNextNarrativeCandidate(reserved, "lease-1", "2026-09-13T00:10:00.000Z")).not.toThrow();
    expect(() => reserveNextNarrativeCandidate({ ...reserved, candidateVersion: 3 }, "lease-1", "2026-09-13T00:10:00.000Z")).toThrow("candidate versions exhausted");
  });

  it("increments epoch for a manual retry and rejects malformed persisted state", () => {
    const next = advanceNarrativeGenerationEpoch({
      ...createNarrativeGenerationAttempt(),
      candidateVersion: 2,
      candidateHash: "candidate_deadbeef",
      httpAttempts: 8,
    });
    expect(next).toEqual({
      epoch: 1,
      candidateVersion: 0,
      candidateHash: null,
      leaseId: null,
      leaseExpiresAt: null,
      httpAttempts: 0,
      status: "idle",
    });
    expect(parseNarrativeGenerationAttempt({ ...next, candidateVersion: 4 })).toEqual({ ok: false, code: "INVALID_NARRATIVE_GENERATION_ATTEMPT" });
    expect(parseNarrativeGenerationAttempt({ ...next, candidateHash: "candidate_deadbeef" })).toEqual({ ok: false, code: "INVALID_NARRATIVE_GENERATION_ATTEMPT" });
  });
});
