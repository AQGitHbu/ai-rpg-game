import { createPendingDecisionRecord, makeDecisionPlan, makeCharacterOutput, makeNarrationOutput } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { asFactId } from "@/game/domain/worldEntity";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import { createStagedHarness } from "../testing/stagedNarrativeHarness.testutil";

export async function dialogueReviewHarness(selected = true) {
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok) throw Error(stored.code);
  const record = createPendingDecisionRecord();
  if (record.storyState.narrative.status !== "provider_pending") throw Error("fixture");
  const base = makeDecisionPlan();
  if (base.decision?.kind !== "ordinary") throw Error("fixture");
  const labels = base.decision.options.map((option, i) => ({ candidateId: option.candidateId,
    label: selected ? i === 0 ? "多谢坦言。" : "此事我不能放下。" : i === 0 ? "这告示可信吗？" : "多谢坦言。" }));
  const plan: PlanProposal = { ...base, units: base.units.map(unit => ({ ...unit, draft: unit.stage === "narration" ? makeNarrationOutput()
    : unit.stage === "character" ? { ...makeCharacterOutput(unit.speakerId!), parts: [{ text: "从哪儿传来、是否可信，我都不知道。", facts: [], evidence: [], beatIds: [] }] }
      : { stage: "choices", labels } })), decision: { ...base.decision, options: base.decision.options.map((option, i) => ({ ...option,
    target: null, deferredLocation: null, dialogueAct: selected ? (i === 0 ? "support" : "refuse") : (i === 0 ? "ask" : "support"),
    publicIntent: { text: labels[i]!.label, facts: !selected && i === 0 ? [{ factId: "fact_notice", certainty: "known" }] : [], evidence: [], beatIds: [] },
  })) as unknown as Extract<NonNullable<PlanProposal["decision"]>, { kind: "ordinary" }>["options"] } };
  const job = { ...record.storyState.narrative.job,
    selectedDialogue: selected ? { dialogueAct: "ask" as const, label: "从哪儿听来的，消息可靠吗？", task: {
      intent: "ask" as const, focusFactIds: ["fact_notice"], prerequisiteFactIds: [],
      inquiries: [{ factId: "fact_notice", aspects: ["source", "reliability"] as const }],
    } } : undefined,
  };
  await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version,
    job: { ...stored.value, input: { kind: "decision", world: createWorldStateFixtureWith({ generation: record.worldState.generation, base: record.worldState }, {
      worldFacts: [...record.worldState.worldFacts, { factId: asFactId("fact_notice"), text: "告示说北滩曾出现陌生人。", source: "generated", discovered: true }],
      eventLedger: record.worldState.eventLedger,
    }), story: record.storyState, job } } });
  const requests: Parameters<typeof h.source.generate>[0][] = [];
  h.source.generate = async request => {
    requests.push(request);
    if (request.stage === "planning") return { ok: true, stage: "planning", value: plan };
    if (request.stage === "narration") return { ok: true, stage: "narration", value: makeNarrationOutput() };
    if (request.stage === "character") return { ok: true, stage: "character", value: { ...makeCharacterOutput(request.context.unit.speakerId!),
      parts: [{ text: "从哪儿传来、是否可信，我都不知道。", facts: [], evidence: [], beatIds: [] }] } };
    return { ok: true, stage: "choices", value: { stage: "choices", labels: request.context.options.map((option, i) => ({
      candidateId: option.candidateId, label: selected ? (i === 0 ? "多谢坦言。" : "此事我不能放下。")
        : (i === 0 ? "这告示可信吗？" : "多谢坦言。"),
    })) } };
  };
  return { h, plan, requests };
}
