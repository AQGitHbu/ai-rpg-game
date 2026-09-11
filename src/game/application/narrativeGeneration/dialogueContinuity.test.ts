import { expect, it } from "vitest";
import { repeatedDialogueCandidates, plannedReplyRejection } from "./dialogueContinuity";
import { createPendingDecisionRecord, makeDecisionPlan } from "@/game/domain/testing/stagedNarrativeFixture.testutil";

it("问询比较不依赖维度顺序，重复子集也拒绝；旧任务、其他 NPC 和未来场景不误拦", () => {
  const narrative = createPendingDecisionRecord().storyState.narrative;
  if (narrative.status !== "provider_pending") throw Error("pending");
  const base = makeDecisionPlan();
  if (base.decision?.kind !== "ordinary") throw Error("ordinary");
  const task = { intent: "ask" as const, focusFactIds: ["fact_0"], prerequisiteFactIds: [],
    inquiries: [{ factId: "fact_0", aspects: ["source", "time"] as const }] };
  const job = { ...narrative.job, focusNpcId: base.decision.npcId as typeof narrative.job.focusNpcId,
    selectedDialogue: { dialogueAct: "ask" as const, task } };
  const proposal = { ...base, decision: { ...base.decision, options: [
    { ...base.decision.options[0], task: { ...task, inquiries: [{ factId: "fact_0", aspects: ["time" as const] }] } },
    base.decision.options[1],
  ] as const } };
  expect(repeatedDialogueCandidates(job, proposal)).toEqual([base.decision.options[0].candidateId]);
  for (const next of [
    { ...task, intent: "challenge" as const },
    { ...task, inquiries: [{ factId: "fact_0", aspects: ["source", "purpose"] as const }] },
    { ...task, inquiries: [] },
  ]) expect(repeatedDialogueCandidates(job, { ...proposal, decision: { ...proposal.decision, options: [
    { ...proposal.decision.options[0], task: next }, proposal.decision.options[1],
  ] } })).toEqual([base.decision.options[0].candidateId]);
  expect(repeatedDialogueCandidates({ ...job, selectedDialogue: { dialogueAct: "ask" } }, proposal)).toEqual([]);
  expect(repeatedDialogueCandidates(job, { ...proposal, decision: { ...proposal.decision, npcId: "another" } })).toEqual([]);
  expect(repeatedDialogueCandidates(job, { ...proposal, decision: { ...proposal.decision,
    point: { stepKey: "future", order: 0 } } })).toEqual([]);
});

it("统一规划必须回答全部已问维度，不能交给未来场景或其他 NPC", () => {
  const narrative = createPendingDecisionRecord().storyState.narrative;
  if (narrative.status !== "provider_pending") throw Error("pending");
  const base = makeDecisionPlan();
  const job = { ...narrative.job, selectedDialogue: { dialogueAct: "ask" as const,
    task: { intent: "ask" as const, focusFactIds: ["fact_0"], prerequisiteFactIds: [],
      inquiries: [{ factId: "fact_0", aspects: ["source", "time"] as const }] } } };
  const reply = { intent: "admit_unknown" as const, focusFactIds: [], prerequisiteFactIds: [],
    answers: ["source", "time"].map(aspect => ({ factId: "fact_0", aspect: aspect as "source" | "time",
      outcome: "unknown" as const, answerFactIds: [] })) };
  const make = (task: typeof reply) => ({ ...base, units: base.units.map(unit => unit.stage === "character" ? { ...unit, task } : unit) });
  expect(plannedReplyRejection(job, make(reply))).toBeNull();
  expect(plannedReplyRejection(job, { ...base, units: base.units.filter(unit => unit.stage !== "character") })).toBe("plan_reply_missing");
  expect(plannedReplyRejection(job, base)).toBe("plan_reply_missing");
  expect(plannedReplyRejection(job, make({ ...reply, answers: reply.answers.slice(0, 1) }))).toBe("plan_reply_missing");
  const wrongNpc = make(reply);
  expect(plannedReplyRejection(job, { ...wrongNpc, units: wrongNpc.units.map(unit => unit.stage === "character"
    ? { ...unit, speakerId: "other_npc" } : unit) })).toBe("plan_reply_question_mismatch");
});
