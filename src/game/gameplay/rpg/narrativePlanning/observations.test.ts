import { describe, expect, it } from "vitest";
import { collectDisclosures, observationsForUnit } from "./observations";
import { approvePlan } from "./approvePlan";
import { branchWorld, branchStory } from "./branchFixture.testutil";
import {
  makeStagedPlan,
  FIXTURE_NPC_A,
  FIXTURE_NARRATION_UNIT,
  FIXTURE_NPC_A_UNIT,
} from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { PLAYER_ENTITY_ID, asFactId } from "@/game/domain/worldEntity";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import type { Observation } from "@/game/domain/narrativeObservation";
import type { Unit, UnitOutput } from "@/game/domain/narrativeUnit";
import type { NpcEntityRecord } from "@/game/domain/entity";
import type { WorldState } from "@/game/domain/worldState";
import type { NpcEntry } from "@/game/domain/worldEntries";

// ---------------------------------------------------------------------------
// collectDisclosures：纯规则匹配单元输出与计划观察。
// 只做已批准句段引用、在场性与披露可用性的确定性校验，不做文本挖掘。
// ---------------------------------------------------------------------------

const FACT_PUB = "fact_pub";
const FACT_SUS = "fact_sus";
const FACT_SECRET = "fact_secret";

const CURRENT = { stepKey: "current", order: 1 } as const;

function npcEntry(overrides: Partial<NpcEntry> = {}): NpcEntry {
  return {
    id: "npc_0" as NpcEntry["id"],
    name: "老陈",
    role: "知情者",
    description: "守着渡口的老陈",
    locationId: "loc_a" as NpcEntry["locationId"],
    isCompanion: false,
    tags: [],
    met: true,
    memory: {
      npcId: "npc_0" as NpcEntry["id"],
      knownFactIds: [],
      hiddenFactIds: [],
      interactionHistory: [],
      relationship: { affinity: 0 },
      emotion: "neutral",
      goals: [],
    },
    ...overrides,
  };
}

function knowledgeWorld(): WorldState {
  return branchWorld({
    worldFacts: [
      { factId: asFactId(FACT_PUB), text: "渡口昨夜有灯火", source: "generated", discovered: true },
      { factId: asFactId(FACT_SUS), text: "下游船行踪可疑", source: "generated", discovered: false },
      { factId: asFactId(FACT_SECRET), text: "老陈私藏密信", source: "generated", discovered: false },
    ],
    npcs: [
      npcEntry({
        memory: {
          npcId: "npc_0" as NpcEntry["id"],
          knownFactIds: [asFactId(FACT_PUB), asFactId(FACT_SUS), asFactId(FACT_SECRET)],
          hiddenFactIds: [asFactId(FACT_SECRET)],
          interactionHistory: [],
          relationship: { affinity: 0 },
          emotion: "neutral",
          goals: [],
        },
      }),
    ],
  });
}

/** 篡改分支：把某 NPC 对某事实的知识降为 suspected（corruption case，仅测试使用）。 */
function withSuspectedKnowledge(world: WorldState, npcId: string, factId: string): WorldState {
  const cloned = structuredClone(world) as WorldState;
  const record = cloned.entityStore.records.find(
    (candidate): candidate is NpcEntityRecord =>
      candidate.core.kind === "npc" && String(candidate.core.id) === npcId,
  );
  if (record === undefined) throw new Error(`fixture missing npc ${npcId}`);
  const entries = record.knowledge.entries.map((entry) =>
    String(entry.factId) === factId ? { ...entry, certainty: "suspected" as const } : entry,
  );
  // corruption case：测试内篡改权威组件，需绕开 Readonly 组件类型。
  const mutable = record as { knowledge: NpcEntityRecord["knowledge"] };
  mutable.knowledge = { entries };
  return cloned;
}

function unit(overrides: Partial<Unit> & Pick<Unit, "key" | "stage">): Unit {
  return {
    point: CURRENT,
    speakerId: null,
    dependencies: [],
    taskFactIds: [],
    requiredObservationKeys: [],
    requiredBeats: [],
    ...overrides,
  };
}

function observation(overrides: Partial<Observation> & Pick<Observation, "key">): Observation {
  return {
    point: CURRENT,
    audienceIds: [PLAYER_ENTITY_ID],
    fact: { factId: FACT_PUB, certainty: "known" },
    source: { kind: "speech", speakerId: FIXTURE_NPC_A },
    ...overrides,
  };
}

function planWith(units: readonly Unit[], observations: readonly Observation[]): PlanProposal {
  const stepKeys = [...new Set(units.map(unit => unit.point.stepKey))].filter(key => key !== "current");
  const last = stepKeys.at(-1) ?? "current";
  return { ...makeStagedPlan(), decision: { ...makeStagedPlan().decision!, point: { stepKey: last, order: 99 } },
    units: [...units, unit({ key: "choices_terminal", stage: "choices", point: { stepKey: last, order: 99 }, dependencies: units.map(unit => unit.key) })],
    observations,
    steps: stepKeys.map((key, index) => ({ key, trigger: { kind: "explore", locationId: branchWorld().currentLocationId }, next: stepKeys[index + 1] === undefined ? [] : [stepKeys[index + 1]!] })),
    terminal: last === "current" ? { kind: "next_decision", target: { kind: "current_scene" } } : { kind: "next_decision", target: { kind: "continuation_step", stepKey: last } },
  };
}

function approve(proposal: PlanProposal, world: WorldState) {
  const result = approvePlan({ kind: "decision", proposal, world, story: branchStory() });
  if (!result.ok) throw new Error(`fixture plan rejected: ${result.code}`);
  return result.value;
}

function characterOutput(speakerId: string, factRefs: readonly { factId: string; certainty: "known" | "suspected" }[]): UnitOutput {
  return {
    stage: "character",
    speakerId,
    parts: [{ text: "我只说我知道的。", facts: factRefs, evidence: [], beatIds: [] }],
    emotion: "neutral",
    actions: [],
    answeredBeatIds: [],
  };
}

function narrationOutput(factRefs: readonly { factId: string; certainty: "known" | "suspected" }[]): UnitOutput {
  return {
    stage: "narration",
    parts: [{ text: "烛火偏了一下。", facts: factRefs, evidence: [], beatIds: [] }],
    actionKeys: [],
  };
}

describe("collectDisclosures", () => {
  it("有效 speech 披露：句段引用、在场与披露可用全部成立时返回观察", () => {
    const world = knowledgeWorld();
    const npcUnit = unit({ key: FIXTURE_NPC_A_UNIT, stage: "character", speakerId: FIXTURE_NPC_A });
    const plan = approve(
      planWith([unit({ key: FIXTURE_NARRATION_UNIT, stage: "narration" }), npcUnit], [
        observation({ key: "obs_pub", fact: { factId: FACT_PUB, certainty: "known" } }),
      ]),
      world,
    );
    const result = collectDisclosures({
      plan,
      unit: npcUnit,
      output: characterOutput(FIXTURE_NPC_A, [{ factId: FACT_PUB, certainty: "known" }]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((o) => o.key)).toEqual(["obs_pub"]);
  });

  it("同一说话人的后续场景观察不归本单元（按 point 限定归属）", () => {
    // 回归：同一 NPC 在两个 step 各说一次时，第一个单元只认领自己所在 step 的观察；
    // 否则它会被迫披露尚未发生的后续场景观察，任何输出都无法通过。
    const world = knowledgeWorld();
    const later = { stepKey: "later", order: 1 } as const;
    const firstUnit = unit({
      key: FIXTURE_NPC_A_UNIT,
      stage: "character",
      speakerId: FIXTURE_NPC_A,
      point: CURRENT,
    });
    const secondUnit = unit({
      key: "character_second",
      stage: "character",
      speakerId: FIXTURE_NPC_A,
      point: later,
    });
    const plan = approve(
      planWith([firstUnit, secondUnit], [
        observation({ key: "obs_now", point: CURRENT }),
        observation({ key: "obs_later", point: later }),
      ]),
      world,
    );
    expect(observationsForUnit(firstUnit, plan.proposal.observations).map((o) => o.key))
      .toEqual(["obs_now"]);
    // 跨 step 的观察互不归属：第二个单元只认领自己 step 内的 obs_later。
    expect(observationsForUnit(secondUnit, plan.proposal.observations).map((o) => o.key))
      .toEqual(["obs_later"]);
    // 第一个单元只需披露 obs_now，引用 fact_pub 即通过。
    const result = collectDisclosures({
      plan,
      unit: firstUnit,
      output: characterOutput(FIXTURE_NPC_A, [{ factId: FACT_PUB, certainty: "known" }]),
    });
    expect(result.ok).toBe(true);
  });

  it("要求披露的观察没有句段 fact 引用时拒绝（遗漏拒绝）", () => {
    const world = knowledgeWorld();
    const npcUnit = unit({ key: FIXTURE_NPC_A_UNIT, stage: "character", speakerId: FIXTURE_NPC_A });
    const plan = approve(
      planWith([npcUnit], [observation({ key: "obs_pub" })]),
      world,
    );
    expect(collectDisclosures({ plan, unit: npcUnit, output: characterOutput(FIXTURE_NPC_A, []) }))
      .toEqual({ ok: false, code: "observation_not_disclosed" });
  });

  it("句段 certainty 与观察不一致时拒绝（speech 来源不得改写认知）", () => {
    const world = withSuspectedKnowledge(knowledgeWorld(), FIXTURE_NPC_A, FACT_SUS);
    const npcUnit = unit({ key: FIXTURE_NPC_A_UNIT, stage: "character", speakerId: FIXTURE_NPC_A });
    const plan = approve(
      planWith([npcUnit], [observation({ key: "obs_sus", fact: { factId: FACT_SUS, certainty: "suspected" } })]),
      world,
    );
    expect(collectDisclosures({
      plan,
      unit: npcUnit,
      output: characterOutput(FIXTURE_NPC_A, [{ factId: FACT_SUS, certainty: "known" }]),
    })).toEqual({ ok: false, code: "observation_certainty_invalid" });
  });

  it("输出 certainty 低于观察声明时允许（确定→存疑的降级表达）", () => {
    // 观察声明 known、说话人知识也是 known，但模型用「传闻/不确定」语气说出：
    // 这是合法的降级表达（spec「疑似事实只能用不确定表达」只禁止反向升级）。
    const world = knowledgeWorld();
    const npcUnit = unit({ key: FIXTURE_NPC_A_UNIT, stage: "character", speakerId: FIXTURE_NPC_A });
    const plan = approve(
      planWith([npcUnit], [observation({
        key: "obs_pub",
        fact: { factId: FACT_PUB, certainty: "known" },
      })]),
      world,
    );
    const result = collectDisclosures({
      plan,
      unit: npcUnit,
      output: characterOutput(FIXTURE_NPC_A, [{ factId: FACT_PUB, certainty: "suspected" }]),
    });
    expect(result.ok).toBe(true);
  });

  it("观察 certainty 超过说话人自身知识时拒绝（不得升级为确定）", () => {
    const world = withSuspectedKnowledge(knowledgeWorld(), FIXTURE_NPC_A, FACT_SUS);
    const npcUnit = unit({ key: FIXTURE_NPC_A_UNIT, stage: "character", speakerId: FIXTURE_NPC_A });
    const plan = approve(
      planWith([npcUnit], [observation({ key: "obs_sus", fact: { factId: FACT_SUS, certainty: "known" } })]),
      world,
    );
    expect(collectDisclosures({
      plan,
      unit: npcUnit,
      output: characterOutput(FIXTURE_NPC_A, [{ factId: FACT_SUS, certainty: "known" }]),
    })).toEqual({ ok: false, code: "observation_certainty_invalid" });
  });

  it("说话人对事实的披露是 secret 时拒绝（disclosure 不可用）", () => {
    const world = knowledgeWorld();
    const npcUnit = unit({ key: FIXTURE_NPC_A_UNIT, stage: "character", speakerId: FIXTURE_NPC_A });
    const plan = approve(
      planWith([npcUnit], [observation({ key: "obs_secret", fact: { factId: FACT_SECRET, certainty: "known" } })]),
      world,
    );
    expect(collectDisclosures({
      plan,
      unit: npcUnit,
      output: characterOutput(FIXTURE_NPC_A, [{ factId: FACT_SECRET, certainty: "known" }]),
    })).toEqual({ ok: false, code: "observation_disclosure_unavailable" });
  });

  it("说话人不存在时拒绝", () => {
    const world = knowledgeWorld();
    const ghostUnit = unit({ key: "character_ghost", stage: "character", speakerId: "npc_9" });
    const plan = approve(
      planWith([ghostUnit], [observation({
        key: "obs_ghost_speaker",
        source: { kind: "speech", speakerId: "npc_9" },
      })]),
      world,
    );
    expect(collectDisclosures({
      plan,
      unit: ghostUnit,
      output: characterOutput("npc_9", [{ factId: FACT_PUB, certainty: "known" }]),
    })).toEqual({ ok: false, code: "observation_speaker_unknown" });
  });

  it("受众不在场（未知实体或与说话人不同地点）时拒绝", () => {
    const world = knowledgeWorld();
    const npcUnit = unit({ key: FIXTURE_NPC_A_UNIT, stage: "character", speakerId: FIXTURE_NPC_A });
    const plan = approve(
      planWith([npcUnit], [observation({ key: "obs_far", audienceIds: ["npc_9"] })]),
      world,
    );
    expect(collectDisclosures({
      plan,
      unit: npcUnit,
      output: characterOutput(FIXTURE_NPC_A, [{ factId: FACT_PUB, certainty: "known" }]),
    })).toEqual({ ok: false, code: "observation_audience_absent" });

    const elsewhere = branchWorld({
      npcs: [npcEntry({ locationId: "loc_b" as NpcEntry["locationId"] })],
    });
    const movedPlan = approve(
      planWith([unit({ key: FIXTURE_NPC_A_UNIT, stage: "character", speakerId: FIXTURE_NPC_A })], [
        observation({ key: "obs_far" }),
      ]),
      elsewhere,
    );
    expect(collectDisclosures({
      plan: movedPlan,
      unit: movedPlan.units[0]!,
      output: characterOutput(FIXTURE_NPC_A, [{ factId: FACT_PUB, certainty: "known" }]),
    })).toEqual({ ok: false, code: "observation_audience_absent" });
  });

  it("witness 披露走旁白单元：事实必须真实存在于世界", () => {
    const world = knowledgeWorld();
    const narratorUnit = unit({ key: FIXTURE_NARRATION_UNIT, stage: "narration" });
    const plan = approve(
      planWith([narratorUnit], [observation({ key: "obs_seen", source: { kind: "witness" } })]),
      world,
    );
    const okResult = collectDisclosures({
      plan,
      unit: narratorUnit,
      output: narrationOutput([{ factId: FACT_PUB, certainty: "known" }]),
    });
    expect(okResult.ok).toBe(true);

    const ghostFactPlan = approve(
      planWith([narratorUnit], [observation({
        key: "obs_ghost_fact",
        source: { kind: "witness" },
        fact: { factId: "fact_ghost", certainty: "known" },
      })]),
      world,
    );
    expect(collectDisclosures({
      plan: ghostFactPlan,
      unit: narratorUnit,
      output: narrationOutput([{ factId: "fact_ghost", certainty: "known" }]),
    })).toEqual({ ok: false, code: "observation_fact_unknown" });
  });

  it("单元不在计划中或 stage 与输出不匹配时拒绝", () => {
    const world = knowledgeWorld();
    const plan = approve(planWith([unit({ key: FIXTURE_NARRATION_UNIT, stage: "narration" })], []), world);
    expect(collectDisclosures({
      plan,
      unit: unit({ key: "ghost", stage: "narration" }),
      output: narrationOutput([]),
    })).toEqual({ ok: false, code: "unknown_unit" });
    expect(collectDisclosures({
      plan,
      unit: plan.units[0]!,
      output: { stage: "choices", labels: [] },
    })).toEqual({ ok: false, code: "unit_output_stage_mismatch" });
  });
});
