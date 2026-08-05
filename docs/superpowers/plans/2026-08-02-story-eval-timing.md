# Story Evaluation Timing and Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make story-quality evaluation runs measurable and faster to diagnose by isolating artifacts, aligning evaluation retry/wait settings, fixing Judge evidence validation, and parallelizing independent Judge calls.

**Architecture:** Keep the shared AI transport unchanged. Evaluation-only settings flow from the record-mode child environment through the RPG composition root into the runtime narrative coordinator; normal game behavior remains at the existing three attempts and 120-second timeout when those settings are absent. Journey manifests gain non-sensitive phase timings, while Judge records per-request timing and uses dimension-specific evidence validation.

**Tech Stack:** Node.js ESM scripts, TypeScript application orchestration, Vitest, Node test runner, OpenAI-compatible `fetch` calls.

## Global Constraints

- Provider calls remain server-only and all AI output remains subject to existing approval and fallback rules.
- Do not modify `@ai-game/ai-transport`; its public contract and shared repository remain unchanged.
- `calls.jsonl` may contain prompts and model output, so it stays under ignored `artifacts/` and never enters git.
- Evaluation-only environment variables must have no effect when `STORY_EVAL_CAPTURE` is not `1`.
- Existing replay tests must remain zero-network and deterministic.

---

### Task 1: Fresh run artifacts and journey phase timings

**Files:**
- Modify: `scripts/storyEvalJourney.mjs:181-218`
- Modify: `src/game/application/testing/storyEvalJourney.test.ts:434-665`
- Modify: `src/game/application/testing/storyEvalJourney.test.ts:855-950`
- Test: `scripts/storyEvalJourney.node-test.mjs`

**Interfaces:**
- Produces a unique `STORY_EVAL_ARTIFACT_DIR` for every record run and a manifest `timings` object with non-sensitive elapsed milliseconds.

- [ ] **Step 1: Write the failing artifact-isolation test**

Add a node test that injects a deterministic `spawn` and asserts two record invocations produce different artifact directory paths even when they use the same case/strategy/run index shape.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test scripts/storyEvalJourney.node-test.mjs`

Expected: the new uniqueness assertion fails because the current path is `${caseId}-${strategy}-${runIndex}`.

- [ ] **Step 3: Implement unique run directories**

Generate the artifact directory with an ISO timestamp plus a short UUID suffix, keep the path-inside-artifact-root guard, and retain the case/strategy/index prefix for discoverability.

- [ ] **Step 4: Add phase timing fields to the journey manifest**

Measure opening generation, main narrative polling, branch execution, player-action rule execution, final artifact writing, and total elapsed time with `performance.now()`. Store only numbers and ISO start/end timestamps; do not store prompts or raw provider output in `manifest.json`.

- [ ] **Step 5: Extend the offline journey assertion**

Assert that `manifest.timings.totalMs` is non-negative and that the phase timing object exists in the existing three-scene offline journey test.

- [ ] **Step 6: Run the focused tests**

Run: `node --test scripts/storyEvalJourney.node-test.mjs`

Run: `npx vitest run src/game/application/testing/storyEvalJourney.test.ts -t "fetch-mock 全链路"`

Expected: PASS with zero network requests.

---

### Task 2: Evaluation-only retry and timeout controls

**Files:**
- Modify: `src/game/application/orchestrateNarrativeScene.ts:30-170`
- Modify: `src/game/application/generatePendingNarrativeScene.ts:11-75`
- Modify: `src/game/application/server/ai/runtimeNarrativeTaskCoordinator.ts:19-47`
- Modify: `src/game/application/server/compositionRoot.ts:113-180`
- Modify: `src/game/application/server/ai/runtimeNarrativeSourceFactory.ts:8-15`
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.ts:11-85`
- Modify: `scripts/storyEvalJourney.mjs:193-204`
- Test: `src/game/application/orchestrateNarrativeScene.test.ts`
- Test: `src/game/application/server/ai/liveRuntimeNarrativeSources.storyEval.test.ts`

**Interfaces:**
- Adds optional evaluation-only `maxRoleAttempts` and `timeoutMs` values to runtime narrative dependencies.
- Defaults remain `maxRoleAttempts = 3` and `timeoutMs = 120000` outside evaluation mode.
- Record-mode journey defaults to `maxRoleAttempts = 2`, while callers may override it with `STORY_EVAL_MAX_ROLE_ATTEMPTS`.

- [ ] **Step 1: Add a failing orchestrator test for bounded attempts**

Create a test source that always returns a rejected director attempt, invoke `orchestrateNarrativeScene` with `maxRoleAttempts: 1`, and assert the director source is called once and the result is fallback.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run src/game/application/orchestrateNarrativeScene.test.ts -t "maxRoleAttempts"`

Expected: FAIL because the orchestrator currently always loops three times.

- [ ] **Step 3: Thread optional attempt and timeout settings**

Replace the hard-coded loop bound with `input.maxRoleAttempts ?? 3`, thread the value through `generatePendingNarrativeScene` and `RuntimeNarrativeTaskCoordinator`, and only parse the environment override in the server composition root when `STORY_EVAL_CAPTURE=1`.

- [ ] **Step 4: Make the live runtime timeout injectable**

Use `timeoutMs ?? 120000` in the transport call and pass `STORY_EVAL_AI_TIMEOUT_MS` only for captured evaluation runs. Preserve the existing default in all normal and fixture paths.

- [ ] **Step 5: Set record-mode evaluation defaults and manifest provenance**

Inject `STORY_EVAL_MAX_ROLE_ATTEMPTS=2` and preserve an override in the child environment. Record the effective attempt and timeout values in the journey manifest.

- [ ] **Step 6: Run focused application and AI-source tests**

Run: `npx vitest run src/game/application/orchestrateNarrativeScene.test.ts src/game/application/server/ai/liveRuntimeNarrativeSources.storyEval.test.ts src/game/application/testing/storyEvalJourney.test.ts -t "fetch-mock|approvalObserver|maxRoleAttempts"`

Expected: PASS; normal tests still use three attempts and 120 seconds.

---

### Task 3: Judge timeout, evidence validation, and parallel scene-level review

**Files:**
- Modify: `scripts/storyEvalJudge.mjs:119-180`
- Modify: `scripts/storyEvalJudge.mjs:185-212`
- Modify: `scripts/storyEvalJudge.mjs:368-381`
- Modify: `scripts/storyEvalJudge.mjs:474-523`
- Test: `scripts/storyEvalJudge.node-test.mjs`

**Interfaces:**
- `validateSceneLevelResult(parsed, story, dimension)` validates quotes against the actual evidence package for C1/C2 and current scene text for C3/C4.
- `callJudge` accepts `timeoutMs` and records optional timing through the caller logger without exposing request contents.

- [ ] **Step 1: Add failing C1/C2 evidence tests**

Construct C1 output quoting `NPC description` and C2 output quoting the previous scene, then assert both validate when the corresponding evidence package contains those quotes.

- [ ] **Step 2: Run the focused Judge tests and verify they fail**

Run: `node --test scripts/storyEvalJudge.node-test.mjs`

Expected: FAIL because validation only checks `sceneToText(row)`.

- [ ] **Step 3: Implement dimension-aware evidence validation**

Build the same evidence text used by `buildSceneLevelPrompt` and validate quotes against it. Keep scene-index and 1–5 score checks unchanged.

- [ ] **Step 4: Add an AbortSignal timeout to `callJudge`**

Use a per-call timeout default of 120 seconds, clear the timer in all success/failure paths, and return a stable `judge_timeout` failure without logging prompt or response data.

- [ ] **Step 5: Parallelize C1–C4**

Keep early prediction and story-level calls in their existing order for context isolation, then issue the independent C1–C4 calls with `Promise.all`. Preserve the current output shape and retry behavior.

- [ ] **Step 6: Add timing-oriented Judge tests**

Use delayed fake fetches to assert C1–C4 overlap rather than run serially, and use an unresolved fake fetch to assert timeout returns within the configured bound.

- [ ] **Step 7: Run Judge tests**

Run: `node --test scripts/storyEvalJudge.node-test.mjs`

Expected: PASS, including C1/C2 evidence acceptance and timeout behavior.

---

### Task 4: Short real run and bottleneck report

**Files:**
- Modify: `docs/agent/AI内容质量评估.md` only if measured behavior or command defaults change materially.
- Create: ignored artifact directory under `artifacts/story-eval/` through the evaluation command.

**Interfaces:**
- Uses the record-mode command with one case and a small scene cap; consumes the new manifest timings and `calls.jsonl` latency fields.

- [ ] **Step 1: Run the complete offline gates**

Run: `npm run test:story-eval-journey-script`

Run: `npm run test:story-eval-judge`

Run: `npx vitest run src/game/application/testing/storyEvalJourney.test.ts src/game/application/orchestrateNarrativeScene.test.ts src/game/application/server/ai/liveRuntimeNarrativeSources.storyEval.test.ts`

- [ ] **Step 2: Run one short real evaluation**

Run with one case and three scenes:

```powershell
$env:RUN_REAL_AI_STORY_EVAL = "1"
$env:STORY_EVAL_MAX_SCENES = "3"
$env:STORY_EVAL_MAX_ROLE_ATTEMPTS = "2"
$env:STORY_EVAL_AI_TIMEOUT_MS = "60000"
npm run smoke:ai:story-eval -- --case=wuxia-a
```

Expected: one explore and one objective run, each with a unique artifact directory; no reuse of prior `calls.jsonl`.

- [ ] **Step 3: Analyze the short artifacts without Judge calls**

Run `npm run analyze:story-eval -- <new-run-dir>` for each new directory and compare `manifest.timings`, per-role `latencyMs` sums, retries, timeout count, and branch time.

- [ ] **Step 4: Report the bottleneck**

State whether remaining time is provider latency, retries/timeouts, branch generation, or local overhead. Do not infer wall time from reused artifact file creation times.

---

### Task 5: Three evaluation profiles and Git handoff

**Files:**
- Modify: `scripts/storyEvalJourney.mjs`
- Modify: `scripts/storyEvalJourney.node-test.mjs`
- Modify: `src/game/application/testing/storyEvalJourney.test.ts`
- Modify: `docs/agent/AI内容质量评估.md`
- Test: `scripts/storyEvalJourney.node-test.mjs`, `src/game/application/testing/storyEvalJourney.test.ts`

**Interfaces:**
- `STORY_EVAL_PROFILE` accepts `smoke`, `regression`, or `baseline`; absent means `baseline` to preserve the current full evaluation command.
- Effective profile settings are injected into the child environment and written to `manifest.json` as `profile`, `branchMode`, `maxRoleAttempts`, and `timeoutMs`.

| Profile | Default scenes | Attempts | AI timeout | Branch checkpoints | Purpose |
| --- | ---: | ---: | ---: | --- | --- |
| `smoke` | 3 | 1 | 60s | none | PR/linkage check; no quality conclusion |
| `regression` | 16 | 2 | 90s | stage 2 only | prompt/code trend comparison; leaves room for long-mainline ending convergence |
| `baseline` | 60 | 3 | 120s | stages 2/4/6 | formal quality evaluation |

- [ ] **Step 1: Add profile parsing tests**

Export `resolveEvalProfile` and `resolveEvalProfileConfig` from `scripts/storyEvalJourney.mjs`. Assert that absent profile resolves to `baseline`, each named profile has the table values above, and an unknown value is rejected without spawning a journey.

- [ ] **Step 2: Add profile defaults to record-mode child env**

Resolve profile settings before the run loop and inject effective `STORY_EVAL_MAX_SCENES`, `STORY_EVAL_MAX_ROLE_ATTEMPTS`, `STORY_EVAL_AI_TIMEOUT_MS`, `STORY_EVAL_BRANCH_MODE`, and `STORY_EVAL_TOTAL_BUDGET_MS`; an explicitly supplied environment value overrides the profile default.

- [ ] **Step 3: Make journey branch checkpoints profile-aware**

Use `STORY_EVAL_BRANCH_MODE=none|sample|full` in `runStoryEvalJourney`: `none` resolves to `[]`, `sample` to `[2]`, and `full` to `[2, 4, 6]`. Keep the existing full list as the default for direct Vitest calls without a profile environment.

- [ ] **Step 4: Record profile provenance**

Write `profile` and `branchMode` next to the effective attempt/timeout settings in `manifest.json`. This keeps fast smoke artifacts from being mistaken for baseline artifacts.

- [ ] **Step 5: Run profile tests and typecheck**

Run: `node --test scripts/storyEvalJourney.node-test.mjs`

Run: `npx vitest run src/game/application/testing/storyEvalJourney.test.ts -t "manifest|branch|fetch-mock"`

Run: `npm run typecheck`

- [ ] **Step 6: Stage and commit the current branch changes**

After checking `git status --short` and `git diff --check`, stage the current branch files and commit with:

```powershell
git add docs scripts src
git commit -m "perf: add story evaluation profiles"
```
