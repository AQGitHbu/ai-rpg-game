import { describe, it, expect } from "vitest";
import { applyApprovedExpansion } from "./applyExpansion";
import {
  createInitialWorldState,
  type LocationEntry,
  type NpcEntry,
  type ItemEntry,
} from "@/game/domain/worldState";
import { asLocationId, asNpcId, asItemId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { ApprovedExpansion } from "./expansionTypes";

describe("applyApprovedExpansion", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });

  it("appends new location and emits BlueprintExpandedEvent", () => {
    const newLoc: LocationEntry = {
      id: asLocationId("loc_new"), name: "密林", description: "t", kind: "main",
      connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
    };
    const approved: ApprovedExpansion = {
      newLocations: [newLoc], newNpcs: [], newItems: [], newEnemies: [], newFacts: [],
      budgetConsumed: { locations: 1, npcs: 0, items: 0, enemies: 0, facts: 0 },
    };
    const nextWs = applyApprovedExpansion(ws, approved, "2026-01-01");
    expect(nextWs.locations.length).toBe(2);
    expect(nextWs.eventLedger[nextWs.eventLedger.length - 1]!.type).toBe("blueprint_expanded");
  });

  it("does not mutate original worldState", () => {
    const newLoc: LocationEntry = {
      id: asLocationId("loc_new"), name: "密林", description: "t", kind: "main",
      connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
    };
    const approved: ApprovedExpansion = {
      newLocations: [newLoc], newNpcs: [], newItems: [], newEnemies: [], newFacts: [],
      budgetConsumed: { locations: 1, npcs: 0, items: 0, enemies: 0, facts: 0 },
    };
    const nextWs = applyApprovedExpansion(ws, approved, "2026-01-01");
    expect(ws.locations.length).toBe(1);
    expect(nextWs.locations.length).toBe(2);
  });

  // ── Task 27：解锁、双向连接、挂载索引 ──

  it("immediately unlocks a new location (added to unlockedLocationIds)", () => {
    const newLoc: LocationEntry = {
      id: asLocationId("loc_new"), name: "密林", description: "t", kind: "main",
      connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
    };
    const approved: ApprovedExpansion = {
      newLocations: [newLoc], newNpcs: [], newItems: [], newEnemies: [], newFacts: [],
      budgetConsumed: { locations: 1, npcs: 0, items: 0, enemies: 0, facts: 0 },
    };
    const nextWs = applyApprovedExpansion(ws, approved, "2026-01-01");
    expect(nextWs.unlockedLocationIds).toContain(asLocationId("loc_new"));
  });

  it("creates bidirectional connection between new and source location", () => {
    const newLoc: LocationEntry = {
      id: asLocationId("loc_new"), name: "密林", description: "t", kind: "main",
      connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
    };
    const approved: ApprovedExpansion = {
      newLocations: [newLoc], newNpcs: [], newItems: [], newEnemies: [], newFacts: [],
      budgetConsumed: { locations: 1, npcs: 0, items: 0, enemies: 0, facts: 0 },
    };
    const nextWs = applyApprovedExpansion(ws, approved, "2026-01-01");
    const source = nextWs.locations.find((l) => l.id === asLocationId("loc_1"))!;
    expect(source.connectedLocationIds).toContain(asLocationId("loc_new"));
    const added = nextWs.locations.find((l) => l.id === asLocationId("loc_new"))!;
    expect(added.connectedLocationIds).toContain(asLocationId("loc_1"));
  });

  it("adds a new NPC to its location's npcIds index", () => {
    const newNpc: NpcEntry = {
      id: asNpcId("npc_new"),
      name: "老猎人",
      role: "猎人",
      description: "一个沉默寡言的老猎人。",
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
    const approved: ApprovedExpansion = {
      newLocations: [], newNpcs: [newNpc], newItems: [], newEnemies: [], newFacts: [],
      budgetConsumed: { locations: 0, npcs: 1, items: 0, enemies: 0, facts: 0 },
    };
    const nextWs = applyApprovedExpansion(ws, approved, "2026-01-01");
    const source = nextWs.locations.find((l) => l.id === asLocationId("loc_1"))!;
    expect(source.npcIds).toContain(asNpcId("npc_new"));
    expect(nextWs.npcs).toContainEqual(newNpc);
  });

  it("attaches a new item to its target location's availableItemIds", () => {
    const newItem: ItemEntry = {
      id: asItemId("item_new"),
      name: "锈剑",
      description: "一把生锈的铁剑。",
      kind: "weapon",
      tags: ["location_id:loc_1"],
    };
    const approved: ApprovedExpansion = {
      newLocations: [], newNpcs: [], newItems: [newItem], newEnemies: [], newFacts: [],
      budgetConsumed: { locations: 0, npcs: 0, items: 1, enemies: 0, facts: 0 },
    };
    const nextWs = applyApprovedExpansion(ws, approved, "2026-01-01");
    const source = nextWs.locations.find((l) => l.id === asLocationId("loc_1"))!;
    expect(source.availableItemIds).toContain(asItemId("item_new"));
  });

  it("does not override existing definition fields when applying expansion", () => {
    const newLoc: LocationEntry = {
      id: asLocationId("loc_new"), name: "密林", description: "t", kind: "main",
      connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
    };
    const approved: ApprovedExpansion = {
      newLocations: [newLoc], newNpcs: [], newItems: [], newEnemies: [], newFacts: [],
      budgetConsumed: { locations: 1, npcs: 0, items: 0, enemies: 0, facts: 0 },
    };
    const nextWs = applyApprovedExpansion(ws, approved, "2026-01-01");
    const source = nextWs.locations.find((l) => l.id === asLocationId("loc_1"))!;
    expect(source.name).toBe("客栈");
    expect(source.kind).toBe("main");
  });
});
