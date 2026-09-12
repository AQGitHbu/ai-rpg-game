import { expect, it } from "vitest";
import { createStagedHarness } from "../testing/stagedNarrativeHarness.testutil";
import { makeDecisionPlan, createPendingDecisionRecord } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import { asFactId } from "@/game/domain/worldEntity";

it.each(["fresh", "cached", "exhausted"])("重复问询有界重规划，旧缓存也撤销且不发布半包：%s", async mode => {
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok || stored.value.input.kind !== "decision") throw Error("decision");
  const base = makeDecisionPlan();
  if (base.decision?.kind !== "ordinary") throw Error("ordinary");
  const task = { intent: "ask" as const, focusFactIds: [], prerequisiteFactIds: [],
    inquiries: [{ factId: "fact_0", aspects: ["source", "time"] as const }] };
  // Full valid task; duplicate approval precedes expression perspective projection.
  const asked = { ...task, focusFactIds: ["fact_0"] };
  const bad = { ...base, units: base.units.map(unit => unit.stage !== "character" ? unit : { ...unit,
    task: { intent: "admit_unknown" as const, focusFactIds: [], contentFactIds: [], prerequisiteFactIds: [],
      answers: ["source", "time"].map(aspect => ({ factId: "fact_0", aspect: aspect as "source" | "time",
        outcome: "unknown" as const, answerFactIds: [] })) } }), decision: { ...base.decision, options: [
    { ...base.decision.options[0], target: null, deferredLocation: null, dialogueAct: "ask" as const, task: asked },
    { ...base.decision.options[1], target: null, deferredLocation: null },
  ] as const } };
  const good = { ...bad, decision: { ...bad.decision, options: [
    { ...bad.decision.options[0], dialogueAct: "support" as const, task: undefined }, bad.decision.options[1],
  ] as const } };
  const record = createPendingDecisionRecord();
  if (record.storyState.narrative.status !== "provider_pending") throw Error("pending");
  const world = createWorldStateFixtureWith({ generation: record.worldState.generation, base: record.worldState }, {
    worldFacts: [...record.worldState.worldFacts, { factId: asFactId("fact_0"), text: "渡口有一则告示。", source: "generated", discovered: true }],
    eventLedger: record.worldState.eventLedger,
  });
  const input = { kind: "decision" as const, world, story: record.storyState, job: { ...record.storyState.narrative.job,
    selectedDialogue: { dialogueAct: "ask" as const, label: "谁说的，什么时候？", task: asked } } };
  const cached = mode === "cached";
  expect((await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version,
    job: { ...stored.value, input, usedRequests: cached ? 1 : 0,
      units: cached ? [{ key: "planning", unit: null, inputDigest: stored.value.inputDigest,
        status: "approved", attempts: 1, value: bad }] : [],
    } })).ok).toBe(true);

  let plans = 0;
  h.source.generate = async (request, execution) => {
    if (request.stage === "narration") return { ok: true, stage: "narration", value: { stage: "narration", parts: [{ text: "你等着答复。", facts: [], evidence: [], beatIds: [] }], actionKeys: [] } };
    if (request.stage === "character") return { ok: true, stage: "character", value: { stage: "character", speakerId: base.decision!.npcId, parts: [{ text: "我不知道。", facts: [], evidence: [], beatIds: [] }], actions: [], emotion: "neutral", answeredBeatIds: [] } };
    if (request.stage === "choices") return { ok: true, stage: "choices", value: { stage: "choices", labels: [{ candidateId: "current_scene_choice_1", label: "我相信你。" }, { candidateId: "current_scene_choice_2", label: "我还是不信。" }] } };
    plans++;
    if (execution.repair) expect(execution.repair.rejectionCode).toBe("plan_dialogue_repeated");
    return { ok: true, stage: "planning", value: mode === "exhausted" || (!cached && plans === 1) ? bad : good };
  };
  const result = await h.run();
  if (mode === "exhausted") {
    expect(result).toMatchObject({ ok: false, code: "plan_dialogue_repeated" });
    expect(plans).toBe(4);
    expect(h.publications()).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  } else {
    expect(result).toMatchObject({ ok: true });
    expect(plans).toBe(cached ? 1 : 2);
    if (result.ok) expect(result.value.usedRequests).toBe(7);
  }
});
