import { describe, expect, it } from "vitest";
import {
  JOURNEY_REPORT_VERSION,
  toJourneySummary,
  validateJourneyReport,
  type JourneyReport,
} from "./runtimeNarrativeJourney";

function passingReport(): JourneyReport {
  return {
    version: JOURNEY_REPORT_VERSION,
    mode: "replay",
    outcome: "success",
    turns: 11,
    aiCalls: 15,
    maxTurns: 20,
    maxAiCalls: 40,
    reloadConsistent: true,
    contentBudgetValid: true,
    mandatoryFallbacks: 0,
    coverage: {
      narrativeChoices: 5,
      generatedNpcLines: 1,
      firstVisitedLocations: 3,
      firstMetNpcs: 1,
      obtainedItems: 1,
      battlesStarted: 1,
      battlesWon: 1,
    },
  };
}

describe("runtime narrative journey report", () => {
  it("accepts a complete successful journey", () => {
    expect(validateJourneyReport(passingReport())).toEqual([]);
  });

  it.each([
    ["JOURNEY_NOT_SUCCESSFUL", { outcome: "unfinished" }],
    ["TURN_BUDGET_EXCEEDED", { turns: 21 }],
    ["AI_CALL_BUDGET_EXCEEDED", { aiCalls: 41 }],
    ["RELOAD_MISMATCH", { reloadConsistent: false }],
    ["CONTENT_BUDGET_VIOLATION", { contentBudgetValid: false }],
    ["MANDATORY_AI_FALLBACK", { mandatoryFallbacks: 1 }],
  ] as const)("rejects %s", (issue, patch) => {
    expect(validateJourneyReport({ ...passingReport(), ...patch })).toContain(issue);
  });

  it.each([
    ["NO_NARRATIVE_CHOICE", "narrativeChoices"],
    ["NO_NPC_DIALOGUE", "generatedNpcLines"],
    ["NO_NEW_LOCATION", "firstVisitedLocations"],
    ["NO_NEW_NPC", "firstMetNpcs"],
    ["NO_ITEM", "obtainedItems"],
    ["NO_BATTLE", "battlesStarted"],
    ["NO_BATTLE_VICTORY", "battlesWon"],
  ] as const)("rejects %s", (issue, key) => {
    const report = passingReport();
    expect(validateJourneyReport({
      ...report,
      coverage: { ...report.coverage, [key]: 0 },
    })).toContain(issue);
  });

  it("summary only contains aggregate allowlisted data", () => {
    const serialized = JSON.stringify(toJourneySummary(passingReport()));
    expect(serialized).not.toContain("actionKey");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("fact_");
  });
});

