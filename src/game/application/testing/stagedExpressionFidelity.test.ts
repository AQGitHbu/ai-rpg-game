import { expect, it } from "vitest";
import { identityInquiryContext, controlledDisclosureHarness } from "./stagedExpressionFidelity.testutil";
import { buildChoicePrompt } from "../server/ai/staged/choicePrompt";
import type { StageSource } from "../narrativeGeneration/stageSource";

it("固定失败样本保留身份和两个完整询问初稿", () => {
  const context = identityInquiryContext();
  expect(context.dialogue).toMatchObject({ speakerName: "凯伦", addresseeName: "林澈" });
  expect(context.options[0]?.publicIntent.text).toContain("深浅");
  expect(context.options[1]?.publicIntent.text).toContain("可信程度");
  expect(context.options[1]?.publicIntent.text).not.toContain("深浅");
  expect(buildChoicePrompt(context)).toContain("说话身份");
});
it.each(["reject", "uncertain"] as const)("受控 %s 审核不能调用下游", async verdict => {
  const h = await controlledDisclosureHarness("受控负例");
  (h.source as StageSource).reviewDisclosure = async () => ({ ok: true, verdict });
  expect(await h.run()).toMatchObject({ ok: false, code: `disclosure_review_${verdict}` });
  expect(h.calls.filter(call => call.stage === "choices")).toHaveLength(0);
  expect(h.publications()).toHaveLength(0);
});
