import { describe, it, expect } from "vitest";
import { resolveByType } from "./resolveByType";
import { createInitialWorldState, appendLocation, appendNpc, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { asLocationId, asNpcId, asItemId, asFactId, asGenerationId, asEnemyId } from "@/game/domain/scenarioBlueprint";

describe("resolveByType", () => {
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
  const ws = appendLocation(baseWs, loc2);
  const deps = { now: () => "2026-01-01" };

  it("move updates currentLocationId and adds event", () => {
    const result = resolveByType(ws, { type: "move", locationId: asLocationId("loc_2") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.currentLocationId).toBe(asLocationId("loc_2"));
      expect(result.events[0]?.type).toBe("location_visited");
    }
  });

  it("talk marks npc as met", () => {
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const wsWithNpc = appendNpc(ws, npc);
    const result = resolveByType(wsWithNpc, { type: "talk", npcId: asNpcId("npc_1") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const npc2 = result.nextWorldState.npcs.find((n) => n.id === asNpcId("npc_1"));
      expect(npc2?.met).toBe(true);
    }
  });

  it("ack_prologue returns unchanged state", () => {
    const result = resolveByType(ws, { type: "ack_prologue" }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events).toHaveLength(0);
    }
  });
});

describe("resolveByType status and stateChanges", () => {
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
  const ws = appendLocation(baseWs, loc2);
  const deps = { now: () => "2026-01-01" };
  const npc1: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };

  it("move returns success status and stateChanges", () => {
    const result = resolveByType(ws, { type: "move", locationId: asLocationId("loc_2") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("success");
      expect(result.stateChanges.length).toBeGreaterThan(0);
      expect(result.stateChanges.some((sc) => sc.path === "currentLocationId")).toBe(true);
    }
  });

  it("talk to hostile npc returns partial_success", () => {
    const hostileNpc: NpcEntry = {
      ...npc1,
      id: asNpcId("npc_hostile"),
      name: "卫兵",
      memory: { ...npc1.memory, npcId: asNpcId("npc_hostile"), relationship: { affinity: -70 } },
    };
    const wsWithHostile = appendNpc(ws, hostileNpc);
    const result = resolveByType(wsWithHostile, { type: "talk", npcId: asNpcId("npc_hostile") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("partial_success");
    }
  });

  it("investigate undiscovered fact returns success", () => {
    const wsWithFact = { ...ws, worldFacts: [{ factId: asFactId("fact_1"), text: "墙上刻字", source: "scene" as any, discovered: false }] };
    const result = resolveByType(wsWithFact, { type: "investigate", factId: asFactId("fact_1") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("success");
      expect(result.stateChanges.some((sc) => sc.path === "worldFacts[fact_1].discovered")).toBe(true);
    }
  });

  it("move during active battle returns blocked", () => {
    const wsInBattle = { ...ws, battle: { status: "active" as const, enemyId: asEnemyId("e1"), playerHp: 50, enemyHp: 30, round: 1 } };
    const result = resolveByType(wsInBattle, { type: "move", locationId: asLocationId("loc_2") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("blocked");
    }
  });

  it("freeform action returns success with no state changes", () => {
    const result = resolveByType(ws, { type: "freeform", intent: "chat", rawText: "你好" }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("success");
      expect(result.stateChanges).toEqual([]);
      expect(result.nextWorldState).toBe(ws); // 无变化
    }
  });
});
