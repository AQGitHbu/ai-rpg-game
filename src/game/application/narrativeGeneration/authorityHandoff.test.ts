import { expect, it } from "vitest";
import { createPendingDecisionRecord, makeDecisionPlan, makeCharacterOutput, makeNarrationOutput } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import { asFactId } from "@/game/domain/worldEntity";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import type { PlanningContext } from "./stageSource";
import { createStagedHarness } from "../testing/stagedNarrativeHarness.testutil";
import { approvePlanningContext } from "./approvePlanningContext";
import { buildDecisionPublication } from "./decisionJob";
import { projectUnitContext } from "./perspectiveContext";
import { buildCharacterPrompt } from "../server/ai/staged/characterPrompt";
import { buildNarrationPrompt } from "../server/ai/staged/narrationPrompt";

function fixture() {
  const record = createPendingDecisionRecord();
  if (record.storyState.narrative.status !== "provider_pending") throw Error("pending fixture");
  const world = createWorldStateFixtureWith({ generation: record.worldState.generation, base: record.worldState }, {
    worldFacts: [{ factId: asFactId("fact_player_only"), text: "旧守门人见过翻墙者。", source: "generated", discovered: true }],
    eventLedger: record.worldState.eventLedger,
  });
  const input: Extract<PlanningContext, { kind: "decision" }> = { kind: "decision", world, story: record.storyState,
    job: { ...record.storyState.narrative.job,
      selectedDialogue: { dialogueAct: "ask", topic: { kind: "general" }, label: "守门人说有人翻墙，你亲眼见过吗？" },
    } };
  const base = makeDecisionPlan();
  if (base.decision?.kind !== "ordinary") throw Error("ordinary fixture");
  const invalid: PlanProposal = { ...base, decision: { ...base.decision, options: [
    { ...base.decision.options[0], target: null, deferredLocation: null },
    { ...base.decision.options[1], target: null, deferredLocation: null },
  ] }, units: makeDecisionPlan().units.map(unit => unit.stage === "character"
    ? { ...unit, taskFactIds: ["fact_player_only"], requiredBeats: [{
      beatId: "reply", kind: "player_utterance", factIds: ["fact_player_only"], evidence: [],
      instruction: "让新 NPC 承认亲眼见过翻墙者。",
    }] } : unit) };
  const fixed: PlanProposal = { ...invalid, units: invalid.units.map(unit => unit.stage === "character"
    ? { ...unit, taskFactIds: [], requiredBeats: unit.requiredBeats.map(beat => ({ ...beat, factIds: [] })), draft: { ...makeCharacterOutput(unit.speakerId!), parts: [{ text: "我不知道。", facts: [], evidence: [], beatIds: ["reply"] }], answeredBeatIds: ["reply"] } } : unit) };
  return { input, invalid, fixed };
}

it("玩家知道不代表新 NPC 知道；无条件知识冲突在规划审批就带定位反馈拒绝", () => {
  const { input, invalid } = fixture();
  const result = approvePlanningContext(input, invalid);
  expect(result).toMatchObject({ ok: false, code: "beat_authority_conflict" });
  if (result.ok) return;
  const detail = JSON.parse(result.detail!);
  expect(detail).toMatchObject({ unitKey: "character_npc_0", speakerId: "npc_dyn_1",
    unavailableFactIds: ["fact_player_only"] });
  expect(result.detail).not.toContain("旧守门人见过翻墙者");
});

it.each(["fresh", "cached", "conditional", "exhausted"])("规划修复不授予知识，保留预算并完整发布（%s）", async mode => {
  const cached = mode === "cached";
  const { input, invalid: originalInvalid, fixed: originalFixed } = fixture();
  const withObservation = (plan: PlanProposal): PlanProposal => mode !== "conditional" ? plan : {
    ...plan, observations: [{ key: "player_reminder", point: { stepKey: "current", order: 1 },
      audienceIds: ["player_0"], source: { kind: "witness" },
      fact: { factId: "fact_player_only", certainty: "known" } }],
    units: plan.units.map(unit => unit.stage === "narration"
      ? { ...unit, taskFactIds: ["fact_player_only"], requiredObservationKeys: ["player_reminder"], draft: {
        stage: "narration", actionKeys: [], parts: [{ text: "你回想起守门人的说法，等待答复。", facts: [{ factId: "fact_player_only", certainty: "known" }], evidence: [], beatIds: [] }],
      } } : unit),
  };
  const invalid = withObservation(originalInvalid);
  const fixed = withObservation(originalFixed);
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok) throw Error(stored.code);
  expect((await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version,
    job: { ...stored.value, input, usedRequests: cached ? 1 : 0,
      units: cached ? [{ key: "planning", unit: null, inputDigest: stored.value.inputDigest,
        status: "approved", attempts: 1, value: invalid }] : [],
    } })).ok).toBe(true);
  const calls: string[] = [];
  h.source.generate = async (request, execution) => {
    calls.push(request.stage);
    if (request.stage === "planning") {
      if (mode === "exhausted" || (!cached && calls.length === 1)) return { ok: true, stage: "planning", value: invalid };
      expect(execution.repair).toMatchObject({ rejectionCode: "beat_authority_conflict" });
      expect(calls.filter(stage => stage !== "planning")).toEqual([]);
      return { ok: true, stage: "planning", value: fixed };
    }
    const here = input.world.locations.find(location => location.id === input.world.currentLocationId)!;
    expect(request.context.scene?.locationName).toBe(here.name);
    expect(request.context.playerUtterance).toBe(input.job.selectedDialogue!.label);
    expect(request.context).not.toHaveProperty("world");
    if (request.stage === "narration") {
      expect(buildNarrationPrompt(request.context)).toContain(here.name);
      return { ok: true, stage: "narration", value: { ...makeNarrationOutput(),
        parts: [{ text: "你回想起守门人的说法，等待答复。", beatIds: [], evidence: [],
          facts: request.context.requiredObservations.map(observation => ({ factId: observation.factId, certainty: observation.certainty })),
        }],
      } };
    }
    if (request.stage === "character") {
      expect(request.context.visibleFacts.some(fact => fact.id === "fact_player_only")).toBe(false);
      const prompt = buildCharacterPrompt(request.context);
      expect(prompt).toContain(input.job.selectedDialogue!.label);
      expect(prompt).toContain("不是已核实事实");
      return { ok: true, stage: "character", value: { ...makeCharacterOutput("npc_dyn_1"),
        parts: [{ text: "我没亲眼见过，你得问当时在场的人。", beatIds: ["reply"], facts: [], evidence: [] }],
        answeredBeatIds: ["reply"],
      } };
    }
    return { ok: true, stage: "choices", value: { stage: "choices", labels: [
      { candidateId: "current_scene_choice_1", label: "那请你帮我找当时在场的人。" },
      { candidateId: "current_scene_choice_2", label: "这件事我自己去查。" },
    ] } };
  };
  const result = await h.run();
  // A player-only witness cannot authorize the NPC. Static preflight rejects it
  // before any expression and the existing bounded planning repair can fix it.
  if (mode === "cached") {
    expect(result).toMatchObject({ ok: false, code: "beat_authority_conflict" });
    expect(calls).toEqual([]); return;
  }
  if (mode === "exhausted") {
    expect(result).toMatchObject({ ok: false, code: "beat_authority_conflict" });
    expect(calls).toEqual(["planning", "planning", "planning", "planning"]);
    expect(h.publications()).toHaveLength(0);
    const failed = await h.readJob();
    expect(failed.ok && failed.value.usedRequests).toBe(4);
    return;
  }
  if (!result.ok) throw Error(result.code + ":" + calls.join(","));
  expect(result.ok).toBe(true);
  expect(result.value.usedRequests).toBe(6);
  const publication = buildDecisionPublication({ job: result.value, createdAt: h.clock.now() });
  expect(publication).toMatchObject({ ok: true });
  if (!publication.ok) return;
  expect(publication.approved.currentScene.npcLine?.text).toContain("没亲眼见过");
  expect(publication.approved.nextWorldState.npcs.find(npc => npc.id === "npc_dyn_1")?.memory.knownFactIds)
    .not.toContain("fact_player_only");
});

it("不把当前提问转发给别的 NPC 或未来场景，也不把提问变成事实", () => {
  const { input, fixed } = fixture();
  const result = approvePlanningContext(input, fixed);
  if (!result.ok) throw Error(result.code);
  const narration = result.value.units.find(unit => unit.stage === "narration")!;
  const context = projectUnitContext({ plan: result.value, unit: narration, approved: new Map() });
  expect(context).toMatchObject({ ok: true });
  if (!context.ok) return;
  expect(context.value.playerUtterance).toBe(input.job.selectedDialogue!.label);
  const otherFocus = approvePlanningContext({ ...input, job: { ...input.job, focusNpcId: undefined } }, fixed);
  if (!otherFocus.ok) throw Error(otherFocus.code);
  const npc = otherFocus.value.units.find(unit => unit.stage === "character")!;
  const projected = projectUnitContext({ plan: otherFocus.value, unit: npc,
    approved: new Map([[narration.key, makeNarrationOutput()]]) });
  expect(projected.ok && projected.value.playerUtterance).toBe(null);
});
