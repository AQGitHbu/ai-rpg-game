import { expect, it } from "vitest";
import { dialogueReviewHarness } from "./dialogueConsistencyFixture.testutil";
import { createLiveStageSource } from "../server/ai/staged/liveStageSource";
import type { RpgAiClient } from "../server/ai/rpgAiClient";
it.each([0, 1, 4])("one full planner, three pure polishers and one review; legacy cache retains %s planning attempts", async attempts => {
  const { h, plan } = await dialogueReviewHarness(); if (plan.decision?.kind !== "ordinary") throw Error("fixture");
  const loaded = await h.readJob(); if (!loaded.ok) throw Error(loaded.code);
  if (attempts > 0) await h.jobs.save({ lease: h.lease(), expectedVersion: loaded.value.version, job: { ...loaded.value,
    usedRequests: attempts + 1, units: [{ key: "planning", unit: null, inputDigest: loaded.value.inputDigest, attempts, status: "approved",
      value: { ...plan, units: plan.units.map(({ draft: _, ...unit }) => unit) } }, { key: "old_expression", unit: plan.units[0]!, inputDigest: "old", attempts: 1, status: "approved", value: plan.units[0]!.draft! }] } });
  const wire = { ...plan, units: plan.units.map(({ taskFactIds: _, ...unit }) => unit), decision: { ...plan.decision,
    options: plan.decision.options.map(option => { const { text: _, ...references } = option.publicIntent; return { ...option, publicIntent: references }; }) } };
  const calls: string[] = [];
  const client = { complete: async (role, messages) => {
    calls.push(role); const text = messages.map(message => message.content).join("\n");
    expect(text).not.toContain('"inquiries"');
    const draft = plan.units.find(unit => unit.stage === role)?.draft;
    const value = role === "planning" ? wire : role === "dialogue_consistency_review" ? { verdict: "pass", failedIds: [] }
      : draft?.stage === "choices" ? { labels: draft.labels } : draft === undefined ? {} : { texts: draft.parts.map(part => part.text) };
    return { ok: true, content: JSON.stringify(value), latencyMs: 1 };
  } } as RpgAiClient;
  Object.assign(h.source, createLiveStageSource({ client }));
  const result = await h.run();
  if (attempts === 4) { expect(result).toMatchObject({ ok: false, code: "unit_attempts_exhausted" }); expect(calls).toEqual([]);
    const failed = await h.readJob(); expect(failed.ok && failed.value.usedRequests).toBe(5); return; }
  expect(result).toMatchObject({ ok: true });
  expect(calls).toEqual(["planning", "narration", "character", "choices", "dialogue_consistency_review"]);
  if (result.ok) { expect(result.value.usedRequests).toBe(attempts > 0 ? 7 : 5); expect(result.value.units.find(unit => unit.key === "planning")?.attempts).toBe(attempts + 1); }
});
