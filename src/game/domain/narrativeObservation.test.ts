import { describe, expect, it } from "vitest";
import { parseObservation, type Observation } from "./narrativeObservation";

const witness: Observation = {
  key: "obs_1",
  point: { stepKey: "current", order: 1 },
  audienceIds: ["npc_0"],
  fact: { factId: "fact_0", certainty: "known" },
  source: { kind: "witness" },
};

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...witness, ...overrides };
}

describe("parseObservation", () => {
  it("accepts a witness observation", () => {
    expect(parseObservation(raw()).ok).toBe(true);
  });

  it("accepts a speech observation with its speaker", () => {
    expect(
      parseObservation(raw({ source: { kind: "speech", speakerId: "npc_0" } })).ok,
    ).toBe(true);
  });

  it("rejects unknown keys instead of silently dropping them", () => {
    expect(parseObservation(raw({ hiddenPrompt: "leak" })).ok).toBe(false);
  });

  it("rejects a missing audience", () => {
    expect(parseObservation(raw({ audienceIds: undefined })).ok).toBe(false);
  });

  it("rejects an empty audience", () => {
    expect(parseObservation(raw({ audienceIds: [] })).ok).toBe(false);
  });

  it("rejects a speech source without a speaker", () => {
    expect(parseObservation(raw({ source: { kind: "speech" } })).ok).toBe(false);
  });

  it("rejects an unknown source kind", () => {
    expect(parseObservation(raw({ source: { kind: "telepathy" } })).ok).toBe(false);
  });

  it("rejects a certainty outside the known/suspected union", () => {
    expect(parseObservation(raw({ fact: { factId: "fact_0", certainty: "certain" } })).ok).toBe(false);
  });

  it("rejects a negative scene order", () => {
    expect(parseObservation(raw({ point: { stepKey: "current", order: -1 } })).ok).toBe(false);
  });

  it("rejects an empty observation key", () => {
    expect(parseObservation(raw({ key: "" })).ok).toBe(false);
  });
});
