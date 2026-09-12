import { planningDimensionCases } from "./planningDialogueReviewCases.testutil";
import { compileDialogueReviewChecks, parseDialogueReviewVerdict, routeDialogueReviewVerdict } from "./dialogueReviewChecks";
import { runJob } from "./runJob";
import { realReviewSubjects } from "./dialogueReviewRealFailures.testutil";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import { asFactId } from "@/game/domain/worldEntity";
import { expect, it } from "vitest";
import { dialogueReviewHarness } from "./dialogueConsistencyFixture.testutil";

it.each([0, 1])("真实武侠具体问询缺 inquiries 在任何表达前失败：%s", async index => {
  const { h, plan, requests } = await dialogueReviewHarness(false);
  if (plan.decision?.kind !== "ordinary") throw Error("fixture");
  const loaded = await h.readJob();
  if (!loaded.ok || loaded.value.input.kind !== "decision") throw Error("fixture");
  const world = loaded.value.input.world;
  await h.jobs.save({ lease: h.lease(), expectedVersion: loaded.value.version, job: { ...loaded.value,
    input: { ...loaded.value.input, world: createWorldStateFixtureWith({ generation: world.generation, base: world }, {
      worldFacts: [...world.worldFacts, ...realReviewSubjects.wuxia[0]!.facts.map(f => ({
        factId: asFactId(f.id), text: f.text, discovered: true, source: "generated" as const,
      }))], eventLedger: world.eventLedger,
    }) } } });
  const decision = plan.decision;
  const broken = { ...plan, decision: { ...decision, options: decision.options.map((o, i) => {
    const real = realReviewSubjects.wuxia[i]!;
    return { ...o, candidateId: real.candidateId!, dialogueAct: real.intent as "ask" | "challenge",
      task: { ...o.task!, intent: real.intent as "ask" | "challenge", brief: real.brief!,
        focusFactIds: real.topicFactIds, inquiries: real.inquiries } };
  }) as unknown as typeof decision.options } };
  const generate = h.source.generate;
  h.source.generate = async (r, e) => r.stage === "planning" ? { ok: true, stage: "planning", value: broken } : generate(r, e);
  h.source.reviewDialogueConsistency = async request => {
    const check = request.checks.filter(c => c.kind === "plan_option")[index]!;
    return { ok: true, verdict: "reject", violations: [{ checkId: check.checkId, type: "extra_inquiry",
      inquiryId: check.inquiryTargets.find(q => q.aspect === (index === 0 ? "source" : "identity"))!.inquiryId }] };
  };
  expect(await h.run()).toEqual({ ok: false, code: "dialogue_consistency_planning_contract" });
  expect(requests.filter(r => r.stage !== "planning")).toEqual([]);
  expect(await h.readJob()).toMatchObject({ value: { failureCode: "dialogue_consistency_planning_contract" } });
});

import { createStagedHarness } from "../testing/stagedNarrativeHarness.testutil";
import { approvePlanningContext } from "./approvePlanningContext";
import { validatePlanningDialogueReviews } from "./planningDialogueReview";
import type { PlanProposal } from "@/game/domain/narrativePlan";

async function conditionalHarness(unauthorized = false) {
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok || stored.value.input.kind !== "decision") throw Error("fixture");
  const world = stored.value.input.world;
  const factId = asFactId("fact_disclosed");
  const text = "PRIVATE_UNTIL_DISCLOSED：官差藏身义庄。";
  const nextWorld = createWorldStateFixtureWith({ generation: world.generation, base: world }, {
    worldFacts: [{ factId, text, discovered: false, source: "generated" }],
    npcs: world.npcs.map((npc, i) => i === 0 ? { ...npc, memory: { ...npc.memory,
      knownFactIds: [factId], hiddenFactIds: [] } } : npc), eventLedger: world.eventLedger,
  });
  await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version,
    job: { ...stored.value, input: { ...stored.value.input, world: nextWorld } } });
  const generate = h.source.generate.bind(h.source);
  h.source.generate = async (request, execution) => {
    const response = await generate(request, execution);
    if (!response.ok) return response;
    if (response.stage === "planning") {
      const decision = response.value.decision;
      if (decision?.kind !== "ordinary") throw Error("fixture");
      return { ...response, value: { ...response.value,
        observations: [{ key: "heard", source: { kind: "speech", speakerId: "npc_0" },
          point: { stepKey: "current", order: 2 }, audienceIds: unauthorized ? ["npc_0"] : ["player_0", "npc_0"],
          fact: { factId, certainty: "known" } }],
        units: response.value.units.map(u => u.key === "character_npc_0" ? { ...u, requiredObservationKeys: ["heard"] } : u),
        decision: { ...decision, options: decision.options.map((o, i) => ({ ...o, target: null, deferredLocation: null, dialogueAct: i === 0 ? "ask" : "support",
          topic: { kind: "fact", factId }, task: { intent: i === 0 ? "ask" : "support", brief: text,
            focusFactIds: [factId], contentFactIds: [], prerequisiteFactIds: [] },
        })) as unknown as typeof decision.options },
      } };
    }
    if (response.stage === "character" && response.value.stage === "character" && response.value.speakerId === "npc_0")
      return { ...response, value: { ...response.value, parts: [{ text, facts: [{ factId, certainty: "known" }], evidence: [], beatIds: [] }] } };
    return response;
  };
  (h.source as import("./stageSource").StageSource).reviewDisclosure = async () => ({ ok: true, verdict: "pass" });
  return { h, text };
}

it("条件topic/brief只在上游实际批准披露后审核，逐单元覆盖凭据缺失不能发布", async () => {
  const { h, text } = await conditionalHarness();
  let planningCalls = 0;
  h.source.reviewDialogueConsistency = async request => {
    if (request.checks.every(c => c.kind.startsWith("plan_"))) {
      planningCalls++;
      const stored = await h.readJob();
      if (!stored.ok) throw Error(stored.code);
      const disclosed = stored.value.units.find(u => u.key === "character_npc_0");
      if (request.checks.some(c => c.kind === "plan_option")) {
        expect(disclosed?.status).toBe("approved");
        expect(disclosed?.disclosureReviewDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(request)).toContain(text);
      } else {
        expect(h.calls.filter(c => c.stage !== "planning")).toEqual([]);
        expect(JSON.stringify(request)).not.toContain(text);
      }
      expect(request.checks.every(c => c.text === undefined)).toBe(true);
    } else expect(request.checks.some(c => c.kind.startsWith("plan_"))).toBe(false);
    return { ok: true, verdict: "pass", violations: [] };
  };
  const ready = await h.run();
  if (!ready.ok) throw Error(ready.code);
  expect(planningCalls).toBe(2);
  const plan = approvePlanningContext(ready.value.input, ready.value.units.find(u => u.key === "planning")!.value as PlanProposal);
  if (!plan.ok) throw Error(plan.code);
  expect(validatePlanningDialogueReviews(ready.value, plan.value).ok).toBe(true);
  const receipts = { ...ready.value.planningDialogueReviews };
  delete receipts.choices_current;
  const tampered = { ...ready.value, planningDialogueReviews: receipts };
  expect(validatePlanningDialogueReviews(tampered, plan.value)).toEqual({ ok: false, code: "dialogue_consistency_planning_review_required" });
  await h.jobs.save({ lease: h.lease(), expectedVersion: ready.value.version, job: tampered });
  expect((await h.publish()).ok).toBe(false);
  expect(h.publications()).toEqual([]);
});

it("未授权给玩家的观察不能作为延后规划的通行证", async () => {
  const { h } = await conditionalHarness(true);
  const reviews: unknown[] = [];
  h.source.reviewDialogueConsistency = async r => { reviews.push(r); return { ok: true, verdict: "pass", violations: [] }; };
  expect((await h.run()).ok).toBe(false);
  expect(reviews).toEqual([]);
  expect(h.calls.filter(c => c.stage !== "planning")).toEqual([]);
});

it.each(["征求对方意见：现在继续监听还是先暂停，由对方表明倾向。", "主动提出一起沿已知脚印方向排查，不询问脚印的方向。", "先核实告示已有说法，再表明支持。"])("无事实开放问询的规划允许空inquiries：%s", async brief => {
  const { h, plan, requests } = await dialogueReviewHarness(false);
  if (plan.decision?.kind !== "ordinary") throw Error("fixture");
  const decision = plan.decision;
  const generate = h.source.generate;
  h.source.generate = async (r, e) => r.stage === "planning" ? { ok: true, stage: "planning", value: { ...plan,
    decision: { ...decision, options: decision.options.map((o, i) => i !== 0 ? o : { ...o,
      task: { ...o.task!, brief, inquiries: [], prerequisiteFactIds: ["fact_notice"] },
    }) as unknown as typeof decision.options },
  } } : generate(r, e);
  h.source.reviewDialogueConsistency = async r => {
    if (r.checks.every(c => c.kind.startsWith("plan_"))) {
      expect(requests.filter(r => r.stage !== "planning")).toEqual([]);
      expect(r.checks.find(c => c.kind === "plan_option")?.brief).toBe(brief);
    }
    return { ok: true, verdict: "pass", violations: [] };
  };
  expect((await h.run()).ok).toBe(true);
});

it("前置审核先扣费保存running，恢复未知结果保留次数和预算且不调用表达", async () => {
  const { h, requests } = await dialogueReviewHarness();
  h.source.reviewDialogueConsistency = async request => {
    if (request.checks.every(c => c.kind.startsWith("plan_"))) {
      const row = await h.readJob();
      if (!row.ok) throw Error(row.code);
      expect(row.value.usedRequests).toBe(2);
      expect(Object.values(row.value.planningDialogueReviews!).every(r => r.status === "running" && r.attempts === 1)).toBe(true);
      h.controller.abort();
    }
    return { ok: true, verdict: "pass", violations: [] };
  };
  expect((await h.run()).ok).toBe(false);
  expect(requests.filter(r => r.stage !== "planning")).toEqual([]);
  const stored = await h.readJob();
  if (!stored.ok) throw Error(stored.code);
  expect(Object.values(stored.value.planningDialogueReviews!).every(r => r.status === "running" && r.attempts === 1)).toBe(true);
  // Resume the same cycle: unknown HTTP outcome is charged, never free.
  await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version, job: { ...stored.value, status: "pending" } });
  let preflight = 0;
  h.source.reviewDialogueConsistency = async request => {
    if (request.checks.every(c => c.kind.startsWith("plan_"))) preflight++;
    return { ok: true, verdict: "pass", violations: [] };
  };
  const resumed = await runJob({ id: h.jobId(), lease: h.lease() }, { jobs: h.jobs, source: h.source,
    now: () => h.clock.now(), signal: new AbortController().signal });
  if (!resumed.ok) throw Error(resumed.code);
  expect(preflight).toBe(1);
  expect(Object.values(resumed.value.planningDialogueReviews!).every(r => r.status === "approved" && r.attempts === 2)).toBe(true);
  expect(resumed.value.usedRequests).toBe(resumed.value.baselineRequests + 1);
});

it.each(["uncertain", "invalid_id"])("前置审核%s两次后失败，所有表达为零", async mode => {
  const { h, requests } = await dialogueReviewHarness();
  let count = 0;
  h.source.reviewDialogueConsistency = async () => {
    count++;
    return mode === "uncertain" ? { ok: true, verdict: "uncertain", violations: [] }
      : { ok: true, verdict: "reject", violations: [{ checkId: "foreign", type: "intent_mismatch", inquiryId: null }] };
  };
  expect(await h.run()).toMatchObject({ ok: false, code: mode === "uncertain" ? "dialogue_consistency_review_uncertain" : "dialogue_consistency_review_failed" });
  expect(count).toBe(2);
  expect(requests.filter(r => r.stage !== "planning")).toEqual([]);
  const row = await h.readJob();
  if (!row.ok) throw Error(row.code);
  expect(row.value.usedRequests).toBe(3);
  expect(Object.values(row.value.planningDialogueReviews!).every(r => r.status === "failed" && r.attempts === 2)).toBe(true);
});

it("辨认/可信度固定对照保留原始合同，地址不能冒充已编码维度", () => {
  for (const sample of planningDimensionCases) {
    const compiled = compileDialogueReviewChecks([sample.subject], "planning");
    const check = compiled.request.checks[0]!;
    expect(check.brief).toBe(sample.subject.brief);
    expect(check.text).toBeUndefined();
    expect(check.inquiries.map(q => q.aspect)).toEqual(sample.id === "recognition_encoded" ? ["identity"] : []);
    if (sample.expectedAspect !== null) {
      const address = check.inquiryTargets.find(q => q.aspect === sample.expectedAspect)!;
      const verdict = parseDialogueReviewVerdict({ verdict: "reject", violations: [{ checkId: check.checkId,
        type: "extra_inquiry", inquiryId: address.inquiryId }] }, compiled.request)!;
      expect(routeDialogueReviewVerdict(verdict, compiled).violations[0]?.aspect).toBe(sample.expectedAspect);
    }
  }
});
