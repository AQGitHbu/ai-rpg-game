import { describe, expect, it } from "vitest";
import { makeOpeningQualityCandidate } from "./openingSituation.testutil";
import { parseOpeningSituation } from "./openingSituation";
import { DIALOGUE_ACTS } from "./action";

describe("parseOpeningSituation", () => {
  it("accepts the minimal quality candidate and rejects unknown or missing structure", () => {
    const candidate = makeOpeningQualityCandidate();
    expect(parseOpeningSituation(candidate.opening.situation)).not.toBeNull();
    expect(parseOpeningSituation({ ...candidate.opening.situation, injectedEffect: 99 })).toBeNull();
    expect(parseOpeningSituation({ ...candidate.opening.situation, responses: [] })).toBeNull();
  });

  it("rejects invalid acts, limits, duplicate participants and malformed keys", () => {
    const situation = makeOpeningQualityCandidate().opening.situation;
    expect(parseOpeningSituation({ ...situation, responses: [{ ...situation.responses[0], dialogueAct: "heal" }, situation.responses[1]] })).toBeNull();
    expect(parseOpeningSituation({ ...situation, history: Array.from({ length: 5 }, (_, i) => ({ ...situation.history[0], key: `history_${i}` })) })).toBeNull();
    expect(parseOpeningSituation({ ...situation, history: [{ ...situation.history[0], participantRefs: ["player", "player"] }] })).toBeNull();
    expect(parseOpeningSituation({ ...situation, threads: [{ ...situation.threads[0], key: "Bad-Key" }] })).toBeNull();
  });

  it("accepts every existing DialogueAct", () => {
    const situation = makeOpeningQualityCandidate().opening.situation;
    for (const dialogueAct of DIALOGUE_ACTS) {
      expect(parseOpeningSituation({ ...situation, responses: [
        { ...situation.responses[0], dialogueAct },
        situation.responses[1],
      ] })).not.toBeNull();
    }
  });
});
