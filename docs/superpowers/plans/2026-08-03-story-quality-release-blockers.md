# Story Quality Release Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the generation-grade story quality gate measure the intended game behavior reliably, then rerun a focused real-AI regression and the seven-topic release matrix with evidence that is complete enough to judge.

**Architecture:** Keep runtime gameplay rules and player-visible contracts unchanged. Fix only the offline evaluator, quality-gate evidence semantics, and judge transport/validation where the release run exposed measurement failures. Treat missing or invalid evidence as a failure; never turn an unavailable score into a passing score. Use pair-level branch evidence only where the design explicitly defines a pair as the unit of comparison.

**Tech Stack:** Node.js ESM scripts, `node:test`, Vitest journey runner, PowerShell orchestration, existing AI provider environment variables.

## Global constraints

- Work only in `.worktrees/ai-story-quality-eval`; do not modify the protected foundation repository or junction.
- Preserve the real-AI env gates and artifact redaction rules.
- Every code change gets a focused test before the corresponding real-AI rerun.
- Update `docs/archive/AI内容质量评估.md` and the index when implementation facts or release results change.

## Task 1: Lock the observed regressions with deterministic tests

**Files:** `scripts/storyEvalAnalyze.node-test.mjs`, `scripts/storyEvalQualityGate.node-test.mjs`, `scripts/storyEvalJudge.node-test.mjs`

1. Add a minimal story fixture where the final objective scene has a valid player action but its progress event is recorded on the following ending row; assert the analyzer counts only the objective scene and does not invent a missing progress opportunity.
2. Add release-gate fixtures for an objective/explore pair whose three branch checkpoints are split across the two runs; assert the intended pair-level contract, while retaining a failure for fewer than three total checkpoints or for reconvergence.
3. Add judge transport tests with a fake fetch that resolves before the deadline, returns a schema-invalid payload, and never resolves; assert timeout classification, retry behavior, and `null` dimensions remain explicit.
4. Run the three node-test files and record the failing assertions before implementation.

## Task 2: Correct mainline objective accounting at the story boundary

**Files:** `scripts/storyEvalAnalyze.mjs`, `scripts/storyEvalAnalyze.node-test.mjs`

1. Trace the science-fiction-a artifact rows and identify whether the mismatch is caused by a terminal objective being represented by an ending/battle row or by a genuinely unpresented/suppressed suggested action.
2. Adjust the analyzer to use the row that owns the player action and its `actionEvents`; do not count an ending-only row as a new opportunity and do not treat unrelated later events as the current objective result.
3. Keep historical-artifact fallback behavior intact (`newEvents` for artifacts without `actionEvents`).
4. Run the analyzer test file and the focused science-fiction-a analysis; verify the metric is explainable from the JSONL rows.

## Task 3: Make judge evidence robust under the updated provider

**Files:** `scripts/storyEvalJudge.mjs`, `scripts/storyEvalJudge.node-test.mjs`

1. Preserve the existing 120-second per-call ceiling, but make timeout/retry configuration explicit in the report and ensure an aborted request cannot leave a pending promise or partial score that looks complete.
2. Keep schema validation strict: every score needs an in-packet scene index and an exact evidence quote; invalid responses become a typed failure and `null` score after the configured retry.
3. Ensure the report distinguishes provider timeout, HTTP/provider error, schema error, and evidence mismatch so release triage can target the real blocker.
4. Run judge unit tests, then rerun the focused xianxia regression with `STORY_EVAL_JUDGE_TIMEOUT_MS=120000` and bounded concurrency before spending the full matrix budget.

## Task 4: Align branch durability checks with the pair-based design

**Files:** `scripts/storyEvalQualityGate.mjs`, `scripts/storyEvalQualityGate.node-test.mjs`, `scripts/storyEvalAnalyze.mjs` (only if a field is missing)

1. Use the spec’s pair artifact as the S8/S9 evidence unit: aggregate checkpoint count and durable differences across the objective/explore pair, while requiring each checkpoint to retain a valid before/after comparison and rejecting reconverged checkpoints.
2. Keep the release requirement at three checkpoints and two durable differences per pair; do not silently lower thresholds because one strategy ends before all checkpoints.
3. Add tests for a valid split pair, an incomplete pair, and a pair with reconvergence; run the quality-gate test file.

**Decision after reading the design:** keep the release gate strict per run. The design states that a run without paired evidence cannot support a high S8/S9 conclusion, so aggregating an objective run's checkpoints into an explore run would hide a real exploration-coverage gap. The latest explore regression therefore remains a truthful `max_scenes`/one-checkpoint result; no gate weakening is made.

## Task 5: Focused real-AI regression, release matrix, and documentation

**Files:** `docs/archive/AI内容质量评估.md`, `docs/Agent文档索引.md` (only if routing facts change)

1. Rerun the xianxia pair serially/with provider-supported bounded concurrency, including analysis and judge at the explicit 120-second timeout; inspect all failures and score nullability.
2. If the focused run is complete enough, launch all seven topics in parallel with the same environment and collect manifests, metrics, scores, and gate output. A worker crash is recorded as an incomplete run and retried once serially.
3. Run the release gate and summarize objective progress, fallback, pacing, facts, branch durability, judge evidence, and convergence by topic/strategy.
4. Update the quality-evaluation agent doc with the new implementation facts and the exact command/results; commit the plan, code, tests, and documentation together.

## Verification checklist

- `node --test scripts/storyEvalAnalyze.node-test.mjs scripts/storyEvalQualityGate.node-test.mjs scripts/storyEvalJudge.node-test.mjs`
- Focused xianxia real-AI journey + analyze + judge at 120s timeout.
- Seven-topic parallel release matrix, then `storyEvalQualityGate.mjs --release`.
- `git diff --check` and clean/intentional worktree status before commit.
