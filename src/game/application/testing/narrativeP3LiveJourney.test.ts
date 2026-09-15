import { describe, expect, it } from "vitest";
import {
  NARRATIVE_P3_BATCH_BUDGET,
  NARRATIVE_P3_INPUT,
  NARRATIVE_P3_PROTOCOL_VERSION,
  NARRATIVE_P3_ROUTES,
  createNarrativeP3Protocol,
  selectNarrativeP3Action,
} from "./narrativeP3LiveJourney";

const deps = {
  environment: { model: "fixture-model", apiBaseUrl: "https://fixture.invalid", inputMaxEstimatedTokens: 64_000 },
  codeFingerprint: "fixture-code",
};

describe("narrative P3 live journey protocol", () => {
  it("freezes the three-act input, two-route denominator, and bounded budgets", () => {
    const protocol = createNarrativeP3Protocol("p3-fixture", deps);

    expect(protocol.protocolVersion).toBe(NARRATIVE_P3_PROTOCOL_VERSION);
    expect(protocol.plannedRoutes).toBe(2);
    expect(protocol.routes).toEqual(NARRATIVE_P3_ROUTES);
    expect(protocol.input).toEqual(NARRATIVE_P3_INPUT);
    expect(protocol.routes.every((route) => route.budget.actions === 32 && route.budget.http === 300)).toBe(true);
    expect(protocol.batchBudget).toEqual(NARRATIVE_P3_BATCH_BUDGET);
    expect(JSON.stringify(protocol)).not.toContain("fixture-secret");
  });

  it("selects an actual action reference by route policy, never by its label", () => {
    const actions = [
      { choiceToken: "opaque-quiet", action: { type: "investigate" as const, factId: "fact_dyn_2", approachId: "quiet" }, label: "现场核对" },
      { choiceToken: "opaque-witnessed", action: { type: "investigate" as const, factId: "fact_dyn_2", approachId: "witnessed" }, label: "请人见证" },
    ];

    expect(selectNarrativeP3Action({ route: "private", actions })).toEqual(actions[0]);
    expect(selectNarrativeP3Action({ route: "public", actions })).toEqual(actions[1]);
    expect(() => selectNarrativeP3Action({ route: "private", actions: [] })).toThrow("P3_CAPABILITY_COVERAGE_FAILED");
  });
});
