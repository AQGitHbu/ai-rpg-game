import { describe, it, expect } from "vitest";
import { checkExpansionTrigger } from "./expansionTrigger";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { Action } from "@/game/domain/action";
import type { RuleEngineResult } from "@/game/gameplay/rpg/ruleEngine";

describe("checkExpansionTrigger", () => {
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  const action: Action = { type: "move", locationId: asLocationId("loc_unknown") };

  it("triggers entity_not_found when ruleEngine returns UNKNOWN_LOCATION", () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_LOCATION",
      feedback: "Action rejected: UNKNOWN_LOCATION",
    };
    const result = checkExpansionTrigger(initialResult, ws, ss, action);
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("entity_not_found");
  });

  it("triggers entity_not_found when ruleEngine returns UNKNOWN_NPC", () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_NPC",
      feedback: "Action rejected: UNKNOWN_NPC",
    };
    const talkAction: Action = { type: "talk", npcId: asNpcId("npc_unknown") };
    const result = checkExpansionTrigger(initialResult, ws, ss, talkAction);
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("entity_not_found");
  });

  it("does NOT trigger when ruleEngine succeeds", () => {
    const initialResult: RuleEngineResult = {
      ok: true,
      nextWorldState: ws,
      nextStoryState: ss,
      resolvedEvent: {
        actionId: "a1", status: "success", eventKind: "travel",
        facts: [], stateChanges: [], costs: [], rewards: [],
        triggeredEvents: [], rejectedEffects: [], stateVersion: 1,
      },
    };
    const result = checkExpansionTrigger(initialResult, ws, ss, action);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_trigger");
  });

  it("does NOT trigger on non-entity rejections (e.g. LOCATION_NOT_CONNECTED)", () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "LOCATION_NOT_CONNECTED",
      feedback: "Action rejected: LOCATION_NOT_CONNECTED",
    };
    const result = checkExpansionTrigger(initialResult, ws, ss, action);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_trigger");
  });

  it("does NOT trigger when budget has no room for locations expansion", () => {
    const ssMaxed = { ...ss, budget: { ...ss.budget, locations: { ...ss.budget.locations, expanded: ss.budget.locations.max } } };
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_LOCATION",
      feedback: "Action rejected: UNKNOWN_LOCATION",
    };
    const result = checkExpansionTrigger(initialResult, ws, ssMaxed, action);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_trigger");
  });

  it("does NOT trigger when budget has no room for npcs expansion (UNKNOWN_NPC)", () => {
    const ssMaxedNpcs = { ...ss, budget: { ...ss.budget, npcs: { ...ss.budget.npcs, expanded: ss.budget.npcs.max } } };
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_NPC",
      feedback: "Action rejected: UNKNOWN_NPC",
    };
    const talkAction: Action = { type: "talk", npcId: asNpcId("npc_unknown") };
    const result = checkExpansionTrigger(initialResult, ws, ssMaxedNpcs, talkAction);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_trigger");
  });
});
