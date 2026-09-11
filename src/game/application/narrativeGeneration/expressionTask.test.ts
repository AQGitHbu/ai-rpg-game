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
