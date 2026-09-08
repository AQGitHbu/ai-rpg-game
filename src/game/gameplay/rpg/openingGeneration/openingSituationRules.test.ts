import { describe, expect, it } from "vitest";
import { makeOpeningQualityCandidate } from "@/game/domain/openingSituation.testutil";
import { resolveOpeningResponses } from "./openingSituationRules";

describe("resolveOpeningResponses", () => {
  it("maps fact and thread keys to server-owned Action ids", () => {
    const choices = resolveOpeningResponses(makeOpeningQualityCandidate());
    expect(choices?.map((choice) => choice.action.dialogueAct)).toEqual(["ask", "refuse"]);
    expect(choices?.[0]?.action.topic).toEqual({ kind: "fact", factId: "fact_2" });
    expect(choices?.[1]?.action.topic).toEqual({ kind: "thread", threadId: "thread_init_shutdown" });
  });

  it("allows equal acts with distinct topics but rejects duplicate semantics", () => {
    const candidate = makeOpeningQualityCandidate();
    const distinct = { ...candidate, opening: { ...candidate.opening, situation: { ...candidate.opening.situation, responses: [
      { key: "ask_records", dialogueAct: "ask", topic: { kind: "fact", key: "fact_records" } },
      { key: "ask_shutdown", dialogueAct: "ask", topic: { kind: "thread", key: "shutdown" } },
    ] as const } } };
    expect(resolveOpeningResponses(distinct)).not.toBeNull();

    const duplicate = { ...candidate, opening: { ...candidate.opening, situation: { ...candidate.opening.situation, responses: [
      { key: "ask_records_a", dialogueAct: "ask", topic: { kind: "fact", key: "fact_records" } },
      { key: "ask_records_b", dialogueAct: "ask", topic: { kind: "fact", key: "fact_records" } },
    ] as const } } };
    expect(resolveOpeningResponses(duplicate)).toBeNull();
  });

  it("rejects circular history, unknown refs, private response targets and invalid relationship basis", () => {
    const candidate = makeOpeningQualityCandidate();
    const withSituation = (situation: typeof candidate.opening.situation) => ({ ...candidate, opening: { ...candidate.opening, situation } });
    expect(resolveOpeningResponses(withSituation({ ...candidate.opening.situation, history: [{ ...candidate.opening.situation.history[0], causeHistoryKeys: ["worked_together"] }] }))).toBeNull();
    expect(resolveOpeningResponses(withSituation({ ...candidate.opening.situation, threads: [{ ...candidate.opening.situation.threads[0], questionFactKey: "missing_fact" }] }))).toBeNull();
    expect(resolveOpeningResponses(withSituation({ ...candidate.opening.situation, responses: [{ ...candidate.opening.situation.responses[0], topic: { kind: "fact", key: "fact_secret" } }, candidate.opening.situation.responses[1]] }))).toBeNull();
    expect(resolveOpeningResponses(withSituation({ ...candidate.opening.situation, npcConnection: { familiarity: "stranger", stance: "ally", basisHistoryKeys: ["worked_together"] } }))).toBeNull();
  });

  it("accepts private or non-focus-known history when it is not the known relationship basis", () => {
    const candidate = makeOpeningQualityCandidate();
    const result = resolveOpeningResponses({
      ...candidate,
      opening: { ...candidate.opening, situation: {
        ...candidate.opening.situation,
        history: [
          ...candidate.opening.situation.history,
          { key: "private_mistake", factKeys: ["fact_secret"], participantRefs: ["opening_npc"], causeHistoryKeys: [] },
        ],
      } },
    });
    expect(result).not.toBeNull();
  });

  it("rejects a known connection backed only by private history", () => {
    const candidate = makeOpeningQualityCandidate();
    const result = resolveOpeningResponses({
      ...candidate,
      opening: { ...candidate.opening, situation: {
        ...candidate.opening.situation,
        history: [{ key: "private_mistake", factKeys: ["fact_secret"], participantRefs: ["opening_npc"], causeHistoryKeys: [] }],
        threads: [{ ...candidate.opening.situation.threads[0], causeHistoryKeys: [] }],
        npcConnection: { familiarity: "known", stance: "neutral", basisHistoryKeys: ["private_mistake"] },
      } },
    });
    expect(result).toBeNull();
  });
});
