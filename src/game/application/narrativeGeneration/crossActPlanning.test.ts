import { publishJob } from "./publishJob";
import { expect, it } from "vitest";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import type { PlanningContext } from "./stageSource";
import { createPendingDecisionRecord, makeDecisionPlan } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { approvePlanningContext } from "./approvePlanningContext";
import { buildNarrationPrompt } from "../server/ai/staged/narrationPrompt";
import { buildPlanningPrompt } from "../server/ai/staged/planningPrompt";
import { asLocationId } from "@/game/domain/worldEntity";
import { createStagedHarness } from "../testing/stagedNarrativeHarness.testutil";
import { makeCharacterOutput, makeNarrationOutput } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { buildDecisionPublication } from "./decisionJob";
import { sceneSnapshot } from "@/game/gameplay/rpg/narrativePlanning";
import { projectUnitContext } from "./perspectiveContext";
import { resolveTurn } from "@/game/gameplay/rpg/ruleEngine";
import { asTurnId } from "@/game/domain/events";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import type { UnitOutput } from "@/game/domain/narrativeUnit";
import { parseNarrativeBundleState } from "@/game/domain/narrativeBundle";
import { consumeNarrativeBundle } from "../consumeNarrativeBundle";

function crossActFixture() {
  const record = createPendingDecisionRecord();
  if (record.storyState.narrative.status !== "provider_pending") throw Error("pending fixture");
  const input: PlanningContext = { kind: "decision", world: record.worldState,
    story: { ...record.storyState, currentAct: 2, evolution: { ...record.storyState.evolution,
      status: "needs_next_act", nextLocationOrdinal: 2, nextNpcOrdinal: 2, nextQuestOrdinal: 2 } },
    job: { ...record.storyState.narrative.job, objectiveTransition: {
      ...record.storyState.narrative.job.objectiveTransition, after: null, mode: "advanced_act" } } };
  const base = makeDecisionPlan();
  if (base.decision?.kind !== "ordinary") throw Error("ordinary fixture");
  const stepKey = "move:loc_dyn_2";
  const proposal: PlanProposal = { ...base,
    worldDelta: { beatSummary: "旧幕结束，追查信使", newLocation: { name: "青山别院", description: "山腰上的别院。",
      scale: "scene", placement: "world", connectFromLocationId: input.world.currentLocationId },
    newNpc: { name: "青山信使", role: "传话人", description: "守在别院的信使。", locationRef: { kind: "new_location" },
      anchors: { selfConcept: "信使", values: ["守信"], speechStyle: "简短", capabilityBoundaries: ["只知送信经过"], taboos: [] },
      goals: [{ horizon: "short", description: "找到收信人", priority: 3, reason: "完成交托" }], relationshipSeeds: [] },
    newItem: null, newEnemy: null, newFact: null,
    nextMainQuest: { name: "追查密信", description: "找到密信的下落。", objectiveText: "与信使交谈" }, endingPair: null },
    steps: [{ key: stepKey, trigger: { kind: "move", locationId: asLocationId("loc_dyn_2") }, next: [] }],
    terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey } },
    units: [...base.units.filter(unit => unit.stage !== "choices"),
      { ...base.units[0]!, key: "arrival_narration", point: { stepKey, order: 0 } },
      { ...base.units[1]!, key: "arrival_npc", speakerId: "npc_dyn_2", point: { stepKey, order: 1 } },
      base.units[2]!],
    decision: { ...base.decision, options: [
      { ...base.decision.options[0], candidateId: `${stepKey}_choice_1`, target: null, deferredLocation: null },
      { ...base.decision.options[1], candidateId: `${stepKey}_choice_2`, target: null, deferredLocation: null },
    ] } };
  return { input, proposal, stepKey };
}

it("重复实体拒绝带占用身份与空间约束，不自动改名或复建旧 NPC", () => {
  const { input, proposal } = crossActFixture();
  const result = approvePlanningContext(input, { ...proposal, worldDelta: { ...proposal.worldDelta!,
    newNpc: { ...proposal.worldDelta!.newNpc!, name: input.world.npcs[0]!.name },
  } });
  expect(result).toMatchObject({ ok: false, code: "world_delta_rejected:duplicate_name:npc" });
  if (result.ok) return;
  expect(JSON.parse(result.detail!).occupiedNames.npc).toContain(input.world.npcs[0]!.name);
  const prompt = buildPlanningPrompt(input);
  expect(prompt).toContain(`"currentLocationId":"${input.world.currentLocationId}"`);
  expect(prompt).toContain("npc_gift");
  expect(prompt).toContain("已存在实体不是新建模板");
});

it("事实证据修复保留已批准世界增量和图，不能因局部错误重新创世界", () => {
  const { input, proposal } = crossActFixture();
  const result = approvePlanningContext(input, { ...proposal, units: proposal.units.map((unit, i) => i !== 0 ? unit : {
    ...unit, requiredBeats: [{ beatId: "atmosphere", kind: "atmosphere", factIds: [],
      evidence: [{ kind: "committed", eventId: "nonexistent" }], instruction: "衔接现场" }],
  }) });
  expect(result).toMatchObject({ ok: false, code: "plan_evidence_unknown" });
  if (result.ok) return;
  expect(JSON.parse(result.detail!).approvedWorldDelta).toEqual(proposal.worldDelta);
  expect(JSON.parse(result.detail!).sceneContract.graphStatus).toBe("approved");
});

it("规则已允许结局时，同包生成结局对后派生并原子发布终幕表达", async () => {
  const { input, proposal } = crossActFixture();
  const endingInput = { ...input, story: { ...input.story, endingAllowed: true,
    currentAct: input.story.targetActs, evolution: { ...input.story.evolution, status: "needs_ending_pair" as const } } };
  const endingPlan: PlanProposal = { ...proposal, steps: [], terminal: { kind: "ending" }, decision: null,
    units: makeDecisionPlan().units, worldDelta: { beatSummary: "真相已明，等待表态", newLocation: null, newNpc: null,
      newItem: null, newEnemy: null, newFact: null, nextMainQuest: null, endingPair: [
        { themeKey: "trust", name: "携手前行", description: "选择信任" },
        { themeKey: "doubt", name: "独立求证", description: "选择质疑" },
      ] } };
  const result = approvePlanningContext(endingInput, endingPlan);
  expect(result.ok ? result.value.choiceExpression?.kind : result.code).toBe("ending");
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok) throw Error(stored.code);
  await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version,
    job: { ...stored.value, input: endingInput } });
  h.source.generate = async request => {
    if (request.stage === "planning") return { ok: true, stage: "planning", value: endingPlan };
    if (request.stage === "narration") return { ok: true, stage: "narration", value: makeNarrationOutput() };
    if (request.stage === "character") return { ok: true, stage: "character", value: makeCharacterOutput("npc_dyn_1") };
    return { ok: true, stage: "choices", value: { stage: "choices", labels: [
      { candidateId: "trust", label: "我愿意相信你。" }, { candidateId: "doubt", label: "我还要核实你的说法。" },
    ] } };
  };
  const ran = await h.run();
  if (!ran.ok) throw Error(ran.code);
  const built = buildDecisionPublication({ job: ran.value, createdAt: h.clock.now() });
  if (!built.ok) throw Error(built.code);
  const published = await publishJob({ job: ran.value, lease: h.lease(), publication: built.publication }, h.jobs);
  expect(published.ok ? published.value.status : published.code).toBe("published");
});

function arrivalFactFixture() {
  const { input, proposal, stepKey } = crossActFixture();
  if (proposal.decision === null || proposal.worldDelta === null) throw Error("cross-act fixture");
  const point = { stepKey, order: 2 };
  const factId = "fact_dyn_0";
  const plan: PlanProposal = { ...proposal, worldDelta: { ...proposal.worldDelta,
    newFact: { text: "信使留下的铜牌刻着盐纹。", visibility: "public", investigationApproaches: [
      { approachId: "inspect", label: "查看铜牌", hint: "注意边缘", evidenceQuality: "clean", tensionDelta: 0 },
      { approachId: "ask", label: "询问信使", hint: "问问来历", evidenceQuality: "noisy", tensionDelta: 2 },
    ] } },
    units: proposal.units.map(unit => unit.stage === "choices" ? { ...unit, point, dependencies: ["arrival_narration", "arrival_npc"] }
      : unit.key === "arrival_narration" ? { ...unit, taskFactIds: [factId], requiredBeats: [
        { beatId: "arrival_fact", kind: "fact_discovered", factIds: [factId], evidence: [], instruction: "呈现抵达后发现的铜牌刻纹" },
      ] } : unit),
    decision: { ...proposal.decision, point, npcId: "npc_dyn_2" } };
  const approved = approvePlanningContext(input, plan);
  if (!approved.ok) throw Error(approved.code);
  return { input, plan, approved: approved.value, factId, stepKey };
}

it.each([0, 1, 4])("强制节拍只分配给 NPC：有界规划修复与完整发布（已耗规划次数=%s）", async priorAttempts => {
  const cached = priorAttempts > 0;
  const fixture = arrivalFactFixture();
  const mandatory = [
    { beatId: "quest_progress_0", kind: "quest_progress" as const, subjectIds: [], instruction: "目标已完成" },
    { beatId: "quest_advanced_1", kind: "quest_advanced" as const, subjectIds: [], instruction: "进入下一幕" },
  ];
  const input = { ...fixture.input, job: { ...fixture.input.job, mandatoryBeats: mandatory } };
  const safeBeats = mandatory.map(beat => ({ beatId: beat.beatId, kind: beat.kind,
    factIds: [], evidence: [], instruction: beat.instruction }));
  const invalid: PlanProposal = { ...fixture.plan, units: fixture.plan.units.map(unit =>
    unit.point.stepKey !== "current" ? unit : { ...unit, requiredBeats: unit.stage === "narration"
      ? [safeBeats[0]!] : unit.stage === "character" ? [safeBeats[1]!] : [] }) };
  const fixed: PlanProposal = { ...invalid, units: invalid.units.map(unit =>
    unit.point.stepKey === "current" && unit.stage === "narration"
      ? { ...unit, requiredBeats: safeBeats } : unit) };
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok) throw Error(stored.code);
  expect((await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version,
    job: { ...stored.value, input, usedRequests: cached ? priorAttempts + 1 : 0,
      units: cached ? [
        { key: "planning", unit: null, inputDigest: stored.value.inputDigest, attempts: priorAttempts, status: "approved", value: invalid },
        { key: "obsolete_expression", unit: invalid.units[0]!, inputDigest: stored.value.inputDigest,
          attempts: 1, status: "approved", value: makeNarrationOutput() },
      ] : [],
    } })).ok).toBe(true);
  const calls: string[] = [];
  h.source.generate = async (request, execution) => {
    calls.push(request.stage);
    if (request.stage === "planning") {
      if (!cached && calls.length === 1) return { ok: true, stage: "planning", value: invalid };
      expect(execution.repair).toMatchObject({ rejectionCode: "plan_mandatory_beat_mismatch" });
      expect(JSON.parse(execution.repair!.detail!).requiredNarrationBeats).toHaveLength(2);
      return { ok: true, stage: "planning", value: fixed };
    }
    expect(request.context).not.toHaveProperty("world");
    expect(request.context).not.toHaveProperty("requiredNarrationBeats");
    if (request.stage === "narration" && request.context.unit.point.stepKey === "current") {
      expect(request.context.narrationLayout).toEqual({ allowAtmosphere: true });
      expect(buildNarrationPrompt(request.context)).toContain("正文末尾");
    } else expect(request.context.narrationLayout).toBeUndefined();
    if (request.stage === "narration") return { ok: true, stage: "narration", value: {
      stage: "narration", actionKeys: [], parts: request.context.requiredBeats.map(beat => ({
        text: beat.beatId === "quest_progress_0" ? "旧事暂告一段落。" : beat.beatId === "quest_advanced_1"
          ? "新的线索指向山中的别院。" : "信使留下的铜牌刻着盐纹。",
        beatIds: [beat.beatId], facts: beat.factIds.map(factId => ({ factId, certainty: "known" as const })), evidence: [],
      })),
    } };
    if (request.stage === "character") return { ok: true, stage: "character", value: {
      ...makeCharacterOutput(request.context.unit.speakerId!),
      parts: [{ text: "你去别院问问吧。", facts: [], evidence: [],
        beatIds: request.context.requiredBeats.map(beat => beat.beatId) }],
      answeredBeatIds: request.context.requiredBeats.map(beat => beat.beatId),
    } };
    return { ok: true, stage: "choices", value: { stage: "choices", labels: [
      { candidateId: `${fixture.stepKey}_choice_1`, label: "我愿意帮你找到收信人。" },
      { candidateId: `${fixture.stepKey}_choice_2`, label: "你先说清楚这封信的来历。" },
    ] } };
  };
  const result = await h.run();
  if (priorAttempts === 4) {
    expect(result).toEqual({ ok: false, code: "unit_attempts_exhausted" });
    expect(calls).toEqual([]);
    const failed = await h.readJob();
    if (!failed.ok) throw Error(failed.code);
    expect(failed.value.usedRequests).toBe(5);
    expect(failed.value.units.every(unit => unit.value === null)).toBe(true);
    expect(failed.value.units.find(unit => unit.key === "planning")?.attempts).toBe(4);
    expect(h.publications()).toHaveLength(0);
    return;
  }
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  expect(calls.filter(stage => stage === "planning")).toHaveLength(cached ? 1 : 2);
  expect(calls.filter(stage => stage !== "planning")).toHaveLength(5);
  expect(result.value.usedRequests).toBe(cached ? 8 : 7);
  expect(result.value.units.some(unit => unit.key === "obsolete_expression")).toBe(false);
  const publication = buildDecisionPublication({ job: result.value, createdAt: h.clock.now() });
  expect(publication).toMatchObject({ ok: true });
  if (!publication.ok) return;
  expect(publication.approved.currentScene.narration).toBe("旧事暂告一段落。\n新的线索指向山中的别院。");
  expect(publication.approved.currentScene.narration).not.toContain("你去别院问问吧");
  expect(publication.approved.bundle.steps).toHaveLength(1);
});

it("真实规则抵达即确认的连续事实目标，未来旁白快照必须同样可知且不提交事件", () => {
  const { approved, factId } = arrivalFactFixture();
  const before = JSON.stringify(approved.world);
  const turnId = asTurnId("arrival-parity");
  const actual = resolveTurn(approved.world, approved.story,
    { type: "move", locationId: asLocationId("loc_dyn_2") }, "arrival-parity", 1, turnId, "fixed_choice",
    { turnId, now: () => "2026-09-11T00:00:00.000Z" });
  expect(actual).toMatchObject({ ok: true });
  if (!actual.ok) return;
  expect(actual.resolution.nextWorldState.worldFacts.find(fact => fact.factId === factId)?.discovered).toBe(true);
  const unit = approved.units.find(unit => unit.key === "arrival_narration")!;
  const snapshot = sceneSnapshot({ plan: approved, point: unit.point });
  expect(snapshot.ok && snapshot.value.world.worldFacts.find(fact => fact.factId === factId)?.discovered).toBe(true);
  const context = projectUnitContext({ plan: approved, unit, approved: new Map<string, UnitOutput>([
    ["narration_current", makeNarrationOutput()], ["character_npc_0", makeCharacterOutput("npc_dyn_1")],
  ]) });
  expect(context).toMatchObject({ ok: true });
  if (context.ok) expect(context.value.visibleFacts).toContainEqual(expect.objectContaining({ id: factId, sources: [] }));
  expect(snapshot.ok && snapshot.value.world.eventLedger).toEqual(approved.world.eventLedger);
  expect(JSON.stringify(approved.world)).toBe(before);
  expect(approved.world.worldFacts.find(fact => fact.factId === factId)?.discovered).toBe(false);
});

it("抵达时可知不等于现在可知：当前旁白仍不能讲未来事实", () => {
  const { approved, factId } = arrivalFactFixture();
  const current = approved.units.find(unit => unit.stage === "narration" && unit.point.stepKey === "current")!;
  const unit = { ...current, requiredBeats: [{ beatId: "too_early", kind: "fact_discovered" as const,
    factIds: [factId], evidence: [], instruction: "提前透露" }] };
  const plan = { ...approved, units: approved.units.map(candidate => candidate.key === unit.key ? unit : candidate) };
  expect(projectUnitContext({ plan, unit, approved: new Map() })).toMatchObject({ ok: false, code: "beat_authority_conflict" });
});

it("模型引用和地点相同均不构成发现权限，事实必须属于规则步骤折叠的目标", () => {
  const { approved, factId, stepKey } = arrivalFactFixture();
  const graph = approved.ruleSceneGraph!;
  const plan = { ...approved, ruleSceneGraph: { ...graph,
    steps: graph.steps.map(step => ({ ...step, absorbedObjectiveIndexes: [] })) } };
  const snapshot = sceneSnapshot({ plan, point: { stepKey, order: 0 } });
  expect(snapshot.ok && snapshot.value.world.worldFacts.find(fact => fact.factId === factId)?.discovered).toBe(false);
});

it("城镇容器的 move 不提前揭示建筑事实，只有 explore 到达边界才预览发现", () => {
  const { approved, factId, stepKey } = arrivalFactFixture();
  const world = createWorldStateFixtureWith({ generation: approved.world.generation, base: approved.world }, {
    locations: approved.world.locations.map(location => location.id === "loc_dyn_2" ? { ...location, scale: "town" } : location),
    eventLedger: approved.world.eventLedger,
  });
  const plan = { ...approved, world };
  const snapshot = sceneSnapshot({ plan, point: { stepKey, order: 0 } });
  expect(snapshot.ok && snapshot.value.world.worldFacts.find(fact => fact.factId === factId)?.discovered).toBe(false);
  if (!snapshot.ok) throw Error(snapshot.code);
  const atBuilding = { ...plan, world: snapshot.value.world, proposal: { ...plan.proposal,
    steps: [{ key: stepKey, trigger: { kind: "explore" as const, locationId: asLocationId("loc_dyn_2") }, next: [] }] } };
  const entered = sceneSnapshot({ plan: atBuilding, point: { stepKey, order: 0 } });
  expect(entered.ok && entered.value.world.worldFacts.find(fact => fact.factId === factId)?.discovered).toBe(true);
});

it("含未来事实节拍的四类生成与完整包发布审批通过，发布仍不提前提交未来发现", async () => {
  const { input, plan, factId, stepKey } = arrivalFactFixture();
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok) throw Error("job missing");
  expect(await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version,
    job: { ...stored.value, input } })).toMatchObject({ ok: true });
  h.source.generate = async request => {
    if (request.stage === "planning") return { ok: true, stage: "planning", value: plan };
    if (request.stage === "narration") return { ok: true, stage: "narration", value: {
      ...makeNarrationOutput(), parts: request.context.requiredBeats.length === 0 ? makeNarrationOutput().parts
        : request.context.requiredBeats.map(beat => ({ text: "信使留下的铜牌刻着盐纹。",
          facts: beat.factIds.map(factId => ({ factId, certainty: "known" as const })), evidence: [], beatIds: [beat.beatId] })),
    } };
    if (request.stage === "character") return { ok: true, stage: "character", value: makeCharacterOutput(request.context.unit.speakerId!) };
    expect(request.context.visibleFacts.some(fact => fact.id === factId)).toBe(true);
    return { ok: true, stage: "choices", value: { stage: "choices", labels: [
      { candidateId: `${stepKey}_choice_1`, label: "我愿意帮你找到收信人。" },
      { candidateId: `${stepKey}_choice_2`, label: "你先说清楚这封信的来历。" },
    ] } };
  };
  const result = await h.run();
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  const publication = buildDecisionPublication({ job: result.value, createdAt: h.clock.now() });
  expect(publication).toMatchObject({ ok: true });
  if (!publication.ok) return;
  expect(publication.approved.nextWorldState.worldFacts.find(fact => fact.factId === factId)?.discovered).toBe(false);
  expect(publication.approved.bundle.steps[0]?.premises?.discoveredFactIds).toEqual([factId]);
  expect(publication.approved.nextWorldState.eventLedger.some(event => event.kind === "fact_discovered" && event.factIds.some(id => id === factId))).toBe(false);
  expect(publication.approved.bundle.steps[0]?.scene.segments.some(segment => segment.text.includes("铜牌刻着盐纹"))).toBe(true);
  expect(parseNarrativeBundleState(JSON.parse(JSON.stringify(publication.approved.bundle))).ok).toBe(true);
  if (publication.publication.kind !== "decision") throw Error("decision publication");
  const { nextWorldState: world, nextStoryState: story } = publication.publication.input;
  const turnId = asTurnId("consume-arrival");
  const action = { type: "move" as const, locationId: asLocationId("loc_dyn_2") };
  const actual = resolveTurn(world, story, action, "consume-arrival", 2, turnId, "fixed_choice",
    { turnId, now: () => "2026-09-11T00:00:00.000Z" });
  if (!actual.ok) throw Error(actual.code);
  const consumed = consumeNarrativeBundle({ beforeStoryState: story, resolvedStoryState: actual.resolution.nextStoryState,
    resolvedWorldState: actual.resolution.nextWorldState, action, actionId: "consume-arrival", postCommitRevision: 3,
    resolvedEvent: actual.resolution.primaryResult, domainEvents: actual.resolution.domainEvents });
  expect(consumed).toMatchObject({ ok: true });
  if (consumed.ok) {
    expect(consumed.nextWorldState.worldFacts.find(fact => fact.factId === factId)?.discovered).toBe(true);
    expect(consumed.nextStoryState.narrative.status === "ready" && consumed.nextStoryState.narrative.currentScene.narration).toContain("铜牌刻着盐纹");
  }
});

it("跨幕错误决策保留拒绝，并反馈增量后的决策位置、NPC、候选和当前回应分工", () => {
  const { input, proposal, stepKey } = crossActFixture();
  const before = JSON.stringify(input);
  const result = approvePlanningContext(input, proposal);
  expect(result).toMatchObject({ ok: false, code: "plan_terminal_choice_mismatch" });
  if (result.ok) throw Error("must reject");
  const detail = JSON.parse(result.detail!);
  expect(detail.sceneContract).toMatchObject({ graphStatus: "approved", decisionPoint: stepKey,
    decisionNpcId: "npc_dyn_2", candidateIds: [`${stepKey}_choice_1`, `${stepKey}_choice_2`],
    scenes: [{ stepKey: "current", responseNpcId: "npc_dyn_1", allowsChoices: false },
      { stepKey, responseNpcId: "npc_dyn_2", allowsChoices: true }] });
  expect(detail.approvedWorldDelta).toEqual(proposal.worldDelta);
  expect(JSON.stringify(input)).toBe(before);
  expect(proposal.decision?.point.stepKey).toBe("current");
});

it("跨幕修复提示只使用已批准的场景契约，末尾不再覆盖成旧幕待生成图", () => {
  const { input, proposal, stepKey } = crossActFixture();
  const result = approvePlanningContext(input, proposal);
  if (result.ok) throw Error("must reject");
  const prompt = buildPlanningPrompt(input, { attempt: 2, reason: result.code, detail: result.detail });
  expect(prompt).not.toContain('"graphStatus":"pending_world_delta"');
  expect(prompt).toContain(`"decisionPoint":"${stepKey}"`);
  expect(prompt).toContain('"decisionNpcId":"npc_dyn_2"');
  expect(prompt.lastIndexOf("# 上次生成的校验反馈")).toBeGreaterThan(prompt.indexOf("# 最终结构检查"));
});

it("由规划器重新生成未来决策可获批，不改写当前 NPC 回应也不强制选项路线", () => {
  const { input, proposal, stepKey } = crossActFixture();
  if (proposal.decision === null) throw Error("decision fixture");
  const point = { stepKey, order: 2 };
  const corrected: PlanProposal = { ...proposal,
    units: proposal.units.map(unit => unit.stage === "choices" ? { ...unit, point,
      dependencies: ["arrival_narration", "arrival_npc"] } : unit),
    decision: { ...proposal.decision, point, npcId: "npc_dyn_2" } };
  const approved = approvePlanningContext(input, corrected);
  expect(approved).toMatchObject({ ok: true });
  if (!approved.ok) return;
  expect(approved.value.proposal).toBe(corrected);
  expect(approved.value.choiceExpression).toMatchObject({ point, npcId: "npc_dyn_2",
    options: [{ target: null }, { target: null }] });
});

it("规划重试后四类生成器完成整包发布审批，当前场景无选项、抵达场景有两个选项", async () => {
  const { input, proposal, stepKey } = crossActFixture();
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok) throw Error("job missing");
  expect(await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version,
    job: { ...stored.value, input } })).toMatchObject({ ok: true });
  const calls: string[] = [];
  h.source.generate = async (request, execution) => {
    calls.push(request.stage);
    if (request.stage === "planning") {
      if (execution.repair === undefined) return { ok: true, stage: "planning", value: proposal };
      expect(calls).toEqual(["planning", "planning"]);
      expect(execution.repair).toMatchObject({ reason: "invalid_schema", rejectionCode: "plan_terminal_choice_mismatch" });
      const contract = JSON.parse(execution.repair.detail!).sceneContract;
      expect(contract.decisionPoint).toBe(stepKey);
      if (proposal.decision === null) throw Error("decision missing");
      const point = { stepKey: contract.decisionPoint, order: 2 };
      return { ok: true, stage: "planning", value: { ...proposal,
        units: proposal.units.map(unit => unit.stage === "choices" ? { ...unit, point,
          dependencies: ["arrival_narration", "arrival_npc"] } : unit),
        decision: { ...proposal.decision, point, npcId: contract.decisionNpcId } } };
    }
    expect(request.context).not.toHaveProperty("sceneContract");
    expect(request.context).not.toHaveProperty("world");
    if (request.stage === "narration") return { ok: true, stage: "narration", value: makeNarrationOutput() };
    if (request.stage === "character") return { ok: true, stage: "character", value: makeCharacterOutput(request.context.unit.speakerId!) };
    expect(request.context.unit.point.stepKey).toBe(stepKey);
    return { ok: true, stage: "choices", value: { stage: "choices", labels: [
      { candidateId: `${stepKey}_choice_1`, label: "我愿意帮你找到收信人。" },
      { candidateId: `${stepKey}_choice_2`, label: "你先说清楚这封信的来历。" },
    ] } };
  };
  const result = await h.run();
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  expect(calls.filter(stage => stage === "choices")).toHaveLength(1);
  expect(calls.filter(stage => stage === "character")).toHaveLength(2);
  expect(calls.filter(stage => stage === "narration")).toHaveLength(2);
  const publication = buildDecisionPublication({ job: result.value, createdAt: h.clock.now() });
  expect(publication).toMatchObject({ ok: true });
  if (!publication.ok) return;
  expect(publication.approved.currentScene.choices).toHaveLength(0);
  expect(publication.approved.currentScene.npcLine?.npcId).toBe("npc_dyn_1");
  expect(publication.approved.bundle.steps).toHaveLength(1);
  expect(publication.approved.bundle.steps[0]?.stepId).toBe(stepKey);
  expect(publication.approved.bundle.steps[0]?.scene.choiceSeeds).toHaveLength(2);
  expect(publication.approved.bundle.steps[0]?.scene.npcLine?.npcId).toBe("npc_dyn_2");
});

it.each(["not JSON", "null", '{"sceneContract":null}', '{"sceneContract":{"graphStatus":"approved"}}'])(
  "无效或旧格式修复详情不会覆盖原结构上下文：%s", detail => {
    const { input } = crossActFixture();
    const prompt = buildPlanningPrompt(input, { attempt: 2, reason: "invalid_schema", detail });
    expect(prompt).toContain('"graphStatus":"pending_world_delta"');
  });

it("同场景普通决策仍合法，不因新增场景契约强制玩家换地点", () => {
  const record = createPendingDecisionRecord();
  if (record.storyState.narrative.status !== "provider_pending") throw Error("pending fixture");
  const prompt = buildPlanningPrompt({ kind: "decision", world: record.worldState,
    story: record.storyState, job: record.storyState.narrative.job });
  const graph = JSON.parse(prompt.split("# 服务端场景骨架\n")[1]!.split("\n")[0]!);
  expect(graph).toMatchObject({ steps: [], decisionPoint: "current", decisionNpcId: "npc_dyn_1",
    scenes: [{ stepKey: "current", allowsChoices: true }] });
});
