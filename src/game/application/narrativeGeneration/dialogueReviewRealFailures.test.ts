import { expect, it } from "vitest";
import { compileDialogueReviewChecks, parseDialogueReviewVerdict, routeDialogueReviewVerdict } from "./dialogueReviewChecks";
import { realReviewSubjects, realReviewFailures } from "./dialogueReviewRealFailures.testutil";

it("真实unknown完整回答只绑定本轮source/purpose，未来候选不能污染回答检查", () => {
  const compiled = compileDialogueReviewChecks(realReviewSubjects.unknown);
  const reply = compiled.request.checks.find(c => c.kind === "answer")!;
  expect(reply).not.toHaveProperty("options");
  expect(reply.inquiries.map(q => q.aspect)).toEqual(["source", "purpose"]);
  expect(reply.text).toContain("为什么用这种方式发出来，我也不知道");
  expect(reply.intent).toBe("admit_unknown");
  expect(compiled.request).not.toHaveProperty("conversations");
});

it.each(realReviewFailures)("拒绝真实旧协议错误输出：$source", failure => {
  const { request } = compileDialogueReviewChecks(realReviewSubjects.unknown);
  expect(parseDialogueReviewVerdict(failure.verdict, request)).toBeNull();
});

it("未知检查项、跨项问题ID及未问维度缺答是协议错误", () => {
  const { request } = compileDialogueReviewChecks(realReviewSubjects.unknown);
  const reply = request.checks.find(c => c.kind === "answer")!;
  const other = request.checks.find(c => c.kind === "option")!;
  for (const [checkId, inquiryId] of [["unknown", reply.inquiries[0]!.inquiryId],
    [reply.checkId, other.inquiries[0]!.inquiryId],
    [reply.checkId, reply.inquiryTargets.find(q => q.aspect === "time")!.inquiryId]]) {
    expect(parseDialogueReviewVerdict({ verdict: "reject", violations: [{ checkId, inquiryId, type: "missing_response" }] }, request)).toBeNull();
  }
});

it("两个相同aspect不同fact的inquiryId不同；缺答只路由服务端对应单元", () => {
  const subject = realReviewSubjects.unknown[0]!;
  const compiled = compileDialogueReviewChecks([{ ...subject, inquiries: [
    { factId: "fact_a", aspects: ["source"] }, { factId: "fact_b", aspects: ["source"] },
  ] }]);
  const reply = compiled.request.checks.find(c => c.kind === "answer")!;
  expect(new Set(reply.inquiries.map(q => q.inquiryId)).size).toBe(2);
  const verdict = parseDialogueReviewVerdict({ verdict: "reject", violations: [{ checkId: reply.checkId,
    inquiryId: reply.inquiries[1]!.inquiryId, type: "missing_response" }] }, compiled.request)!;
  expect(routeDialogueReviewVerdict(verdict, compiled)).toEqual({ verdict: "reject", violations: [
    { scope: "expression", unitKey: subject.unitKey, type: "missing_response", aspect: "source", factId: "fact_b" },
  ] });
});

it("生产StageSource请求只发送checks并包含NPC自身获批intent", async () => {
  const { dialogueReviewHarness } = await import("./dialogueConsistencyFixture.testutil");
  const { h } = await dialogueReviewHarness();
  h.source.reviewDialogueConsistency = async request => {
    expect(request).not.toHaveProperty("conversations");
    expect(request.checks.find(c => c.kind === "plan_answer")?.intent).toBe("admit_unknown");
    return { ok: true, verdict: "pass", violations: [] };
  };
  expect((await h.run()).ok).toBe(true);
});

it.each(Object.entries(realReviewSubjects))("最小真实样本%s的完整检查请求保持在现有上下文预算内", (_name, subjects) => {
  const request = compileDialogueReviewChecks(subjects).request;
  expect([...JSON.stringify(request)].length).toBeLessThanOrEqual(16_000);
});

it("真实未来time/reliability只能定位未来选项，不能成为当前NPC缺答", () => {
  const { request } = compileDialogueReviewChecks(realReviewSubjects.future);
  const answer = request.checks.find(c => c.kind === "answer")!;
  const option = request.checks.find(c => c.kind === "option")!;
  expect(answer.inquiries).toEqual([]);
  expect(answer.text).toContain("现有仪表上，我确认不了。不知道");
  for (const q of option.inquiries) expect(parseDialogueReviewVerdict({ verdict: "reject", violations: [
    { checkId: answer.checkId, inquiryId: q.inquiryId, type: "missing_response" },
  ] }, request)).toBeNull();
});

it("真正遗漏source的固定反例仍可拒绝，unknown/refuse不能仅凭元数据自动pass", () => {
  const compiled = compileDialogueReviewChecks(realReviewSubjects.missingSource);
  const answer = compiled.request.checks.find(c => c.kind === "answer")!;
  expect(answer.text).toBe("可信不可信，我说不准。");
  expect(answer.answers.map(a => a.outcome)).toEqual(["unknown", "unknown"]);
  for (const type of ["missing_response", "answer_mismatch"] as const) {
    const verdict = parseDialogueReviewVerdict({ verdict: "reject", violations: [
      { checkId: answer.checkId, inquiryId: answer.inquiries.find(q => q.aspect === "source")!.inquiryId, type },
    ] }, compiled.request)!;
    expect(routeDialogueReviewVerdict(verdict, compiled).violations[0]).toEqual({
      scope: "expression", unitKey: "character_current", type, aspect: "source", factId: "fact_rumor",
    });
  }
});

it("空inquiries的真实武侠计划仍能按授权话题报告额外提问，成稿ID不改变修复层级", () => {
  const compiled = compileDialogueReviewChecks(realReviewSubjects.wuxia);
  for (const kind of ["plan_option", "option"] as const) {
    const check = compiled.request.checks.find(c => c.kind === kind)!;
    expect(check.inquiries).toEqual([]);
    const verdict = parseDialogueReviewVerdict({ verdict: "reject", violations: [{ checkId: check.checkId,
      inquiryId: check.inquiryTargets.find(q => q.factId === "fact_0" && q.aspect === "identity")!.inquiryId,
      type: "extra_inquiry" }] }, compiled.request)!;
    expect(routeDialogueReviewVerdict(verdict, compiled).violations[0]).toEqual({
      scope: kind === "plan_option" ? "planning" : "expression", candidateId: "r_ask_token",
      type: "extra_inquiry", aspect: "identity", factId: "fact_0",
    });
  }
});

it("无成稿时可编译计划检查，不制造实际回答，也不把自身意图与历史意图混用", () => {
  const subjects = realReviewSubjects.unknown.map(({ text: _text, ...subject }) => subject);
  const { request } = compileDialogueReviewChecks(subjects);
  expect(request.checks.map(c => c.kind)).toEqual(["selected", "plan_answer", "plan_option"]);
  expect(request.checks.find(c => c.kind === "plan_answer")).toMatchObject({ intent: "admit_unknown" });
  expect(request.checks.find(c => c.kind === "selected")).toMatchObject({ intent: "ask" });
  expect(request.checks.find(c => c.kind === "plan_answer")).not.toHaveProperty("text");
});

it("计划检查使用安全验证后的原始brief，不让编译追加的回答指令掩盖漏答", async () => {
  const { dialogueReviewHarness } = await import("./dialogueConsistencyFixture.testutil");
  const { h } = await dialogueReviewHarness();
  const generate = h.source.generate;
  h.source.generate = async (request, execution) => {
    const result = await generate(request, execution);
    if (!result.ok || result.stage !== "planning") return result;
    return { ...result, value: { ...result.value, units: result.value.units.map(unit => unit.stage !== "character" ? unit
      : { ...unit, task: { ...unit.task!, brief: "消息来源我不知道。" } }) } };
  };
  h.source.reviewDialogueConsistency = async request => {
    const plan = request.checks.find(c => c.kind === "plan_answer")!;
    expect(plan.brief).toBe("消息来源我不知道。");
    expect(plan.inquiries.map(q => q.aspect)).toEqual(["source", "reliability"]);
    expect(plan.answers.map(a => a.aspect)).toEqual(["source", "reliability"]);
    expect(plan).not.toHaveProperty("text");
    return { ok: true, verdict: "reject", violations: [{ checkId: plan.checkId,
      inquiryId: plan.inquiries.find(q => q.aspect === "reliability")!.inquiryId, type: "missing_response" }] };
  };
  expect(await h.run()).toMatchObject({ ok: false, code: "dialogue_consistency_planning_contract" });
});

it.each(["unknown_check", "cross_inquiry", "old_dual_target"])("运行器把%s作为协议失败，不撤销已批准表达", async failure => {
  const { dialogueReviewHarness } = await import("./dialogueConsistencyFixture.testutil");
  const { h, requests } = await dialogueReviewHarness(false);
  h.source.reviewDialogueConsistency = async request => {
    const reply = request.checks.find(c => c.kind === "answer")!;
    const option = request.checks.find(c => c.kind === "option")!;
    const violation = failure === "old_dual_target" ? { scope: "expression", unitKey: "character_current",
      candidateId: "candidate_1", type: "extra_inquiry", aspect: "source" }
      : { checkId: failure === "unknown_check" ? "check_absent" : reply.checkId,
        type: "missing_response", inquiryId: option.inquiries[0]!.inquiryId };
    return { ok: true, verdict: "reject", violations: [violation] } as never;
  };
  expect(await h.run()).toMatchObject({ ok: false, code: "dialogue_consistency_review_failed" });
  const loaded = await h.readJob();
  if (!loaded.ok) throw Error(loaded.code);
  expect(loaded.value.units.every(u => u.status === "approved")).toBe(true);
  expect(loaded.value.dialogueConsistencyReview?.attempts).toBe(2);
  expect(loaded.value.dialogueConsistencyReview?.violations).toBeUndefined();
  expect(requests.filter(r => r.stage === "choices")).toHaveLength(1);
  expect(h.publications()).toHaveLength(0);
});

it("model cannot supply routing, wrong type or unbound intent/aspect combinations", () => {
  const { request } = compileDialogueReviewChecks(realReviewSubjects.unknown);
  const answer = request.checks.find(c => c.kind === "answer")!;
  const option = request.checks.find(c => c.kind === "option")!;
  const valid = { checkId: answer.checkId, type: "missing_response", inquiryId: answer.inquiries[0]!.inquiryId };
  for (const violation of [{ ...valid, scope: "planning" }, { ...valid, candidateId: "model_target" },
    { ...valid, inquiryId: null }, { ...valid, type: "intent_mismatch" }, { ...valid, type: "extra_inquiry" },
    { ...valid, type: "answer_mismatch", checkId: option.checkId, inquiryId: option.inquiries[0]!.inquiryId },
    { ...valid, type: "invented" }]) expect(parseDialogueReviewVerdict({ verdict: "reject", violations: [violation] }, request)).toBeNull();
});

it("每个检查只收到自己授权的话题/条件/答案事实，未知答案不扩大权限", () => {
  const [reply, option] = realReviewSubjects.unknown;
  const fact = (id: string) => ({ id, text: `authorized ${id}`, certainty: "known" as const, sources: [] });
  const facts = [fact("fact_0"), fact("fact_3"), fact("answer_fact"), fact("unrelated_fact")];
  const compiled = compileDialogueReviewChecks([{ ...reply!, topicFactIds: [], facts,
    answers: [{ factId: "fact_3", aspect: "source", outcome: "answer", answerFactIds: ["answer_fact"] }] },
  { ...option!, facts }]);
  expect(compiled.request.checks.find(c => c.kind === "answer")!.facts.map(f => f.id)).toEqual(["fact_3", "answer_fact"]);
  expect(compiled.request.checks.find(c => c.kind === "option")!.facts.map(f => f.id)).toEqual(["fact_0"]);
  expect(compiled.request.checks.find(c => c.kind === "selected")!.facts.map(f => f.id)).toEqual(["fact_3"]);
  expect(JSON.stringify(compiled.request)).not.toContain("unrelated_fact");
  expect(compiled.request.checks.find(c => c.kind === "answer")!.inquiryTargets.some(q => q.factId === "fact_0")).toBe(false);
});
