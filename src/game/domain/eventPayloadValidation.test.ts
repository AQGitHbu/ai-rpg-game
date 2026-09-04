import { describe, expect, it } from "vitest";
import { isNarrativeEventPayload } from "./eventPayloadValidation";

describe("event payload validation", () => {
  const valid = [
    { type: "fact_discovered", factId: "fact:1", witnessNpcIds: ["npc:1"], evidenceQuality: "clean", tensionDelta: -2 },
    { type: "npc_relationship_changed", fromNpcId: "npc:1", targetId: "player", signal: "supported" },
    { type: "battle_round_resolved", enemyId: "enemy:1", round: 1, playerHp: 10, enemyHp: 0, action: "attack", results: [{ round: 1, sequence: 0, actorId: "player", kind: "attack", damage: 10, actorEnergyAfter: 20 }] },
    { type: "narrative_scene_presented", sceneId: "scene:1", focusNpcId: null, pacing: "develop", beatIds: [], revealedFactIds: [] },
  ];
  it.each(valid)("accepts a complete closed payload: $type", (payload) => {
    expect(isNarrativeEventPayload(payload)).toBe(true);
    expect(isNarrativeEventPayload({ ...payload, rawText: "forbidden" })).toBe(false);
  });
  it.each([
    { type: "npc_relationship_changed", fromNpcId: "npc:1", targetId: "player", signal: "married" },
    { type: "npc_knowledge_changed", npcId: "npc:1", factId: "fact:1", change: "forgotten" },
    { ...valid[2], results: [{ rawText: "forbidden" }] },
    { ...valid[3], revealedFactIds: [null] },
    { type: "game_initialized", generation: { generationId: "g" } },
    { type: "__proto__" },
  ])("rejects malformed nested payload: %j", (payload) => {
    expect(isNarrativeEventPayload(payload)).toBe(false);
  });
});
