export const JOURNEY_REPORT_VERSION = "phase10-journey-report-v1" as const;

export type JourneyCoverage = Readonly<{
  narrativeChoices: number;
  generatedNpcLines: number;
  firstVisitedLocations: number;
  firstMetNpcs: number;
  obtainedItems: number;
  battlesStarted: number;
  battlesWon: number;
}>;

export type JourneyReport = Readonly<{
  version: typeof JOURNEY_REPORT_VERSION;
  mode: "record" | "replay";
  outcome: "success" | "failure" | "unfinished";
  turns: number;
  aiCalls: number;
  maxTurns: number;
  maxAiCalls: number;
  reloadConsistent: boolean;
  contentBudgetValid: boolean;
  mandatoryFallbacks: number;
  coverage: JourneyCoverage;
}>;

export const JOURNEY_ISSUE_CODES = Object.freeze([
  "JOURNEY_NOT_SUCCESSFUL",
  "TURN_BUDGET_EXCEEDED",
  "AI_CALL_BUDGET_EXCEEDED",
  "RELOAD_MISMATCH",
  "CONTENT_BUDGET_VIOLATION",
  "MANDATORY_AI_FALLBACK",
  "NO_NARRATIVE_CHOICE",
  "NO_NPC_DIALOGUE",
  "NO_NEW_LOCATION",
  "NO_NEW_NPC",
  "NO_ITEM",
  "NO_BATTLE",
  "NO_BATTLE_VICTORY",
] as const);

export type JourneyIssueCode = (typeof JOURNEY_ISSUE_CODES)[number];

export function validateJourneyReport(report: JourneyReport): readonly JourneyIssueCode[] {
  const issues: JourneyIssueCode[] = [];
  if (report.outcome !== "success") issues.push("JOURNEY_NOT_SUCCESSFUL");
  if (report.turns > report.maxTurns) issues.push("TURN_BUDGET_EXCEEDED");
  if (report.aiCalls > report.maxAiCalls) issues.push("AI_CALL_BUDGET_EXCEEDED");
  if (!report.reloadConsistent) issues.push("RELOAD_MISMATCH");
  if (!report.contentBudgetValid) issues.push("CONTENT_BUDGET_VIOLATION");
  if (report.mandatoryFallbacks > 0) issues.push("MANDATORY_AI_FALLBACK");
  if (report.coverage.narrativeChoices < 1) issues.push("NO_NARRATIVE_CHOICE");
  if (report.coverage.generatedNpcLines < 1) issues.push("NO_NPC_DIALOGUE");
  if (report.coverage.firstVisitedLocations < 1) issues.push("NO_NEW_LOCATION");
  if (report.coverage.firstMetNpcs < 1) issues.push("NO_NEW_NPC");
  if (report.coverage.obtainedItems < 1) issues.push("NO_ITEM");
  if (report.coverage.battlesStarted < 1) issues.push("NO_BATTLE");
  if (report.coverage.battlesWon < 1) issues.push("NO_BATTLE_VICTORY");
  return issues;
}

/** Aggregate certification facts only; never story text or internal action keys. */
export function toJourneySummary(report: JourneyReport): Readonly<Record<string, unknown>> {
  return {
    version: report.version,
    mode: report.mode,
    outcome: report.outcome,
    turns: report.turns,
    aiCalls: report.aiCalls,
    maxTurns: report.maxTurns,
    maxAiCalls: report.maxAiCalls,
    reloadConsistent: report.reloadConsistent,
    contentBudgetValid: report.contentBudgetValid,
    mandatoryFallbacks: report.mandatoryFallbacks,
    coverage: report.coverage,
    issues: validateJourneyReport(report),
  };
}

