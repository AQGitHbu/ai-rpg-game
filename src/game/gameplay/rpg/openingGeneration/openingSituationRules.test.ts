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

// Minimal regression from real planning call 8902a855-9c72-4bad-a546-4147bec4569e (round20260912-r1).
// The displayed player question was “劫镖的人，和寒山派有关？”; the stranger NPC did not know convoy_raid.
function playerConvoyTopic() {
  const base = makeOpeningQualityCandidate();
  return { ...base, world: { ...base.world, publicFacts: [...base.world.publicFacts, {
    key: "convoy_raid", text: "沈孤鸿押送的镖车在雨夜被劫，镖银尽失，他只在现场捡到一枚寒山派青铜令牌。",
  }] }, player: { ...base.player, knownFactKeys: ["convoy_raid"] }, opening: { ...base.opening, situation: {
    ...base.opening.situation, npcConnection: { familiarity: "stranger" as const, stance: "neutral" as const, basisHistoryKeys: [] },
    responses: [{ key: "press_token", dialogueAct: "challenge" as const, topic: { kind: "fact" as const, key: "convoy_raid" } }, base.opening.situation.responses[1]] as const,
  } } };
}
it("player-known convoy response and thread question are allowed without teaching the NPC", () => {
  const candidate = playerConvoyTopic();
  expect(resolveOpeningResponses(candidate)?.[0].action.topic).toEqual({ kind: "fact", factId: "fact_4" });
  expect(resolveOpeningResponses({ ...candidate, opening: { ...candidate.opening, situation: {
    ...candidate.opening.situation, threads: [{ ...candidate.opening.situation.threads[0]!, questionFactKey: "convoy_raid" }],
  } } })).not.toBeNull();
  expect(candidate.opening.npc.knownFactKeys).not.toContain("convoy_raid");
});
it.each(["missing", "fact_secret"])("player topic whitelist still excludes %s", key => {
  const candidate = playerConvoyTopic();
  const invalid = { ...candidate, player: { ...candidate.player, knownFactKeys: [key] }, opening: { ...candidate.opening, situation: {
    ...candidate.opening.situation, responses: [{ ...candidate.opening.situation.responses[0], topic: { kind: "fact" as const, key } }, candidate.opening.situation.responses[1]] as const,
  } } };
  expect(resolveOpeningResponses(invalid)).toBeNull();
  expect(resolveOpeningResponses({ ...invalid, opening: { ...invalid.opening, situation: { ...invalid.opening.situation,
    responses: makeOpeningQualityCandidate().opening.situation.responses, threads: [{ ...invalid.opening.situation.threads[0]!, questionFactKey: key }],
  } } })).toBeNull();
});
it("player history never substitutes for NPC knowledge in a known relationship", () => {
  const candidate = playerConvoyTopic();
  expect(resolveOpeningResponses({ ...candidate, opening: { ...candidate.opening, situation: {
    ...candidate.opening.situation, history: [{ key: "player_history", factKeys: ["convoy_raid"], participantRefs: ["player", "opening_npc"], causeHistoryKeys: [] }],
    threads: [{ ...candidate.opening.situation.threads[0]!, causeHistoryKeys: [] }],
    npcConnection: { familiarity: "known", stance: "neutral", basisHistoryKeys: ["player_history"] },
  } } })).toBeNull();
});
it("explicit empty player knowledge still permits an NPC-public future topic; absent preserves legacy", () => {
  const candidate = makeOpeningQualityCandidate();
  expect(resolveOpeningResponses({ ...candidate, player: { ...candidate.player, knownFactKeys: [] } })).toEqual(resolveOpeningResponses(candidate));
  const convoy = playerConvoyTopic(); const { knownFactKeys: _, ...legacyPlayer } = convoy.player;
  expect(resolveOpeningResponses({ ...convoy, player: legacyPlayer })).toBeNull();
});
