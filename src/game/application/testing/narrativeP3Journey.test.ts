/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { runOfflineP3Story } from "./narrativeP3Journey.testutil";

describe("P3 divergent evidence and cooperation journeys", () => {
  it("completes the private route with a reload-safe recalled investigation", async () => {
    const result = await runOfflineP3Story({ route: "private", reloadAtRevisit: true });

    expect(result.completed).toBe(true);
    expect(result.itemGivenEventCount).toBe(1);
    expect(result.investigationEventIds.length).toBeGreaterThan(0);
    expect(result.goalChangeEventIds.length).toBeGreaterThan(0);
    expect(result.recalledEvidenceInAuthorRequest).toBe(true);
    expect(result.privateEvidenceLeaked).toBe(false);
    expect(result.reloadEqual).toBe(true);
    expect(result.availableActionsAfterEvidence).not.toEqual(result.availableActionsBeforeEvidence);
  }, 30_000);

  it("completes the public route with a witnessed investigation and a different action set", async () => {
    const result = await runOfflineP3Story({ route: "public", reloadAtRevisit: true });

    expect(result.completed).toBe(true);
    expect(result.itemGivenEventCount).toBe(1);
    expect(result.investigationEventIds.length).toBeGreaterThan(0);
    expect(result.goalChangeEventIds.length).toBeGreaterThan(0);
    expect(result.publicWitnessFactIds.length).toBeGreaterThan(0);
    expect(result.privateEvidenceLeaked).toBe(false);
    expect(result.reloadEqual).toBe(true);
    expect(result.availableActionsAfterEvidence).not.toEqual(result.availableActionsBeforeEvidence);
  }, 30_000);

  it("keeps the witness boundary route-dependent while sharing the approved initial state", async () => {
    const privateRoute = await runOfflineP3Story({ route: "private", reloadAtRevisit: false });
    const publicRoute = await runOfflineP3Story({ route: "public", reloadAtRevisit: false });

    expect(privateRoute.publicWitnessFactIds).not.toEqual(publicRoute.publicWitnessFactIds);
    expect(privateRoute.investigationEventIds).not.toEqual(publicRoute.investigationEventIds);
  }, 60_000);
});
