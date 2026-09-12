import { expect, it } from "vitest";
import { buildDialogueConsistencyReviewPrompt } from "./dialogueConsistencyReviewPrompt";
it("review compares complete drafts against authorized facts without an inquiry ontology", () => {
  const request = { items: [{ id: "polish_0", stage: "character" as const, draft: "潮汐里17号拆迁前是什么地方、为什么会被拆掉，这两点我都不知道。", text: "旧址的原用途和拆迁原因，我都不知道。", facts: [] }] };
  const prompt = buildDialogueConsistencyReviewPrompt(request);
  expect(prompt).toContain(JSON.stringify(request)); expect(prompt).toContain("failedIds");
  expect(prompt).not.toContain("inquiryTargets"); expect(prompt).not.toContain("checkId");
  expect(prompt).toContain("忠实照抄未授权原稿也应拒绝");
});
