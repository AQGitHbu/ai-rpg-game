import { expect, it } from "vitest";
import { approvePlanningContext } from "./approvePlanningContext";
import { dialogueConsistencyReviewInput, isStoredDialogueReview, parseDialogueConsistencyVerdict,
  shouldReviewDialogueConsistency, validateJobDialogueConsistencyReview } from "./dialogueConsistencyReview";
import { dialogueReviewHarness } from "./dialogueConsistencyFixture.testutil";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import { createStagedHarness } from "../testing/stagedNarrativeHarness.testutil";
import { runDialogueConsistencyReview } from "./runDialogueConsistencyReview";

it("历史brief经安全投影核对协助条件，只交给当前focus审核，不转发其他NPC或原始task", async () => {
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok || stored.value.input.kind !== "decision") throw Error("fixture");
  const brief = "只有你愿意同行，我才答应帮你探路。";
  await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version, job: { ...stored.value,
    input: { ...stored.value.input, job: { ...stored.value.input.job, selectedDialogue: { dialogueAct: "offer",
      label: "你愿意同行，我就帮你探路。", task: { intent: "offer", brief,
        focusFactIds: [], contentFactIds: [], prerequisiteFactIds: [] } } } } } });
  const generate = h.source.generate;
  h.source.generate = async (r, e) => {
    const result = await generate(r, e);
    if (result.ok && result.stage === "character" && result.value.stage === "character" && result.value.speakerId === "npc_1")
      return { ...result, value: { ...result.value, parts: [{ text: "OTHER_NPC_PRIVATE_LINE", facts: [], evidence: [], beatIds: [] }] } };
    return result;
  };
  h.source.reviewDialogueConsistency = async request => {
    const current = request.conversations.find(c => c.speakerId === "npc_0")!;
    expect(current.selected?.contract?.brief).toContain(brief);
    expect(current.selected?.contract).not.toHaveProperty("focusFactIds");
    expect(JSON.stringify(request)).not.toContain("OTHER_NPC_PRIVATE_LINE");
    expect(request.conversations.some(c => c.speakerId === "npc_1")).toBe(false);
    return { ok: true, verdict: "pass", violations: [] };
  };
  expect((await h.run()).ok).toBe(true);
  const other = h.requests.find(r => r.stage === "character" && r.context.unit.speakerId === "npc_1");
  expect(JSON.stringify(other)).not.toContain(brief);
});

it("历史brief引用玩家不可见事实时显式拒绝，不让审核器读取隐藏正文", async () => {
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok || stored.value.input.kind !== "decision") throw Error("fixture");
  await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version, job: { ...stored.value,
    input: { ...stored.value.input, job: { ...stored.value.input.job, selectedDialogue: { dialogueAct: "offer", label: "我帮你。",
      task: { intent: "offer", brief: "PRIVATE_HISTORICAL_BRIEF", focusFactIds: ["fact_private"], prerequisiteFactIds: [] } } } } } });
  let reviews = 0;
  h.source.reviewDialogueConsistency = async () => { reviews++; return { ok: true, verdict: "pass", violations: [] }; };
  expect(await h.run()).toMatchObject({ ok: false, code: "legacy_dialogue_contract_mismatch" });
  expect(reviews).toBe(0);
  expect(JSON.stringify(h.requests.filter(r => r.stage !== "planning"))).not.toContain("PRIVATE_HISTORICAL_BRIEF");
});

it("逐场景绑定实际问题与unknown回应，安全投影不含完整世界/私密计划", async () => {
  const { h } = await dialogueReviewHarness();
  h.source.reviewDialogueConsistency = async request => {
    const reply = request.conversations.find(c => c.stage === "character")!;
    expect(reply.selected).toMatchObject({ historicalChoice: true, label: "从哪儿听来的，消息可靠吗？",
      contract: { inquiries: [{ aspects: ["source", "reliability"] }] } });
    expect(reply.answers.map(answer => answer.aspect)).toEqual(["source", "reliability"]);
    expect(reply.text).toContain("从哪儿传来、是否可信");
    expect(request).not.toHaveProperty("world");
    expect(reply).not.toHaveProperty("unit");
    return { ok: true, verdict: "pass", violations: [] };
  };
  expect((await h.run()).ok).toBe(true);
});

it.each(["text", "order", "style", "dependency", "cycle", "missing"])("发布凭据绑定完整输入：%s变化失效", async change => {
  const { h } = await dialogueReviewHarness();
  const result = await h.run();
  if (!result.ok) throw Error(result.code);
  let job = result.value;
  if (change === "cycle") job = { ...job, cycle: job.cycle + 1 };
  if (change === "missing") job = { ...job, dialogueConsistencyReview: undefined };
  if (change === "text" || change === "order" || change === "dependency") job = { ...job, units: job.units.map(unit =>
    unit.value !== null && "stage" in unit.value && unit.value.stage === "choices" ? { ...unit,
      inputDigest: change === "dependency" ? "changed" : unit.inputDigest,
      value: { ...unit.value, labels: change === "order" ? [...unit.value.labels].reverse()
        : unit.value.labels.map((label, i) => i === 0 && change === "text" ? { ...label, label: label.label + "啊" } : label) },
    } : unit) };
  const plan = approvePlanningContext(job.input, job.units.find(u => u.key === "planning")!.value as PlanProposal);
  if (!plan.ok) throw Error(plan.code);
  const changedPlan = change === "style" ? { ...plan.value, world: { ...plan.value.world, generation: {
    ...plan.value.world.generation, gameType: "xianxia" as const,
  } } } : plan.value;
  expect(validateJobDialogueConsistencyReview(job, changedPlan)).toMatchObject({ ok: false });
});

it("无候选无待答问题无需审核；null终点待答问题仍审核且缺回答单元失败", async () => {
  const { h } = await dialogueReviewHarness();
  const result = await h.run();
  if (!result.ok) throw Error(result.code);
  const approved = approvePlanningContext(result.value.input, result.value.units.find(u => u.key === "planning")!.value as PlanProposal);
  if (!approved.ok) throw Error(approved.code);
  const plan = { ...approved.value, choiceExpression: null, units: approved.value.units.filter(u => u.stage !== "choices") };
  expect(shouldReviewDialogueConsistency(plan)).toBe(true);
  expect(shouldReviewDialogueConsistency({ ...plan, currentUtterance: undefined })).toBe(false);
  expect(dialogueConsistencyReviewInput(result.value, { ...plan, units: plan.units.filter(u => u.stage !== "character") }))
    .toMatchObject({ ok: false, code: "plan_reply_missing" });
});

it.each(["ending", "null", "none"] as const)("无候选的审核执行与发布谓词同源：%s", async kind => {
  const { h } = await dialogueReviewHarness();
  const ready = await h.run();
  if (!ready.ok) throw Error(ready.code);
  let job = { ...ready.value, dialogueConsistencyReview: undefined } as typeof ready.value;
  const approved = approvePlanningContext(job.input, job.units.find(u => u.key === "planning")!.value as PlanProposal);
  if (!approved.ok) throw Error(approved.code);
  const units = approved.value.units.filter(u => u.stage !== "choices");
  const plan = { ...approved.value, units, choiceExpression: null,
    ...(kind === "none" ? { currentUtterance: undefined } : {}),
    proposal: { ...approved.value.proposal, units, decision: null,
      ...(kind === "ending" ? { terminal: { kind: "ending" as const } } : {}) },
  };
  let calls = 0;
  const source = { ...h.source, reviewDialogueConsistency: async () => {
    calls++;
    return { ok: true as const, verdict: "pass" as const, violations: [] };
  } };
  expect(await runDialogueConsistencyReview({ plan, getJob: () => job, source,
    now: () => h.clock.now(), signal: h.controller.signal,
    persist: async mutate => { job = mutate(job); return true; },
  })).toMatchObject({ ok: true });
  expect(calls).toBe(kind === "none" ? 0 : 1);
  expect(validateJobDialogueConsistencyReview(job, plan).ok).toBe(true);
  expect(job.usedRequests).toBe(ready.value.usedRequests + (kind === "none" ? 0 : 1));
});

it.each([
  { verdict: "approve", violations: [] }, { verdict: "pass", violations: [{ scope: "expression" }] },
  { verdict: "reject", violations: [] }, { verdict: "uncertain", violations: [], rewrite: "秘密" },
  { verdict: "reject", violations: [{ scope: "expression", candidateId: "x", type: "extra_inquiry", aspect: "secret" }] },
  { verdict: "reject", violations: Array(9).fill({ scope: "expression", candidateId: "x", type: "extra_inquiry", aspect: "source" }) },
])("拒绝非法/超长审核schema：%j", value => expect(parseDialogueConsistencyVerdict(value)).toBeNull());

it("可选持久化字段兼容旧job，但拒绝错误attempts与私密自由反馈", () => {
  expect(isStoredDialogueReview(undefined)).toBe(true);
  const review = { version: 1, cycle: 0, inputDigest: "a".repeat(64), attempts: 1, status: "running" };
  expect(isStoredDialogueReview(review)).toBe(true);
  expect(isStoredDialogueReview({ ...review, attempts: 3 })).toBe(false);
  expect(isStoredDialogueReview({ ...review, violations: [{ scope: "expression", unitKey: "x", type: "missing_response", aspect: "source", detail: "私密" }] })).toBe(false);
});
