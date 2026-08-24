import { describe, expect, it } from "vitest";
import {
  decideNarrativeExecution,
  intentProviderAllowedFor,
  providerAllowedFor,
  type NarrativeExecutionInput,
  type ProviderGenerationKind,
  type NarrativeSceneRequestKind,
} from "@/game/gameplay/rpg/narrativeExecution";

describe("narrative execution provider whitelist", () => {
  it.each([
    ["opening", true],
    ["npc_fixed_choice", true],
    ["npc_free_text", true],
    ["prepared_action", false],
    ["rule_only", false],
  ] as const)("%s providerAllowed=%s", (kind, allowed) => {
    expect(providerAllowedFor(kind)).toBe(allowed);
  });

  it("re-exports provider trigger types from the facade", () => {
    const kinds: readonly [ProviderGenerationKind, NarrativeSceneRequestKind] = [
      "npc_fixed_choice",
      "npc_response",
    ];
    expect(kinds).toEqual(["npc_fixed_choice", "npc_response"]);
  });

  it("classifies formal NPC choices as provider work", () => {
    expect(decideNarrativeExecution({
      action: { type: "talk", npcId: "npc_1" as never, dialogueAct: "support" },
      interactionKind: "fixed_choice",
      advancesObjective: true,
      hasPreparedStep: false,
      battleWillResolve: false,
      dialogueWillComplete: false,
    })).toEqual({
      kind: "provider",
      generationKind: "npc_fixed_choice",
      sceneRequestKind: "npc_response",
    });
  });

  const nonDialogueInputs: readonly NarrativeExecutionInput[] = [
    { action: { type: "move", locationId: "loc_2" as never }, interactionKind: null, advancesObjective: true, hasPreparedStep: true, battleWillResolve: false, dialogueWillComplete: false },
    { action: { type: "investigate", factId: "fact_2" as never }, interactionKind: null, advancesObjective: true, hasPreparedStep: true, battleWillResolve: false, dialogueWillComplete: false },
    { action: { type: "take_item", itemId: "item_1" as never }, interactionKind: null, advancesObjective: false, hasPreparedStep: false, battleWillResolve: false, dialogueWillComplete: false },
    { action: { type: "give_item", itemId: "item_1" as never, npcId: "npc_1" as never }, interactionKind: null, advancesObjective: false, hasPreparedStep: false, battleWillResolve: false, dialogueWillComplete: false },
    { action: { type: "attack", enemyId: "enemy_1" as never }, interactionKind: null, advancesObjective: true, hasPreparedStep: true, battleWillResolve: false, dialogueWillComplete: false },
    { action: { type: "battle_action", action: "attack" }, interactionKind: null, advancesObjective: true, hasPreparedStep: true, battleWillResolve: true, dialogueWillComplete: false },
  ];

  it.each(nonDialogueInputs)("$action.type never receives provider permission", (input) => {
    expect(decideNarrativeExecution(input).kind).not.toBe("provider");
  });

  it("does not authorize an internally synthesized talk without a formal interaction", () => {
    expect(decideNarrativeExecution({
      action: { type: "talk", npcId: "npc_1" as never, dialogueAct: "ask" },
      interactionKind: null,
      advancesObjective: false,
      hasPreparedStep: false,
      battleWillResolve: false,
      dialogueWillComplete: false,
    })).toEqual({ kind: "rule_only" });
  });

  it("routes an objective action with missing prepared content to the prepared error path", () => {
    expect(decideNarrativeExecution({
      action: { type: "move", locationId: "loc_2" as never },
      interactionKind: null,
      advancesObjective: true,
      hasPreparedStep: false,
      battleWillResolve: false,
      dialogueWillComplete: false,
    })).toEqual({ kind: "prepared" });
  });

  it("allows intent AI only for free text bound to the authoritative focused NPC", () => {
    const npcId = "npc_1" as never;
    expect(intentProviderAllowedFor({
      interaction: { kind: "free_text", text: "昨夜发生了什么？", targetNpcId: npcId },
      focusedNpcId: npcId,
    })).toBe(true);
    expect(intentProviderAllowedFor({
      interaction: { kind: "free_text", text: "昨夜发生了什么？", targetNpcId: "npc_2" as never },
      focusedNpcId: npcId,
    })).toBe(false);
  });
});
