import { describe, it, expect } from "vitest";
import { reconcileQuests } from "./reconcileQuests";
import { createInitialWorldState, appendNpc, type NpcEntry, type LocationEntry } from "@/game/domain/worldState";
import { asLocationId, asNpcId, asQuestId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { WorldState } from "@/game/domain/worldState";

describe("reconcileQuests", () => {
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
  const deps = { now: () => "2026-01-01" };

  it("completes active quest when talk_to_npc objective satisfied", () => {
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "n", role: "r", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const ws: WorldState = {
      ...appendNpc(baseWs, npc),
      quests: [{
        id: asQuestId("q1"), name: "talk quest", description: "t",
        objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_1") }],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" },
        tags: [], kind: "side", status: "active",
      }],
    };
    const result = reconcileQuests(ws, deps);
    expect(result.events[0]?.type).toBe("quest_completed");
    expect(result.nextWorldState.quests[0]?.status).toBe("completed");
  });

  it("does not complete quest when objective not satisfied", () => {
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "n", role: "r", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const ws: WorldState = {
      ...appendNpc(baseWs, npc),
      quests: [{
        id: asQuestId("q1"), name: "talk quest", description: "t",
        objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_1") }],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" },
        tags: [], kind: "side", status: "active",
      }],
    };
    const result = reconcileQuests(ws, deps);
    expect(result.events).toHaveLength(0);
    expect(result.nextWorldState.quests[0]?.status).toBe("active");
  });
});
