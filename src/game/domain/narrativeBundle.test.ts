import { describe, expect, it } from "vitest";
import { asEnemyId, asFactId, asItemId, asLocationId, asNpcId } from "./worldEntity";
import { asNarrativeJobId } from "./events";
import {
  MAX_NARRATIVE_BUNDLE_STEPS,
  narrativeBundleTriggerKey,
  parseNarrativeBundleProposal,
  parseNarrativeBundleState,
  type BundleSceneProposal,
  type BundleStepProposal,
  type NarrativeBundleProposal,
  type NarrativeBundleState,
  type ScenePerformanceNpcDialogue,
} from "./narrativeBundle";
import type { PreparedSceneSeedState } from "./preparedContinuation";

function makeValidScene(): BundleSceneProposal {
  return {
    segments: [{ beatId: "atmosphere", text: "阳光透过树叶洒下。" }],
    npcLine: {
      npcId: "npc_1",
      text: "你来了。",
      emotion: "neutral",
      answeredBeatIds: [],
      usedFactIds: [],
      usedEventIds: [],
    },
    objectiveLink: null,
    choices: [
      { candidateId: "support", label: "表示赞同" },
      { candidateId: "challenge", label: "提出质疑" },
    ],
  };
}

function makeValidBundle(): NarrativeBundleProposal {
  return {
    worldDelta: null,
    currentScene: makeValidScene(),
    continuationScenes: [],
    terminal: { kind: "next_decision", target: { kind: "current_scene" } },
  };
}

function makeStep(stepKey: string): BundleStepProposal {
  return {
    stepKey,
    scene: {
      segments: [{ beatId: "atmosphere", text: "继续前行。" }],
      npcLine: null,
      objectiveLink: null,
      choices: [],
    },
  };
}

function makeValidBundleState(): NarrativeBundleState {
  return {
    contractVersion: 1,
    originJobId: asNarrativeJobId("job-1"),
    steps: [],
    activeStepIds: [],
    terminal: { kind: "next_decision", target: { kind: "current_scene" } },
  };
}

describe("NarrativeBundleProposal parser", () => {
  it("requires speech reference arrays in the provider DTO construction type", () => {
    // @ts-expect-error v4 provider dialogue construction must include both arrays.
    const missingReferences: ScenePerformanceNpcDialogue = {
      npcId: "npc_2",
      text: "路过喝口茶。",
    };
    void missingReferences;
    expect(true).toBe(true);
  });

  it("accepts a valid current_scene terminal with empty continuation", () => {
    const result = parseNarrativeBundleProposal(makeValidBundle());
    expect(result.ok).toBe(true);
  });

  it("rejects NPC lines and ambient dialogues without exact reference arrays", () => {
    const missingInteractionIds = {
      ...makeValidScene(),
      npcLine: {
        ...makeValidScene().npcLine!,
        usedEventIds: undefined,
      },
    };
    expect(parseNarrativeBundleProposal({
      ...makeValidBundle(),
      currentScene: missingInteractionIds,
    }).ok).toBe(false);

    expect(parseNarrativeBundleProposal({
      ...makeValidBundle(),
      currentScene: {
        ...makeValidScene(),
        npcDialogues: [{ npcId: "npc_2", text: "路过喝口茶。" }],
      },
    }).ok).toBe(false);
  });

  it("rejects duplicate or malformed speech reference IDs", () => {
    expect(parseNarrativeBundleProposal({
      ...makeValidBundle(),
      currentScene: {
        ...makeValidScene(),
        npcLine: { ...makeValidScene().npcLine!, usedFactIds: ["fact_1", "fact_1"] },
      },
    }).ok).toBe(false);
    expect(parseNarrativeBundleProposal({
      ...makeValidBundle(),
      currentScene: {
        ...makeValidScene(),
        npcLine: { ...makeValidScene().npcLine!, usedEventIds: ["bad action id"] },
      },
    }).ok).toBe(false);
  });

  it("rejects current_scene terminal with continuation scenes", () => {
    const bundle: NarrativeBundleProposal = {
      ...makeValidBundle(),
      continuationScenes: [makeStep("move:loc_2")],
    };
    expect(parseNarrativeBundleProposal(bundle)).toMatchObject({
      ok: false,
      code: "INVALID_NARRATIVE_BUNDLE_PROPOSAL",
      reason: "current_scene_terminal_requires_empty_continuation",
    });
  });

  it("names the terminal step when it lacks exactly two distinct choices", () => {
    const bundle: NarrativeBundleProposal = {
      ...makeValidBundle(),
      currentScene: { ...makeValidScene(), choices: [] },
      continuationScenes: [makeStep("battle_resolved:victory:enemy_1")],
      terminal: {
        kind: "next_decision",
        target: { kind: "continuation_step", stepKey: "battle_resolved:victory:enemy_1" },
      },
    };
    expect(parseNarrativeBundleProposal(bundle)).toMatchObject({
      ok: false,
      reason: "terminal_step_requires_two_choices",
      stepKey: "battle_resolved:victory:enemy_1",
    });
  });

  it("rejects continuation_step terminal without continuation scenes", () => {
    const bundle: NarrativeBundleProposal = {
      ...makeValidBundle(),
      terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: "move:loc_2" } },
    };
    expect(parseNarrativeBundleProposal(bundle).ok).toBe(false);
  });

  it("rejects continuation_step terminal whose stepKey does not match any step", () => {
    const bundle: NarrativeBundleProposal = {
      ...makeValidBundle(),
      continuationScenes: [makeStep("move:loc_2")],
      terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: "move:nonexistent" } },
      currentScene: { ...makeValidScene(), choices: [] },
    };
    expect(parseNarrativeBundleProposal(bundle).ok).toBe(false);
  });

  it("rejects more than 12 continuation steps", () => {
    const steps = Array.from({ length: 13 }, (_, i) => makeStep(`move:loc_${i}`));
    const bundle: NarrativeBundleProposal = {
      ...makeValidBundle(),
      continuationScenes: steps,
      terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: "move:loc_0" } },
      currentScene: { ...makeValidScene(), choices: [] },
    };
    expect(parseNarrativeBundleProposal(bundle).ok).toBe(false);
  });

  it("accepts exactly 12 continuation steps", () => {
    const steps = Array.from({ length: 12 }, (_, i) => makeStep(`move:loc_${i}`));
    steps[0] = {
      ...steps[0]!,
      scene: {
        ...steps[0]!.scene,
        choices: [
          { candidateId: "choice_1", label: "继续" },
          { candidateId: "choice_2", label: "停下" },
        ],
      },
    };
    const bundle: NarrativeBundleProposal = {
      ...makeValidBundle(),
      continuationScenes: steps,
      terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: "move:loc_0" } },
      currentScene: { ...makeValidScene(), choices: [] },
    };
    expect(parseNarrativeBundleProposal(bundle).ok).toBe(true);
  });

  it("rejects a current_scene terminal without exactly two distinct choices", () => {
    const bundle: NarrativeBundleProposal = {
      ...makeValidBundle(),
      currentScene: {
        ...makeValidScene(),
        choices: [{ candidateId: "support", label: "表示赞同" }],
      },
    };
    expect(parseNarrativeBundleProposal(bundle).ok).toBe(false);
  });

  it("accepts ending terminal with no continuation and two stance labels", () => {
    const bundle: NarrativeBundleProposal = {
      ...makeValidBundle(),
      terminal: { kind: "ending" },
      currentScene: { ...makeValidScene(), choices: [] },
      endingLabels: { trust: "我们一起把证据摊开。", doubt: "我要先核对每一份证据。" },
    };
    expect(parseNarrativeBundleProposal(bundle).ok).toBe(true);
  });

  it("rejects ending terminal without stance labels", () => {
    const bundle: NarrativeBundleProposal = {
      ...makeValidBundle(),
      terminal: { kind: "ending" },
      currentScene: { ...makeValidScene(), choices: [] },
    };
    expect(parseNarrativeBundleProposal(bundle)).toMatchObject({ ok: false, reason: "ending_labels_missing" });
  });

  it("rejects ending labels on a non-ending terminal", () => {
    const bundle: NarrativeBundleProposal = {
      ...makeValidBundle(),
      endingLabels: { trust: "我们一起把证据摊开。", doubt: "我要先核对每一份证据。" },
    };
    expect(parseNarrativeBundleProposal(bundle)).toMatchObject({ ok: false, reason: "ending_labels_invalid" });
  });

  it("rejects ending terminal with continuation scenes", () => {
    const bundle: NarrativeBundleProposal = {
      ...makeValidBundle(),
      continuationScenes: [makeStep("move:loc_2")],
      terminal: { kind: "ending" },
      currentScene: { ...makeValidScene(), choices: [] },
      endingLabels: { trust: "我们一起把证据摊开。", doubt: "我要先核对每一份证据。" },
    };
    expect(parseNarrativeBundleProposal(bundle).ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(parseNarrativeBundleProposal(null).ok).toBe(false);
    expect(parseNarrativeBundleProposal("hello").ok).toBe(false);
    expect(parseNarrativeBundleProposal(42).ok).toBe(false);
  });

  it("MAX_NARRATIVE_BUNDLE_STEPS is 12", () => {
    expect(MAX_NARRATIVE_BUNDLE_STEPS).toBe(12);
  });
});

describe("narrativeBundleTriggerKey", () => {
  it("produces canonical keys for each trigger variant", () => {
    expect(narrativeBundleTriggerKey({ kind: "move", locationId: asLocationId("loc_1") })).toBe("move:loc_1");
    expect(narrativeBundleTriggerKey({ kind: "explore", locationId: asLocationId("loc_1") })).toBe("explore:loc_1");
    expect(narrativeBundleTriggerKey({ kind: "investigate", factId: asFactId("fact_1") })).toBe("investigate:fact_1:");
    expect(narrativeBundleTriggerKey({ kind: "investigate", factId: asFactId("fact_1"), approachId: "quiet" })).toBe("investigate:fact_1:quiet");
    expect(narrativeBundleTriggerKey({ kind: "take_item", itemId: asItemId("item_1") })).toBe("take_item:item_1");
    expect(narrativeBundleTriggerKey({ kind: "give_item", itemId: asItemId("item_1"), npcId: asNpcId("npc_1") })).toBe("give_item:item_1:npc_1");
    expect(narrativeBundleTriggerKey({ kind: "battle_started", enemyId: asEnemyId("enemy_1") })).toBe("battle_started:enemy_1");
    expect(narrativeBundleTriggerKey({ kind: "battle_resolved", enemyId: asEnemyId("enemy_1"), outcome: "victory" })).toBe("battle_resolved:victory:enemy_1");
  });
});

describe("NarrativeBundleState parser", () => {
  it("accepts a valid current_scene terminal state", () => {
    expect(parseNarrativeBundleState(makeValidBundleState()).ok).toBe(true);
  });

  it("rejects unknown edges", () => {
    const state: NarrativeBundleState = {
      ...makeValidBundleState(),
      steps: [{
        stepId: "step-1",
        objectiveKey: "quest_1:0",
        consumptionGroupKey: "quest_1:0:move",
        trigger: { kind: "move", locationId: asLocationId("loc_1") },
        scene: {} as PreparedSceneSeedState,
        nextStepIds: ["nonexistent"],
      }],
      activeStepIds: ["step-1"],
      terminal: { kind: "next_decision", target: { kind: "continuation_step", stepId: "step-1" } },
    };
    expect(parseNarrativeBundleState(state).ok).toBe(false);
  });

  it("rejects cycles", () => {
    const state: NarrativeBundleState = {
      ...makeValidBundleState(),
      steps: [{
        stepId: "step-1",
        objectiveKey: "quest_1:0",
        consumptionGroupKey: "quest_1:0:move",
        trigger: { kind: "move", locationId: asLocationId("loc_1") },
        scene: {} as PreparedSceneSeedState,
        nextStepIds: ["step-1"],
      }],
      activeStepIds: ["step-1"],
      terminal: { kind: "next_decision", target: { kind: "continuation_step", stepId: "step-1" } },
    };
    expect(parseNarrativeBundleState(state).ok).toBe(false);
  });

  it("rejects more than 12 steps", () => {
    const steps = Array.from({ length: 13 }, (_, i) => ({
      stepId: `step-${i}`,
      objectiveKey: "quest_1:0",
      consumptionGroupKey: `quest_1:0:move_${i}`,
      trigger: { kind: "move" as const, locationId: asLocationId(`loc_${i}`) },
      scene: {} as PreparedSceneSeedState,
      nextStepIds: [],
    }));
    const state: NarrativeBundleState = {
      ...makeValidBundleState(),
      steps,
      activeStepIds: steps.map((s) => s.stepId),
      terminal: { kind: "ending" as const },
    };
    expect(parseNarrativeBundleState(state).ok).toBe(false);
  });

  it("rejects continuation_step terminal with absent stepId", () => {
    const state: NarrativeBundleState = {
      ...makeValidBundleState(),
      terminal: { kind: "next_decision", target: { kind: "continuation_step", stepId: "nonexistent" } },
    };
    expect(parseNarrativeBundleState(state).ok).toBe(false);
  });

  it("rejects current_scene terminal with continuation steps", () => {
    const state: NarrativeBundleState = {
      ...makeValidBundleState(),
      steps: [{
        stepId: "step-1",
        objectiveKey: "quest_1:0",
        consumptionGroupKey: "quest_1:0:move",
        trigger: { kind: "move", locationId: asLocationId("loc_1") },
        scene: {} as PreparedSceneSeedState,
        nextStepIds: [],
      }],
      activeStepIds: ["step-1"],
      terminal: { kind: "next_decision", target: { kind: "current_scene" } },
    };
    expect(parseNarrativeBundleState(state).ok).toBe(false);
  });

  it("rejects ending terminal with continuation steps", () => {
    const state: NarrativeBundleState = {
      ...makeValidBundleState(),
      steps: [{
        stepId: "step-1",
        objectiveKey: "quest_1:0",
        consumptionGroupKey: "quest_1:0:move",
        trigger: { kind: "move", locationId: asLocationId("loc_1") },
        scene: {} as PreparedSceneSeedState,
        nextStepIds: [],
      }],
      activeStepIds: ["step-1"],
      terminal: { kind: "ending" },
    };
    expect(parseNarrativeBundleState(state).ok).toBe(false);
  });

  it("rejects duplicate step IDs", () => {
    const step = {
      stepId: "step-1",
      objectiveKey: "quest_1:0",
      consumptionGroupKey: "quest_1:0:move",
      trigger: { kind: "move" as const, locationId: asLocationId("loc_1") },
      scene: {} as PreparedSceneSeedState,
      nextStepIds: [] as readonly string[],
    };
    const state: NarrativeBundleState = {
      ...makeValidBundleState(),
      steps: [step, { ...step }],
      activeStepIds: ["step-1"],
      terminal: { kind: "ending" },
    };
    expect(parseNarrativeBundleState(state).ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(parseNarrativeBundleState(null).ok).toBe(false);
    expect(parseNarrativeBundleState("hello").ok).toBe(false);
  });
});
