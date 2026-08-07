import { describe, it, expect } from "vitest";
import { runExpansionProposer } from "./index";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import { createFixtureExpansionSource } from "@/game/application/server/ai/expansionSource";
import type { RuleEngineResult } from "@/game/gameplay/rpg/ruleEngine";

describe("runExpansionProposer", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
  };
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01" };

  it("returns no trigger when initial result is success", async () => {
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
    const result = await runExpansionProposer(
      initialResult, ws, ss,
      { type: "move", locationId: asLocationId("loc_2") },
      "act_1",
      createFixtureExpansionSource(),
      deps,
    );
    expect(result.triggered).toBe(false);
    expect(result.approved).toBeNull();
  });

  it("triggers expansion for UNKNOWN_LOCATION, re-evaluates action", async () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_LOCATION",
      feedback: "Action rejected: UNKNOWN_LOCATION",
    };
    const wsWithUnlocked = { ...ws, unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_unknown")] };
    const result = await runExpansionProposer(
      initialResult, wsWithUnlocked, ss,
      { type: "move", locationId: asLocationId("loc_unknown") },
      "act_2",
      createFixtureExpansionSource(),
      deps,
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("entity_not_found");
    expect(result.approved).not.toBeNull();
    expect(result.approved!.newLocations.length).toBe(1);
    expect(result.reEvaluatedResult).not.toBeNull();
    expect(result.reEvaluatedResult!.ok).toBe(true);
  });

  it("returns no trigger when no expansion source provided", async () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_LOCATION",
      feedback: "Action rejected: UNKNOWN_LOCATION",
    };
    const result = await runExpansionProposer(
      initialResult, ws, ss,
      { type: "move", locationId: asLocationId("loc_unknown") },
      "act_3",
      null,
      deps,
    );
    expect(result.triggered).toBe(false);
  });

  it("triggers expansion for UNKNOWN_NPC, re-evaluates action", async () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_NPC",
      feedback: "Action rejected: UNKNOWN_NPC",
    };
    const result = await runExpansionProposer(
      initialResult, ws, ss,
      { type: "talk", npcId: asNpcId("npc_unknown") },
      "act_4",
      createFixtureExpansionSource(),
      deps,
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("entity_not_found");
    expect(result.approved).not.toBeNull();
    expect(result.approved!.newNpcs.length).toBe(1);
    expect(result.reEvaluatedResult).not.toBeNull();
    expect(result.reEvaluatedResult!.ok).toBe(true);
  });
});
