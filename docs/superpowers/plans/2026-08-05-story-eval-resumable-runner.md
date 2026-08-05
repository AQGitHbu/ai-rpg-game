# Story Evaluation Resumable Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make story evaluation resumable at matrix, scene, and judge-dimension boundaries while adding cheap layered verification before expensive real-AI release runs.

**Architecture:** Keep the authoritative game state in an artifact-local SQLite checkpoint and persist a small progress journal after every scene boundary. The matrix runner will reuse only completed artifacts whose run fingerprint matches the requested configuration; the journey runner will resume only transient failures from the last committed scene. Judge output will be split into independently validated dimension fragments and merged into the existing `scores.json` contract.

**Tech Stack:** TypeScript/Vitest application tests, Node.js ESM evaluation scripts, SQLite repository, JSON/JSONL artifacts, PowerShell-compatible CLI invocation.

## Global Constraints

- All real AI requests must use the configured `ai-slg-game-model`; no model override is allowed.
- Evaluation requests and judge requests keep the permanent 300000 ms upper bound.
- Resume requires matching case, strategy, seed, model, branch mode, profile, scenario/runtime contract versions, and prompt/code fingerprint; incompatible runs fail closed.
- Checkpoint files must contain structural state and safe evidence only; never write API keys, raw prompts, or model output outside the existing captured `calls.jsonl` contract.
- Existing artifact formats remain readable; completed legacy runs can still be analyzed and judged.
- Changes stay in `ai-rpg-game`; no foundation/shared package changes.

---

### Task 1: Define resumable checkpoint and fingerprint contracts

**Files:**
- Create: `src/game/application/testing/storyEvalCheckpoint.ts`
- Test: `src/game/application/testing/storyEvalCheckpoint.test.ts`
- Modify: `src/game/application/testing/storyEvalArtifacts.ts` only if the partial-row type must be exported.

**Interfaces:**
- Produces `STORY_EVAL_CHECKPOINT_VERSION`, `StoryEvalRunFingerprint`, `StoryEvalProgress`, `readStoryEvalProgress`, `writeStoryEvalProgressAtomic`, `readStoryEvalPartialRows`, and `assertResumableFingerprint`.
- Consumes `StoryEvalStoryRow`, existing narrative/scenario contract version constants, and JSON-safe structural metadata.

- [ ] **Step 1: Write failing tests** for atomic progress writes, partial JSONL de-duplication by `sceneId`, fingerprint mismatch rejection, and transient resume metadata.
- [ ] **Step 2: Run the focused test** and confirm the new module/tests fail because the contract does not exist.
- [ ] **Step 3: Implement the module** with temp-file-plus-rename writes, safe JSON parsing, schema version checks, and a fingerprint comparison that reports exact mismatched keys.
- [ ] **Step 4: Run the focused test** and confirm all checkpoint contract cases pass.
- [ ] **Step 5: Commit** `feat(story-eval): add resumable checkpoint contract`.

### Task 2: Persist and resume one journey at scene boundaries

**Files:**
- Modify: `src/game/application/testing/storyEvalJourney.test.ts`
- Modify: `scripts/storyEvalJourney.mjs`
- Test: `src/game/application/testing/storyEvalJourney.test.ts` and `scripts/storyEvalJourney.node-test.mjs`

**Interfaces:**
- Adds `STORY_EVAL_RUN_DIR`/`STORY_EVAL_RESUME` handling through the existing child environment.
- Adds journey options `resumeDir?: string` and `checkpointDbPath?: string` to the internal config.
- Produces `progress.json`, `story.partial.jsonl`, and `checkpoint.sqlite` inside a resumable artifact directory; finalization still emits `story.jsonl`, `manifest.json`, `metrics.json` compatibility artifacts.

- [ ] **Step 1: Add failing journey tests** that stop after a committed scene, invoke the journey again with the same fingerprint, and assert no duplicate scene rows, preserved scene count, and continued action/ending processing; add a mismatch test that fails closed before any AI call.
- [ ] **Step 2: Run the focused journey tests** and confirm they fail because the runner currently always creates a new database and only finalizes rows at the end.
- [ ] **Step 3: Implement artifact-local SQLite and progress initialization**. On a fresh run create `checkpoint.sqlite`; on resume open the existing DB, load `progress.json`, validate the fingerprint, and reconstruct `storyRows` from `story.partial.jsonl`.
- [ ] **Step 4: Implement the scene two-phase journal**. Before selecting a choice write a pending scene record; after the rule action commits, append the completed scene row atomically and clear the pending marker. If the process restarts after the rule action but before append, derive the action-event slice from the saved ledger length and finalize the pending row without another AI scene generation.
- [ ] **Step 5: Persist branch checkpoint completion and continuation counters** after each successful branch stage; reuse an existing valid `branch.json` rather than rerunning that branch on resume.
- [ ] **Step 6: Change the parent runner** to preserve failed artifact directories and checkpoint databases, print a resumable run path, skip a completed compatible slot, and expose `--resume=<artifactDir>`/`--case`/`--strategy` combinations without deleting the database.
- [ ] **Step 7: Run focused journey and script tests**, then run typecheck and targeted lint.
- [ ] **Step 8: Commit** `feat(story-eval): resume journeys from scene checkpoints`.

### Task 3: Add matrix-level reuse and layered verification commands

**Files:**
- Modify: `scripts/storyEvalJourney.mjs`
- Modify: `scripts/storyEvalJourney.node-test.mjs`
- Modify: `package.json`
- Create: `scripts/storyEvalVerify.mjs`
- Test: `scripts/storyEvalVerify.node-test.mjs`
- Modify: `docs/agent/AI内容质量评估.md`

**Interfaces:**
- Adds exported `buildRunFingerprint`, `findReusableArtifact`, and `resolveLayeredVerificationProfile` helpers.
- Adds `npm run verify:story-eval -- --layer=offline|smoke|regression|release` as a no-network/explicit-real-AI layered entry point; release remains opt-in.

- [ ] **Step 1: Write failing node tests** for skipping a matching completed matrix slot, rejecting a mismatched artifact, selecting only the requested case/strategy, and mapping layers to exact max-scenes/branch/timeout settings.
- [ ] **Step 2: Implement matrix manifest persistence** at `artifacts/story-eval/matrix-state.json`; record slot status, artifact path, pair ID, fingerprint, exit code, and last error after every child run.
- [ ] **Step 3: Implement compatible artifact discovery**. A completed slot is reusable only when its manifest fingerprint matches; incomplete/failed slots become resume candidates and never silently count as passing.
- [ ] **Step 4: Implement `storyEvalVerify.mjs`** with four layers: offline replay; one smoke case; one captured-blueprint regression pair; release matrix. The script must stop before real AI unless the layer explicitly requires it and the opt-in env is present.
- [ ] **Step 5: Add package scripts and update the evaluation agent document** with resume commands, compatibility rules, and the four-layer workflow.
- [ ] **Step 6: Run node tests, replay verification, and typecheck/lint; commit** `feat(story-eval): resume matrix slots and add layered verification`.

### Task 4: Cache judge dimensions and merge partial evidence

**Files:**
- Modify: `scripts/storyEvalJudge.mjs`
- Modify: `scripts/storyEvalJudge.node-test.mjs`
- Modify: `scripts/storyEvalQualityGate.mjs` only if it needs to recognize merged fragment metadata.
- Modify: `docs/agent/AI内容质量评估.md`

**Interfaces:**
- Adds `STORY_EVAL_JUDGE_RESUME=1`, `STORY_EVAL_JUDGE_ONLY=S1-S5,S6-S9,C1,C2,C3,C4`, and `judge/` fragment files.
- Produces the existing `scores.json` plus `judge/index.json` containing model, timeout, scale version, input digest, and per-dimension status.

- [ ] **Step 1: Write failing judge tests** for valid fragment reuse, invalid/mismatched fragment invalidation, `--only` dimension selection, and merge behavior when one dimension is still missing.
- [ ] **Step 2: Implement fragment input digests** from manifest/story/metrics/scale/model/config, and write each successful or failed dimension result atomically to `judge/<dimension>.json`.
- [ ] **Step 3: Implement resume selection** so valid existing fragments are skipped, failed/missing fragments are requested, and `scores.json` is merged without erasing valid prior dimensions.
- [ ] **Step 4: Keep strict evidence rules**: missing fragments remain failures; null or schema-invalid results never become passing scores.
- [ ] **Step 5: Run judge node tests with mocked fetch**, then run quality-gate tests and typecheck/lint; commit `feat(story-eval): cache judge dimensions`.

### Task 5: Offline acceptance and documentation

**Files:**
- Modify: `docs/agent/AI内容质量评估.md`
- Modify: `docs/Agent文档索引.md` only if the new checkpoint/verification document is added to the index.

- [ ] **Step 1: Run the complete offline acceptance set**: checkpoint tests, journey tests, runner node tests, judge node tests, quality-gate tests, `npm run typecheck`, targeted eslint, and `npm run test:boundaries`.
- [ ] **Step 2: Run a process-kill/resume fixture test** with mocked AI and verify the resumed artifact has contiguous scene indices, no duplicate `sceneId`, one manifest, and unchanged failure evidence.
- [ ] **Step 3: Document exact commands for fresh, resume, case-only, judge-only, and layered verification runs; state that real AI remains disabled for this acceptance.
- [ ] **Step 4: Commit** `docs(story-eval): document resumable evaluation workflow`.
