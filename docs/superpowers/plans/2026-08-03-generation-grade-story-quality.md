# Generation-Grade Story Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current single-case success into a production gate where generated RPGs remain playable after exploration, use their generated facts in the rule-backed story, preserve meaningful branch consequences, and converge to an evidence-complete ending across supported game types.

**Architecture:** Keep AI responsible for scenario/director/writer/NPC content and keep the rule engine authoritative. First make explore/objective evaluations share one generated blueprint, then distinguish a playable one-action transition from a true dead end. Reject blueprints whose facts or act descriptions cannot support the story, and finish with a deterministic generation-grade gate that aggregates objective, explore, fact, branch, pacing, ending, and reliability evidence.

**Tech Stack:** TypeScript, Vitest, Node.js, JSONL story-evaluation artifacts, PowerShell/npm real-AI runners.

## Global Constraints

- AI output never mutates `GameState`; only existing validated `PlayerIntent` and rule events may change state.
- Do not fabricate a second narrative action when only one legal action exists; the evaluator may execute the single legal rule action as a recorded transition.
- Paired explore/objective runs must use the same captured scenario candidate, world seed, case, and strategy seed.
- Generated facts must be discoverable through rules before Writer/NPC may cite them.
- Existing artifact keys remain backward-compatible; all new metrics and manifest fields are additive.
- Real-AI commands remain opt-in through `RUN_REAL_AI_STORY_EVAL=1`; no prompt, raw response, provider URL, or API key may enter reports or logs.
- The protected `../ai-game-foundation` repository and `.foundation` junction are out of scope.

## Generation-Grade Acceptance Gate

The pilot gate uses three paired `wuxia-a` regression replicates; the release gate uses every case in `data/story-eval/cases/v2.json` once with the baseline profile.

- Objective convergence: 100% within the configured scene limit; mainline `suggestedPresentationRate=1`, `suggestedChosenRate=1`, `progressedSceneRate=1`.
- Explore playability: `trueDeadEnds=0`, `recoveryLoops=0`; baseline explore convergence at least 80%.
- Reliability: final role failures 0; aggregate fallback rate at most 5%; invalid JSON may retry but must recover within profile attempts.
- Facts: every generated fact has a rule discovery anchor; each long blueprint has at least one mainline `discover_fact`; paired-run generated-fact narration coverage at least 70% and discovery coverage at least 50%.
- Branches: long baseline has paired evidence at stages 2/4/6; at least two checkpoints retain a state or event difference through the two-scene branch horizon; no more than one checkpoint fully reconverges.
- Pacing/ending: no stage-window violation, at least one setup, one middle-act turn, one climax, and one visible ending title/description/outcome; judge S1/S3/S7/S8/S9 and C1–C4 must each be at least 3 when judge output is available.
- Coverage corpus: all seven supported `gameType` values appear in the case set before a release claim.

---

### Task 1: Pair explore and objective runs on one generated blueprint

**Files:**
- Modify: `scripts/storyEvalJourney.mjs`
- Modify: `scripts/storyEvalJourney.node-test.mjs`
- Modify: `src/game/application/testing/storyEvalJourney.test.ts`
- Modify: `src/game/application/testing/storyEvalArtifacts.ts`
- Test: `src/game/application/testing/storyEvalArtifacts.test.ts`

**Interfaces:**
- Produces: `buildPairedRunSpecs(cases, strategies, runs, baseSeed)` returning `{ pairId, caseId, replicate, seed, strategies }[]`.
- Produces manifest fields `pairingVersion`, `pairId`, `blueprintPairSource`, `gameType`, and `strategySeed`.
- The first strategy writes a normal live `calls.jsonl`; the second receives that exact path through `STORY_EVAL_BLUEPRINT_ARTIFACT`.

- [ ] **Step 1: Add failing runner tests for blueprint and seed pairing**

```js
test("explore/objective pair reuses the first run candidate and the same seed", () => {
  const envDir = mkdtempSync(join(tmpdir(), "story-eval-env-"));
  const envPath = join(envDir, ".env.local");
  writeFileSync(envPath, [
    "AI_API_BASE_URL=https://example.invalid/v1",
    "AI_MODEL=test-model",
    "AI_API_KEY=test-key",
  ].join("\n"), "utf8");
  const spawned = [];
  try {
    const code = main({
      argv: ["--mode=record", "--case=wuxia-a", "--runs=1", "--seed=77"],
      env: { RUN_REAL_AI_STORY_EVAL: "1", STORY_EVAL_PROFILE: "regression" },
      sources: [envPath],
      spawn: (env) => { spawned.push(env); return 0; },
      log: () => {},
    });
    assert.equal(code, 0);
    assert.equal(spawned.length, 2);
    assert.equal(spawned[0].STORY_EVAL_SEED, "77");
    assert.equal(spawned[1].STORY_EVAL_SEED, "77");
    assert.equal(spawned[0].STORY_EVAL_PAIR_ID, spawned[1].STORY_EVAL_PAIR_ID);
    assert.equal(spawned[0].STORY_EVAL_BLUEPRINT_ARTIFACT, undefined);
    assert.match(spawned[1].STORY_EVAL_BLUEPRINT_ARTIFACT, /calls\.jsonl$/);
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
});
```

Import `mkdtempSync`, `writeFileSync`, and `rmSync` from `node:fs`, `tmpdir` from `node:os`, and `join` from `node:path` in the test file.

- [ ] **Step 2: Run the script tests and verify the new assertion fails**

Run: `node --test scripts/storyEvalJourney.node-test.mjs`

Expected: FAIL because the current runner increments the seed and starts both strategies from independent live blueprints.

- [ ] **Step 3: Build paired run specs and inject the captured scenario into the second run**

```js
export function buildPairedRunSpecs(cases, strategies, runs, baseSeed) {
  return cases.flatMap((entry) => Array.from({ length: runs }, (_, replicate) => ({
    pairId: `${entry.caseId}-${baseSeed + replicate}-${replicate + 1}`,
    caseId: entry.caseId,
    replicate,
    seed: baseSeed + replicate,
    strategies: [...strategies],
  })));
}

for (const pair of buildPairedRunSpecs(selectedCases, strategies, runs, baseSeed)) {
  let capturedCallsPath = blueprintArtifact;
  for (const strategy of pair.strategies) {
    const artifactDir = buildStoryEvalArtifactDir({ artifactRoot, caseId: pair.caseId, strategy, runIndex });
    const childEnv = {
      ...env,
      RUN_REAL_AI_STORY_EVAL: "1",
      STORY_EVAL_CAPTURE: "1",
      STORY_EVAL_ARTIFACT_DIR: artifactDir,
      STORY_EVAL_CASE_ID: pair.caseId,
      STORY_EVAL_STRATEGY: strategy,
      STORY_EVAL_SEED: String(pair.seed),
      STORY_EVAL_PAIR_ID: pair.pairId,
      STORY_EVAL_PROFILE: profileConfig.profile,
      STORY_EVAL_MAX_SCENES: String(profileConfig.maxScenes),
      STORY_EVAL_MAX_ROLE_ATTEMPTS: String(profileConfig.maxRoleAttempts),
      STORY_EVAL_AI_TIMEOUT_MS: String(profileConfig.aiTimeoutMs),
      STORY_EVAL_BRANCH_MODE: profileConfig.branchMode,
      STORY_EVAL_TOTAL_BUDGET_MS: String(profileConfig.totalBudgetMs),
      GAME_DB_PATH: databasePath,
      ...(capturedCallsPath === undefined ? {} : { STORY_EVAL_BLUEPRINT_ARTIFACT: capturedCallsPath }),
    };
    for (const key of ["AI_API_BASE_URL", "AI_MODEL", "AI_API_KEY"]) {
      childEnv[key] = aiValues.get(key).decoded;
    }
    const status = runSpawn(childEnv);
    if (status !== 0) failed += 1;
    if (capturedCallsPath === undefined && status === 0) {
      capturedCallsPath = resolve(artifactDir, "calls.jsonl");
    }
    runIndex += 1;
  }
}
```

- [ ] **Step 4: Persist and validate pair metadata**

```ts
const manifest: Record<string, unknown> = {
  // existing fields
  pairingVersion: "paired-v1",
  pairId: env.STORY_EVAL_PAIR_ID ?? null,
  blueprintPairSource: capturedBlueprintSource === undefined ? "live" : "paired_capture",
  gameType: storyEvalCase.input.gameType,
  strategySeed,
};
```

When `manifest.pairingVersion === "paired-v1"`, completeness requires a non-empty `pairId`, `gameType`, and `strategySeed`. Legacy artifacts without `pairingVersion` remain readable, but the generation-grade gate rejects them as `EVIDENCE_INCOMPLETE`.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test scripts/storyEvalJourney.node-test.mjs`

Run: `npx vitest run src/game/application/testing/storyEvalJourney.test.ts src/game/application/testing/storyEvalArtifacts.test.ts`

Expected: all pass; the two child environments share a seed and the second references the first `calls.jsonl`.

Commit: `git commit -am "fix(story-eval): pair strategies on one blueprint"`

---

### Task 2: Recover through playable one-action transitions and expose true dead ends

**Files:**
- Create: `src/game/application/testing/storyEvalContinuation.ts`
- Create: `src/game/application/testing/storyEvalContinuation.test.ts`
- Modify: `src/game/application/testing/storyEvalJourney.test.ts`
- Modify: `scripts/storyEvalAnalyze.mjs`
- Modify: `scripts/storyEvalAnalyze.node-test.mjs`
- Modify: `docs/agent/AI内容质量评估.md`

**Interfaces:**
- Produces: `projectStoryEvalContinuation(blueprint, state): StoryEvalContinuation | null`.
- `StoryEvalContinuation` contains one existing `PlayerIntent`, its stable `actionKey`, public label, and reason `single_legal_action`.
- Manifest adds `continuationBridges`, `trueDeadEnds`, and `recoveryLoops`.

- [ ] **Step 1: Add failing tests for one-action recovery and zero-action dead ends**

```ts
const PIPELINE = runScenarioPipeline({
  gameType: "wuxia",
  characterName: "沈孤鸿",
  characterIdentity: "身世成谜的独行者",
  characterProfile: "追查旧案的独行者。",
  personalityTags: ["谨慎"],
  worldPremise: "江湖动荡，旧案未雪。",
  storyOpening: "沈孤鸿在雨夜抵达青石镇。",
  narrativeStyle: "concise",
  contentIntensity: "normal",
  gameLength: "long",
}, "continuation-test-seed");

function singleMoveState(): GameState {
  return {
    ...PIPELINE.state,
    eventLedger: [{
      type: "location_observed",
      locationId: PIPELINE.state.currentLocationId,
      occurredAt: "2026-08-03T00:00:00.000Z",
    }],
    npcs: PIPELINE.state.npcs.map((npc) =>
      npc.locationId === PIPELINE.state.currentLocationId ? { ...npc, met: true } : npc
    ),
    worldFacts: PIPELINE.state.worldFacts.map((fact) => ({ ...fact, discovered: true })),
  };
}

it("returns the sole legal move without inventing a second action", () => {
  const state = singleMoveState();
  const result = projectStoryEvalContinuation(PIPELINE.blueprint, state);
  expect(result).toEqual({
    actionKey: "move:loc_2",
    label: "前往渡口集市",
    intent: { type: "move", locationId: asLocationId("loc_2") },
    reason: "single_legal_action",
  });
});

it("returns null when no rule action remains", () => {
  const state = singleMoveState();
  const blocked = { ...state, unlockedLocationIds: [state.currentLocationId] };
  expect(projectStoryEvalContinuation(PIPELINE.blueprint, blocked)).toBeNull();
});
```

Import `GameState` from `@/game/domain` and `runScenarioPipeline` from `../applicationFixture.testutil`.

- [ ] **Step 2: Run the continuation tests and verify they fail**

Run: `npx vitest run src/game/application/testing/storyEvalContinuation.test.ts`

Expected: FAIL because `projectStoryEvalContinuation` does not exist.

- [ ] **Step 3: Implement the pure continuation projection**

```ts
import type { GameState, ScenarioBlueprint } from "@/game/domain";
import { projectAvailableActions, type PlayerIntent } from "@/game/gameplay/rpg/actions";
import { actionKeyOf } from "@/game/gameplay/rpg/narrative";

export type StoryEvalContinuation = Readonly<{
  actionKey: string;
  label: string;
  intent: PlayerIntent;
  reason: "single_legal_action";
}>;

export function projectStoryEvalContinuation(
  blueprint: ScenarioBlueprint,
  state: GameState,
): StoryEvalContinuation | null {
  const actions = projectAvailableActions(blueprint, state);
  if (actions.length !== 1 || actions[0].type === "battle_action") return null;
  const action = actions[0];
  const { label, ...intent } = action;
  return { actionKey: actionKeyOf(action), label, intent, reason: "single_legal_action" };
}
```

- [ ] **Step 4: Refactor the journey loop so bridge actions do not consume narrative scene budget**

```ts
const continuationBridges: Record<string, unknown>[] = [];
let recoveryLoops = 0;
let sceneIndex = 1;
while (sceneIndex <= maxScenes) {
  // existing ending/battle/narrative generation handling
  if (view.narrative === null && view.battle === null && view.ending === null) {
    const record = await loadRecord();
    const bridge = projectStoryEvalContinuation(record.blueprint, record.state);
    if (bridge === null) {
      manifest.trueDeadEnds = Number(manifest.trueDeadEnds ?? 0) + 1;
      status = "exhausted";
      break;
    }
    if (continuationBridges.length >= maxScenes * 2) {
      recoveryLoops += 1;
      status = "recovery_loop";
      break;
    }
    const before = record.state.eventLedger.length;
    const result = await entry.performAction({ intent: bridge.intent, expectedRevision: view.revision });
    if (!result.ok) throw new Error(`continuation rejected: ${result.code}`);
    const after = await loadRecord();
    continuationBridges.push({
      actionKey: bridge.actionKey,
      reason: bridge.reason,
      mainStage: deriveContentProgression({ blueprint: after.blueprint, state: after.state }).mainStage,
      events: after.state.eventLedger.slice(before).map(toSafeEvent),
    });
    view = result.view;
    continue;
  }
  // write a normal scene row
  sceneIndex += 1;
}
manifest.continuationBridges = continuationBridges;
manifest.trueDeadEnds ??= 0;
manifest.recoveryLoops = recoveryLoops;
```

Extend `StoryEvalJourneyResult.status` with `"recovery_loop"` so the bounded bridge failure is represented explicitly rather than cast through an unrelated status.

- [ ] **Step 5: Add analyzer output and regression assertions**

```js
const continuation = {
  bridges: Array.isArray(manifest.continuationBridges) ? manifest.continuationBridges.length : 0,
  trueDeadEnds: Number(manifest.trueDeadEnds ?? 0),
  recoveryLoops: Number(manifest.recoveryLoops ?? 0),
};
```

Assert that a synthetic one-action bridge produces `bridges=1`, `trueDeadEnds=0`, and does not increase `sceneCount`.

- [ ] **Step 6: Run focused and application tests, then commit**

Run: `npx vitest run src/game/application/testing/storyEvalContinuation.test.ts src/game/application/testing/storyEvalJourney.test.ts`

Run: `node --test scripts/storyEvalAnalyze.node-test.mjs`

Run: `npm run test:game-application`

Expected: all pass; the former `explore exhausted` state is classified as a recoverable single-action transition.

Commit: `git add src/game/application/testing scripts/storyEvalAnalyze.mjs scripts/storyEvalAnalyze.node-test.mjs docs/agent/AI内容质量评估.md && git commit -m "fix(story-eval): recover playable narrative gaps"`

---

### Task 3: Make generated facts discoverable and mainline-relevant

**Files:**
- Modify: `src/game/gameplay/rpg/scenario/validateScenarioBlueprint.ts`
- Modify: `src/game/gameplay/rpg/scenario/validateScenarioBlueprint.test.ts`
- Modify: `src/game/application/server/ai/scenarioPrompt.ts`
- Modify: `src/game/application/server/ai/scenarioPrompt.test.ts`
- Modify: `src/game/gameplay/rpg/scenario/createFallbackBlueprint.ts`
- Test: `src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts`
- Modify: `scripts/storyEvalAnalyze.mjs`
- Modify: `scripts/storyEvalAnalyze.node-test.mjs`
- Update: `docs/策划文档/AI内容质量评估标准.md`

**Interfaces:**
- Adds issue codes `UNANCHORED_GENERATED_FACT` and `MAINLINE_GENERATED_FACT_MISSING`.
- A generated fact is anchored when referenced by `openingScene.investigableFactIds`, an NPC `knownFactIds`, a `discover_fact` quest objective, or a `fact_discovered` ending requirement.
- Medium/long blueprints must include at least one main quest `discover_fact` objective targeting a generated fact.
- Analyzer adds `generatedUniverseFactIds`, `generatedUsedFactIds`, `generatedDiscoveredFactIds`, `generatedUsedCoverageRate`, and `generatedDiscoveredCoverageRate` under `facts`.

- [ ] **Step 1: Add failing validator tests**

```ts
it("rejects a generated fact that no rule path or NPC can reach", () => {
  const candidate = draft();
  candidate.world.facts.push({ id: "fact_orphan", text: "无人可知的真相", source: "generated" });
  expect(issuesOf(candidate)).toContainEqual(expect.objectContaining({
    code: "UNANCHORED_GENERATED_FACT",
    params: { factId: "fact_orphan" },
  }));
});

it("requires a generated fact on the medium/long mainline", () => {
  const candidate = draft();
  for (const quest of candidate.quests) {
    if (quest.kind === "main") quest.objectives = quest.objectives.filter((entry) => entry.kind !== "discover_fact");
  }
  const result = validateScenarioBlueprintCandidate(candidate as ScenarioBlueprintCandidate, {
    profile: TEST_PROFILE,
    policy: createBudgetPolicy("medium"),
  });
  expect(result.ok ? [] : codesOf(result.issues)).toContain("MAINLINE_GENERATED_FACT_MISSING");
});
```

Import `createBudgetPolicy` from `@/game/domain`; reuse the existing `draft`, `issuesOf`, and `codesOf` helpers in this test file.

- [ ] **Step 2: Run scenario tests and verify they fail**

Run: `npx vitest run src/game/gameplay/rpg/scenario/validateScenarioBlueprint.test.ts`

Expected: FAIL because the new issue codes and fact anchor analysis do not exist.

- [ ] **Step 3: Implement fact-anchor validation**

```ts
function validateGeneratedFactAnchors(
  issues: ScenarioBlueprintIssue[],
  candidate: ScenarioBlueprintCandidate,
  policy: BudgetPolicy,
): void {
  const anchored = new Set<string>(candidate.openingScene.investigableFactIds);
  candidate.npcs.forEach((npc) => npc.knownFactIds.forEach((id) => anchored.add(id)));
  candidate.quests.forEach((quest) => quest.objectives.forEach((objective) => {
    if (objective.kind === "discover_fact") anchored.add(objective.factId);
  }));
  candidate.endings.forEach((ending) => ending.requirements.forEach((requirement) => {
    if (requirement.kind === "fact_discovered") anchored.add(requirement.factId);
  }));

  for (const fact of candidate.world.facts) {
    if (fact.source === "generated" && !anchored.has(fact.id)) {
      const index = candidate.world.facts.findIndex((entry) => entry.id === fact.id);
      issues.push({
        path: `world.facts[${index}]`,
        code: "UNANCHORED_GENERATED_FACT",
        params: { factId: fact.id },
      });
    }
  }

  const hasMainlineGeneratedFact = candidate.quests.some((quest) =>
    quest.kind === "main" && quest.objectives.some((objective) =>
      objective.kind === "discover_fact" &&
      candidate.world.facts.some((fact) => fact.id === objective.factId && fact.source === "generated")
    )
  );
  if (policy.mainActs >= 5 && !hasMainlineGeneratedFact) {
    issues.push({ path: "quests", code: "MAINLINE_GENERATED_FACT_MISSING", params: {} });
  }
}
```

Call this function after reference validation and before quest-graph validation.

- [ ] **Step 4: Strengthen the scenario prompt and fallback contract**

Add these exact prompt requirements:

```ts
"每条 source=generated 的事实必须至少出现在 openingScene.investigableFactIds、某个 NPC.knownFactIds、discover_fact objective 或 fact_discovered ending requirement 之一；禁止生成永远无法发现或无人知道的孤儿事实。",
"medium/long 主线必须至少有一幕使用 discover_fact，且目标是 source=generated 的事实；该事实应在后续 NPC、战斗动机或结局描述中被回收。",
```

Assert both sentences appear in `scenarioPrompt.test.ts`. Confirm `createFallbackBlueprint` already meets the rule; if a profile variant does not, place `fact_gen_1` in the first available middle main stage and preserve unique `kind+target` objectives.

- [ ] **Step 5: Report generated-only coverage separately from player-input facts**

```js
const generatedUniverseFactIds = (manifest.blueprint?.facts ?? [])
  .filter((fact) => fact.source === "generated")
  .map((fact) => fact.id);
const generatedUsedFactIds = generatedUniverseFactIds.filter((id) => usedFactIds.includes(id));
const generatedDiscoveredFactIds = generatedUniverseFactIds.filter((id) => discoveredFactIds.includes(id));
facts.generatedUniverseFactIds = generatedUniverseFactIds;
facts.generatedUsedFactIds = generatedUsedFactIds;
facts.generatedDiscoveredFactIds = generatedDiscoveredFactIds;
facts.generatedUsedCoverageRate = generatedUniverseFactIds.length === 0
  ? 1
  : generatedUsedFactIds.length / generatedUniverseFactIds.length;
facts.generatedDiscoveredCoverageRate = generatedUniverseFactIds.length === 0
  ? 1
  : generatedDiscoveredFactIds.length / generatedUniverseFactIds.length;
```

Add analyzer tests proving player-input facts do not inflate generated-fact coverage.

- [ ] **Step 6: Run scenario, fixture, analyzer, and type tests, then commit**

Run: `npx vitest run src/game/gameplay/rpg/scenario/validateScenarioBlueprint.test.ts src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts src/game/application/server/ai/scenarioPrompt.test.ts`

Run: `npm run test:game-gameplay`

Run: `node --test scripts/storyEvalAnalyze.node-test.mjs`

Run: `npm run typecheck`

Expected: all pass; all three phase1 fixtures remain valid and no generated fact is unreachable.

Commit: `git add src/game/gameplay/rpg/scenario src/game/application/server/ai/scenarioPrompt* scripts/storyEvalAnalyze.mjs scripts/storyEvalAnalyze.node-test.mjs docs/策划文档/AI内容质量评估标准.md data/fixtures/phase1 && git commit -m "fix(scenario): require usable generated facts"`

---

### Task 4: Reject semantic act copy-paste and measure stage-aware pacing

**Files:**
- Modify: `src/game/gameplay/rpg/scenario/validateScenarioBlueprint.ts`
- Modify: `src/game/gameplay/rpg/scenario/validateScenarioBlueprint.test.ts`
- Modify: `scripts/storyEvalAnalyze.mjs`
- Modify: `scripts/storyEvalAnalyze.node-test.mjs`
- Modify: `docs/策划文档/AI内容质量评估标准.md`
- Modify: `docs/agent/AI内容质量评估.md`

**Interfaces:**
- Adds `REPEATED_MAIN_QUEST_DESCRIPTION_FRAGMENT` for repeated meaningful clauses of eight or more code points.
- Adds `pacing.stageWindowViolations`, `turnStages`, `hasSetup`, `hasClimax`, and `hasResolutionEvidence` without removing `illegalOrderCount`.

- [ ] **Step 1: Add failing tests for repeated suffixes and stage-aware pacing**

```ts
it("rejects a repeated semantic suffix even when the stage prefix differs", () => {
  const candidate = draft();
  candidate.quests.filter((quest) => quest.kind === "main").slice(1, 4).forEach((quest) => {
    quest.description = `第 ${quest.stage} 幕：完成当前目标。深入山庄求证并取回关键信物。`;
  });
  expect(codesOf(issuesOf(candidate))).toContain("REPEATED_MAIN_QUEST_DESCRIPTION_FRAGMENT");
});
```

```js
test("stage-aware pacing accepts a middle turn followed by next-stage develop", () => {
  const scene = (sceneIndex, mainStage, pacing) => ({
    kind: "scene",
    sceneIndex,
    mainStage,
    narration: `场景 ${sceneIndex}`,
    directorPlan: { pacing, allowedRevealFactIds: [], introducedEntities: [] },
  });
  const metrics = computeStoryEvalMetrics({
    calls: [],
    story: [
      scene(1, 1, "setup"),
      scene(2, 3, "turn"),
      scene(3, 4, "develop"),
      scene(4, 8, "climax"),
      { kind: "ending", sceneIndex: 5, endingName: "终局", endingDescription: "冲突得到回应", outcome: "success" },
    ],
    manifest: {},
  });
  assert.equal(metrics.pacing.stageWindowViolations, 0);
  assert.deepEqual(metrics.pacing.turnStages, [3]);
  assert.equal(metrics.pacing.hasResolutionEvidence, true);
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run src/game/gameplay/rpg/scenario/validateScenarioBlueprint.test.ts`

Run: `node --test scripts/storyEvalAnalyze.node-test.mjs`

Expected: FAIL on the repeated suffix and missing stage-aware metrics.

- [ ] **Step 3: Detect repeated meaningful description fragments**

```ts
function meaningfulDescriptionFragments(value: string): readonly string[] {
  return value
    .replace(/^第\s*\d+\s*幕[：:]?/, "")
    .split(/[。！？!?；;]/)
    .map((part) => part.replace(/\s+/g, "").trim())
    .filter((part) => Array.from(part).length >= 8);
}
```

Track the first stage for each fragment and emit `REPEATED_MAIN_QUEST_DESCRIPTION_FRAGMENT` for later stages. Do not reject short connective phrases.

- [ ] **Step 4: Compute stage-window pacing and ending evidence from story rows**

```js
function stageAwarePacing(sceneRows, endingRow, finalStage) {
  const turnStages = [];
  let stageWindowViolations = 0;
  let hasSetup = false;
  let hasClimax = false;
  for (const row of sceneRows) {
    const pacing = row.directorPlan?.pacing;
    const stage = row.mainStage;
    if (pacing === "setup") hasSetup = true;
    if (pacing === "turn" && Number.isInteger(stage) && !turnStages.includes(stage)) turnStages.push(stage);
    if (pacing === "climax") hasClimax = true;
    const allowed = stage === finalStage
      ? ["climax"]
      : stage === 1
        ? ["setup", "develop"]
        : ["develop", "turn"];
    if (typeof pacing === "string" && Number.isInteger(stage) && !allowed.includes(pacing)) {
      stageWindowViolations += 1;
    }
  }
  return {
    stageWindowViolations,
    turnStages,
    hasSetup,
    hasClimax,
    hasResolutionEvidence: endingRow !== undefined &&
      typeof endingRow.endingName === "string" && endingRow.endingName.trim() !== "" &&
      typeof endingRow.endingDescription === "string" && endingRow.endingDescription.trim() !== "" &&
      typeof endingRow.outcome === "string" && endingRow.outcome.trim() !== "",
  };
}
```

Derive `finalStage` from manifest main quests when available, otherwise use the maximum numeric `mainStage` in story rows.

- [ ] **Step 5: Run focused and full analyzer/gameplay tests, then commit**

Run: `node --test scripts/storyEvalAnalyze.node-test.mjs`

Run: `npx vitest run src/game/gameplay/rpg/scenario/validateScenarioBlueprint.test.ts`

Run: `npm run test:game-gameplay`

Expected: all pass; the observed stage-3 turn followed by stage-4 develop has zero stage-window violations while still reporting the legacy global-order metric.

Commit: `git add scripts/storyEvalAnalyze* src/game/gameplay/rpg/scenario/validateScenarioBlueprint* docs && git commit -m "fix(story-quality): validate act semantics and pacing windows"`

---

### Task 5: Add a deterministic generation-grade gate and seven-type corpus

**Files:**
- Create: `scripts/storyEvalQualityGate.mjs`
- Create: `scripts/storyEvalQualityGate.node-test.mjs`
- Modify: `package.json`
- Modify: `data/story-eval/cases/v2.json`
- Modify: `src/game/application/testing/storyEvalCases.test.ts`
- Modify: `docs/agent/AI内容质量评估.md`
- Modify: `docs/策划文档/AI内容质量评估标准.md`

**Interfaces:**
- Produces `evaluateGenerationGrade(runDirs): { ok, failures, warnings, summary }`.
- CLI: `node scripts/storyEvalQualityGate.mjs <run-dir>...`; exit 0 only when all hard gates pass.
- Package script: `"gate:story-eval": "node scripts/storyEvalQualityGate.mjs"`.

- [ ] **Step 1: Add failing gate tests for pass, quality failure, and insufficient coverage**

```js
function run({ strategy, converged = true, generatedFactCoverage = 0.8 } = {}) {
  const generatedUniverseFactIds = Array.from({ length: 10 }, (_, index) => `g${index + 1}`);
  const generatedUsedFactIds = generatedUniverseFactIds.slice(0, Math.floor(generatedFactCoverage * 10));
  return {
    manifest: { pairId: "pair-1", strategy, gameType: "wuxia" },
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

test("generation-grade pair passes all deterministic hard gates", () => {
  const result = evaluateGenerationGrade([objectiveRun(), exploreRun()]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("non-converged objective and orphan fact coverage fail the gate", () => {
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
```

- [ ] **Step 2: Run the gate tests and verify they fail**

Run: `node --test scripts/storyEvalQualityGate.node-test.mjs`

Expected: FAIL because the gate module does not exist.

- [ ] **Step 3: Implement exact hard-gate evaluation**

```js
export const GENERATION_GRADE_THRESHOLDS = Object.freeze({
  maxFallbackRate: 0.05,
  minObjectiveConvergenceRate: 1,
  minExploreBaselineConvergenceRate: 0.8,
  minGeneratedFactNarrationCoverage: 0.7,
  minGeneratedFactDiscoveryCoverage: 0.5,
  minDurableBranchCheckpoints: 2,
  maxReconvergedCheckpoints: 1,
});

export function evaluateGenerationGrade(runs, options = {}) {
  const failures = [];
  const objectives = runs.filter((run) => run.manifest.strategy === "objective");
  const explores = runs.filter((run) => run.manifest.strategy === "explore");
  const pairs = new Map();
  for (const run of runs) {
    const pairId = run.manifest.pairId;
    if (typeof pairId !== "string" || pairId === "") {
      failures.push("EVIDENCE_INCOMPLETE");
      continue;
    }
    pairs.set(pairId, [...(pairs.get(pairId) ?? []), run]);
  }
  const rate = (items, predicate) => items.length === 0 ? 0 : items.filter(predicate).length / items.length;
  if (objectives.length === 0 || rate(objectives, (run) => run.metrics.converged) < 1) {
    failures.push("OBJECTIVE_NOT_CONVERGED");
  }
  if (objectives.some((run) => {
    const objective = run.metrics.mainlineObjective ?? {};
    return objective.opportunities <= 0 ||
      objective.suggestedPresented !== objective.opportunities ||
      objective.suggestedChosen !== objective.opportunities ||
      objective.progressedScenes !== objective.opportunities;
  })) failures.push("MAINLINE_PROGRESS_INCOMPLETE");
  if (options.release === true && explores.length > 0 && rate(explores, (run) => run.metrics.converged) < 0.8) {
    failures.push("EXPLORE_CONVERGENCE_LOW");
  }
  if (runs.some((run) => run.metrics.continuation?.trueDeadEnds > 0)) failures.push("TRUE_DEAD_END");
  if (runs.some((run) => run.metrics.continuation?.recoveryLoops > 0)) failures.push("RECOVERY_LOOP");
  if (runs.some((run) => run.metrics.fallbackRate > 0.05)) failures.push("FALLBACK_RATE_HIGH");
  if (runs.some((run) => run.metrics.pacing?.stageWindowViolations > 0)) failures.push("PACING_WINDOW_VIOLATION");
  if (objectives.some((run) =>
    run.metrics.pacing?.hasSetup !== true ||
    run.metrics.pacing?.hasClimax !== true ||
    run.metrics.pacing?.hasResolutionEvidence !== true ||
    !Array.isArray(run.metrics.pacing?.turnStages) || run.metrics.pacing.turnStages.length === 0
  )) failures.push("PACING_ARC_INCOMPLETE");
  for (const pairRuns of pairs.values()) {
    const union = (field) => new Set(pairRuns.flatMap((run) => run.metrics.facts?.[field] ?? []));
    const universe = union("generatedUniverseFactIds");
    const used = union("generatedUsedFactIds");
    const discovered = union("generatedDiscoveredFactIds");
    if (universe.size > 0 && used.size / universe.size < 0.7) failures.push("GENERATED_FACT_COVERAGE_LOW");
    if (universe.size > 0 && discovered.size / universe.size < 0.5) failures.push("GENERATED_FACT_DISCOVERY_LOW");
  }
  const minCheckpoints = options.release === true ? 3 : 1;
  const minDurableCheckpoints = options.release === true ? 2 : 1;
  if (runs.some((run) => {
    const choices = run.metrics.choices ?? {};
    return choices.pairedCheckpoints < minCheckpoints ||
      Math.max(choices.stateDifferent ?? 0, choices.eventDifferent ?? 0) < minDurableCheckpoints ||
      choices.reconvergedCheckpoints > 1;
  })) failures.push("BRANCH_DURABILITY_LOW");
  for (const run of runs.filter((entry) => entry.scores !== undefined)) {
    if ((run.scores.failures ?? []).length > 0) failures.push("JUDGE_EVIDENCE_INCOMPLETE");
    for (const dimension of ["S1", "S3", "S7", "S8", "S9"]) {
      if ((run.scores.storyLevel?.scores?.[dimension]?.score ?? 0) < 3) failures.push(`JUDGE_${dimension}_LOW`);
    }
    for (const dimension of ["C1", "C2", "C3", "C4"]) {
      const entries = run.scores.sceneLevel?.[dimension]?.scores ?? [];
      if (entries.some((entry) => entry.score < 3)) failures.push(`JUDGE_${dimension}_LOW`);
    }
  }
  if (options.release === true) {
    if (runs.some((run) => run.scores === undefined)) failures.push("JUDGE_EVIDENCE_INCOMPLETE");
    const covered = new Set(runs.map((run) => run.manifest.gameType));
    const required = ["wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse"];
    if (required.some((gameType) => !covered.has(gameType))) failures.push("GAME_TYPE_COVERAGE_INCOMPLETE");
  }
  return {
    ok: failures.length === 0,
    failures: [...new Set(failures)],
    warnings: [],
    summary: { objectives: objectives.length, explores: explores.length },
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
```

Import `* as realFs` from `node:fs` and `resolve` from `node:path`; execute `process.exitCode = main()` only when the script is the direct entry point. Add `"gate:story-eval": "node scripts/storyEvalQualityGate.mjs"` to `package.json`.

Aggregate paired branch and fact coverage by `pairId`; do not compare independent blueprints. Treat missing fields in legacy artifacts as `EVIDENCE_INCOMPLETE`, not as zero-quality content.

- [ ] **Step 4: Expand the case corpus to all supported game types**

Add one long case each for the four missing values with valid non-empty player inputs and distinct premises:

```json
[
  { "caseId": "xianxia-a", "input": { "gameType": "xianxia", "gameLength": "long", "characterName": "陆归尘", "characterIdentity": "被逐出宗门的外门弟子", "characterProfile": "灵根受损，却记得一段被抹去的山门往事。", "personalityTags": ["克制", "执着"], "worldPremise": "宗门灵脉正在枯竭，各峰却把灾变归咎于失踪的镇山法宝。", "storyOpening": "陆归尘在废弃渡劫台醒来，掌心多了一枚不属于自己的宗门印。", "narrativeStyle": "novel", "contentIntensity": "normal" } },
  { "caseId": "fantasy-a", "input": { "gameType": "fantasy", "gameLength": "long", "characterName": "萝赛塔·晨风", "characterIdentity": "失去封地的年轻骑士", "characterProfile": "曾负责守卫王国北境，如今背负一场败战的责任。", "personalityTags": ["守信", "多疑"], "worldPremise": "古代盟约失效，王国、教会与边境异族争夺一座重新苏醒的遗迹。", "storyOpening": "萝赛塔收到一封盖着已灭亡家族纹章的求援信。", "narrativeStyle": "novel", "contentIntensity": "normal" } },
  { "caseId": "alternate-history-a", "input": { "gameType": "alternate_history", "gameLength": "long", "characterName": "谢明远", "characterIdentity": "奉命查账的年轻御史", "characterProfile": "出身寒门，熟悉盐路与边军粮饷。", "personalityTags": ["审慎", "刚直"], "worldPremise": "新法推行三年，边镇军粮却在朝廷账册中凭空消失。", "storyOpening": "谢明远抵达云中郡当夜，负责接应他的驿丞死在封存粮仓前。", "narrativeStyle": "novel", "contentIntensity": "normal" } },
  { "caseId": "post-apocalypse-a", "input": { "gameType": "post_apocalypse", "gameLength": "long", "characterName": "七号", "characterIdentity": "负责寻找净水设备的拾荒者", "characterProfile": "来自水塔镇，熟悉旧世界地下管网。", "personalityTags": ["务实", "护短"], "worldPremise": "旱季提前到来，三个聚落为最后一座净水站的控制权互相封锁道路。", "storyOpening": "七号从废弃泵站带回一张地图，却发现水塔镇的储水罐被人投毒。", "narrativeStyle": "novel", "contentIntensity": "normal" } }
]
```

Merge these entries into the existing array and extend `storyEvalCases.test.ts` to assert the exact seven-value game-type set.

- [ ] **Step 5: Run the local gate suite and all deterministic quality tests**

Run: `node --test scripts/storyEvalQualityGate.node-test.mjs scripts/storyEvalAnalyze.node-test.mjs scripts/storyEvalJourney.node-test.mjs`

Run: `npx vitest run src/game/application/testing/storyEvalCases.test.ts src/game/application/testing/storyEvalJourney.test.ts`

Run: `npm run typecheck`

Expected: all pass; release-mode synthetic coverage contains all seven game types.

- [ ] **Step 6: Run the paid pilot, judge, and generation-grade gate**

Run:

```powershell
$env:RUN_REAL_AI_STORY_EVAL='1'
$env:STORY_EVAL_PROFILE='regression'
npm run smoke:ai:story-eval -- --case=wuxia-a --runs=3
```

For every completed run directory, run:

```powershell
node scripts/storyEvalAnalyze.mjs <run-dir>
$env:RUN_REAL_AI_STORY_EVAL_JUDGE='1'
node scripts/storyEvalJudge.mjs <run-dir>
```

Then run:

```powershell
npm run gate:story-eval -- <six-paired-run-directories>
```

Expected: exit 0 and no hard-gate failures. If any hard gate fails, record its stable code and artifact path in `docs/agent/AI内容质量评估.md`; do not average it away with prose scores.

- [ ] **Step 7: Run the release matrix and commit**

Run:

```powershell
$env:RUN_REAL_AI_STORY_EVAL='1'
$env:STORY_EVAL_PROFILE='baseline'
npm run smoke:ai:story-eval
```

Analyze/judge each run and execute `npm run gate:story-eval -- --release <all-run-directories>`.

Expected: all seven game types represented, objective convergence 100%, explore convergence at least 80%, zero true dead ends/recovery loops, and all deterministic evidence gates pass.

Commit: `git add scripts/storyEvalQualityGate* package.json data/story-eval/cases/v2.json src/game/application/testing/storyEvalCases.test.ts docs && git commit -m "feat(story-quality): add generation-grade release gate"`

## Self-Review

- Spec coverage: paired causality, explore playability, fact reachability/use, semantic act uniqueness, pacing, ending evidence, branch durability, AI reliability, judge floor, and seven-type coverage each have an implementation task and an explicit gate.
- Placeholder scan: the plan contains no TBD/TODO/“similar to” steps; every code-changing step names exact files, signatures, commands, and expected outcomes.
- Type consistency: `pairId`, `continuationBridges`, `trueDeadEnds`, `recoveryLoops`, `stageWindowViolations`, and generated-fact coverage flow from manifest/analyzer into `evaluateGenerationGrade` under stable names.
