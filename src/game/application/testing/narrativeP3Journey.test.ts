/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { runOfflineP3Story } from "./narrativeP3Journey.testutil";

describe("P3 divergent evidence and cooperation journeys", () => {
  it("completes the private route with a reload-safe recalled investigation", async () => {
    const result = await runOfflineP3Story({ route: "private", reloadAfterInvestigation: true });

    expect(result.completed).toBe(true);
    expect(result.itemGivenEventCount).toBe(1);
    expect(result.investigationEventIds.length).toBeGreaterThan(0);
    expect(result.goalChangeEventIds.length).toBeGreaterThan(0);
    expect(result.recalledEvidenceInAuthorRequest).toBe(true);
    expect(result.privateEvidenceLeaked).toBe(false);
    expect(result.reloadEqual).toBe(true);
    expect(result.availableActionsAfterEvidence).not.toEqual(result.availableActionsBeforeEvidence);
    expect(result.verificationAvailableAfterInvestigation).toBe(false);
    expect(result.goalEvidenceKindsAfterFollowUps).toContain("story_interaction_resolved");
    expect(result.revisited).toBe(true);
    expect(result.revisitSourceEventIds).toEqual(expect.arrayContaining([...result.investigationEventIds]));
    expect(result.giverKnewBeforeTelling).toBe(false);
    expect(result.giverLearnedFromTelling).toBe(true);
    expect(result.giverVerifiedAfterTelling).toBe(true);
    expect(result.revisitChoicesOnlyPresentNpc).toBe(true);
    expect(result.privateJourneyCausalOrder).toEqual(["leave", "investigate", "revisit", "tell", "goal_changed", "verify", "resume", "deliver"]);
  }, 30_000);

  it("completes the public route with a witnessed investigation and a different action set", async () => {
    const result = await runOfflineP3Story({ route: "public", reloadAfterInvestigation: true });

    expect(result.completed).toBe(true);
    expect(result.itemGivenEventCount).toBe(1);
    expect(result.investigationEventIds.length).toBeGreaterThan(0);
    expect(result.goalChangeEventIds.length).toBeGreaterThan(0);
    expect(result.publicWitnessFactIds.length).toBeGreaterThan(0);
    expect(result.privateEvidenceLeaked).toBe(false);
    expect(result.reloadEqual).toBe(true);
    expect(result.availableActionsAfterEvidence).not.toEqual(result.availableActionsBeforeEvidence);
    expect(result.verificationAvailableAfterInvestigation).toBe(true);
    expect(result.goalEvidenceKindsAfterFollowUps).toContain("fact_discovered");
  }, 30_000);

  it("keeps the witness boundary route-dependent while sharing the approved initial state", async () => {
    const privateRoute = await runOfflineP3Story({ route: "private", reloadAfterInvestigation: false });
    const publicRoute = await runOfflineP3Story({ route: "public", reloadAfterInvestigation: false });

    expect(privateRoute.publicWitnessFactIds).not.toEqual(publicRoute.publicWitnessFactIds);
    expect(privateRoute.investigationEventIds).not.toEqual(publicRoute.investigationEventIds);
    expect(privateRoute.verificationAvailableAfterInvestigation).toBe(false);
    expect(publicRoute.verificationAvailableAfterInvestigation).toBe(true);
    expect(privateRoute.goalEvidenceKindsAfterFollowUps).not.toEqual(publicRoute.goalEvidenceKindsAfterFollowUps);
  }, 60_000);
});
