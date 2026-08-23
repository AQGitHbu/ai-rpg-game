# NPC Next-Scene Fallback Root Cause Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the production next-scene path from exposing legacy deterministic dialogue labels or a move/explore fallback when the current objective is the NPC at the arrival location.

**Architecture:** Make `src/game/application/sceneChoiceCandidates.ts` the single authoritative candidate projection for both live AI and explicit offline fixtures. Align its arrival-NPC rule with the existing approval/read-model contract, and retain live generation failure as a stable failed job rather than synthesizing a production fallback scene.

**Tech Stack:** TypeScript, Vitest, existing RPG application scene source/approval pipeline, Chrome extension browser playtest.

**Spec:** `docs/agent/NPC对话驱动叙事场景触发.md`, `docs/agent/运行时AI导演与场景表演.md`, `docs/agent/探索与任务推进.md`.

## Global Constraints

- Production AI failure or incomplete content remains `AI_RESPONSE_INVALID`/`AI_CALL_FAILED` and persists `narrative.generation.status = failed`; it must not become a deterministic scene.
- A normal ready focused NPC scene exposes exactly two fixed dialogue choices and one custom input; a completed dialogue session whose objective advances exposes exactly one generated/approved handoff choice attached to the NPC's final line.
- An arrival scene whose authoritative objective is the present NPC exposes two `talk` actions targeting that NPC, even when its event kind is `travel` or `observe`.
- Fixed choices continue through the existing opaque-token `/api/game/actions` and CAS pipeline.
- Only `ai-rpg-game` changes; do not modify the protected foundation sibling.

## Target File Structure

- Modify: `src/game/application/sceneChoiceCandidates.ts` — canonical live/offline candidate projection; remove the stale arrival move fallback branch.
- Modify: `src/game/application/deterministicSceneSource.ts` — consume the canonical candidate projection while retaining deterministic-only narration construction.
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts` — prove the live parser uses two target-NPC dialogue candidates and still fails on incomplete content.
- Modify: `src/game/application/deterministicSceneSource.test.ts` — preserve the offline arrival regression while exercising the shared projection.
- Modify: `src/game/application/testing/linearMovePrefetchRegression.test.ts` or `src/game/application/gameSessionView.test.ts` — assert the persisted/read-model arrival scene exposes only dialogue choices if the existing journey gap requires it.
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`, `docs/agent/运行时AI导演与场景表演.md`, `docs/Agent文档索引.md` — record the implementation fact after verification.

### Task 1: Lock the production candidate regression

- [x] Add a live-path fixture with `job.actionSummary.kind = "move"`, `resolvedEvent.eventKind = "travel"`, `objectiveTarget` equal to a present NPC, and matching `focusNpcContext`.
- [x] Assert `buildSelectableSceneCandidates` returns exactly two `talk` candidates targeting that NPC; assert the live parser accepts two candidate IDs and does not expose the old non-dialogue branch.
- [x] Add/retain a test proving incomplete live scene content returns a typed failure and does not construct a deterministic fallback proposal.
- [x] Run the focused live and candidate tests and confirm the regression is reproduced before implementation.

### Task 2: Remove the duplicate projection drift

- [x] Change the shared candidate projection to return the support/challenge pair whenever `event.kind === "dialogue" || focusedObjectiveNpc !== undefined`.
- [x] Make deterministic scene choice construction call the shared projection instead of maintaining a second copy of candidate labels and arrival branching.
- [x] Keep deterministic source usage explicit to offline fixtures; do not make `sourceFactory` or live generation fall back to it.
- [x] Add and pass final-handoff parser/approval/read-model regression tests; run the focused application tests.

### Task 3: Verify production failure and browser behavior

- [ ] Run `npm run typecheck`, `npm run lint`, `npm run test:boundaries`, `npm run test:fast`, and relevant application/component tests.
- [ ] Start the development server with the repository's normal command, connect to Chrome, clear the current development save through the UI/API exposed by the app, and create a new game through visible browser controls.
- [ ] Use Chrome clicks only to advance at least three generated scenes, recording each scene's NPC, two choices, generation state/source, and objective progression; do not simulate requests or use offline journey helpers as the real-playtest evidence.
- [ ] If any scene is incomplete, stuck, shows a fallback label, or fails to advance, fix the root issue, rerun focused tests, restart/reload as needed, and repeat the three-scene Chrome journey until the story advances normally.
- [ ] Update implementation docs, inspect `git diff --check`, and report the root cause, changed files, automated results, and browser evidence.
