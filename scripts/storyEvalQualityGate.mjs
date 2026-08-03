// ---------------------------------------------------------------------------
// storyEvalQualityGate：生成级质量门禁（零 AI 成本）。
// 读取 analyze/judge 产物，按 pairId 聚合事实与分支证据；缺字段一律视为
// 证据不完整，不把旧产物默认为零质量。--release 额外要求七种题材覆盖。
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
import * as realFs from "node:fs";

export const GENERATION_GRADE_THRESHOLDS = Object.freeze({
  maxFallbackRate: 0.05,
  minObjectiveConvergenceRate: 1,
  minExploreBaselineConvergenceRate: 0.8,
  minGeneratedFactNarrationCoverage: 0.7,
  minGeneratedFactDiscoveryCoverage: 0.5,
  minDurableBranchCheckpoints: 2,
  maxReconvergedCheckpoints: 1,
});

const REQUIRED_GAME_TYPES = [
  "wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse",
];

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function hasFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function requiredRunEvidence(run) {
  const missing = [];
  const manifest = run?.manifest;
  const metrics = run?.metrics;
  if (manifest === null || typeof manifest !== "object") missing.push("manifest");
  if (metrics === null || typeof metrics !== "object") missing.push("metrics");
  if (typeof manifest?.pairId !== "string" || manifest.pairId.trim() === "") missing.push("pairId");
  if (manifest?.strategy !== "objective" && manifest?.strategy !== "explore") missing.push("strategy");
  if (typeof manifest?.gameType !== "string" || manifest.gameType.trim() === "") missing.push("gameType");
  for (const field of ["converged", "fallbackRate", "mainlineObjective", "facts", "choices", "pacing"]) {
    if (metrics?.[field] === undefined || metrics?.[field] === null) missing.push(`metrics.${field}`);
  }
  if (metrics?.continuation === undefined || metrics?.continuation === null) missing.push("metrics.continuation");
  if (metrics?.facts && !Array.isArray(metrics.facts.generatedUniverseFactIds)) missing.push("metrics.facts.generatedUniverseFactIds");
  if (metrics?.facts && !Array.isArray(metrics.facts.generatedUsedFactIds)) missing.push("metrics.facts.generatedUsedFactIds");
  if (metrics?.facts && !Array.isArray(metrics.facts.generatedDiscoveredFactIds)) missing.push("metrics.facts.generatedDiscoveredFactIds");
  return missing;
}

export function evaluateGenerationGrade(runs, options = {}) {
  const failures = [];
  const warnings = [];
  for (const run of runs) {
    if (requiredRunEvidence(run).length > 0) pushUnique(failures, "EVIDENCE_INCOMPLETE");
  }
  const objectives = runs.filter((run) => run?.manifest?.strategy === "objective");
  const explores = runs.filter((run) => run?.manifest?.strategy === "explore");
  const pairs = new Map();
  for (const run of runs) {
    const pairId = run?.manifest?.pairId;
    if (typeof pairId !== "string" || pairId === "") continue;
    pairs.set(pairId, [...(pairs.get(pairId) ?? []), run]);
  }
  const rate = (items, predicate) => items.length === 0 ? 0 : items.filter(predicate).length / items.length;

  if (objectives.length === 0 || rate(objectives, (run) => run.metrics?.converged === true) < GENERATION_GRADE_THRESHOLDS.minObjectiveConvergenceRate) {
    pushUnique(failures, "OBJECTIVE_NOT_CONVERGED");
  }
  if (objectives.some((run) => {
    const objective = run.metrics?.mainlineObjective ?? {};
    return !Number.isInteger(objective.opportunities) || objective.opportunities <= 0 ||
      objective.suggestedPresented !== objective.opportunities ||
      objective.suggestedChosen !== objective.opportunities ||
      objective.progressedScenes !== objective.opportunities;
  })) pushUnique(failures, "MAINLINE_PROGRESS_INCOMPLETE");
  if (options.release === true && explores.length > 0 && rate(explores, (run) => run.metrics?.converged === true) < GENERATION_GRADE_THRESHOLDS.minExploreBaselineConvergenceRate) {
    pushUnique(failures, "EXPLORE_CONVERGENCE_LOW");
  }
  if (runs.some((run) => (run.metrics?.continuation?.trueDeadEnds ?? 0) > 0)) pushUnique(failures, "TRUE_DEAD_END");
  if (runs.some((run) => (run.metrics?.continuation?.recoveryLoops ?? 0) > 0)) pushUnique(failures, "RECOVERY_LOOP");
  if (runs.some((run) => !hasFiniteNumber(run.metrics?.fallbackRate) || run.metrics.fallbackRate > GENERATION_GRADE_THRESHOLDS.maxFallbackRate)) pushUnique(failures, "FALLBACK_RATE_HIGH");
  if (runs.some((run) => (run.metrics?.pacing?.stageWindowViolations ?? 0) > 0)) pushUnique(failures, "PACING_WINDOW_VIOLATION");
  if (objectives.some((run) =>
    run.metrics?.pacing?.hasSetup !== true ||
    run.metrics?.pacing?.hasClimax !== true ||
    run.metrics?.pacing?.hasResolutionEvidence !== true ||
    !Array.isArray(run.metrics?.pacing?.turnStages) || run.metrics.pacing.turnStages.length === 0
  )) pushUnique(failures, "PACING_ARC_INCOMPLETE");

  for (const run of runs) {
    const facts = run.metrics?.facts;
    const universe = Array.isArray(facts?.generatedUniverseFactIds) ? new Set(facts.generatedUniverseFactIds) : new Set();
    if (universe.size > 0) {
      const used = Array.isArray(facts.generatedUsedFactIds) ? new Set(facts.generatedUsedFactIds) : new Set();
      const discovered = Array.isArray(facts.generatedDiscoveredFactIds) ? new Set(facts.generatedDiscoveredFactIds) : new Set();
      if (used.size / universe.size < GENERATION_GRADE_THRESHOLDS.minGeneratedFactNarrationCoverage) pushUnique(failures, "GENERATED_FACT_COVERAGE_LOW");
      if (discovered.size / universe.size < GENERATION_GRADE_THRESHOLDS.minGeneratedFactDiscoveryCoverage) pushUnique(failures, "GENERATED_FACT_DISCOVERY_LOW");
    }
  }

  for (const pairRuns of pairs.values()) {
    const union = (field) => new Set(pairRuns.flatMap((run) => run.metrics?.facts?.[field] ?? []));
    const universe = union("generatedUniverseFactIds");
    const used = union("generatedUsedFactIds");
    const discovered = union("generatedDiscoveredFactIds");
    if (universe.size === 0) {
      pushUnique(failures, "GENERATED_FACT_EVIDENCE_MISSING");
    } else {
      if (used.size / universe.size < GENERATION_GRADE_THRESHOLDS.minGeneratedFactNarrationCoverage) pushUnique(failures, "GENERATED_FACT_COVERAGE_LOW");
      if (discovered.size / universe.size < GENERATION_GRADE_THRESHOLDS.minGeneratedFactDiscoveryCoverage) pushUnique(failures, "GENERATED_FACT_DISCOVERY_LOW");
    }
  }

  const minCheckpoints = options.release === true ? 3 : 1;
  const minDurableCheckpoints = options.release === true ? GENERATION_GRADE_THRESHOLDS.minDurableBranchCheckpoints : 1;
  if (runs.some((run) => {
    const choices = run.metrics?.choices ?? {};
    return !Number.isInteger(choices.pairedCheckpoints) || choices.pairedCheckpoints < minCheckpoints ||
      Math.max(choices.stateDifferent ?? 0, choices.eventDifferent ?? 0) < minDurableCheckpoints ||
      (choices.reconvergedCheckpoints ?? 0) > GENERATION_GRADE_THRESHOLDS.maxReconvergedCheckpoints;
  })) pushUnique(failures, "BRANCH_DURABILITY_LOW");

  for (const run of runs.filter((entry) => entry?.scores !== undefined)) {
    if ((run.scores?.failures ?? []).length > 0) pushUnique(failures, "JUDGE_EVIDENCE_INCOMPLETE");
    for (const dimension of ["S1", "S3", "S7", "S8", "S9"]) {
      if ((run.scores?.storyLevel?.scores?.[dimension]?.score ?? 0) < 3) pushUnique(failures, `JUDGE_${dimension}_LOW`);
    }
    for (const dimension of ["C1", "C2", "C3", "C4"]) {
      const entries = run.scores?.sceneLevel?.[dimension]?.scores ?? [];
      if (entries.some((entry) => entry.score < 3)) pushUnique(failures, `JUDGE_${dimension}_LOW`);
    }
  }
  if (options.release === true) {
    if (runs.some((run) => run?.scores === undefined)) pushUnique(failures, "JUDGE_EVIDENCE_INCOMPLETE");
    const covered = new Set(runs.map((run) => run?.manifest?.gameType));
    if (REQUIRED_GAME_TYPES.some((gameType) => !covered.has(gameType))) pushUnique(failures, "GAME_TYPE_COVERAGE_INCOMPLETE");
  }
  return {
    ok: failures.length === 0,
    failures,
    warnings,
    summary: { objectives: objectives.length, explores: explores.length, pairs: pairs.size },
  };
}

function loadRun(runDir, fs) {
  const readJson = (name, required) => {
    try {
      return JSON.parse(fs.readFileSync(resolve(runDir, name), "utf8"));
    } catch {
      if (required) throw new Error(`missing ${name}`);
      return undefined;
    }
  };
  return {
    manifest: readJson("manifest.json", true),
    metrics: readJson("metrics.json", true),
    scores: readJson("scores.json", false),
  };
}

export function main({ argv = process.argv.slice(2), fs = realFs, log = console.log } = {}) {
  const release = argv.includes("--release");
  const runDirs = argv.filter((entry) => entry !== "--release");
  if (runDirs.length === 0) {
    log("[story-eval-gate] RUN_DIR_REQUIRED");
    return 1;
  }
  let runs;
  try {
    runs = runDirs.map((runDir) => loadRun(runDir, fs));
  } catch {
    log("[story-eval-gate] EVIDENCE_INCOMPLETE");
    return 1;
  }
  const result = evaluateGenerationGrade(runs, { release });
  log(`[story-eval-gate] ${result.ok ? "GENERATION_GRADE_OK" : `GENERATION_GRADE_FAILED ${result.failures.join(",")}`}`);
  return result.ok ? 0 : 1;
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  process.exitCode = main();
}
