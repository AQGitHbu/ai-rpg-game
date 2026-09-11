import { expect, it, vi } from "vitest";
import { createStagedHarness } from "../testing/stagedNarrativeHarness.testutil";
import { createAiSourceFailure } from "../aiGenerationRetry";
import { dialogueReviewHarness } from "./dialogueConsistencyFixture.testutil";
import { runJob } from "./runJob";
import type { StageSource } from "./stageSource";

it.each([false, true])("free-text有selectedDialogue仍不是旧固定选项；错误legacy verdict不放行：%s", async misclassified => {
  const { h } = await dialogueReviewHarness(false);
  const stored = await h.readJob();
  if (!stored.ok || stored.value.input.kind !== "decision") throw Error("fixture");
  await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version, job: { ...stored.value,
    input: { ...stored.value.input, job: { ...stored.value.input.job, generationKind: "npc_free_text",
      utterance: "消息是从哪儿来的？", selectedDialogue: { dialogueAct: "ask", label: "消息是从哪儿来的？" } } } } });
  let calls = 0;
  h.source.reviewDialogueConsistency = async request => {
    calls++;
    const reply = request.conversations.find(c => c.stage === "character")!;
    expect(reply.selected).toMatchObject({ historicalChoice: false, contract: null });
    expect(reply.answers).toEqual([]);
    return misclassified ? { ok: true, verdict: "reject", violations: [{ scope: "legacy", unitKey: reply.unitKey,
      type: "intent_mismatch", aspect: null }] } : { ok: true, verdict: "pass", violations: [] };
  };
  const result = await h.run();
  expect(result).toMatchObject(misclassified ? { ok: false, code: "dialogue_consistency_review_failed" } : { ok: true });
  expect(calls).toBe(misclassified ? 2 : 1);
});

it("第二次审核拒绝即耗尽，重启不能再发审核或表达；手动新cycle可重做", async () => {
  const h = createStagedHarness();
  await h.startDecision();
  let reviews = 0;
  h.source.reviewDialogueConsistency = async request => {
    reviews++;
    return { ok: true, verdict: "reject", violations: [{ scope: "expression", candidateId:
      request.conversations.find(c => c.stage === "choices")!.options[0]!.candidateId, type: "extra_inquiry", aspect: "source" }] };
  };
  expect(await h.run()).toMatchObject({ ok: false, code: "dialogue_consistency_review_exhausted" });
  expect(reviews).toBe(2);
  const loaded = await h.readJob();
  if (!loaded.ok) throw Error(loaded.code);
  const count = h.calls.length;
  // Simulate a restart between atomic reject persistence and failJob persistence.
  await h.jobs.save({ lease: h.lease(), expectedVersion: loaded.value.version, job: { ...loaded.value, status: "pending" } });
  expect(await h.run()).toMatchObject({ ok: false, code: "dialogue_consistency_review_exhausted" });
  expect(h.calls).toHaveLength(count);
  expect(reviews).toBe(2);
});

it("剩余额度耗尽在审核发送前失败，baseline恢复不累加", async () => {
  const h = createStagedHarness();
  await h.startDecision();
  const ready = await h.run();
  if (!ready.ok) throw Error(ready.code);
  await h.jobs.save({ lease: h.lease(), expectedVersion: ready.value.version, job: { ...ready.value,
    usedRequests: ready.value.baselineRequests + 12, dialogueConsistencyReview: undefined } });
  const review = vi.fn(async () => ({ ok: true as const, verdict: "pass" as const, violations: [] }));
  h.source.reviewDialogueConsistency = review;
  expect(await h.run()).toMatchObject({ ok: false, code: "job_budget_exhausted" });
  expect(review).not.toHaveBeenCalled();
  expect(await h.readJob()).toMatchObject({ ok: true, value: { baselineRequests: ready.value.baselineRequests } });
});

it("审核在途发生另一个worker接管，旧fence不能写回pass", async () => {
  const h = createStagedHarness();
  await h.startDecision();
  h.source.reviewDialogueConsistency = async () => {
    h.clock.advance(31_000);
    const takeover = await h.jobs.claim({ id: h.jobId(), owner: "other-worker", now: h.clock.now(),
      expiresAt: new Date(Date.parse(h.clock.now()) + 30_000).toISOString() });
    expect(takeover.ok).toBe(true);
    return { ok: true, verdict: "pass", violations: [] };
  };
  expect(await h.run()).toMatchObject({ ok: false, code: "LEASE_LOST" });
  expect(await h.readJob()).toMatchObject({ ok: true, value: { status: "pending",
    dialogueConsistencyReview: { status: "running", attempts: 1 } } });
});

it("reliability标签追加从哪儿听来：只重做choices，二次合并审核后发布", async () => {
  const { h, requests } = await dialogueReviewHarness(false);
  const generate = h.source.generate;
  let choices = 0;
  h.source.generate = async (request, execution) => {
    const response = await generate(request, execution);
    if (response.ok && response.stage === "choices" && response.value.stage === "choices") {
      choices++;
      if (choices === 1) return { ...response, value: { ...response.value, labels: response.value.labels.map((label, i) =>
        i === 0 ? { ...label, label: "告示可信吗，从哪儿听来的？" } : label) } };
      expect(execution.repair).toMatchObject({ rejectionCode: "dialogue_consistency_rejected" });
      expect(execution.repair?.detail).toContain('"aspect":"source"');
    }
    return response;
  };
  let reviews = 0;
  h.source.reviewDialogueConsistency = async request => {
    reviews++;
    const choice = request.conversations.find(c => c.stage === "choices")!.options[0]!;
    expect(choice.contract.inquiries[0]?.aspects).toEqual(["reliability"]);
    if (reviews === 1) {
      expect(choice.label).toContain("从哪儿听来");
      return { ok: true, verdict: "reject", violations: [{ scope: "expression", candidateId: choice.candidateId,
        type: "extra_inquiry", aspect: "source" }] };
    }
    expect(choice.label).toBe("这告示可信吗？");
    return { ok: true, verdict: "pass", violations: [] };
  };
  const result = await h.run();
  expect(result).toMatchObject({ ok: true, value: { usedRequests: 7, baselineRequests: 5,
    dialogueConsistencyReview: { attempts: 2, status: "approved" } } });
  expect(reviews).toBe(2);
  expect(requests.filter(r => r.stage === "planning")).toHaveLength(1);
  expect(requests.filter(r => r.stage === "character")).toHaveLength(1);
});

it("source+reliability计划均unknown但实际只回应reliability：失效NPC及其choices依赖", async () => {
  const { h, requests } = await dialogueReviewHarness();
  const generate = h.source.generate;
  let replies = 0;
  h.source.generate = async (request, execution) => {
    const response = await generate(request, execution);
    if (response.ok && response.stage === "character" && ++replies === 1) return { ...response, value: { ...response.value,
      parts: [{ text: "是否可信我不知道。", facts: [], evidence: [], beatIds: [] }] } };
    return response;
  };
  let reviews = 0;
  h.source.reviewDialogueConsistency = async request => {
    const reply = request.conversations.find(c => c.stage === "character")!;
    expect(reply.answers).toHaveLength(2);
    if (++reviews === 1) {
      expect(reply.text).toBe("是否可信我不知道。");
      return { ok: true, verdict: "reject", violations: [{ scope: "expression", unitKey: reply.unitKey,
        type: "missing_response", aspect: "source" }] };
    }
    return { ok: true, verdict: "pass", violations: [] };
  };
  expect((await h.run()).ok).toBe(true);
  expect(requests.filter(r => r.stage === "character")).toHaveLength(2);
  expect(requests.filter(r => r.stage === "choices")).toHaveLength(2);
  expect(requests.filter(r => r.stage === "planning")).toHaveLength(1);
});

it.each(["来源并不重要，我只关心告示是否可信。", "劳驾，请问告示可靠吗？"])("陈述来源与礼貌语不由关键词拒绝：%s", async label => {
  const { h } = await dialogueReviewHarness(false);
  const generate = h.source.generate;
  h.source.generate = async (r, e) => {
    const value = await generate(r, e);
    return value.ok && value.stage === "choices" && value.value.stage === "choices" ? { ...value, value: { ...value.value,
      labels: value.value.labels.map((l, i) => i === 0 ? { ...l, label } : l) } } : value;
  };
  const review = vi.fn(async () => ({ ok: true as const, verdict: "pass" as const, violations: [] }));
  h.source.reviewDialogueConsistency = review;
  expect((await h.run()).ok).toBe(true);
  expect(review).toHaveBeenCalledTimes(1);
});

it.each(["uncertain", "provider", "throw", "schema"])("审核%s最多两次；不生成半包", async failure => {
  const h = createStagedHarness();
  await h.startDecision();
  const review = vi.fn(async () => {
    if (failure === "throw") throw Error("private provider body");
    if (failure === "provider") return createAiSourceFailure("scene", "timeout");
    return { ok: true as const, verdict: failure === "schema" ? "invalid" as never : "uncertain" as const, violations: [] };
  });
  h.source.reviewDialogueConsistency = review;
  expect((await h.run()).ok).toBe(false);
  expect(review).toHaveBeenCalledTimes(2);
  expect(await h.readJob()).toMatchObject({ ok: true, value: { status: "failed", usedRequests: 7,
    dialogueConsistencyReview: { attempts: 2, status: "failed" } } });
  expect(h.publications()).toHaveLength(0);
});

it("缺审核实现为配置失败，不能因旧fixture或requiresTaskBrief省略而放行", async () => {
  const h = createStagedHarness();
  await h.startDecision();
  delete (h.source as StageSource).reviewDialogueConsistency;
  expect(await h.run()).toMatchObject({ ok: false, code: "dialogue_consistency_review_unavailable" });
});

it("审核前保存running和预算，pass恢复复用；unknown恢复保留已扣成本", async () => {
  const h = createStagedHarness();
  await h.startDecision();
  let calls = 0;
  h.source.reviewDialogueConsistency = async () => {
    const loaded = await h.readJob();
    expect(loaded).toMatchObject({ ok: true, value: { dialogueConsistencyReview: { status: "running", attempts: ++calls } } });
    return { ok: true, verdict: "pass", violations: [] };
  };
  const first = await h.run();
  if (!first.ok) throw Error(first.code);
  expect((await h.run()).ok).toBe(true);
  expect(calls).toBe(1);
  const saved = await h.jobs.save({ lease: h.lease(), expectedVersion: first.value.version, job: { ...first.value,
    dialogueConsistencyReview: { ...first.value.dialogueConsistencyReview!, status: "running", passDigest: undefined } } });
  if (!saved.ok) throw Error(saved.code);
  expect(await h.run()).toMatchObject({ ok: true, value: { usedRequests: 7, baselineRequests: 6,
    dialogueConsistencyReview: { attempts: 2 } } });
  expect(calls).toBe(2);
});

it("reject与DAG失效原子保存，保存后重启仍带安全反馈修复", async () => {
  const h = createStagedHarness();
  await h.startDecision();
  const save = h.jobs.save.bind(h.jobs);
  let interrupted = false;
  h.jobs.save = async input => {
    const result = await save(input);
    if (!interrupted && input.job.dialogueConsistencyReview?.violations?.length) {
      interrupted = true;
      expect(input.job.units.find(u => u.key === "choices_current")).toMatchObject({ status: "pending", value: null });
      h.controller.abort();
    }
    return result;
  };
  let reviews = 0;
  h.source.reviewDialogueConsistency = async request => ++reviews === 1
    ? { ok: true, verdict: "reject", violations: [{ scope: "expression", candidateId: request.conversations.find(c => c.stage === "choices")!.options[0]!.candidateId,
      type: "extra_inquiry", aspect: "source" }] }
    : { ok: true, verdict: "pass", violations: [] };
  expect((await h.run()).ok).toBe(false);
  const resumed = await runJob({ id: h.jobId(), lease: h.lease() }, { jobs: h.jobs, source: h.source,
    now: () => h.clock.now(), signal: new AbortController().signal });
  expect(resumed).toMatchObject({ ok: true, value: { usedRequests: 8, dialogueConsistencyReview: { attempts: 2 } } });
  expect(h.calls.filter(c => c.stage === "choices").at(-1)?.repair?.detail).toContain('"aspect":"source"');
});

it.each(["planning", "legacy"] as const)("%s合同拒绝终止周期；planning手动重试不复用旧骨架", async scope => {
  const { h, requests } = await dialogueReviewHarness();
  h.source.reviewDialogueConsistency = async request => ({ ok: true, verdict: "reject", violations: [{ scope,
    unitKey: request.conversations.find(c => c.stage === "character")!.unitKey, type: "intent_mismatch", aspect: null }] });
  expect(await h.run()).toMatchObject({ ok: false, code: scope === "legacy" ? "legacy_dialogue_contract_mismatch" : "dialogue_consistency_planning_contract" });
  if (scope !== "planning") return;
  expect(await h.readJob()).toMatchObject({ ok: true, value: { units: expect.arrayContaining([
    expect.objectContaining({ key: "planning", status: "pending", value: null }),
  ]) } });
  await h.retry();
  h.source.reviewDialogueConsistency = async () => ({ ok: true, verdict: "pass", violations: [] });
  const claimed = await h.jobs.claim({ id: h.jobId(), owner: "new-cycle", now: h.clock.now(),
    expiresAt: new Date(Date.parse(h.clock.now()) + 30_000).toISOString() });
  if (!claimed.ok) throw Error(claimed.code);
  expect(await runJob({ id: h.jobId(), lease: claimed.value }, { jobs: h.jobs, source: h.source,
    now: () => h.clock.now(), signal: h.controller.signal })).toMatchObject({ ok: true, value: { cycle: 1, dialogueConsistencyReview: { cycle: 1, attempts: 1 } } });
  expect(requests.filter(r => r.stage === "planning")).toHaveLength(2);
});

it("late审核被cancel fence拒绝，不能保存pass或发布", async () => {
  const h = createStagedHarness();
  await h.startDecision();
  h.source.reviewDialogueConsistency = async () => {
    await h.cancel();
    return { ok: true, verdict: "pass", violations: [] };
  };
  expect((await h.run()).ok).toBe(false);
  expect(await h.readJob()).toMatchObject({ ok: true, value: { status: "cancelled",
    dialogueConsistencyReview: { status: "running", attempts: 1 } } });
});

it("审核响应越过deadline不保存pass", async () => {
  const h = createStagedHarness();
  await h.startDecision();
  h.source.reviewDialogueConsistency = async () => { h.clock.advance(600_000); return { ok: true, verdict: "pass", violations: [] }; };
  expect(await h.run()).toMatchObject({ ok: false, code: "job_deadline_exceeded" });
});
