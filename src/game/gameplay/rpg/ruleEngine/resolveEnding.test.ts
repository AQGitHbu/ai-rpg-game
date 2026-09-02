import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { resolveEnding } from "./resolveEnding";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asQuestId, asEndingId, asGenerationId, asNpcId } from "@/game/domain/worldEntity";
import type { WorldState } from "@/game/domain/worldState";

describe("resolveEnding", () => {
  const loc: LocationEntry = {
    id: asLocationId("loc_1"), name: "t", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc,
    startingItemIds: [],
  });
  const baseSs = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01" };

  it("triggers ending when requirements met and endingAllowed", () => {
    const ws: WorldState = {
      ...baseWs,
      quests: [{ id: asQuestId("q1"), name: "q", description: "t", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "main", status: "completed" }],
      endings: [{ id: asEndingId("e1"), name: "end", description: "t", requirements: [{ kind: "quest_completed", questId: asQuestId("q1") }] }],
    };
    const ss = { ...baseSs, endingAllowed: true };
    const result = resolveEnding(ws, ss);
    expect(result.drafts[0]?.payload.type).toBe("ending_reached");
    expect(result.nextWorldState.ending?.endingId).toBe(asEndingId("e1"));
  });

  it("does not trigger ending when endingAllowed is false", () => {
    const ws: WorldState = {
      ...baseWs,
      quests: [{ id: asQuestId("q1"), name: "q", description: "t", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "main", status: "completed" }],
      endings: [{ id: asEndingId("e1"), name: "end", description: "t", requirements: [{ kind: "quest_completed", questId: asQuestId("q1") }] }],
    };
    const ss = { ...baseSs, endingAllowed: false };
    const result = resolveEnding(ws, ss);
    expect(result.drafts).toHaveLength(0);
  });

  it("selects mutually exclusive endings from the key NPC affinity", () => {
    const keyNpc = {
      id: asNpcId("npc_key"), name: "线人", role: "ally", description: "t",
      locationId: loc.id, isCompanion: false, tags: [], met: true,
      memory: {
        npcId: asNpcId("npc_key"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
        relationship: { affinity: -8 }, emotion: "guarded" as const, goals: [],
      },
    };
    const ws: WorldState = {
      ...baseWs,
      npcs: [keyNpc],
      endings: [
        { id: asEndingId("e_trust"), name: "trust", description: "t", requirements: [{ kind: "npc_affinity_at_least", npcId: keyNpc.id, value: 10 }] },
        { id: asEndingId("e_doubt"), name: "doubt", description: "t", requirements: [{ kind: "npc_affinity_at_most", npcId: keyNpc.id, value: 5 }] },
      ],
    };
    const result = resolveEnding(ws, { ...baseSs, endingAllowed: true });
    expect(result.nextWorldState.ending?.endingId).toBe(asEndingId("e_doubt"));
  });

  it("resolves an invalid ambiguous state independently of ending array order", () => {
    const endings: WorldState["endings"] = [
      { id: asEndingId("ending_z"), name: "z", description: "t", requirements: [] },
      { id: asEndingId("ending_a"), name: "a", description: "t", requirements: [] },
    ];
    const storyState = { ...baseSs, endingAllowed: true };

    const forward = resolveEnding({ ...baseWs, endings }, storyState);
    const reversed = resolveEnding({ ...baseWs, endings: [...endings].reverse() }, storyState);

    expect(forward.nextWorldState.ending?.endingId).toBe(asEndingId("ending_a"));
    expect(reversed.nextWorldState.ending).toEqual(forward.nextWorldState.ending);
  });

  it("picks the requirement-satisfied ending even when its id sorts later", () => {
    const keyNpc = {
      id: asNpcId("npc_key"), name: "线人", role: "ally", description: "t",
      locationId: loc.id, isCompanion: false, tags: [], met: true,
      memory: {
        npcId: asNpcId("npc_key"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
        relationship: { affinity: 80 }, emotion: "warm" as const, goals: [],
      },
    };
    const ws: WorldState = {
      ...baseWs,
      npcs: [keyNpc],
      endings: [
        // doubt 的 id 更小，但亲和度高，满足的是 trust 要求。
        { id: asEndingId("ending_a"), name: "doubt", description: "t", requirements: [{ kind: "npc_affinity_at_most", npcId: keyNpc.id, value: 9 }] },
        { id: asEndingId("ending_z"), name: "trust", description: "t", requirements: [{ kind: "npc_affinity_at_least", npcId: keyNpc.id, value: 10 }] },
      ],
    };
    const result = resolveEnding(ws, { ...baseSs, endingAllowed: true });
    expect(result.nextWorldState.ending?.endingId).toBe(asEndingId("ending_z"));
  });

  it("lets the final NPC support/challenge choice override a stale opening affinity", () => {
    const openingNpc = {
      id: asNpcId("npc_key"), name: "开场线人", role: "ally", description: "t",
      locationId: loc.id, isCompanion: false, tags: [], met: true,
      memory: {
        npcId: asNpcId("npc_key"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
        relationship: { affinity: 0 }, emotion: "neutral" as const, goals: [],
      },
    };
    const finalNpc = {
      ...openingNpc,
      id: asNpcId("npc_final"), name: "终幕知情人",
      memory: {
        ...openingNpc.memory,
        npcId: asNpcId("npc_final"),
        interactionHistory: [{
          turnNumber: 9, actionId: "turn-9", locationId: loc.id, dialogueAct: "support" as const,
          topicSummary: "general", outcome: "positive" as const, relationshipDelta: 3,
          learnedFactIds: [], summary: "支持终幕知情人",
        }],
      },
    };
    const ws: WorldState = {
      ...baseWs,
      npcs: [openingNpc, finalNpc],
      endings: [
        { id: asEndingId("ending_a"), name: "doubt", description: "t", requirements: [{ kind: "npc_affinity_at_most", npcId: openingNpc.id, value: 9 }] },
        { id: asEndingId("ending_z"), name: "trust", description: "t", requirements: [{ kind: "npc_affinity_at_least", npcId: openingNpc.id, value: 10 }] },
      ],
    };
    const result = resolveEnding(ws, { ...baseSs, endingAllowed: true });
    expect(result.nextWorldState.ending?.endingId).toBe(asEndingId("ending_z"));
  });

  it("falls back to a deterministic pick when no requirement is satisfied", () => {
    const keyNpc = {
      id: asNpcId("npc_key"), name: "线人", role: "ally", description: "t",
      locationId: loc.id, isCompanion: false, tags: [], met: true,
      memory: {
        npcId: asNpcId("npc_key"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
        relationship: { affinity: 8 }, emotion: "neutral" as const, goals: [],
      },
    };
    const ws: WorldState = {
      ...baseWs,
      npcs: [keyNpc],
      endings: [
        { id: asEndingId("ending_a"), name: "trust", description: "t", requirements: [{ kind: "npc_affinity_at_least", npcId: keyNpc.id, value: 10 }] },
        { id: asEndingId("ending_z"), name: "doubt", description: "t", requirements: [{ kind: "npc_affinity_at_most", npcId: keyNpc.id, value: 5 }] },
      ],
    };
    // 亲和度 8：既不满足 trust(≥10) 也不满足 doubt(≤5)——此时按 id 确定性回退。
    const forward = resolveEnding(ws, { ...baseSs, endingAllowed: true });
    const reversed = resolveEnding({ ...ws, endings: [...ws.endings].reverse() }, { ...baseSs, endingAllowed: true });
    expect(forward.nextWorldState.ending?.endingId).toBe(asEndingId("ending_a"));
    expect(reversed.nextWorldState.ending).toEqual(forward.nextWorldState.ending);
  });
});
