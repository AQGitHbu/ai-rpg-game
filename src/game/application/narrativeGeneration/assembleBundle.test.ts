// 表达装配（Plan 2026-09-09 / Task 6 Step 4）。
//
// assembleBundle 按 ScenePoint 顺序把已批准单元输出装配成整包提案：
// 旁白→segments、角色→npcLine（逐 speaker 归属）、选项→choices；
// 缺单元/stage 不符/秘密 sentinel 泄漏拒绝；观察引用保留条件证据元数据。

import { describe, expect, it } from "vitest";
import { assembleBundle } from "./assembleBundle";
import { projectUnitContext } from "./perspectiveContext";
import { approveUnit } from "./approveUnit";
import { approvePlan } from "@/game/gameplay/rpg/narrativePlanning";
import {
  branchWorld,
  branchStory,
} from "@/game/gameplay/rpg/narrativePlanning/branchFixture.testutil";
import {
  makeStagedPlan,
  makeCharacterOutput,
  makeChoiceOutput,
  makeNarrationOutput,
  FIXTURE_NARRATION_UNIT,
  FIXTURE_NPC_A_UNIT,
  FIXTURE_NPC_B_UNIT,
  FIXTURE_CHOICE_UNIT,
  FIXTURE_NPC_A,
  FIXTURE_NPC_B,
  FIXTURE_CANDIDATE_ROUTE,
  FIXTURE_CANDIDATE_ALT,
} from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { asEndingId, asLocationId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { LEGACY_IMPORT_REASON_KEY } from "@/game/domain/entity";
import type { Observation } from "@/game/domain/narrativeObservation";
import { parsePlanProposal, type PlanProposal } from "@/game/domain/narrativePlan";
import type { UnitOutput } from "@/game/domain/narrativeUnit";

/** 与单元归属规则匹配的观察源：同一 stepKey、order 先于单元、受众含说话人。 */
function observation(
  key: string,
  speakerId: string | null,
  order = 0,
): Observation {
  return {
    key,
    point: { stepKey: "current", order },
    audienceIds: speakerId === null
      ? [String(PLAYER_ENTITY_ID)]
      : [speakerId, String(PLAYER_ENTITY_ID)],
    fact: { factId: "fact_ctx", certainty: "known" },
    source: speakerId === null ? { kind: "witness" } : { kind: "speech", speakerId },
  };
}

function approvedPlan(proposalOverrides: Partial<PlanProposal> = {}) {
  const result = approvePlan({
    kind: "decision",
    proposal: { ...makeStagedPlan(), ...proposalOverrides },
    world: branchWorld(),
    story: branchStory(),
  });
  if (!result.ok) throw new Error(`fixture plan rejected: ${result.code}`);
  return result.value;
}

function fullApprovedMap(overrides: {
  narration?: UnitOutput;
  npcA?: UnitOutput;
  npcB?: UnitOutput;
  choice?: UnitOutput;
} = {}): Map<string, UnitOutput> {
  const map = new Map<string, UnitOutput>();
  map.set(FIXTURE_NARRATION_UNIT, overrides.narration ?? makeNarrationOutput());
  map.set(FIXTURE_NPC_A_UNIT, overrides.npcA ?? makeCharacterOutput(FIXTURE_NPC_A));
  map.set(FIXTURE_NPC_B_UNIT, overrides.npcB ?? makeCharacterOutput(FIXTURE_NPC_B));
  map.set(FIXTURE_CHOICE_UNIT, overrides.choice ?? makeChoiceOutput());
  return map;
}

describe("assembleBundle", () => {
  it("真实 parser 的 decision=null 终幕经规则派生、选项表达与装配闭环", () => {
    const parsed = parsePlanProposal({ ...makeStagedPlan(), decision: null, terminal: { kind: "ending" } });
    if (!parsed.ok) throw Error(parsed.code);
    const world = { ...branchWorld(), endings: [
      { id: asEndingId("ending_trust"), name: "信任", description: "未发生的结果", requirements: [] },
      { id: asEndingId("ending_doubt"), name: "质疑", description: "另一结果", requirements: [] },
    ] };
    const result = approvePlan({ kind: "decision", proposal: parsed.value, world,
      story: { ...branchStory(), endingAllowed: true } });
    if (!result.ok) throw Error(result.code);
    expect(result.value.proposal.decision).toBeNull();
    expect(result.value.choiceExpression?.kind).toBe("ending");
    const choice: UnitOutput = { stage: "choices", labels: [
      { candidateId: "trust", label: "我信你，这件事我们一起查到底。" },
      { candidateId: "doubt", label: "证据还不够，我要亲自核对你的说法。" },
    ] };
    const outputs = fullApprovedMap({ choice });
    const unit = result.value.units.find(unit => unit.stage === "choices")!;
    const context = projectUnitContext({ plan: result.value, unit, approved: outputs });
    if (!context.ok) throw Error(context.code);
    expect(JSON.stringify(context.value)).not.toContain("未发生的结果");
    expect(approveUnit({ unit, context: context.value, output: choice }).ok).toBe(true);
    const assembled = assembleBundle({ plan: result.value, approved: outputs });
    if (!assembled.ok) throw Error(assembled.code);
    expect(assembled.value.currentScene.choices).toEqual([]);
    expect(assembled.value.endingLabels).toEqual({ trust: choice.labels[0]!.label, doubt: choice.labels[1]!.label });
    expect(approvePlan({ kind: "decision", proposal: parsed.value, world, story: branchStory() }))
      .toEqual({ ok: false, code: "plan_ending_not_ready" });
  });

  it("多个无强制节拍的获批旁白句段合并为氛围段", () => {
    const output = makeNarrationOutput();
    const result = assembleBundle({ plan: approvedPlan(), approved: fullApprovedMap({ narration: {
      ...output, parts: [...output.parts, { text: "门外响起脚步声。", facts: [], evidence: [], beatIds: [] }],
    } }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currentScene.segments).toHaveLength(1);
    expect(result.value.currentScene.segments[0]?.text).toContain("门外响起脚步声。");
  });
  it("未来决策不能被提升为当前场景而提前剧透", () => {
    const base = makeStagedPlan();
    if (base.decision === null) throw new Error("missing decision");
    const plan = approvedPlan({
      units: base.units.map(unit => unit.stage === "choices"
        ? { ...unit, point: { stepKey: "future", order: 4 } } : unit),
      decision: { ...base.decision, point: { stepKey: "future", order: 4 } },
      steps: [{ key: "future", trigger: { kind: "move", locationId: asLocationId("loc_b") }, next: [] }],
      terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: "future" } },
    });
    const result = assembleBundle({ plan, approved: fullApprovedMap() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currentScene.choices).toEqual([]);
    expect(result.value.currentScene.npcLine?.npcId).toBe(FIXTURE_NPC_A);
    expect(result.value.continuationScenes[0]?.scene.choices).toHaveLength(2);
  });
  it("按 ScenePoint 顺序装配 currentScene", () => {
    const plan = approvedPlan();
    const result = assembleBundle({ plan, approved: fullApprovedMap() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { currentScene, terminal } = result.value;
    expect(terminal).toEqual({ kind: "next_decision", target: { kind: "current_scene" } });
    // 旁白 parts → segments（无节拍要求时按 atmosphere 兜底）
    expect(currentScene.segments.length).toBe(1);
    expect(currentScene.segments[0]?.text).toContain("风从门缝");
    // 每句直接对白只归对应 NPC
    expect(currentScene.npcLine).not.toBeNull();
    expect(currentScene.npcLine?.npcId).toBe(FIXTURE_NPC_A);
    expect(currentScene.npcLine?.text).toContain("先坐吧");
    // 旁白不复制对白
    expect(currentScene.segments[0]?.text).not.toContain("先坐吧");
    // 选项按候选映射
    expect(currentScene.choices).toEqual([
      { candidateId: FIXTURE_CANDIDATE_ROUTE, label: "我跟你去北岭看看。" },
      { candidateId: FIXTURE_CANDIDATE_ALT, label: "我不替你送信，我要当面问清楚。" },
    ]);
  });

  it("后续 stepKey 的单元进入 continuationScenes", () => {
    const plan = approvedPlan({
      units: makeStagedPlan().units.map((u) =>
        u.key === FIXTURE_NPC_B_UNIT ? { ...u, point: { stepKey: "arrive", order: 1 } }
          : u.stage === "choices" ? { ...u, point: { stepKey: "arrive", order: 4 } } : u),
      decision: { ...makeStagedPlan().decision!, point: { stepKey: "arrive", order: 4 } },
      steps: [{ key: "arrive", trigger: { kind: "move", locationId: asLocationId("loc_b") }, next: [] }],
      terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: "arrive" } },
    });
    const npcB: UnitOutput = {
      stage: "character", speakerId: FIXTURE_NPC_B,
      parts: [{ text: "义庄的门是虚掩的。", facts: [], evidence: [], beatIds: [] }],
      emotion: "guarded", actions: [], answeredBeatIds: [],
    };
    const result = assembleBundle({
      plan,
      approved: fullApprovedMap({ npcB }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.continuationScenes).toHaveLength(1);
    const step = result.value.continuationScenes[0];
    expect(step?.stepKey).toBe("arrive");
    expect(step?.scene.npcLine?.npcId).toBe(FIXTURE_NPC_B);
    expect(step?.scene.npcLine?.text).toContain("虚掩");
    // currentScene 不含 npc_1 的对白
    expect(result.value.currentScene.npcLine?.npcId).toBe(FIXTURE_NPC_A);
  });

  it("句段 fact 与观察引用保持逐 speaker 来源", () => {
    const plan = approvedPlan({
      observations: [observation("obs_speech_1", FIXTURE_NPC_A)],
      units: makeStagedPlan().units.map((u) =>
        u.key === FIXTURE_NPC_A_UNIT
          ? {
            ...u,
            requiredObservationKeys: ["obs_speech_1"],
            taskFactIds: ["fact_1"],
          }
          : u),
    });
    const npcA: UnitOutput = {
      stage: "character", speakerId: FIXTURE_NPC_A,
      parts: [{
        text: "货就在废窑。",
        facts: [{ factId: "fact_1", certainty: "known" }],
        evidence: [{ kind: "committed", eventId: "evt_1" }],
        beatIds: [],
      }],
      emotion: "neutral", actions: [], answeredBeatIds: [],
    };
    const result = assembleBundle({ plan, approved: fullApprovedMap({ npcA }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 逐 speaker 传递：usedFactIds / usedEventIds 只来自该 NPC 的句段
    expect(result.value.currentScene.npcLine?.usedFactIds).toEqual(["fact_1"]);
    expect(result.value.currentScene.npcLine?.usedEventIds).toEqual(["evt_1"]);
    // 旁白 segments 不复制该 fact
    expect(result.value.currentScene.segments.every((seg) => !seg.text.includes("废窑"))).toBe(true);
  });

  it("观察要求转为条件证据元数据（句段索引、observationKey、audienceId）", () => {
    const plan = approvedPlan({
      observations: [
        observation("obs_witness_1", null),
        observation("obs_speech_1", FIXTURE_NPC_A),
      ],
      units: makeStagedPlan().units.map((u) => {
        if (u.key === FIXTURE_NARRATION_UNIT) {
          return { ...u, requiredObservationKeys: ["obs_witness_1"] };
        }
        if (u.key === FIXTURE_NPC_A_UNIT) {
          return { ...u, requiredObservationKeys: ["obs_speech_1"] };
        }
        return u;
      }),
    });
    const narration = makeNarrationOutput();
    const npcA = makeCharacterOutput(FIXTURE_NPC_A);
    const result = assembleBundle({ plan, approved: fullApprovedMap({
      narration: { ...narration, parts: narration.parts.map(part => ({ ...part, facts: [{ factId: "fact_ctx", certainty: "known" }] })) },
      npcA: { ...npcA, parts: npcA.parts.map(part => ({ ...part, facts: [{ factId: "fact_ctx", certainty: "known" }] })) },
    }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.value.currentScene.conditionalEvidence ?? [];
    expect(evidence).toContainEqual({
      partIndex: 0, observationKey: "obs_witness_1", audienceId: String(PLAYER_ENTITY_ID),
    });
    // npcLine 的条件证据用 partIndex=-1 标记，受众是说话 NPC
    expect(evidence).toContainEqual({
      partIndex: -1, observationKey: "obs_speech_1", audienceId: FIXTURE_NPC_A,
    });
  });

  it("缺必要单元拒绝", () => {
    const plan = approvedPlan();
    const map = fullApprovedMap();
    map.delete(FIXTURE_NPC_B_UNIT);
    expect(assembleBundle({ plan, approved: map }))
      .toEqual({ ok: false, code: "assemble_unit_missing" });
  });

  it("approved 映射中 stage 不符拒绝", () => {
    const plan = approvedPlan();
    const map = fullApprovedMap();
    map.set(FIXTURE_NPC_A_UNIT, makeNarrationOutput());
    expect(assembleBundle({ plan, approved: map }))
      .toEqual({ ok: false, code: "assemble_unit_stage_mismatch" });
  });

  it("秘密 sentinel 泄漏拒绝且不回显", () => {
    const plan = approvedPlan();
    const narration: UnitOutput = {
      stage: "narration",
      parts: [{ text: `线索指向${LEGACY_IMPORT_REASON_KEY}。`, facts: [], evidence: [], beatIds: [] }],
      actionKeys: [],
    };
    expect(assembleBundle({ plan, approved: fullApprovedMap({ narration }) }))
      .toEqual({ ok: false, code: "assemble_secret_leak" });
  });

  it("旁白句段必须携带已知节拍", () => {
    const plan = approvedPlan({
      units: makeStagedPlan().units.map((u) =>
        u.key === FIXTURE_NARRATION_UNIT
          ? { ...u, requiredBeats: [{ beatId: "beat_open", kind: "atmosphere" as const, factIds: [], evidence: [], instruction: "氛围" }] }
          : u),
    });
    const narration: UnitOutput = {
      stage: "narration",
      parts: [{ text: "风停了。", facts: [], evidence: [], beatIds: ["beat_ghost"] }],
      actionKeys: [],
    };
    expect(assembleBundle({ plan, approved: fullApprovedMap({ narration }) }))
      .toEqual({ ok: false, code: "assemble_segment_beat_unknown" });
  });

  it("规划素材不进入展示字段：不读 proposal.opening", () => {
    const plan = approvedPlan();
    // proposal 不携带 opening（decision 输入被禁止携带）；即使模型在别处
    // 夹带 prologue，装配只消费单元输出，无法把规划素材放进展示字段。
    const result = assembleBundle({ plan, approved: fullApprovedMap() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const allText = JSON.stringify(result.value);
    expect(allText).not.toContain("prologue");
  });
});
