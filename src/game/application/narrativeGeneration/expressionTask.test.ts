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
