import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import { asFactId } from "@/game/domain/worldEntity";
import { expect, it } from "vitest";
import { projectUnitContext } from "./perspectiveContext";
import { approveUnit } from "./approveUnit";
import { asQuestId } from "@/game/domain/worldEntity";
import { narrationLayoutOf } from "./perspectiveContext";
import { buildPlanningPrompt, PLANNING_CONTENT_RULES } from "../server/ai/staged/planningPrompt";
import { approvePlanningContext } from "./approvePlanningContext";
import { createPendingDecisionRecord, makeDecisionPlan, FIXTURE_DECISION_NPC } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import type { PlanningContext } from "./stageSource";

function context(): PlanningContext {
  const record = createPendingDecisionRecord();
  const narrative = record.storyState.narrative;
  if (narrative.status !== "provider_pending") throw Error("fixture not pending");
  return { kind: "decision", world: record.worldState, story: record.storyState, job: narrative.job };
}

it.each(["npc_only", "absent", "future_only", "duplicate", "wrong_kind", "extra"] as const)(
  "必选节拍必须由当前旁白唯一承接，表达请求前拒绝：%s", mode => {
    const input = context();
    if (input.kind !== "decision") throw Error("decision");
    const beat = { beatId: "quest_advanced_1", kind: "quest_advanced" as const,
      factIds: [], evidence: [], instruction: "承接任务推进" };
    const base = makeDecisionPlan();
    const narration = base.units[0]!;
    const units = base.units.map(unit => ({ ...unit, requiredBeats:
      mode === "npc_only" && unit.stage === "character" ? [beat]
        : (mode === "duplicate" || mode === "wrong_kind") && unit.stage === "narration"
          ? [{ ...beat, kind: mode === "wrong_kind" ? "atmosphere" as const : beat.kind }] : [] }));
    if (mode === "extra") units[0] = { ...units[0]!, requiredBeats: [beat, { ...beat, beatId: "invented" }] };
    if (mode === "duplicate") units.push({ ...narration, key: "extra_narration",
      point: { stepKey: "current", order: 0 }, requiredBeats: [beat] });
    if (mode === "future_only") units.push({ ...narration, key: "future_narration",
      point: { stepKey: "future", order: 0 }, requiredBeats: [beat] });
    const result = approvePlanningContext({ ...input, job: { ...input.job,
      mandatoryBeats: [{ beatId: beat.beatId, kind: beat.kind, subjectIds: [], instruction: beat.instruction }],
    } }, { ...base, units });
    expect(result).toMatchObject({ ok: false, code: "plan_mandatory_beat_mismatch" });
    if (!result.ok && mode === "extra") expect(JSON.parse(result.detail!).unexpectedNarrationBeatIds).toEqual(["invented"]);
    if (!result.ok) expect(JSON.parse(result.detail!).requiredNarrationBeats).toEqual([
      { beatId: beat.beatId, kind: beat.kind, stepKey: "current", stage: "narration" },
    ]);
  });

it("多旁白单元只允许最后一个承接独立氛围，不要求新增场景", () => {
  const input = context();
  if (input.kind !== "decision") throw Error("decision");
  const base = makeDecisionPlan();
  const mandatory = ["a", "b"].map(beatId => ({ beatId, kind: "quest_progress" as const,
    subjectIds: [], instruction: "任务进展" }));
  const beats = mandatory.map(({ beatId, kind, instruction }) => ({ beatId, kind, instruction, factIds: [], evidence: [] }));
  const extra = { ...base.units[0]!, key: "early", point: { stepKey: "current", order: 0 }, requiredBeats: [beats[0]!] };
  const proposal = { ...base, units: [extra, ...base.units.map(unit => unit.stage === "narration"
    ? { ...unit, requiredBeats: [beats[1]!] } : unit)] };
  const scoped = { ...input, job: { ...input.job, mandatoryBeats: mandatory } };
  const result = approvePlanningContext(scoped, proposal);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(narrationLayoutOf(result.value, extra)).toEqual({ allowAtmosphere: false });
  expect(narrationLayoutOf(result.value, base.units[0]!)).toEqual({ allowAtmosphere: true });
  const bad = { ...proposal, units: proposal.units.map(unit => unit.key === "early"
    ? { ...unit, requiredBeats: [...unit.requiredBeats,
      { beatId: "atmosphere", kind: "atmosphere" as const, instruction: "氛围", factIds: [], evidence: [] }] } : unit) };
  expect(approvePlanningContext(scoped, bad)).toMatchObject({ ok: false, code: "plan_mandatory_beat_mismatch" });
});

it("无必选节拍的普通回应也不能新增当前节拍，开局契约不受影响", () => {
  const base = makeDecisionPlan();
  expect(approvePlanningContext(context(), { ...base, units: base.units.map(unit => unit.stage === "narration"
    ? { ...unit, requiredBeats: [{ beatId: "player_utterance", kind: "player_utterance",
      factIds: [], evidence: [], instruction: "自造节拍" }] } : unit) }))
    .toMatchObject({ ok: false, code: "plan_mandatory_beat_mismatch" });
});

it("同一场景同一 NPC 的回应必须合在一个 character 单元", () => {
  const base = makeDecisionPlan();
  const character = base.units.find(unit => unit.stage === "character")!;
  const split = { ...character, key: `${character.key}_split`,
    point: { ...character.point, order: character.point.order + 1 } };
  const result = approvePlanningContext(context(), { ...base, units: [...base.units, split] });
  expect(result).toMatchObject({ ok: false, code: "plan_character_response_split" });
  if (!result.ok) expect(JSON.parse(result.detail!).repeatedResponseUnits).toEqual([split.key]);
});

it("旁白与 NPC 可用不同表达共同承接，原提案和事实权限不改写", () => {
  const input = context();
  if (input.kind !== "decision") throw Error("decision");
  const base = makeDecisionPlan();
  const beat = { beatId: "quest_advanced_1", kind: "quest_advanced" as const,
    factIds: [], evidence: [], instruction: "承接任务推进" };
  const proposal = { ...base, units: base.units.map(unit => unit.stage === "choices" ? unit
    : { ...unit, requiredBeats: [beat] }) };
  const scopedInput = { ...input, job: { ...input.job,
    mandatoryBeats: [{ beatId: beat.beatId, kind: beat.kind, subjectIds: [], instruction: beat.instruction }],
  } };
  const prompt = buildPlanningPrompt(scopedInput);
  expect(prompt).toContain('stepKey="current" 的 narration');
  expect(prompt).toContain('允许的 beatId 全集：["quest_advanced_1","atmosphere"]');
  expect(prompt).toContain("没有该节拍不表示 NPC 不回应玩家");
  expect(prompt).toContain("NPC 可以另行回应同一个节拍");
  expect(prompt).toContain("不替代旁白");
  expect(prompt).not.toContain("每个 beatId 必须被某个单元");
  const result = approvePlanningContext(scopedInput, proposal);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.proposal).toBe(proposal);
});

it("真实失败结构：将 current 塞进未来图时在表达调用前拒绝", () => {
  const input = context();
  if (input.kind !== "decision") throw Error("fixture context");
  expect(approvePlanningContext(input, { ...makeDecisionPlan(), steps: [
    { key: "current", trigger: { kind: "move", locationId: input.world.currentLocationId }, next: [] },
  ] })).toMatchObject({ ok: false, code: "plan_scene_graph_mismatch", detail: expect.stringContaining('"steps"') });
});

it("合法 current 决策先审批实质分支并保留原提案", () => {
  const proposal = makeDecisionPlan();
  const result = approvePlanningContext(context(), proposal);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.proposal).toBe(proposal);
  if (result.value.choiceExpression?.kind !== "ordinary") throw Error("ordinary decision expected");
  expect(result.value.choiceExpression.options.map(option => option.target))
    .toEqual([{ kind: "visit_location", locationId: "loc_dyn_0" }, { kind: "visit_location", locationId: "loc_dyn_1" }]);
});

it("表达调用前拒绝把 witness observation 分配给 character 单元", () => {
  const base = makeDecisionPlan();
  const character = base.units.find((unit) => unit.stage === "character");
  if (character === undefined) throw new Error("character fixture missing");
  const proposal = {
    ...base,
    observations: [{
      key: "obs_witness",
      point: { stepKey: "current", order: 1 },
      audienceIds: ["player_0", FIXTURE_DECISION_NPC],
      fact: { factId: "fact_routes", certainty: "known" as const },
      source: { kind: "witness" as const },
    }],
    units: base.units.map((unit) => unit.key === character.key
      ? { ...unit, requiredObservationKeys: ["obs_witness"] }
      : unit),
  };

  const result = approvePlanningContext(context(), proposal);
  expect(result).toMatchObject({ ok: false, code: "beat_authority_conflict" });
  if (!result.ok) {
    expect(JSON.parse(result.detail!)).toMatchObject({
      unitKey: character.key,
      unavailableEvidence: [{ kind: "required_observation", observationKey: "obs_witness" }],
    });
  }
});

it("允许 character 引用更早 narration 真实披露的 conditional observation", () => {
  const base = makeDecisionPlan();
  const narration = base.units.find((unit) => unit.stage === "narration");
  const character = base.units.find((unit) => unit.stage === "character");
  if (narration === undefined || character === undefined) throw new Error("staged fixture missing");
  const observation = {
    key: "obs_witness",
    point: { stepKey: "current", order: narration.point.order },
    audienceIds: ["player_0", FIXTURE_DECISION_NPC],
    fact: { factId: "fact_routes", certainty: "known" as const },
    source: { kind: "witness" as const },
  };
  const proposal = {
    ...base,
    observations: [observation],
    units: base.units.map((unit) => {
      if (unit.key === narration.key) return { ...unit, requiredObservationKeys: [observation.key] };
      if (unit.key === character.key) return { ...unit, requiredBeats: [{
        beatId: "follow_up", kind: "player_utterance" as const, factIds: [],
        evidence: [{ kind: "conditional" as const, observationKey: observation.key }],
        instruction: "承接已披露观察",
      }] };
      return unit;
    }),
  };

  expect(approvePlanningContext(context(), proposal)).toMatchObject({ ok: true });
});

it("同地点的不同对白无需路线目标，相同语义仍拒绝", () => {
  const base = makeDecisionPlan();
  if (base.decision?.kind !== "ordinary") throw Error("ordinary fixture");
  const [left, right] = base.decision.options;
  const proposal = { ...base, decision: { ...base.decision, options: [
    { ...left, target: null, deferredLocation: null, dialogueAct: "support" as const },
    { ...right, target: null, deferredLocation: null, dialogueAct: "challenge" as const },
  ] as const } };
  expect(approvePlanningContext(context(), proposal).ok).toBe(true);
  expect(approvePlanningContext(context(), { ...proposal, decision: { ...proposal.decision, options: [
    proposal.decision.options[0], { ...proposal.decision.options[0], candidateId: right.candidateId },
  ] } })).toMatchObject({ ok: false, code: "decision_duplicate_intent" });
});

it("规则要求下一幕时不能用 null 世界增量假装已经结束", () => {
  const input = context();
  if (input.kind !== "decision") throw Error("decision fixture");
  const result = approvePlanningContext({ ...input, story: { ...input.story,
    evolution: { ...input.story.evolution, status: "needs_next_act" },
  } }, makeDecisionPlan());
  expect(result).toMatchObject({ ok: false, code: "planning_world_delta_required" });
});

it("事件类型不能冒充证据 ID，必须在表达调用前退回规划修复", () => {
  const base = makeDecisionPlan();
  const result = approvePlanningContext(context(), { ...base, units: base.units.map((unit, index) => index === 0
    ? { ...unit, requiredBeats: [{ beatId: "progress", kind: "quest_progress", factIds: [],
      evidence: [{ kind: "committed", eventId: "quest_completed" }], instruction: "衔接任务" }] }
    : unit) });
  expect(result).toMatchObject({ ok: false, code: "plan_evidence_unknown" });
});

it.each([false, true])("本回合真实任务完成事件可证明旁白的完成节拍，终幕=%s，不授予 NPC 知识", ending => {
  const input = context();
  if (input.kind !== "decision") throw Error("decision");
  const event = input.world.eventLedger[1]!;
  const questId = input.world.quests[0]!.id;
  const scoped = { ...input, world: { ...input.world, eventLedger: input.world.eventLedger.map(entry => entry.eventId !== event.eventId ? entry : {
    ...event, kind: "quest_completed" as const, payload: { type: "quest_completed" as const, questId },
  }) }, job: { ...input.job, domainEventIds: [event.eventId],
    objectiveTransition: { ...input.job.objectiveTransition,
      before: { questId: asQuestId(String(questId)), objectiveIndex: 0, label: "完成交谈" },
      mode: ending ? "ready_for_ending" as const : "progressed" as const,
      completed: ending ? [] : [{ questId: asQuestId(String(questId)), objectiveIndex: 0, label: "完成交谈" }] },
    mandatoryBeats: [{ beatId: "progress", kind: "quest_progress" as const, subjectIds: [String(questId)], instruction: "目标完成" }],
  } };
  const base = makeDecisionPlan();
  const plan = { ...base, units: base.units.map(unit => unit.stage === "narration" ? { ...unit,
    requiredBeats: [{ beatId: "progress", kind: "quest_progress" as const, factIds: [],
      evidence: [{ kind: "committed" as const, eventId: String(event.eventId) }], instruction: "目标完成" }],
  } : unit) };
  const result = approvePlanningContext(scoped, plan);
  if (ending) {
    // 此夹具保留普通候选图：证据闸门应已通过，再由终幕图闸门拒绝。
    expect(result).toMatchObject({ ok: false, code: "plan_terminal_graph_mismatch" });
    expect(approvePlanningContext({ ...scoped, job: { ...scoped.job, domainEventIds: [] } }, plan))
      .toMatchObject({ ok: false, code: "plan_evidence_not_fact_source" });
    return;
  }
  if (!result.ok) throw Error(result.code);
  const unit = result.value.units.find(unit => unit.stage === "narration")!;
  const projected = projectUnitContext({ plan: result.value, unit, approved: new Map() });
  if (!projected.ok) throw Error(projected.code);
  expect(approveUnit({ unit, context: projected.value, output: { stage: "narration", actionKeys: [], parts: [{
    text: "这段交谈已告一段落。", facts: [], evidence: [{ kind: "committed", eventId: String(event.eventId) }], beatIds: ["progress"],
  }] } }).ok).toBe(true);
  expect(projected.value.visibleFacts.map(fact => fact.id)).toEqual(input.world.worldFacts.filter(fact => fact.discovered).map(fact => fact.factId));
});

it("真实事件 ID 也不自动成为 NPC 已知事实的出处", () => {
  const input = context();
  if (input.kind !== "decision") throw Error("decision fixture");
  const base = makeDecisionPlan();
  const eventId = String(input.world.eventLedger[0]!.eventId);
  const result = approvePlanningContext(input, { ...base, units: base.units.map(unit => unit.stage === "character"
    ? { ...unit, requiredBeats: [{ beatId: "heard", kind: "player_utterance", factIds: [],
      evidence: [{ kind: "committed", eventId }], instruction: "回应玩家" }] } : unit) });
  expect(result).toMatchObject({ ok: false, code: "plan_evidence_not_fact_source" });
  if (result.ok) throw Error("invalid evidence accepted");
  expect(JSON.parse(result.detail!)).toMatchObject({
    unitKey: base.units.find(unit => unit.stage === "character")!.key,
    invalidBeats: [{ beatId: "heard", invalidEventIds: [eventId], allowedEventIds: expect.any(Array) }],
  });
});


it("柳三娘回归：重复来源/时间在表达前退回规划，同事实的新维度允许", () => {
  const input = context();
  if (input.kind !== "decision") throw Error("decision");
  const base = makeDecisionPlan();
  if (base.decision?.kind !== "ordinary") throw Error("ordinary");
  const task = { intent: "ask" as const, focusFactIds: ["fact_0"], prerequisiteFactIds: [],
    inquiries: [{ factId: "fact_0", aspects: ["source", "time"] as const }] };
  const world = createWorldStateFixtureWith({ generation: input.world.generation, base: input.world }, {
    worldFacts: [{ factId: asFactId("fact_0"), text: "镇口贴有告示。", source: "generated", discovered: true }],
    eventLedger: input.world.eventLedger,
  });
  const scoped = { ...input, world, job: { ...input.job, focusNpcId: input.world.npcs[0]!.id,
    selectedDialogue: { dialogueAct: "ask" as const, label: "是谁贴的？什么时候贴的？", task } } };
  const proposal = { ...base, decision: { ...base.decision, npcId: String(input.world.npcs[0]!.id), options: [
    { ...base.decision.options[0], target: null, deferredLocation: null, dialogueAct: "ask" as const,
      topic: { kind: "general" as const }, task },
    { ...base.decision.options[1], target: null, deferredLocation: null, dialogueAct: "challenge" as const },
  ] as const } };
  const rejected = approvePlanningContext(scoped, proposal);
  expect(rejected).toMatchObject({ ok: false, code: "plan_dialogue_repeated" });
  if (!rejected.ok) expect(JSON.parse(rejected.detail!)).toMatchObject({
    repeatedCandidates: [proposal.decision.options[0].candidateId], sceneContract: expect.any(Object),
    repairInstruction: expect.stringContaining("不能只换措辞"),
  });
  const repaired = { ...proposal, decision: { ...proposal.decision, options: [
    { ...proposal.decision.options[0], task: { ...task, inquiries: [{ factId: "fact_0", aspects: ["purpose" as const] }] } },
    proposal.decision.options[1],
  ] as const } };
  expect(approvePlanningContext(scoped, repaired).ok).toBe(true);
  expect(buildPlanningPrompt(scoped)).toContain('"aspects":["source","time"]');
  expect(PLANNING_CONTENT_RULES).toContain("已问过且答称不知道的问题不再问");
});
