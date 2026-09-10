import { describe, expect, it } from "vitest";
import { projectUnitContext } from "./perspectiveContext";
import { approvePlan } from "@/game/gameplay/rpg/narrativePlanning";
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
    const proposal: PlanProposal = { ...makeStagedPlan(), units };
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
