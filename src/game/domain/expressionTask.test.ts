import { expect, it } from "vitest";
import { parseExpressionTask } from "./expressionTask";
import { parseUnit } from "./narrativeUnit";
import { parseBranchOption } from "./narrativeBranch";
import { makeStagedPlan } from "./testing/stagedNarrativeFixture.testutil";

const task = { intent: "offer", focusFactIds: ["fact_0"], prerequisiteFactIds: ["fact_1"] };
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
