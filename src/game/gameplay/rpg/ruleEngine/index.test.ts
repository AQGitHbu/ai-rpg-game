import { describe, it, expect } from "vitest";
import { ruleEngine } from "./index";
import { createInitialWorldState, appendNpc, appendLocation, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId, asEnemyId } from "@/game/domain/scenarioBlueprint";

describe("ruleEngine facade", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const ws = { ...appendLocation(baseWs, loc2), unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01" };

  it("returns ok for valid move action", () => {
    const result = ruleEngine(ws, ss, { type: "move", locationId: asLocationId("loc_2") }, "act_1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.currentLocationId).toBe(asLocationId("loc_2"));
      expect(result.resolvedEvent.status).toBe("success");
      expect(result.resolvedEvent.eventKind).toBe("travel");
    }
  });

  it("returns failure for unknown location", () => {
    const result = ruleEngine(ws, ss, { type: "move", locationId: asLocationId("nope") }, "act_2", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_LOCATION");
    }
  });

  it("updates story metrics after action", () => {
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const wsWithNpc = appendNpc(ws, npc);
    const result = ruleEngine(wsWithNpc, ss, { type: "talk", npcId: asNpcId("npc_1") }, "act_3", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextStoryState.tension).toBe(33); // 30 + 3 (npc_met)
    }
  });
});

describe("ruleEngine status passthrough", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const ws = { ...appendLocation(baseWs, loc2), unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01" };

  it("passes partial_success from resolveByType to ResolvedEvent", () => {
    const hostileNpc: NpcEntry = {
      id: asNpcId("npc_hostile"), name: "卫兵", role: "守卫", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_hostile"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: -70 }, emotion: "hostile", goals: [] },
    };
    const wsWithHostile = appendNpc(ws, hostileNpc);
    const result = ruleEngine(wsWithHostile, ss, { type: "talk", npcId: asNpcId("npc_hostile") }, "act_1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.status).toBe("partial_success");
    }
  });

  it("passes blocked status for move during battle", () => {
    const wsInBattle = { ...ws, battle: { status: "active" as const, enemyId: asEnemyId("e1"), playerHp: 50, enemyHp: 30, round: 1 } };
    const result = ruleEngine(wsInBattle, ss, { type: "move", locationId: asLocationId("loc_2") }, "act_1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.status).toBe("blocked");
      expect(result.resolvedEvent.stateChanges).toEqual([]);
    }
  });

  it("populates stateChanges in ResolvedEvent", () => {
    const result = ruleEngine(ws, ss, { type: "move", locationId: asLocationId("loc_2") }, "act_1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.stateChanges.length).toBeGreaterThan(0);
      expect(result.resolvedEvent.stateChanges.some((sc) => sc.path === "currentLocationId")).toBe(true);
    }
  });
});
