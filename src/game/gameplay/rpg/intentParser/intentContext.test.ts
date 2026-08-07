import { describe, it, expect } from "vitest";
import { buildIntentContext, type IntentContext } from "./intentContext";
import { createInitialWorldState, appendLocation, appendNpc, appendItem, type LocationEntry, type NpcEntry, type ItemEntry } from "@/game/domain/worldState";
import { asLocationId, asNpcId, asItemId, asFactId, asGenerationId } from "@/game/domain/scenarioBlueprint";

describe("buildIntentContext", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")],
    availableItemIds: [asItemId("item_1")], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const item1: ItemEntry = {
    id: asItemId("item_1"), name: "钥匙", description: "t", kind: "key", tags: [],
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const npc1: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  const ws = appendItem(appendLocation(appendNpc(baseWs, npc1), loc2), item1);

  it("includes current location name and connected locations", () => {
    const ctx = buildIntentContext(ws);
    expect(ctx.currentLocationName).toBe("客栈");
    expect(ctx.connectedLocations).toHaveLength(1);
    expect(ctx.connectedLocations[0]?.name).toBe("街道");
  });

  it("includes NPCs at current location", () => {
    const ctx = buildIntentContext(ws);
    expect(ctx.presentNpcs).toHaveLength(1);
    expect(ctx.presentNpcs[0]?.name).toBe("老板");
  });

  it("includes available items at current location", () => {
    const ctx = buildIntentContext(ws);
    expect(ctx.availableItems).toHaveLength(1);
    expect(ctx.availableItems[0]?.name).toBe("钥匙");
  });

  it("includes undiscovered facts", () => {
    const ctx = buildIntentContext(ws);
    expect(Array.isArray(ctx.undiscoveredFacts)).toBe(true);
  });

  it("includes active quests", () => {
    const ctx = buildIntentContext(ws);
    expect(Array.isArray(ctx.activeQuests)).toBe(true);
  });
});
