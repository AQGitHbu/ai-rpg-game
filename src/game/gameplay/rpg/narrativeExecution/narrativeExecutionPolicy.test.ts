import { describe, expect, it } from "vitest";
import {
  decideNarrativeExecution,
  intentProviderAllowedFor,
  providerAllowedFor,
  type NarrativeExecutionInput,
  type ProviderGenerationKind,
  type NarrativeSceneRequestKind,
} from "@/game/gameplay/rpg/narrativeExecution";
import {
  DECISION_BOUNDARY_KINDS,
  classifyProviderDecisionBoundary,
  type DecisionBoundaryKind,
} from "@/game/domain/pendingNarrativeJob";

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

  it("classifies a completed-act boundary as provider work for scene/world preparation", () => {
    expect(decideNarrativeExecution({
      action: { type: "explore" },
      interactionKind: "fixed_choice",
      advancesObjective: false,
      hasPreparedStep: false,
      battleWillResolve: false,
      dialogueWillComplete: false,
      worldBoundaryNeedsPreparation: true,
    })).toEqual({
      kind: "provider",
      generationKind: "npc_fixed_choice",
      sceneRequestKind: "npc_response",
    });
  });

  it("prepared continuation wins over a coincident act-boundary status", () => {
    expect(decideNarrativeExecution({
      action: { type: "move", locationId: "loc_2" as never },
      interactionKind: null,
      advancesObjective: true,
      hasPreparedStep: true,
      battleWillResolve: false,
      dialogueWillComplete: false,
      worldBoundaryNeedsPreparation: true,
    })).toEqual({ kind: "prepared" });
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

  it("目标推进但没有 prepared content 时保留规则场景，不伪造 continuation 消费", () => {
    expect(decideNarrativeExecution({
      action: { type: "move", locationId: "loc_2" as never },
      interactionKind: null,
      advancesObjective: true,
      hasPreparedStep: false,
      battleWillResolve: false,
      dialogueWillComplete: false,
    })).toEqual({ kind: "rule_only" });
  });

  it("abandon_quest always routes through the provider-owned story exit", () => {
    expect(decideNarrativeExecution({
      action: { type: "abandon_quest", questId: "quest_main" as never },
      interactionKind: "fixed_choice",
      advancesObjective: true,
      hasPreparedStep: false,
      battleWillResolve: false,
      dialogueWillComplete: false,
    })).toEqual({ kind: "provider", generationKind: "story_exit", sceneRequestKind: "story_exit" });
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

describe("semantic decision boundary classification", () => {
  it("DECISION_BOUNDARY_KINDS is the additive semantic whitelist", () => {
    expect(DECISION_BOUNDARY_KINDS).toEqual([
      "initialization",
      "narrative_choice",
      "npc_free_text",
      "investigation_result",
      "changed_revisit",
    ]);
  });

  it("formal fixed choice classifies as narrative_choice", () => {
    const kind: DecisionBoundaryKind | null = classifyProviderDecisionBoundary({
      action: { type: "talk", npcId: "npc_1" as never, dialogueAct: "support" },
      interactionKind: "fixed_choice",
      fixedChoiceIsCurrentFormalDecision: true,
      focusedNpcId: "npc_1" as never,
    });
    expect(kind).toBe("narrative_choice");
  });

  it("focus NPC free text classifies as npc_free_text", () => {
    const kind: DecisionBoundaryKind | null = classifyProviderDecisionBoundary({
      action: { type: "talk", npcId: "npc_1" as never, dialogueAct: "ask" },
      interactionKind: "free_text",
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: "npc_1" as never,
    });
    expect(kind).toBe("npc_free_text");
  });

  it("non-dialogue boundary returns null", () => {
    const kind: DecisionBoundaryKind | null = classifyProviderDecisionBoundary({
      action: { type: "move", locationId: "loc_2" as never },
      interactionKind: null,
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: null,
    });
    expect(kind).toBeNull();
  });
});
