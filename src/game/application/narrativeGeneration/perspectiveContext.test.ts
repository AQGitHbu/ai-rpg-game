import { describe, expect, it } from "vitest";
import { projectUnitContext } from "./perspectiveContext";
import { approvePlan, approvePlanDecision } from "@/game/gameplay/rpg/narrativePlanning";
import { branchWorld, branchStory } from "@/game/gameplay/rpg/narrativePlanning/branchFixture.testutil";
import {
  makeStagedPlan,
  makeCharacterOutput,
  makeChoiceOutput,
  makeNarrationOutput,
  FIXTURE_NPC_A,
  FIXTURE_NPC_B,
  FIXTURE_NARRATION_UNIT,
  FIXTURE_NPC_A_UNIT,
  FIXTURE_NPC_B_UNIT,
  FIXTURE_CHOICE_UNIT,
  FIXTURE_CANDIDATE_ROUTE,
  FIXTURE_CANDIDATE_ALT,
} from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { asQuestId, asNpcId, asFactId } from "@/game/domain/worldEntity";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import type { Unit, UnitOutput } from "@/game/domain/narrativeUnit";
import type { NpcEntityRecord } from "@/game/domain/entity";
import type { WorldState } from "@/game/domain/worldState";
import type { NpcEntry, QuestEntry } from "@/game/domain/worldEntries";

// ---------------------------------------------------------------------------
// projectUnitContext：单角色/玩家视角的安全上下文投影。
// 秘密以唯一 sentinel 埋进各类自由文本，断言整个 DTO 不含它（fail-closed 投影）。
// ---------------------------------------------------------------------------

const SENTINEL = "SECRET_TRACKING_SEAL";
const FACT_PUB = "fact_pub";
const FACT_SECRET = "fact_secret";

function npcEntry(id: string, overrides: Partial<NpcEntry> = {}): NpcEntry {
  return {
    id: id as NpcEntry["id"],
    name: id === FIXTURE_NPC_A ? "老陈" : "船夫",
    role: "知情者",
    description: "守着渡口的人",
    locationId: "loc_a" as NpcEntry["locationId"],
    isCompanion: false,
    tags: [],
    met: true,
    memory: {
      npcId: id as NpcEntry["id"],
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

function personaWorld(): WorldState {
  return branchWorld({
    worldFacts: [
      { factId: asFactId(FACT_PUB), text: "渡口昨夜有灯火", source: "generated", discovered: true },
      { factId: asFactId(FACT_SECRET), text: `老陈私藏${SENTINEL}密信`, source: "generated", discovered: false },
    ],
    npcs: [
      npcEntry(FIXTURE_NPC_A, {
        description: `守着渡口的人 ${SENTINEL}`,
        memory: {
          npcId: FIXTURE_NPC_A as NpcEntry["id"],
          knownFactIds: [asFactId(FACT_PUB), asFactId(FACT_SECRET)],
          hiddenFactIds: [asFactId(FACT_SECRET)],
          interactionHistory: [],
          relationship: { affinity: 0 },
          emotion: "neutral",
          goals: [`暗中追查${SENTINEL}密信的下落`],
        },
      }),
      npcEntry(FIXTURE_NPC_B),
    ],
    quests: [{
      id: asQuestId("quest_0"),
      name: `渡口${SENTINEL}疑云`,
      description: "查清渡口昨夜发生的事",
      objectives: [{ kind: "talk_to_npc", npcId: asNpcId(FIXTURE_NPC_A) }],
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: [],
      kind: "main",
      stage: 1,
      status: "active",
    } satisfies QuestEntry],
  });
}

/** corruption case：把 sentinel 埋进 legacy 导入覆盖不到的锚点自由文本。 */
function withTamperedAnchors(world: WorldState): WorldState {
  const cloned = structuredClone(world) as WorldState;
  const record = cloned.entityStore.records.find(
    (candidate): candidate is NpcEntityRecord =>
      candidate.core.kind === "npc" && String(candidate.core.id) === FIXTURE_NPC_A,
  );
  if (record === undefined) throw new Error("fixture missing npc_0");
  // corruption case：测试内篡改权威组件，需绕开 Readonly 组件类型。
  const mutable = record as unknown as {
    identity: { anchors: NpcEntityRecord["identity"]["anchors"] };
    dynamicState: NpcEntityRecord["dynamicState"];
  };
  mutable.identity.anchors = {
    ...record.identity.anchors,
    taboos: [`不得谈论${SENTINEL}`],
  };
  mutable.dynamicState = {
    ...record.dynamicState,
    goals: record.dynamicState.goals.map((goal, index) =>
      index === 0 ? { ...goal, reason: SENTINEL } : goal),
  };
  return cloned;
}

function approvedPlanOf(world: WorldState, proposal: PlanProposal = makeStagedPlan()) {
  if (proposal.decision?.kind === "ordinary") {
    const options = proposal.decision.options;
    proposal = { ...proposal, decision: { ...proposal.decision, options: [
      { ...options[0], target: { kind: "visit_location", locationId: "loc_b" } },
      { ...options[1], target: { kind: "visit_location", locationId: "loc_c" } },
    ] } };
  }
  const result = approvePlan({ kind: "decision", proposal, world, story: branchStory() });
  if (!result.ok) throw new Error(`fixture plan rejected: ${result.code}`);
  return result.value;
}

function approvedOutputs(): ReadonlyMap<string, UnitOutput> {
  return new Map<string, UnitOutput>([
    [FIXTURE_NARRATION_UNIT, makeNarrationOutput()],
    [FIXTURE_NPC_A_UNIT, makeCharacterOutput(FIXTURE_NPC_A)],
    [FIXTURE_NPC_B_UNIT, makeCharacterOutput(FIXTURE_NPC_B)],
    [FIXTURE_CHOICE_UNIT, makeChoiceOutput()],
  ]);
}

function contextOf(plan: ReturnType<typeof approvedPlanOf>, key: string) {
  const unit = plan.units.find((candidate) => candidate.key === key);
  if (unit === undefined) throw new Error(`fixture missing unit ${key}`);
  return projectUnitContext({ plan, unit, approved: approvedOutputs() });
}

describe("projectUnitContext", () => {
  it("具体意图与先求证条件保真：合法事实不许可任意规划正文", () => {
    const base = makeStagedPlan();
    if (base.decision?.kind !== "ordinary") throw Error("decision");
    const proposal: PlanProposal = { ...base,
      units: base.units.map(unit => unit.stage === "narration" ? { ...unit,
        task: { intent: "describe", focusFactIds: [FACT_PUB], prerequisiteFactIds: [] } } : unit),
      decision: { ...base.decision, options: [
        { ...base.decision.options[0], dialogueAct: "offer", publicIntent: { text: SENTINEL, facts: [], evidence: [], beatIds: [] },
          task: { intent: "offer", focusFactIds: [FACT_PUB], prerequisiteFactIds: [FACT_PUB] } },
        { ...base.decision.options[1], dialogueAct: "refuse",
          task: { intent: "refuse", focusFactIds: [FACT_PUB], prerequisiteFactIds: [] } },
      ] } };
    const plan = approvedPlanOf(personaWorld(), proposal);
    const narration = contextOf(plan, FIXTURE_NARRATION_UNIT);
    expect(narration.ok && narration.value.taskInstruction).toContain("渡口");
    const choices = contextOf(plan, FIXTURE_CHOICE_UNIT);
    if (!choices.ok) throw Error(choices.code);
    expect(choices.value.options[0]!.publicIntent.text).toContain("先要求对方核实");
    expect(choices.value.options[1]!.publicIntent.text).toContain("明确拒绝");
    expect(JSON.stringify(choices)).not.toContain(SENTINEL);
  });

  it("旁白与角色都不能拿到未来步骤或尚未发生的表演动作", () => {
    const base = makeStagedPlan();
    const proposal: PlanProposal = { ...base, actions: [
      { key: "future_scene", actorId: FIXTURE_NPC_A, point: { stepKey: "elsewhere", order: 0 },
        kind: "look", objectId: null, audienceIds: ["player_0"] },
      { key: "future_order", actorId: FIXTURE_NPC_A, point: { stepKey: "current", order: 99 },
        kind: "look", objectId: null, audienceIds: ["player_0"] },
    ] };
    const plan = approvedPlanOf(personaWorld(), proposal);
    for (const key of [FIXTURE_NARRATION_UNIT, FIXTURE_NPC_A_UNIT]) {
      const result = contextOf(plan, key);
      expect(result.ok && result.value.allowedActions).toEqual([]);
    }
  });

  it("先求证条件也不能携带秘密，不能静默删条件冒充原意图", () => {
    const base = makeStagedPlan();
    const plan = approvedPlanOf(personaWorld(), { ...base, units: base.units.map(unit =>
      unit.stage === "narration" ? { ...unit, task: { intent: "describe", focusFactIds: [FACT_PUB],
        prerequisiteFactIds: [FACT_SECRET] } } : unit) });
    expect(contextOf(plan, FIXTURE_NARRATION_UNIT)).toMatchObject({ ok: false, code: "beat_authority_conflict" });
  });

  it("规划意图和节拍即使不标注秘密引用，也不能把正文传给表达器", () => {
    const base = makeStagedPlan();
    const proposal: PlanProposal = {
      ...base,
      decision: base.decision?.kind === "ordinary" ? {
        ...base.decision,
        options: [
          { ...base.decision.options[0], publicIntent: { text: SENTINEL, facts: [], evidence: [], beatIds: [] } },
          { ...base.decision.options[1], publicIntent: { text: SENTINEL, facts: [], evidence: [], beatIds: [] } },
        ],
      } : base.decision,
      units: base.units.map(unit => ({ ...unit, requiredBeats: [{
        beatId: "safe_beat", kind: "atmosphere", factIds: [], evidence: [], instruction: SENTINEL,
      }] })),
    };
    const plan = approvedPlanOf(personaWorld(), proposal);
    for (const unit of plan.units) {
      const result = contextOf(plan, unit.key);
      expect(result.ok).toBe(true);
      if (result.ok) expect(JSON.stringify(result.value)).not.toContain(SENTINEL);
    }
  });

  it("非 legacy 人格锚点也不是公开事实证明", () => {
    const world = personaWorld();
    const record = world.entityStore.records.find(r => r.core.kind === "npc") as NpcEntityRecord;
    Object.assign(record.identity.anchors, { selfConcept: SENTINEL, speechStyle: SENTINEL });
    const result = contextOf(approvedPlanOf(world), FIXTURE_NPC_A_UNIT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.stringify(result.value)).not.toContain(SENTINEL);
  });
  it("角色上下文不含秘密：知识、描述、目标、锚点与任务名中的 sentinel 全部不可见", () => {
    const plan = approvedPlanOf(withTamperedAnchors(personaWorld()));
    const result = contextOf(plan, FIXTURE_NPC_A_UNIT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const context = result.value;
    expect(JSON.stringify(context)).not.toContain(SENTINEL);
    // 人格保留公开身份与当前情绪，不被过滤成空壳
    expect(context.persona).not.toBeNull();
    if (context.persona === null) return;
    expect(context.persona.publicName).toBe("老陈");
    expect(context.persona.publicRole.text).toBe("知情者");
    expect(context.persona.emotion).toBe("neutral");
    expect(typeof context.persona.relationshipTier).toBe("string");
    expect(context.persona.behavior).toContain("withhold_source");
    // 可说事实 = 说话人可知 ∩ 对受众可披露；discovered 全集不是 NPC 知识
    expect(context.visibleFacts.map((fact) => fact.id)).toContain(FACT_PUB);
    expect(context.visibleFacts.map((fact) => fact.id)).not.toContain(FACT_SECRET);
    expect(context.unit.speakerId).toBe(FIXTURE_NPC_A);
  });

  it("旁白上下文是玩家视角：persona 为空，可见事实来自现场观察与玩家已知", () => {
    const plan = approvedPlanOf(personaWorld());
    const result = contextOf(plan, FIXTURE_NARRATION_UNIT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const context = result.value;
    expect(JSON.stringify(context)).not.toContain(SENTINEL);
    expect(context.persona).toBeNull();
    expect(context.visibleFacts.map((fact) => fact.id)).toContain(FACT_PUB);
    expect(context.visibleFacts.map((fact) => fact.id)).not.toContain(FACT_SECRET);
    expect(context.choiceKind).toBeNull();
    expect(context.options).toEqual([]);
    expect(context.priorText).toEqual([]);
  });

  it("选项上下文从 choiceExpression 投影：玩家视角 + 已批准候选意图", () => {
    const plan = approvedPlanOf(personaWorld());
    const result = contextOf(plan, FIXTURE_CHOICE_UNIT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const context = result.value;
    expect(JSON.stringify(context)).not.toContain(SENTINEL);
    expect(context.persona).toBeNull();
    expect(context.choiceKind).toBe("ordinary");
    expect(context.options.map((option) => option.candidateId))
      .toEqual([FIXTURE_CANDIDATE_ROUTE, FIXTURE_CANDIDATE_ALT]);
    expect(context.options.every((option) => option.publicIntent.text.length > 0)).toBe(true);
    // 选项前文 = 前序已批准可见表达（旁白 + 两个 NPC 台词），按 ScenePoint 顺序
    expect(context.priorText).toHaveLength(3);
  });

  it("未在场的 NPC 拿不到玩家私聊：priorText 为空且不含他人台词", () => {
    const plan = approvedPlanOf(personaWorld());
    const result = contextOf(plan, FIXTURE_NPC_B_UNIT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.priorText).toEqual([]);
    expect(JSON.stringify(result.value)).not.toContain("先坐吧，路上不好走。");
  });

  it("新增 DAG 依赖不能把玩家私聊原文授权给其他 NPC", () => {
    const base = makeStagedPlan();
    const plan = approvedPlanOf(personaWorld(), { ...base, units: base.units.map(unit =>
      unit.key === FIXTURE_NPC_B_UNIT ? { ...unit, dependencies: [FIXTURE_NPC_A_UNIT] } : unit) });
    const output = makeCharacterOutput(FIXTURE_NPC_A);
    const approved = new Map<string, UnitOutput>([[FIXTURE_NARRATION_UNIT, makeNarrationOutput()], [FIXTURE_NPC_A_UNIT, {
      ...output, parts: [{ text: SENTINEL, facts: [], evidence: [], beatIds: [] }],
    }]]);
    const unit = plan.units.find(unit => unit.key === FIXTURE_NPC_B_UNIT)!;
    const result = projectUnitContext({ plan, unit, approved });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("候选经过规范化后任务仍须与最终对白意图一致", () => {
    const base = approvedPlanOf(personaWorld());
    if (base.choiceExpression?.kind !== "ordinary") throw Error("ordinary");
    const [left, right] = base.choiceExpression.options;
    const plan = { ...base, choiceExpression: { ...base.choiceExpression, options: [
      { ...left, dialogueAct: "support" as const, task: { intent: "refuse" as const, focusFactIds: [], prerequisiteFactIds: [] } }, right,
    ] as const } };
    expect(approvePlanDecision(plan)).toMatchObject({ ok: false, code: "plan_task_intent_mismatch" });
    expect(contextOf(plan, FIXTURE_CHOICE_UNIT)).toMatchObject({ ok: false, code: "plan_task_intent_mismatch" });
  });

  it("终幕表达投影 ending 候选，不需要 RouteTarget", () => {
    const proposal: PlanProposal = {
      ...makeStagedPlan(),
      decision: {
        kind: "ending",
        point: { stepKey: "current", order: 4 },
        npcId: FIXTURE_NPC_A,
        options: [
          { candidateId: "trust", dialogueAct: "support", publicIntent: { text: "我信你。", facts: [], evidence: [], beatIds: [] } },
          { candidateId: "doubt", dialogueAct: "challenge", publicIntent: { text: "我不信。", facts: [], evidence: [], beatIds: [] } },
        ],
      },
    };
    const plan = approvedPlanOf(personaWorld(), proposal);
    const result = contextOf(plan, FIXTURE_CHOICE_UNIT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.choiceKind).toBe("ending");
    expect(result.value.options.map((option) => [option.candidateId, option.dialogueAct]))
      .toEqual([["trust", "support"], ["doubt", "challenge"]]);
  });

  it("重建 Unit：taskFactIds 与观察引用只保留授权后的子集", () => {
    const world = personaWorld();
    const proposal: PlanProposal = {
      ...makeStagedPlan(),
      units: makeStagedPlan().units.map((unit) =>
        unit.key === FIXTURE_NPC_A_UNIT
          ? { ...unit, taskFactIds: [FACT_PUB, FACT_SECRET] }
          : unit),
    };
    const plan = approvedPlanOf(world, proposal);
    const result = contextOf(plan, FIXTURE_NPC_A_UNIT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unit.taskFactIds).toEqual([FACT_PUB]);
  });

  it("未知说话人与未知单元 fail-closed", () => {
    const world = personaWorld();
    const units: readonly Unit[] = [
      { key: FIXTURE_NARRATION_UNIT, stage: "narration", point: { stepKey: "current", order: 1 }, speakerId: null, dependencies: [], taskFactIds: [], requiredObservationKeys: [], requiredBeats: [] },
      { key: "character_npc_9", stage: "character", point: { stepKey: "current", order: 2 }, speakerId: "npc_9", dependencies: [], taskFactIds: [], requiredObservationKeys: [], requiredBeats: [] },
      { key: FIXTURE_CHOICE_UNIT, stage: "choices", point: { stepKey: "current", order: 3 }, speakerId: null, dependencies: [FIXTURE_NARRATION_UNIT, "character_npc_9"], taskFactIds: [], requiredObservationKeys: [], requiredBeats: [] },
    ];
    const proposal: PlanProposal = { ...makeStagedPlan(), units,
      decision: { ...makeStagedPlan().decision!, point: { stepKey: "current", order: 3 } } };
    const plan = approvedPlanOf(world, proposal);
    const ghostUnit = plan.units.find((candidate) => candidate.key === "character_npc_9");
    if (ghostUnit === undefined) throw new Error("fixture missing ghost unit");
    expect(projectUnitContext({ plan, unit: ghostUnit, approved: approvedOutputs() }))
      .toEqual({ ok: false, code: "unknown_speaker" });
    expect(projectUnitContext({
      plan,
      unit: { ...ghostUnit, key: "ghost" },
      approved: approvedOutputs(),
    })).toEqual({ ok: false, code: "unknown_unit" });
  });
});
