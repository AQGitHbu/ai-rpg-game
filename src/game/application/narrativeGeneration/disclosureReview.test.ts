import { describe, expect, it, vi } from "vitest";
import { createStagedHarness } from "@/game/application/testing/stagedNarrativeHarness.testutil";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import { asFactId } from "@/game/domain/worldEntity";
import type { StageSource } from "./stageSource";
import { validateJobDisclosureReviews } from "./disclosureReview";
import { approvePlanningContext } from "./approvePlanningContext";

async function disclosureHarness(verdict: "pass" | "reject" | "uncertain" = "pass") {
  const h = createStagedHarness();
  await h.startDecision();
  const stored = await h.readJob();
  if (!stored.ok || stored.value.input.kind !== "decision") throw Error("job");
  const world = stored.value.input.world;
  const factId = asFactId("fact_new_disclosure");
  const nextWorld = createWorldStateFixtureWith({ generation: world.generation, base: {
    ...world, worldFacts: [{ factId, text: "官差藏身义庄。", source: "generated", discovered: false }],
    npcs: world.npcs.map((npc, index) => index === 0 ? { ...npc,
      memory: { ...npc.memory, knownFactIds: [factId], hiddenFactIds: [] } } : npc),
  } });
  await h.jobs.save({ lease: h.lease(), expectedVersion: stored.value.version,
    job: { ...stored.value, input: { ...stored.value.input, world: nextWorld } } });
  const generate = h.source.generate.bind(h.source);
  h.source.generate = async (request, execution) => {
    const response = await generate(request, execution);
    if (!response.ok) return response;
    if (response.stage === "planning") return { ...response, value: { ...response.value,
      observations: [{ key: "heard_new", source: { kind: "speech", speakerId: "npc_0" },
        point: { stepKey: "current", order: 2 }, audienceIds: ["player_0", "npc_0"],
        fact: { factId, certainty: "known" } }],
      units: response.value.units.map(u => u.key === "character_npc_0"
        ? { ...u, requiredObservationKeys: ["heard_new"] } : u),
    } };
    if (response.stage === "character" && response.value.stage === "character" && response.value.speakerId === "npc_0")
      return { ...response, value: { ...response.value, parts: [{ text: verdict === "pass" ? "官差藏身义庄。" : "我不会告诉你这件事。",
        facts: [{ factId, certainty: "known" }], evidence: [], beatIds: [] }] } };
    return response;
  };
  const review = vi.fn(async () => ({ ok: true as const, verdict }));
  (h.source as StageSource).reviewDisclosure = review;
  return { h, review };
}

describe("disclosure review gate", () => {
  it.each(["reject", "uncertain"] as const)("%s 不得批准事实引用冒充实际披露", async verdict => {
    const { h, review } = await disclosureHarness(verdict);
    const result = await h.run();
    expect(result).toMatchObject({ ok: false, code: `disclosure_review_${verdict}` });
    expect(review).toHaveBeenCalledTimes(4);
    expect(h.calls.filter(c => c.stage === "choices")).toHaveLength(0);
    expect(h.publications()).toHaveLength(0);
  });
  it("通过的审核单独计费、绑定正文并可重放验证", async () => {
    const { h, review } = await disclosureHarness();
    const result = await h.run();
    if (!result.ok) throw Error(result.code);
    expect(review).toHaveBeenCalledTimes(1);
    expect(result.value.usedRequests).toBe(h.calls.length + 1);
    const plan = approvePlanningContext(result.value.input,
      result.value.units.find(u => u.key === "planning")!.value as import("@/game/domain/narrativePlan").PlanProposal);
    if (!plan.ok) throw Error(plan.code);
    expect(validateJobDisclosureReviews(result.value, plan.value).ok).toBe(true);
    const altered = { ...result.value, units: result.value.units.map(u =>
      u.value !== null && "stage" in u.value && u.value.stage === "character" && u.key === "character_npc_0"
        ? { ...u, value: { ...u.value, parts: u.value.parts.map(p => ({ ...p, text: "篡改后的正文。" })) } } : u) };
    expect(validateJobDisclosureReviews(altered, plan.value)).toMatchObject({ ok: false });
  });
  it("缺少审核端口明确失败，不调用下游表达", async () => {
    const { h } = await disclosureHarness();
    delete (h.source as StageSource).reviewDisclosure;
    expect(await h.run()).toMatchObject({ ok: false, code: "disclosure_review_unavailable" });
    expect(h.calls.filter(c => c.stage === "choices")).toHaveLength(0);
  });
  it("审核异常不得放行或生成下游选项", async () => {
    const { h } = await disclosureHarness();
    (h.source as StageSource).reviewDisclosure = async () => { throw Error("offline"); };
    expect(await h.run()).toMatchObject({ ok: false, code: "disclosure_review_failed" });
    expect(h.calls.filter(c => c.stage === "choices")).toHaveLength(0);
  });
  it("额度耗尽不发起审核请求", async () => {
    const { h, review } = await disclosureHarness();
    const first = await h.run();
    if (!first.ok) throw Error(first.code);
    review.mockClear();
    await h.jobs.save({ lease: h.lease(), expectedVersion: first.value.version,
      job: { ...first.value, usedRequests: first.value.baselineRequests + 11,
        units: first.value.units.map(u => u.key === "character_npc_0" || u.unit?.stage === "choices"
          ? { ...u, status: "pending", value: null, disclosureReviewDigest: undefined } : u) } });
    expect(await h.run()).toMatchObject({ ok: false, code: "job_budget_exhausted" });
    expect(review).not.toHaveBeenCalled();
  });
  it("缺失旧凭据使单元和下游缓存失效，必须重新审核", async () => {
    const { h, review } = await disclosureHarness();
    const ran = await h.run();
    if (!ran.ok) throw Error(ran.code);
    await h.jobs.save({ lease: h.lease(), expectedVersion: ran.value.version,
      job: { ...ran.value, units: ran.value.units.map(u => ({ ...u, disclosureReviewDigest: undefined })) } });
    expect((await h.run()).ok).toBe(true);
    expect(review).toHaveBeenCalledTimes(2);
    expect(h.calls.filter(c => c.stage === "planning")).toHaveLength(1);
    expect(h.calls.filter(c => c.stage === "choices")).toHaveLength(2);
  });
});
