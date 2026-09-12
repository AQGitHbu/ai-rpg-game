import { expect, it } from "vitest";
import { createStagedHarness } from "../testing/stagedNarrativeHarness.testutil";
import { createPendingDecisionRecord, makeDecisionPlan } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { createLiveStageSource } from "../server/ai/staged/liveStageSource";
import type { RpgAiClient } from "../server/ai/rpgAiClient";
import { approvePlanningContext } from "./approvePlanningContext";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import { asFactId } from "@/game/domain/worldEntity";

it.each(["none", "answers", "brief", "contentFactIds"] as const)("单规划器决定回答与最终候选，正常四次生成加前置及最终审核，旧不完整规划有界修复：missing=%s", async missing => {
  const cached = missing !== "none";
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok) throw Error("job");
  const record = createPendingDecisionRecord();
  const narrative = record.storyState.narrative;
  if (narrative.status !== "provider_pending") throw Error("pending");
  const base = makeDecisionPlan();
  if (base.decision?.kind !== "ordinary") throw Error("decision");
  const selected = { dialogueAct: "ask" as const, label: "告示是谁贴的，何时贴的？",
    task: { intent: "ask" as const, focusFactIds: ["fact_notice"], prerequisiteFactIds: [],
      inquiries: [{ factId: "fact_notice", aspects: ["source", "time"] as const }] } };
  const plan = { ...base, units: base.units.map(unit => unit.stage === "choices" ? unit : { ...unit,
    task: { intent: unit.stage === "narration" ? "describe" as const : "admit_unknown" as const,
      brief: unit.stage === "narration" ? "只承接玩家正在等待答复。" : "明确回答不知道告示由哪个衙门发布、何时贴出；不要复述告示内容。",
      focusFactIds: [], contentFactIds: [], prerequisiteFactIds: [], ...(unit.stage === "character" ? { answers: [
        { factId: "fact_notice", aspect: "source" as const, outcome: "unknown" as const, answerFactIds: [] },
        { factId: "fact_notice", aspect: "time" as const, outcome: "unknown" as const, answerFactIds: [] },
      ] } : {}) } }), decision: { ...base.decision, options: [
    { ...base.decision.options[0], target: null, deferredLocation: null, dialogueAct: "support" as const,
      task: { intent: "support" as const, brief: "感谢对方坦言不知道，并表示会向别处查证。",
        focusFactIds: [], contentFactIds: [], prerequisiteFactIds: [] } },
    { ...base.decision.options[1], target: null, deferredLocation: null, dialogueAct: "refuse" as const,
      task: { intent: "refuse" as const, brief: "表示不能就此放下调查，但不要求对方重复回答。",
        focusFactIds: [], contentFactIds: [], prerequisiteFactIds: [] } },
  ] as const } };
  const old = { ...plan, units: plan.units.map(unit => unit.stage === "character"
    ? { ...unit, task: { ...unit.task!,
      ...(missing === "answers" ? { answers: undefined } : {}),
      ...(missing === "brief" ? { brief: undefined } : {}),
      ...(missing === "contentFactIds" ? { contentFactIds: undefined } : {}),
    } } : unit) };
  const world = createWorldStateFixtureWith({ generation: record.worldState.generation, base: record.worldState }, {
    worldFacts: [...record.worldState.worldFacts, { factId: asFactId("fact_notice"), text: "告示已经张贴。", source: "generated", discovered: true }],
    eventLedger: record.worldState.eventLedger,
  });
  const input = { kind: "decision" as const, world, story: record.storyState,
    job: { ...narrative.job, selectedDialogue: selected } };
  // answers 与其他规则契约均合法，只有 live 的完整内容要求能拒绝这两类旧缓存。
  if (missing === "brief" || missing === "contentFactIds") {
    expect(approvePlanningContext(input, old).ok).toBe(true);
  }
  await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version, job: { ...stored.value,
    input, usedRequests: cached ? 1 : 0, units: cached ? [{ key: "planning", unit: null, inputDigest: stored.value.inputDigest,
      status: "approved", attempts: 1, value: old }] : [],
  } });
  const calls: { role: string; text: string }[] = [];
  const client = { complete: async (role, messages) => {
    const text = messages.map(message => message.content).join("\n");
    calls.push({ role, text });
    const value = role === "dialogue_consistency_review" ? { verdict: "pass", violations: [] } : role === "planning" ? plan : role === "narration"
      ? { stage: "narration", parts: [{ text: "你等她回答。", facts: [], evidence: [], beatIds: [] }], actionKeys: [] }
      : role === "character" ? { stage: "character", speakerId: base.decision!.npcId,
        parts: [{ text: "谁贴的、何时贴的，我都不知道。", facts: [], evidence: [], beatIds: [] }], actions: [], emotion: "neutral", answeredBeatIds: [] }
        : { stage: "choices", labels: [{ candidateId: plan.decision.options[0].candidateId, label: "多谢你坦言。" },
          { candidateId: plan.decision.options[1].candidateId, label: "这件事我不能就此罢休。" }] };
    return { ok: true, content: JSON.stringify(value), latencyMs: 1 };
  } } as RpgAiClient;
  Object.assign(h.source, createLiveStageSource({ client }));
  expect(h.source.requiresTaskBrief).toBe(true);
  const result = await h.run();
  expect(result).toMatchObject({ ok: true });
  expect(calls.map(call => call.role)).toEqual(["planning", "dialogue_consistency_review", "narration", "character", "choices", "dialogue_consistency_review"]);
  if (missing === "brief" || missing === "contentFactIds") {
    expect(calls[0]!.text).toContain("plan_task_missing");
  }
  expect(calls[3]!.text).toContain("明确表示不知道");
  expect(calls[3]!.text).not.toContain(plan.decision.options[0].candidateId);
  expect(calls[4]!.text).toContain("谁贴的、何时贴的，我都不知道。");
  if (result.ok) {
    expect(result.value.usedRequests).toBe(cached ? 7 : 6);
    expect(result.value.units.find(unit => unit.key === "planning")?.attempts).toBe(cached ? 2 : 1);
    expect(result.value.units.find(unit => unit.key === "planning")?.value).toEqual(plan);
  }
});
