import { expect, it } from "vitest";
import { dialogueReviewHarness } from "./dialogueConsistencyFixture.testutil";
import type { StageExecution } from "./stageSource";
import { isStoredPlanningSemanticRepair } from "./planningSemanticRepair";
import { parsePlanProposal } from "@/game/domain/narrativePlan";
import { semanticReviewSamples } from "./dialogueReviewSemanticFailures.testutil";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import { asFactId } from "@/game/domain/worldEntity";
import { runJob } from "./runJob";
import { createAiSourceFailure } from "../aiGenerationRetry";
import type { DialogueReviewRequest } from "./dialogueReviewChecks";
import { createStagedHarness } from "../testing/stagedNarrativeHarness.testutil";

const pass = { ok: true as const, verdict: "pass" as const, violations: [] };
function reject(request: DialogueReviewRequest) {
  return { ok: true as const, verdict: "reject" as const, violations: [{
    checkId: request.checks.find(c => c.kind === "plan_option")!.checkId,
    type: "intent_mismatch" as const, inquiryId: null }] };
}

it("首次规划语义拒绝原子撤销后只重做一次，修正骨架才表达和发布", async () => {
  const { h, plan: base } = await dialogueReviewHarness(false);
  const real = semanticReviewSamples.find(s => s.id === "no_ship_response")!.subjects[0]!;
  const stored = await h.readJob();
  if (!stored.ok || stored.value.input.kind !== "decision" || base.decision?.kind !== "ordinary") throw Error("fixture");
  const world = stored.value.input.world;
  await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version, job: { ...stored.value,
    input: { ...stored.value.input, world: createWorldStateFixtureWith({ generation: world.generation, base: world }, {
      worldFacts: [...world.worldFacts, ...real.facts.map(f => ({ factId: asFactId(f.id), text: f.text,
        discovered: true, source: "generated" as const }))], eventLedger: world.eventLedger,
    }) } } });
  const decision = { ...base.decision, options: base.decision.options.map((o, i) => i !== 1 ? o : {
    ...o, dialogueAct: "challenge" as const, task: { ...o.task!, intent: "challenge" as const,
      brief: "追问信号来自哪里，只询问来源。", focusFactIds: ["fact_3"],
      inquiries: [{ factId: "fact_3", aspects: ["source"] as const }] },
  }) as unknown as typeof base.decision.options };
  const broken = { ...base, decision: { ...decision, options: decision.options.map((o, i) => i !== 0 ? o : {
    ...o, dialogueAct: "offer" as const, task: { ...o.task!, intent: "offer" as const, brief: real.brief!,
      focusFactIds: real.topicFactIds, inquiries: [] },
  }) as unknown as typeof decision.options } };
  const plan = { ...base, decision: { ...decision, options: decision.options.map((o, i) => i !== 0 ? o : {
    ...o, task: { ...o.task!, brief: "询问没有其他船只应答的记录能否可靠说明附近没有船只，再考虑靠近母站。",
      focusFactIds: real.topicFactIds, inquiries: [{ factId: "fact_3", aspects: ["reliability"] as const }] },
  }) as unknown as typeof decision.options } };
  const generate = h.source.generate;
  const planning: StageExecution[] = [];
  let calls = 0;
  h.source.generate = async (request, execution) => {
    calls++;
    if (request.stage === "planning") {
      planning.push(execution);
      return { ok: true, stage: "planning", value: planning.length === 1 ? broken : plan };
    }
    if (request.stage === "choices") expect(request.context.options[0]!.inquiries).toEqual([{ factId: "fact_3", aspects: ["reliability"] }]);
    return generate(request, execution);
  };
  let reviews = 0;
  h.source.reviewDialogueConsistency = async (request, execution) => {
    calls++;
    if (++reviews === 1) {
      const check = request.checks.find(c => c.kind === "plan_option" && c.inquiries.some(q => q.aspect === "source"))!;
      return { ok: true, verdict: "reject", violations: [{ checkId: check.checkId, type: "extra_inquiry",
        inquiryId: check.inquiries.find(q => q.aspect === "source")!.inquiryId }] };
    }
    if (reviews === 2) {
      expect(execution.repair?.detail).toContain("$.violations[0].inquiryId");
      expect(execution.repair?.detail).toContain("invalid_inquiryId");
      const check = request.checks.find(c => c.kind === "plan_option")!;
      return { ok: true, verdict: "reject", violations: [{ checkId: check.checkId, type: "extra_inquiry",
        inquiryId: check.inquiryTargets.find(q => q.factId === "fact_3" && q.aspect === "reliability")!.inquiryId }] };
    }
    if (reviews === 3) expect(execution.repair?.detail).toContain("planning_content_recheck");
    return { ok: true, verdict: "pass", violations: [] };
  };
  const ready = await h.run();
  expect(ready.ok).toBe(true);
  expect(planning).toHaveLength(2);
  expect(planning[1]!.repair?.rejectionCode).toBe("dialogue_consistency_planning_contract");
  expect(JSON.parse(planning[1]!.repair!.detail!).approvedProposal).toEqual(broken);
  if (!ready.ok) throw Error(ready.code);
  expect(parsePlanProposal(ready.value.planningSemanticRepair!.anchor)).toMatchObject({ ok: true });
  expect(isStoredPlanningSemanticRepair(ready.value.planningSemanticRepair)).toBe(true);
  expect(ready.value.units.find(u => u.key === "planning")!.value).toEqual(plan);
  expect(ready.value.usedRequests).toBe(calls);
  expect(ready.value.planningSemanticRepair).toMatchObject({ used: 1, status: "replanned", protocolCorrections: 1 });
  expect((await h.publish()).ok).toBe(true);
});

it("永久拒绝同周期只重做一次，恢复不能增加额度", async () => {
  const { h, requests } = await dialogueReviewHarness(false);
  h.source.reviewDialogueConsistency = async request => reject(request);
  expect(await h.run()).toEqual({ ok: false, code: "dialogue_consistency_planning_contract" });
  const row = await h.readJob();
  if (!row.ok) throw Error(row.code);
  expect(row.value).toMatchObject({ usedRequests: 4, planningSemanticRepair: { used: 1, status: "exhausted" } });
  expect(requests.map(r => r.stage)).toEqual(["planning", "planning"]);
  await h.jobs.save({ lease: h.lease(), expectedVersion: row.value.version, job: { ...row.value, status: "pending" } });
  expect((await h.run()).ok).toBe(false);
  expect(requests).toHaveLength(2);
});

it.each(["pending", "planning_running", "review_running"])("崩溃点%s恢复保留charge与唯一语义额度", async crashPoint => {
  const { h, requests } = await dialogueReviewHarness(false);
  let reviews = 0;
  h.source.reviewDialogueConsistency = async request => ++reviews === 1 ? reject(request) : pass;
  const save = h.jobs.save.bind(h.jobs);
  let crashed = false;
  h.jobs.save = async input => {
    const result = await save(input);
    const repair = input.job.planningSemanticRepair;
    if (!crashed && repair?.used === 1 && (crashPoint === "pending" ? repair.status === "pending"
      : crashPoint === "planning_running" ? input.job.units.some(u => u.key === "planning" && u.status === "running")
        : repair.status === "replanned" && repair.reviewInFlight)) {
      crashed = true;
      throw Error("process loss after durable save");
    }
    return result;
  };
  await expect(h.run()).rejects.toThrow("process loss");
  const before = await h.readJob();
  if (!before.ok) throw Error(before.code);
  expect(before.value.planningSemanticRepair).toMatchObject({ used: 1 });
  const ready = await h.run();
  expect(ready.ok).toBe(true);
  if (!ready.ok) throw Error(ready.code);
  expect(ready.value.planningSemanticRepair).toMatchObject({ used: 1, status: "replanned", reviewInFlight: false,
    protocolCorrections: crashPoint === "review_running" ? 1 : 0 });
  expect(ready.value.usedRequests).toBe(requests.length + reviews + (crashPoint === "pending" ? 0 : 1));
  expect(requests.filter(r => r.stage === "planning")).toHaveLength(2);
  expect(isStoredPlanningSemanticRepair(ready.value.planningSemanticRepair)).toBe(true);
});

it.each(["pass", "protocol_error", "reject"])("规划修复改unit key后%s仍继承原协议额度", async after => {
  const { h, plan, requests } = await dialogueReviewHarness(false);
  const generate = h.source.generate;
  let plans = 0, reviews = 0;
  h.source.generate = async (request, execution) => {
    if (request.stage !== "planning" || ++plans === 1) return generate(request, execution);
    return { ok: true, stage: "planning", value: { ...plan, units: plan.units.map(u => ({ ...u,
      key: `renamed_${u.key}`, dependencies: u.dependencies.map(d => `renamed_${d}`) })) } };
  };
  h.source.reviewDialogueConsistency = async request => {
    if (++reviews === 1 || (reviews === 3 && after === "protocol_error")) return { ok: true, verdict: "reject",
      violations: [{ checkId: "foreign", type: "intent_mismatch", inquiryId: null }] };
    if (reviews === 2 || (reviews === 3 && after === "reject")) return reject(request);
    return pass;
  };
  const ready = await h.run();
  expect(ready.ok).toBe(after === "pass");
  expect(plans).toBe(2);
  const row = await h.readJob();
  if (!row.ok) throw Error(row.code);
  expect(row.value.planningSemanticRepair?.protocolCorrections).toBe(1);
  expect(Object.values(row.value.planningDialogueReviews!).some(r => r.attempts === 3)).toBe(true);
  if (after !== "pass") expect(requests.filter(r => r.stage !== "planning")).toEqual([]);
});

it.each(["uncertain", "provider_failure"])("%s不启动规划语义修复", async mode => {
  const { h, requests } = await dialogueReviewHarness(false);
  h.source.reviewDialogueConsistency = async () => mode === "uncertain" ? { ok: true, verdict: "uncertain", violations: [] }
    : createAiSourceFailure("scene", "transport", "provider_failure", "network_error");
  expect((await h.run()).ok).toBe(false);
  expect(requests.map(r => r.stage)).toEqual(["planning"]);
  expect(await h.readJob()).toMatchObject({ value: { planningSemanticRepair: { used: 0, reviewFailure: mode } } });
});

it("旧语义拒绝缺周期记录不获得新额度", async () => {
  const { h, requests } = await dialogueReviewHarness(false);
  h.source.reviewDialogueConsistency = async request => reject(request);
  await h.run();
  const row = await h.readJob();
  if (!row.ok) throw Error(row.code);
  await h.jobs.save({ lease: h.lease(), expectedVersion: row.value.version, job: { ...row.value,
    status: "pending", planningSemanticRepair: undefined, planningDialogueReviews: Object.fromEntries(
      Object.entries(row.value.planningDialogueReviews!).map(([key, r]) => [key, { ...r, status: "failed" }])) } });
  expect(await h.run()).toEqual({ ok: false, code: "dialogue_consistency_planning_contract" });
  expect(requests).toHaveLength(2);
});

it.each(["budget", "deadline", "cancel", "fence"])("首次拒绝后%s阻止修复请求并禁止发布", async limit => {
  const { h, requests } = await dialogueReviewHarness(false);
  h.source.reviewDialogueConsistency = async request => {
    if (limit === "deadline") h.clock.epochMs += 600_001;
    if (limit === "cancel") await h.cancel();
    if (limit === "fence") {
      h.clock.epochMs += 30_001;
      expect((await h.jobs.claim({ id: h.jobId(), owner: "other", now: h.clock.now(),
        expiresAt: new Date(h.clock.epochMs + 30_000).toISOString() })).ok).toBe(true);
    }
    return reject(request);
  };
  const save = h.jobs.save.bind(h.jobs);
  h.jobs.save = async input => save(limit === "budget" && input.job.planningSemanticRepair?.status === "pending"
    ? { ...input, job: { ...input.job, usedRequests: input.job.baselineRequests + 12 } } : input);
  expect((await h.run()).ok).toBe(false);
  expect(requests.map(r => r.stage)).toEqual(["planning"]);
  expect((await h.publish()).ok).toBe(false);
});

it("开局pending修复恢复保留原opening，返回世界漂移仍被审批拒绝", async () => {
  const h = createStagedHarness();
  await h.startInitialization();
  h.source.reviewDialogueConsistency = async request => reject(request);
  const save = h.jobs.save.bind(h.jobs);
  let crashed = false;
  h.jobs.save = async input => {
    const result = await save(input);
    if (!crashed && input.job.planningSemanticRepair?.status === "pending") {
      crashed = true;
      throw Error("opening repair persisted");
    }
    return result;
  };
  expect((await h.runInitializationJob()).ok).toBe(false);
  expect(crashed).toBe(true);
  const row = await h.readJob();
  if (!row.ok) throw Error(row.code);
  const anchor = row.value.planningSemanticRepair!.anchor;
  expect(anchor.opening).not.toBeNull();
  const lease = await h.jobs.claim({ id: h.jobId(), owner: "recover-opening", now: h.clock.now(),
    expiresAt: new Date(h.clock.epochMs + 30_000).toISOString() });
  if (!lease.ok) throw Error(lease.code);
  if (row.value.status !== "pending") await h.jobs.save({ lease: lease.value, expectedVersion: row.value.version,
    job: { ...row.value, status: "pending", failureCode: null } });
  const executions: StageExecution[] = [];
  const result = await runJob({ id: h.jobId(), lease: lease.value }, { jobs: h.jobs, source: {
    ...h.source, generate: async (request, execution) => {
      expect(request.stage).toBe("planning");
      executions.push(execution);
      return { ok: true, stage: "planning", value: { ...anchor, opening: { ...anchor.opening!, prologue: "另造一个世界" } } };
    },
  }, now: () => h.clock.now(), signal: new AbortController().signal });
  expect(result).toEqual({ ok: false, code: "plan_semantic_anchor_mismatch" });
  expect(executions).toHaveLength(3);
  expect(JSON.parse(executions[0]!.repair!.detail!).approvedOpening).toEqual(anchor.opening);
  expect(await h.readJob()).toMatchObject({ value: { planningSemanticRepair: { used: 1 }, usedRequests: 5 } });
});

it("语义修复不能通过新增越权事实扩大表达权限", async () => {
  const { h, plan, requests } = await dialogueReviewHarness(false);
  const generate = h.source.generate;
  let planning = 0;
  h.source.generate = async (request, execution) => request.stage === "planning" && ++planning > 1
    ? { ok: true, stage: "planning", value: { ...plan, units: plan.units.map(u => u.stage !== "character" ? u : {
      ...u, task: { ...u.task!, focusFactIds: ["unavailable_secret"], contentFactIds: ["unavailable_secret"] },
    }) } } : generate(request, execution);
  h.source.reviewDialogueConsistency = async request => reject(request);
  expect((await h.run()).ok).toBe(false);
  expect(planning).toBe(4);
  expect(requests.filter(r => r.stage !== "planning")).toEqual([]);
});

it("idle旧锚点不限制首次拒绝前合法重规划，首次拒绝冻结当时获批提案", async () => {
  const { h, plan } = await dialogueReviewHarness(false);
  h.source.reviewDialogueConsistency = async () => pass;
  const ready = await h.run();
  if (!ready.ok) throw Error(ready.code);
  const oldAnchor = { ...plan, actions: [{ key: "old_pause", actorId: "npc_0", point: { stepKey: "current", order: 0 },
    kind: "pause" as const, objectId: null, audienceIds: ["player_0"] }] };
  await h.jobs.save({ lease: h.lease(), expectedVersion: ready.value.version, job: { ...ready.value,
    planningSemanticRepair: { ...ready.value.planningSemanticRepair!, anchor: oldAnchor },
    planningDialogueReviews: undefined, dialogueConsistencyReview: undefined,
    units: ready.value.units.map(u => ({ ...u, value: null, status: "pending" })),
  } });
  let reviews = 0;
  h.source.reviewDialogueConsistency = async request => ++reviews === 1 ? reject(request) : pass;
  const resumed = await h.run();
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) throw Error(resumed.code);
  expect(resumed.value.planningSemanticRepair!.anchor).toEqual(plan);
});
