import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGenerationGrade, main } from "./storyEvalQualityGate.mjs";

function run({ strategy, gameType = "wuxia", pairId = "pair-1", converged = true, generatedFactCoverage = 0.8 } = {}) {
  const generatedUniverseFactIds = Array.from({ length: 10 }, (_, index) => `g${index + 1}`);
  const generatedUsedFactIds = generatedUniverseFactIds.slice(0, Math.floor(generatedFactCoverage * 10));
  return {
    manifest: { pairId, strategy, gameType },
    metrics: {
      converged,
      fallbackRate: 0,
      continuation: { trueDeadEnds: 0, recoveryLoops: 0 },
      pacing: { stageWindowViolations: 0, hasSetup: true, turnStages: [4], hasClimax: true, hasResolutionEvidence: true },
      mainlineObjective: { opportunities: 8, suggestedPresented: 8, suggestedChosen: 8, progressedScenes: 8 },
      facts: {
        generatedUniverseFactIds,
        generatedUsedFactIds,
        generatedDiscoveredFactIds: generatedUniverseFactIds.slice(0, 6),
        generatedUsedCoverageRate: generatedFactCoverage,
        generatedDiscoveredCoverageRate: 0.6,
      },
      choices: { pairedCheckpoints: 3, stateDifferent: 2, eventDifferent: 2, reconvergedCheckpoints: 1 },
    },
  };
}

const objectiveRun = (overrides = {}) => run({ strategy: "objective", ...overrides });
const exploreRun = (overrides = {}) => run({ strategy: "explore", ...overrides });

test("generation-grade pair passes deterministic hard gates", () => {
  const result = evaluateGenerationGrade([objectiveRun(), exploreRun()]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("non-converged objective and low generated-fact coverage fail the gate", () => {
  const result = evaluateGenerationGrade([
    objectiveRun({ converged: false, generatedFactCoverage: 0.25 }),
    exploreRun(),
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("OBJECTIVE_NOT_CONVERGED"));
  assert.ok(result.failures.includes("GENERATED_FACT_COVERAGE_LOW"));
});

test("release mode requires all seven supported game types", () => {
  const result = evaluateGenerationGrade([objectiveRun(), exploreRun()], { release: true });
  assert.ok(result.failures.includes("GAME_TYPE_COVERAGE_INCOMPLETE"));
});

test("legacy/missing pairing evidence fails instead of being treated as zero", () => {
  const incomplete = evaluateGenerationGrade([{ manifest: { strategy: "objective" }, metrics: {} }]);
  assert.ok(incomplete.failures.includes("EVIDENCE_INCOMPLETE"));
});

test("main without run directories returns a stable non-zero code", () => {
  const lines = [];
  assert.equal(main({ argv: [], log: (line) => lines.push(line) }), 1);
  assert.ok(lines.some((line) => line.includes("RUN_DIR_REQUIRED")));
});
