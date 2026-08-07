import { describe, it, expect } from "vitest";
import { resolveEnding } from "./resolveEnding";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asQuestId, asEndingId, asGenerationId } from "@/game/domain/scenarioBlueprint";
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
  const baseSs = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01" };

  it("triggers ending when requirements met and endingAllowed", () => {
    const ws: WorldState = {
      ...baseWs,
      quests: [{ id: asQuestId("q1"), name: "q", description: "t", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "main", status: "completed" }],
      endings: [{ id: asEndingId("e1"), name: "end", description: "t", requirements: [{ kind: "quest_completed", questId: asQuestId("q1") }] }],
    };
    const ss = { ...baseSs, endingAllowed: true };
    const result = resolveEnding(ws, ss, deps);
    expect(result.events[0]?.type).toBe("ending_reached");
    expect(result.nextWorldState.ending?.endingId).toBe(asEndingId("e1"));
  });

  it("does not trigger ending when endingAllowed is false", () => {
    const ws: WorldState = {
      ...baseWs,
      quests: [{ id: asQuestId("q1"), name: "q", description: "t", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "main", status: "completed" }],
      endings: [{ id: asEndingId("e1"), name: "end", description: "t", requirements: [{ kind: "quest_completed", questId: asQuestId("q1") }] }],
    };
    const ss = { ...baseSs, endingAllowed: false };
    const result = resolveEnding(ws, ss, deps);
    expect(result.events).toHaveLength(0);
  });
});
