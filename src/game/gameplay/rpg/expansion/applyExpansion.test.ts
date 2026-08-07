import { describe, it, expect } from "vitest";
import { applyApprovedExpansion } from "./applyExpansion";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { asLocationId, asGenerationId } from "@/game/domain/scenarioBlueprint";
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
});
