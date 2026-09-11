import { expect, it } from "vitest";
import { parseExpressionTask } from "./expressionTask";
import { parseUnit } from "./narrativeUnit";
import { parseBranchOption } from "./narrativeBranch";
import { makeStagedPlan } from "./testing/stagedNarrativeFixture.testutil";

const task = { intent: "offer", focusFactIds: ["fact_0"], prerequisiteFactIds: ["fact_1"] };
it("具体询问维度通过 Unit 和候选解析后不丢失", () => {
  const detailed = { intent: "ask", focusFactIds: ["fact_0"], prerequisiteFactIds: [],
    inquiries: [{ factId: "fact_0", aspects: ["direction", "depth"] }] };
  expect(parseExpressionTask(detailed)).toEqual(detailed);
  expect(parseUnit({ ...makeStagedPlan().units[1], task: detailed })?.task).toEqual(detailed);
  const option = parseBranchOption({ ...makeStagedPlan().decision!.options[0], dialogueAct: "ask", task: detailed });
  expect(option.ok && option.value.task).toEqual(detailed);
});
it.each([
  { factId: "fact_hidden", aspects: ["direction"] },
  { factId: "fact_0", aspects: ["secret_answer"] },
  { factId: "fact_0", aspects: ["direction", "direction"] },
  { factId: "fact_0", aspects: [] },
  { factId: "fact_0", aspects: ["direction"], answer: "秘密" },
])("询问维度必须受控且锚定可表达事实：%j", inquiry => {
  expect(parseExpressionTask({ intent: "ask", focusFactIds: ["fact_0"], prerequisiteFactIds: [],
    inquiries: [inquiry] })).toBeNull();
});
it("非问询意图不能夹带追问条件", () => {
  expect(parseExpressionTask({ ...task, inquiries: [{ factId: "fact_0", aspects: ["direction"] }] })).toBeNull();
});
it("严格重建任务，保留具体主题与先后条件", () => {
  expect(parseExpressionTask(task)).toEqual(task);
  expect(parseUnit({ ...makeStagedPlan().units[1], task })?.task).toEqual(task);
  const decision = makeStagedPlan().decision!;
  const option = parseBranchOption({ ...decision.options[0], task });
  expect(option.ok && option.value.task).toEqual(task);
});
it.each([
  { ...task, text: "秘密原文" }, { ...task, intent: "invent_quest" },
  { ...task, focusFactIds: ["fact_0", "fact_0"] }, { ...task, prerequisiteFactIds: ["秘密正文"] },
  { ...task, prerequisiteFactIds: null },
])("禁止任务自由正文、非法键和值：%j", value => {
  expect(parseExpressionTask(value)).toBeNull();
  expect(parseUnit({ ...makeStagedPlan().units[0], task: value })).toBeNull();
});
it("任务表达目的不得改写候选行动语义", () => {
  const decision = makeStagedPlan().decision!;
  expect(parseBranchOption({ ...decision.options[0], task: { ...task, intent: "refuse" } }))
    .toMatchObject({ ok: false, code: "branch_option_task_invalid" });
});
