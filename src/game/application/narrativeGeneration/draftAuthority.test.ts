import { expect, it } from "vitest";
import { dialogueReviewHarness } from "./dialogueConsistencyFixture.testutil";
import { approvePlanningContext } from "./approvePlanningContext";
it.each(["facts", "beats", "actions"])("fresh draft invalid %s fails before plan acceptance", async field => {
  const { h, plan } = await dialogueReviewHarness(); const loaded = await h.readJob(); if (!loaded.ok) throw Error(loaded.code);
  const invalid = { ...plan, units: plan.units.map(unit => unit.draft?.stage === "narration" ? { ...unit,
    draft: { ...unit.draft, ...(field === "actions" ? { actionKeys: ["unapproved_action"] } : {}),
      parts: unit.draft.parts.map(part => ({ ...part,
        ...(field === "facts" ? { facts: [{ factId: "hidden_fact", certainty: "known" as const }] } : {}),
        ...(field === "beats" ? { beatIds: ["unapproved_beat"] } : {}) })) } } : unit) };
  expect(approvePlanningContext(loaded.value.input, invalid).ok).toBe(false);
});
it("candidate publicIntent references cannot grant knowledge or leak a private fact", async () => {
  const { h, plan } = await dialogueReviewHarness(); const loaded = await h.readJob(); if (!loaded.ok || plan.decision?.kind !== "ordinary") throw Error("fixture");
  const decision = plan.decision;
  const invalid = { ...plan, decision: { ...decision, options: decision.options.map(option => ({ ...option,
    publicIntent: { ...option.publicIntent, facts: [{ factId: "hidden_fact", certainty: "known" as const }] } })) as unknown as typeof decision.options } };
  expect(approvePlanningContext(loaded.value.input, invalid)).toMatchObject({ ok: false, code: "choice_intent_authority_conflict" });
});
