import { expect, it, vi } from "vitest";
import { createAiSourceFailure } from "../aiGenerationRetry";
import { dialogueReviewHarness } from "./dialogueConsistencyFixture.testutil";

it.each(["protocol", "reject"])("%s then reject shares a strict two-request cycle and never replans", async first => {
  const { h, requests } = await dialogueReviewHarness(false);
  let reviews = 0;
  h.source.reviewDialogueConsistency = async request => {
    reviews++;
    if (first === "protocol" && reviews === 1) return createAiSourceFailure("scene", "invalid_schema");
    return { ok: true, verdict: "reject", failedIds: [request.items.find(item => item.stage === "choices")!.id] };
  };
  expect(await h.run()).toMatchObject({ ok: false, code: "dialogue_consistency_review_exhausted" });
  expect(reviews).toBe(2);
  expect(requests.filter(request => request.stage === "planning")).toHaveLength(1);
  const loaded = await h.readJob(); if (!loaded.ok) throw Error(loaded.code);
  const count = requests.length;
  await h.jobs.save({ lease: h.lease(), expectedVersion: loaded.value.version, job: { ...loaded.value, status: "pending" } });
  expect(await h.run()).toMatchObject({ ok: false, code: "dialogue_consistency_review_exhausted" });
  expect(requests).toHaveLength(count); expect(reviews).toBe(2);
});

it("a rejected NPC repolishes its descendants, retaining the approved world and narration", async () => {
  const { h, requests } = await dialogueReviewHarness(); let reviews = 0;
  h.source.reviewDialogueConsistency = async (request, execution) => {
    expect(execution.repair).toBeUndefined();
    return ++reviews === 1
      ? { ok: true, verdict: "reject", failedIds: [request.items.find(item => item.stage === "character")!.id] }
      : { ok: true, verdict: "pass", failedIds: [] };
  };
  expect((await h.run()).ok).toBe(true);
  expect(requests.filter(request => request.stage === "planning")).toHaveLength(1);
  expect(requests.filter(request => request.stage === "narration")).toHaveLength(1);
  expect(requests.filter(request => request.stage === "character")).toHaveLength(2);
  expect(requests.filter(request => request.stage === "choices")).toHaveLength(2);
  expect(reviews).toBe(2);
});

it.each(["uncertain", "provider", "throw"])("%s is explicit failure without polish or plan recovery", async failure => {
  const { h, requests } = await dialogueReviewHarness();
  const review = vi.fn(async () => {
    if (failure === "throw") throw Error("offline failure");
    return failure === "provider" ? createAiSourceFailure("scene", "unavailable") : { ok: true as const, verdict: "uncertain" as const, failedIds: [] };
  });
  h.source.reviewDialogueConsistency = review;
  expect((await h.run()).ok).toBe(false);
  expect(review).toHaveBeenCalledTimes(1);
  expect(requests.filter(request => request.stage === "planning")).toHaveLength(1);
});

it.each(["cancel", "deadline", "lease"])("late review cannot persist pass after %s", async change => {
  const { h } = await dialogueReviewHarness();
  h.source.reviewDialogueConsistency = async () => {
    if (change === "cancel") h.controller.abort();
    else h.clock.advance(change === "deadline" ? 600_001 : 31_000);
    if (change === "lease") await h.jobs.claim({ id: h.jobId(), owner: "other-worker", now: h.clock.now(), expiresAt: new Date(Date.parse(h.clock.now()) + 30_000).toISOString() });
    return { ok: true, verdict: "pass", failedIds: [] };
  };
  expect((await h.run()).ok).toBe(false);
  const loaded = await h.readJob(); if (!loaded.ok) throw Error(loaded.code);
  expect(loaded.value.dialogueConsistencyReview?.status).not.toBe("approved");
  expect(loaded.value.dialogueConsistencyReview?.attempts).toBe(1);
});

it("review charge and running receipt precede provider send; unchanged pass is reused", async () => {
  const { h } = await dialogueReviewHarness(); let calls = 0;
  h.source.reviewDialogueConsistency = async () => {
    calls++; const loaded = await h.readJob(); if (!loaded.ok) throw Error(loaded.code);
    expect(loaded.value.dialogueConsistencyReview).toMatchObject({ attempts: 1, status: "running" });
    expect(loaded.value.usedRequests).toBe(5);
    return { ok: true, verdict: "pass", failedIds: [] };
  };
  expect((await h.run()).ok).toBe(true); expect((await h.run()).ok).toBe(true); expect(calls).toBe(1);
});
