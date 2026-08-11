import { describe, it, expect } from "vitest";
import { createFixtureExpansionSource } from "./expansionSource";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";

describe("createFixtureExpansionSource", () => {
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
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });

  it("proposes a location for move action", async () => {
    const source = createFixtureExpansionSource();
    const result = await source.propose({
      worldState: ws,
      storyState: ss,
      action: { type: "move", locationId: asLocationId("loc_unknown") },
      triggerReason: "entity_not_found",
    });
    expect(result.proposals.length).toBe(1);
    expect(result.proposals[0]!.kind).toBe("location");
  });

  it("proposes an npc for talk action", async () => {
    const source = createFixtureExpansionSource();
    const result = await source.propose({
      worldState: ws,
      storyState: ss,
      action: { type: "talk", npcId: asNpcId("npc_unknown"), dialogueAct: "ask" },
      triggerReason: "entity_not_found",
    });
    expect(result.proposals.length).toBe(1);
    expect(result.proposals[0]!.kind).toBe("npc");
  });

  it("returns empty for other action types", async () => {
    const source = createFixtureExpansionSource();
    const result = await source.propose({
      worldState: ws,
      storyState: ss,
      action: { type: "explore" },
      triggerReason: "entity_not_found",
    });
    expect(result.proposals).toEqual([]);
  });
});
