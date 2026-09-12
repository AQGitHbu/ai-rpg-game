import { describe, expect, it } from "vitest";
import { asNarrativeJobId } from "./events";
import {
  createPreparedContinuationState,
  preparedContinuationTriggerKey,
  type PreparedContinuationState,
  type PreparedContinuationStepState,
  type PreparedContinuationTrigger,
} from "./preparedContinuation";
import {
  asEnemyId,
  asFactId,
  asLocationId,
  asNpcId,
  asQuestId,
} from "./worldEntity";

function scene(
  event: PreparedContinuationStepState["scene"]["event"],
): PreparedContinuationStepState["scene"] {
  return {
    segments: [{ beatId: "atmosphere", text: "风从山门外吹来。" }],
    event,
    npcLine: null,
    objectiveLink: null,
    choiceSeeds: [],
    source: "generated",
  };
}

describe("PreparedContinuationState", () => {
  it("represents a complete move-to-NPC prepared step without minted tokens", () => {
    const prepared: PreparedContinuationState = {
      originJobId: asNarrativeJobId("job_dialogue_2"),
      steps: [{
        stepId: "prepared:quest_2:move:loc_temple",
        objectiveKey: "quest_2:0",
        consumptionGroupKey: "quest_2:0:move",
        trigger: { kind: "move", locationId: asLocationId("loc_temple") },
        scene: {
          segments: [{ beatId: "atmosphere", text: "你沿山路抵达破庙。" }],
          event: { kind: "travel", locationId: asLocationId("loc_temple") },
          npcLine: {
            npcId: asNpcId("npc_beggar"),
            text: "后生，脚步放轻些。这里昨夜来过不该来的人。",
            emotion: "guarded",
            usedFactIds: [],
            usedEventIds: [],
          },
          objectiveLink: {
            questId: asQuestId("quest_2"),
            objectiveIndex: 1,
            mode: "hint",
          },
          choiceSeeds: [
            {
              label: "老丈，昨夜来的是谁？",
              action: {
                type: "talk",
                npcId: asNpcId("npc_beggar"),
                dialogueAct: "support",
              },
            },
            {
              label: "你若隐瞒，我只能自己搜。",
              action: {
                type: "talk",
                npcId: asNpcId("npc_beggar"),
                dialogueAct: "challenge",
              },
            },
          ],
          source: "generated",
        },
        nextStepIds: [],
      }],
      activeStepIds: ["prepared:quest_2:move:loc_temple"],
    };

    expect(prepared.steps[0]!.scene.choiceSeeds).toHaveLength(2);
    expect("choiceToken" in prepared.steps[0]!.scene.choiceSeeds[0]!).toBe(false);
    expect(createPreparedContinuationState(prepared)).toEqual({ ok: true, value: prepared });
  });

  it("accepts an expression-only scene seed", () => {
    const prepared: PreparedContinuationState = {
      originJobId: asNarrativeJobId("job-expression-only"),
      steps: [{
        stepId: "prepared:observe",
        objectiveKey: "quest_2:0",
        consumptionGroupKey: "quest_2:0:observe",
        trigger: { kind: "move", locationId: asLocationId("loc_temple") },
        scene: {
          expressions: [{
            kind: "narration",
            beatId: "atmosphere",
            text: "雨声落在残瓦上。",
            referencedEntityIds: [],
          }],
          event: { kind: "travel", locationId: asLocationId("loc_temple") },
          npcLine: null,
          objectiveLink: null,
          choiceSeeds: [],
          source: "fixture",
        },
        nextStepIds: [],
      }],
      activeStepIds: ["prepared:observe"],
    };

    expect(createPreparedContinuationState(prepared)).toEqual({ ok: true, value: prepared });
  });

  it("keeps investigate approaches and battle outcomes as distinct canonical triggers", () => {
    const triggers = [
      { kind: "investigate", factId: asFactId("fact_tracks"), approachId: "quiet" },
      { kind: "investigate", factId: asFactId("fact_tracks"), approachId: "forceful" },
      { kind: "battle_resolved", enemyId: asEnemyId("enemy_wolf"), outcome: "victory" },
      { kind: "battle_resolved", enemyId: asEnemyId("enemy_wolf"), outcome: "defeat" },
      { kind: "battle_resolved", enemyId: asEnemyId("enemy_wolf"), outcome: "withdraw" },
    ] satisfies readonly PreparedContinuationTrigger[];

    expect(new Set(triggers.map(preparedContinuationTriggerKey)).size).toBe(triggers.length);
  });

  it("preserves branch-specific investigation successors", () => {
    const steps: readonly PreparedContinuationStepState[] = [
      {
        stepId: "investigate:quiet",
        objectiveKey: "quest_2:0",
        consumptionGroupKey: "quest_2:0:investigate",
        trigger: { kind: "investigate", factId: asFactId("fact_tracks"), approachId: "quiet" },
        scene: scene({ kind: "investigate", factId: asFactId("fact_tracks") }),
        nextStepIds: ["move:quiet"],
      },
      {
        stepId: "investigate:forceful",
        objectiveKey: "quest_2:0",
        consumptionGroupKey: "quest_2:0:investigate",
        trigger: { kind: "investigate", factId: asFactId("fact_tracks"), approachId: "forceful" },
        scene: scene({ kind: "investigate", factId: asFactId("fact_tracks") }),
        nextStepIds: ["move:forceful"],
      },
      {
        stepId: "move:quiet",
        objectiveKey: "quest_2:1",
        consumptionGroupKey: "quest_2:1:quiet",
        trigger: { kind: "move", locationId: asLocationId("loc_temple") },
        scene: scene({ kind: "travel", locationId: asLocationId("loc_temple") }),
        nextStepIds: [],
      },
      {
        stepId: "move:forceful",
        objectiveKey: "quest_2:1",
        consumptionGroupKey: "quest_2:1:forceful",
        trigger: { kind: "move", locationId: asLocationId("loc_camp") },
        scene: scene({ kind: "travel", locationId: asLocationId("loc_camp") }),
        nextStepIds: [],
      },
    ];
    const result = createPreparedContinuationState({
      originJobId: asNarrativeJobId("job-investigation"),
      steps,
      activeStepIds: ["investigate:quiet", "investigate:forceful"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps.find((step) => step.stepId === "investigate:quiet")?.nextStepIds)
      .toEqual(["move:quiet"]);
    expect(result.value.steps.find((step) => step.stepId === "investigate:forceful")?.nextStepIds)
      .toEqual(["move:forceful"]);
  });

  it("keeps all three battle outcomes behind one battle_started step", () => {
    const enemyId = asEnemyId("enemy_wolf");
    const outcomeSteps = (["victory", "defeat", "withdraw"] as const).map((outcome) => ({
      stepId: `battle:${outcome}`,
      objectiveKey: "quest_2:2",
      consumptionGroupKey: "quest_2:2:battle_resolved",
      trigger: { kind: "battle_resolved", enemyId, outcome },
      scene: scene({ kind: "battle", enemyId }),
      nextStepIds: [],
    })) satisfies readonly PreparedContinuationStepState[];
    const result = createPreparedContinuationState({
      originJobId: asNarrativeJobId("job-battle"),
      steps: [{
        stepId: "battle:started",
        objectiveKey: "quest_2:2",
        consumptionGroupKey: "quest_2:2:battle_started",
        trigger: { kind: "battle_started", enemyId },
        scene: scene({ kind: "battle", enemyId }),
        nextStepIds: outcomeSteps.map((step) => step.stepId),
      }, ...outcomeSteps],
      activeStepIds: ["battle:started"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps[0]?.nextStepIds).toEqual([
      "battle:victory",
      "battle:defeat",
      "battle:withdraw",
    ]);
  });

  it.each([
    {
      name: "duplicate step IDs",
      mutate: (step: PreparedContinuationStepState) => ({
        steps: [step, step], activeStepIds: [step.stepId],
      }),
    },
    {
      name: "empty active IDs when steps exist",
      mutate: (step: PreparedContinuationStepState) => ({ steps: [step], activeStepIds: [] }),
    },
    {
      name: "unknown successor IDs",
      mutate: (step: PreparedContinuationStepState) => ({
        steps: [{ ...step, nextStepIds: ["missing"] }], activeStepIds: [step.stepId],
      }),
    },
    {
      name: "cycles",
      mutate: (step: PreparedContinuationStepState) => ({
        steps: [{ ...step, nextStepIds: [step.stepId] }], activeStepIds: [step.stepId],
      }),
    },
    {
      name: "duplicate canonical sibling triggers",
      mutate: (step: PreparedContinuationStepState) => ({
        steps: [step, { ...step, stepId: "step-2" }], activeStepIds: [step.stepId, "step-2"],
      }),
    },
  ])("rejects $name", ({ mutate }) => {
    const step: PreparedContinuationStepState = {
      stepId: "step-1",
      objectiveKey: "quest_1:0",
      consumptionGroupKey: "quest_1:0:move",
      trigger: { kind: "move", locationId: asLocationId("loc_1") },
      scene: scene({ kind: "travel", locationId: asLocationId("loc_1") }),
      nextStepIds: [],
    };
    const invalid = mutate(step);

    expect(createPreparedContinuationState({
      originJobId: asNarrativeJobId("job-invalid"),
      ...invalid,
    })).toEqual({ ok: false, code: "INVALID_PREPARED_CONTINUATION" });
  });
});
