import { expect, it } from "vitest";
import { dialogueReviewHarness } from "./dialogueConsistencyFixture.testutil";
import { approvePlanningContext } from "./approvePlanningContext";
import { dialogueConsistencyReviewInput, parsePolishReviewVerdict, validateJobDialogueConsistencyReview } from "./dialogueConsistencyReview";
import type { PlanProposal } from "@/game/domain/narrativePlan";

it("strict small protocol rejects old aspects, foreign/duplicate IDs and malformed pass", () => {
  const request = { items: [{ id: "polish_0", stage: "character" as const, draft: "我不知道旧址是什么地方。", text: "我不知道旧址是什么地方。", facts: [] }] };
  expect(parsePolishReviewVerdict({ verdict: "pass", failedIds: [] }, request).ok).toBe(true);
  expect(parsePolishReviewVerdict({ verdict: "reject", failedIds: ["polish_0"] }, request).ok).toBe(true);
  for (const value of [{ verdict: "pass", failedIds: ["polish_0"] }, { verdict: "uncertain", failedIds: ["polish_0"] },
    { verdict: "reject", failedIds: [] }, { verdict: "reject", failedIds: ["unknown"] },
    { verdict: "reject", failedIds: ["polish_0", "polish_0"] }, { verdict: "pass", violations: [] },
    { verdict: "reject", failedIds: ["polish_0"], scope: "planning" }]) expect(parsePolishReviewVerdict(value, request).ok).toBe(false);
});

it("whole package covers narration/NPC/both candidates with actual selected words and scoped facts", async () => {
  const { h } = await dialogueReviewHarness();
  h.source.reviewDialogueConsistency = async request => {
    expect(request.items.map(item => item.stage)).toEqual(["narration", "character", "choices", "choices"]);
    expect(request.items.find(item => item.stage === "character")?.selectedLabel).toBe("从哪儿听来的，消息可靠吗？");
    expect(JSON.stringify(request)).not.toContain('"inquiries"');
    expect(request.items.find(item => item.stage === "character")?.facts).toEqual([]);
    return { ok: true, verdict: "pass", failedIds: [] };
  };
  expect((await h.run()).ok).toBe(true);
});

it.each(["draft", "text", "cycle", "context", "legacy"])("publication receipt invalidated by %s mutation", async change => {
  const { h } = await dialogueReviewHarness(); const ready = await h.run(); if (!ready.ok) throw Error(ready.code);
  let job = ready.value;
  if (change === "cycle") job = { ...job, cycle: job.cycle + 1 };
  if (change === "context") job = { ...job, inputDigest: "changed" };
  if (change === "legacy") job = { ...job, dialogueConsistencyReview: { ...job.dialogueConsistencyReview!, version: 1 } };
  job = { ...job, units: job.units.map(stored => {
    if (change === "draft" && stored.key === "planning" && stored.value !== null && "units" in stored.value)
      return { ...stored, value: { ...stored.value, units: stored.value.units.map(unit => unit.draft?.stage === "character"
        ? { ...unit, draft: { ...unit.draft, parts: unit.draft.parts.map(part => ({ ...part, text: "我拒绝回答。" })) } } : unit) } };
    if (change === "text" && stored.value !== null && "stage" in stored.value && stored.value.stage === "character")
      return { ...stored, value: { ...stored.value, parts: stored.value.parts.map(part => ({ ...part, text: "我拒绝回答。" })) } };
    return stored;
  }) };
  const plan = approvePlanningContext(job.input, job.units.find(unit => unit.key === "planning")!.value as PlanProposal);
  if (!plan.ok) throw Error(plan.code);
  expect(dialogueConsistencyReviewInput(job, plan.value).ok).toBe(true);
  expect(validateJobDialogueConsistencyReview(job, plan.value).ok).toBe(false);
});
