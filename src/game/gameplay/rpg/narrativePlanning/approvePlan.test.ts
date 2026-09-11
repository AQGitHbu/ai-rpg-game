import { describe, expect, it } from "vitest";
import { approvePlan } from "./approvePlan";
import { approvePlanDecision } from "./approvePlanDecision";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import type { Unit } from "@/game/domain/narrativeUnit";
import {
  makeStagedPlan,
  FIXTURE_NARRATION_UNIT,
} from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import {
  branchWorld,
  branchStory,
  BRANCH_GENERATION,
} from "./branchFixture.testutil";
import { makeOpeningQualityCandidate } from "@/game/domain/openingSituation.testutil";
import { asGenerationId, asQuestId, asFactId } from "@/game/domain/worldEntity";
import type { GenerationMetadata } from "@/game/domain/worldEntity";

const GENERATION: GenerationMetadata = {
  ...BRANCH_GENERATION,
  generationId: asGenerationId("gen_open"),
};

function unit(overrides: Partial<Unit> & Pick<Unit, "key" | "stage">): Unit {
  return {
    point: { stepKey: "current", order: 1 },
    speakerId: null,
    dependencies: [],
    taskFactIds: [],
    requiredObservationKeys: [],
    requiredBeats: [],
    ...overrides,
  };
}

describe("approvePlan", () => {
  it.each([3])("choices order=%s 必须晚于同场 NPC 的表达", order => {
    const base = makeStagedPlan();
    if (base.decision === null) throw Error("decision");
    const point = { stepKey: "current", order };
    const proposal = { ...base, decision: { ...base.decision, point },
      units: base.units.map(u => u.stage === "choices" ? { ...u, point, dependencies: [] } : u) };
    expect(approvePlan({ kind: "decision", proposal, world: branchWorld(), story: branchStory() }))
      .toMatchObject({ ok: false, code: "plan_choices_before_expression" });
  });

  it.each(["quest", "fact"] as const)("普通选项拒绝不存在的 %s topic", kind => {
    const base = makeStagedPlan();
    if (base.decision?.kind !== "ordinary") throw Error("decision");
    const topic = kind === "quest" ? { kind, questId: asQuestId("quest_missing") } : { kind, factId: asFactId("fact_missing") };
    const proposal: PlanProposal = { ...base, decision: { ...base.decision,
      options: [
        { ...base.decision.options[0], dialogueAct: "support", target: null, deferredLocation: null, topic },
        { ...base.decision.options[1], dialogueAct: "challenge", target: null, deferredLocation: null, topic },
      ] } };
    const plan = approvePlan({ kind: "decision", proposal, world: branchWorld(), story: branchStory() });
    if (!plan.ok) throw Error(plan.code);
    expect(approvePlanDecision(plan.value)).toMatchObject({ ok: false, code: "decision_action_invalid" });
  });

  it("decision 输入复用权威世界/剧情状态，choiceExpression 来自提案", () => {
    const world = branchWorld();
    const story = branchStory();
    const result = approvePlan({
      kind: "decision",
      proposal: makeStagedPlan(),
      world,
      story,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.world).toBe(world);
    expect(result.value.story).toBe(story);
    expect(result.value.choiceExpression).toEqual(makeStagedPlan().decision);
    expect(result.value.units.map((u) => u.key)).toContain(FIXTURE_NARRATION_UNIT);
    // fixture 无观察要求 → 步骤依赖为空映射
    expect(result.value.stepDependencies).toEqual({});
  });

  it("opening 输入通过结构编译器生成稳定实体 ID 与正式 pending 叙事", () => {
    const proposal: PlanProposal = { ...makeStagedPlan(), opening: makeOpeningQualityCandidate() };
    const result = approvePlan({
      kind: "opening",
      proposal,
      generation: GENERATION,
      gameLength: "short",
      seed: "seed-open",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.world.entityStore.records.map((r) => r.core.id);
    expect(ids).toContain("loc_0");
    expect(ids).toContain("npc_0");
    // 结构 preview 的叙事是正式 pending 状态，不含伪造 ready 台词
    expect(result.value.story.narrative.status).toBe("provider_pending");
    // 确定性：同输入两次编译结构一致
    const again = approvePlan({ kind: "opening", proposal, generation: GENERATION, gameLength: "short", seed: "seed-open" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.world).toEqual(result.value.world);
    expect(again.value.story).toEqual(result.value.story);
  });

  it("opening 输入必须携带开局候选", () => {
    expect(approvePlan({
      kind: "opening",
      proposal: makeStagedPlan(),
      generation: GENERATION,
      gameLength: "short",
      seed: "seed",
    })).toEqual({ ok: false, code: "opening_required" });
  });

  it("decision 输入拒绝携带开局候选", () => {
    expect(approvePlan({
      kind: "decision",
      proposal: { ...makeStagedPlan(), opening: makeOpeningQualityCandidate() },
      world: branchWorld(),
      story: branchStory(),
    })).toEqual({ ok: false, code: "opening_forbidden" });
  });

  it("透传单元图校验失败码", () => {
    const proposal: PlanProposal = {
      ...makeStagedPlan(),
      units: [unit({ key: "a", stage: "narration", dependencies: ["ghost"] })],
    };
    expect(approvePlan({ kind: "decision", proposal, world: branchWorld(), story: branchStory() }))
      .toEqual({ ok: false, code: "unknown_dependency" });
  });

  it("decision 输入同样拒绝没有观察来源的知识要求", () => {
    const withObs: PlanProposal = {
      ...makeStagedPlan(),
      decision: null,
      units: [
        unit({
          key: "c",
          stage: "character",
          speakerId: "npc_0",
          requiredObservationKeys: ["obs_ghost"],
        }),
      ],
    };
    expect(approvePlan({ kind: "decision", proposal: withObs, world: branchWorld(), story: branchStory() }))
      .toEqual({ ok: false, code: "observation_without_source" });
  });
});
