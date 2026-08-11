import { describe, it, expect } from "vitest";
import {
  createInitialWorldState,
  findLocation,
  findNpc,
  appendLocation,
  appendNpc,
  type LocationEntry,
  type NpcEntry,
} from "./worldState";
import { asLocationId, asNpcId, asItemId, asGenerationId } from "./scenarioBlueprint";

describe("WorldState", () => {
  const startingLocation: LocationEntry = {
    id: asLocationId("loc_1"),
    name: "起始客栈",
    description: "测试",
    kind: "main",
    connectedLocationIds: [],
    npcIds: [],
    availableItemIds: [],
    tags: [],
    scale: "scene",
  };
  const baseInput = {
    generation: {
      generationId: asGenerationId("gen_test"),
      seed: "test-seed",
      templateVersion: "v2",
      inputDigest: "",
      gameType: "wuxia" as const,
    },
    player: { name: "测试侠客", identity: "流浪剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation,
    startingItemIds: [asItemId("item_1")] as const,
  };

  it("createInitialWorldState produces valid state with version 2", () => {
    const ws = createInitialWorldState(baseInput);
    expect(ws.version).toBe(2);
    expect(ws.player.name).toBe("测试侠客");
    expect(ws.currentLocationId).toBe(asLocationId("loc_1"));
    expect(ws.locations).toHaveLength(1); // 起始地点必须在 locations 内，currentLocationId 不指向不存在的地点
    expect(ws.eventLedger[0]?.type).toBe("game_initialized");
  });

  it("findLocation returns entry by id, undefined if missing", () => {
    const ws = createInitialWorldState(baseInput);
    const loc = findLocation(ws, asLocationId("loc_1"));
    expect(loc?.id).toBe(asLocationId("loc_1"));
    expect(findLocation(ws, asLocationId("nonexistent"))).toBeUndefined();
  });

  it("appendLocation adds new location immutably", () => {
    const ws = createInitialWorldState(baseInput);
    const newLoc: LocationEntry = {
      id: asLocationId("loc_new"),
      name: "新地点",
      description: "测试",
      kind: "main",
      connectedLocationIds: [],
      npcIds: [],
      availableItemIds: [],
      tags: [],
      scale: "scene",
    };
    const ws2 = appendLocation(ws, newLoc);
    expect(findLocation(ws2, asLocationId("loc_new"))).toBeDefined();
    expect(findLocation(ws, asLocationId("loc_new"))).toBeUndefined(); // 原state不变
  });

  it("appendNpc adds new npc immutably with default memory", () => {
    const ws = createInitialWorldState(baseInput);
    const newNpc: NpcEntry = {
      id: asNpcId("npc_new"),
      name: "新NPC",
      role: "路人",
      description: "测试",
      locationId: asLocationId("loc_1"),
      isCompanion: false,
      tags: [],
      met: false,
      memory: {
        npcId: asNpcId("npc_new"),
        knownFactIds: [],
        hiddenFactIds: [],
        interactionHistory: [],
        relationship: { affinity: 0 },
        emotion: "neutral",
        goals: [],
      },
    };
    const ws2 = appendNpc(ws, newNpc);
    expect(findNpc(ws2, asNpcId("npc_new"))).toBeDefined();
  });
});
