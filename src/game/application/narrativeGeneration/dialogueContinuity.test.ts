import { expect, it } from "vitest";
import { repeatedDialogueCandidates } from "./dialogueContinuity";
import { createPendingDecisionRecord, makeDecisionPlan } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
it("only exact selected text repeats; legacy dimensions do not reinterpret different wording", () => {
  const record = createPendingDecisionRecord(); if (record.storyState.narrative.status !== "provider_pending") throw Error("fixture");
  const plan = makeDecisionPlan(); if (plan.decision?.kind !== "ordinary") throw Error("fixture");
  const job = { ...record.storyState.narrative.job, selectedDialogue: { dialogueAct: "ask" as const, label: plan.decision.options[0].publicIntent.text } };
  expect(repeatedDialogueCandidates(job, plan)).toEqual([plan.decision.options[0].candidateId]);
  expect(repeatedDialogueCandidates({ ...job, selectedDialogue: { ...job.selectedDialogue, label: "旧址从前是什么地方？" } }, plan)).toEqual([]);
});
