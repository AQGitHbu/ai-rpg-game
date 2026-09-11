import { expect, it } from "vitest";
import { parseExpressionTask, requiredExpressionFactIds } from "./expressionTask";
import { parseUnit } from "./narrativeUnit";
import { parseBranchOption } from "./narrativeBranch";
import { makeStagedPlan } from "./testing/stagedNarrativeFixture.testutil";

const task = { intent: "offer" as const, focusFactIds: ["fact_0"], prerequisiteFactIds: ["fact_1"] };
it("完整 brief 与正文事实经过严格解析并原样保留", () => {
  const concrete = { ...task, brief: "答应帮老人留意刀客的行踪，并说明会先问清装束。",
    contentFactIds: ["fact_0"] };
  expect(parseExpressionTask(concrete)).toEqual(concrete);
  expect(parseUnit({ ...makeStagedPlan().units[1], task: concrete })?.task).toEqual(concrete);
  expect(parseBranchOption({ ...makeStagedPlan().decision!.options[0], task: concrete }).ok).toBe(true);
  expect(parseExpressionTask({ ...concrete, contentFactIds: ["fact_secret"] })).toBeNull();
  expect(parseExpressionTask({ ...concrete, brief: "" })).toBeNull();
  expect(parseExpressionTask({ ...concrete, brief: "x".repeat(1201) })).toBeNull();
});
it("正文事实与话题背景分离，旧任务继续要求原 focus", () => {
  const answer = { factId: "fact_notice", aspect: "source" as const, outcome: "answer" as const,
    answerFactIds: ["fact_answer"] };
  expect(requiredExpressionFactIds({ intent: "inform", brief: "回答告示由哪个衙门发布。",
    focusFactIds: ["fact_notice", "fact_answer", "fact_background"], contentFactIds: ["fact_notice"],
    prerequisiteFactIds: ["fact_condition"], answers: [answer] }))
    .toEqual(["fact_notice", "fact_condition", "fact_answer"]);
  expect(requiredExpressionFactIds(task)).toEqual(["fact_0", "fact_1"]);
});
it("回应结果随任务解析保存，答案事实必须属于任务，未知/拒答不能夹带答案", () => {
  const answer = { factId: "fact_question", aspect: "source", outcome: "answer", answerFactIds: ["fact_0"] };
  const reply = { ...task, intent: "inform", answers: [answer] };
  expect(parseExpressionTask(reply)).toEqual(reply);
  expect(parseUnit({ ...makeStagedPlan().units[1], task: reply })?.task).toEqual(reply);
  for (const invalid of [
    { ...answer, answerFactIds: ["fact_secret"] }, { ...answer, answerFactIds: [] },
    { ...answer, outcome: "unknown" }, { ...answer, outcome: "refuse" },
    { ...answer, text: "隐藏答案" }, { ...answer, aspect: "invented" }, { ...answer, outcome: "maybe" },
  ]) expect(parseExpressionTask({ ...reply, answers: [invalid] })).toBeNull();
  expect(parseExpressionTask({ ...reply, answers: [answer, answer] })).toBeNull();
  expect(parseExpressionTask({ ...reply, focusFactIds: [], answers: [{ ...answer, outcome: "unknown", answerFactIds: [] }] })).not.toBeNull();
});
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
