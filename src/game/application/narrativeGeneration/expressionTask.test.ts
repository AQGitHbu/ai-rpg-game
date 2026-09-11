import { expect, it } from "vitest";
import { projectExpressionTask } from "./expressionTask";
import type { ExpressionTask } from "@/game/domain/expressionTask";

const task: ExpressionTask = { intent: "ask", focusFactIds: ["fact_0"], prerequisiteFactIds: [],
  inquiries: [{ factId: "fact_0", aspects: ["direction", "depth"] }] };
it("脚印走向与深浅保留为问题，不伪装成已知答案", () => {
  const result = projectExpressionTask(task, [{ id: "fact_0", text: "舱门旁有陌生脚印。", certainty: "known", sources: [] }]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toContain("走向");
  expect(result.value).toContain("深浅");
  expect(result.value).toContain("未知答案");
  expect(result.value).not.toContain("向北");
});
it("没有权限时退回，不静默简化询问", () => {
  expect(projectExpressionTask(task, [])).toMatchObject({ ok: false, code: "beat_authority_conflict" });
});

it("NPC 逐问题回应由规划决定，未知问题不授予知识，已答内容仍需授权", () => {
  const questions = [{ factId: "fact_notice", aspects: ["source", "time"] as const }];
  const reply: ExpressionTask = { intent: "inform", focusFactIds: ["fact_time"], prerequisiteFactIds: [], answers: [
    { factId: "fact_notice", aspect: "source", outcome: "unknown", answerFactIds: [] },
    { factId: "fact_notice", aspect: "time", outcome: "answer", answerFactIds: ["fact_time"] },
  ] };
  const facts = [{ id: "fact_time", text: "告示昨日贴出。", certainty: "suspected" as const, sources: [] }];
  const result = projectExpressionTask(reply, facts, questions);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toContain("明确表示不知道");
    expect(result.value).toContain("告示昨日贴出");
    expect(result.value).toContain("suspected");
  }
  expect(projectExpressionTask(reply, facts)).toMatchObject({ ok: false, code: "plan_reply_question_mismatch" });
  expect(projectExpressionTask(reply, [], questions)).toMatchObject({ ok: false, code: "beat_authority_conflict" });
});

it("完整 brief 原样主导协助对象与方式，话题背景不被强制复述", () => {
  const brief = "答应帮老人留意刀客的行踪，但不承诺独自追捕；先问清刀客装束。";
  const result = projectExpressionTask({ intent: "support", brief,
    focusFactIds: ["fact_blade", "fact_background"], contentFactIds: ["fact_blade"], prerequisiteFactIds: [] }, [
    { id: "fact_blade", text: "老人正在寻找一名佩刀客。", certainty: "known", sources: [] },
    { id: "fact_background", text: "老人曾在集市遇袭。", certainty: "known", sources: [] },
  ]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.split("\n")[0]).toBe(brief);
  expect(result.value).toContain("老人正在寻找一名佩刀客");
  expect(result.value).not.toContain("老人曾在集市遇袭");
  expect(result.value).not.toContain("任务：表明支持");
});

it("具体问题与未知范围完整交给表达器，显式越权事实仍被拒绝", () => {
  const brief = "明确回答自己不知道告示由哪个衙门发布，也不知道发布人的身份；不要复述告示内容。";
  const task: ExpressionTask = { intent: "admit_unknown", brief, focusFactIds: ["fact_notice"],
    contentFactIds: [], prerequisiteFactIds: [], answers: [
      { factId: "fact_notice", aspect: "source", outcome: "unknown", answerFactIds: [] },
    ] };
  const result = projectExpressionTask(task,
    [{ id: "fact_notice", text: "城门贴有告示。", certainty: "known", sources: [] }],
    [{ factId: "fact_notice", aspects: ["source"] }]);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.split("\n")[0]).toBe(brief);
    expect(result.value).not.toContain("具体内容：城门贴有告示");
  }
  expect(projectExpressionTask({ ...task, focusFactIds: ["fact_secret"] }, [],
    [{ factId: "fact_notice", aspects: ["source"] }]))
    .toMatchObject({ ok: false, code: "beat_authority_conflict" });
});
