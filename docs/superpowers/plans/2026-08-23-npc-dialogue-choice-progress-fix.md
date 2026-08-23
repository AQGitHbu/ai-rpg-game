# NPC Dialogue Choice Progress Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a scene that presents a focused target NPC always exposes two dialogue actions, so a move/explore fallback cannot appear as an NPC response and consume a turn as an unintended branch.

**Architecture:** Keep action legality and choice construction in `application`'s authoritative deterministic scene-candidate projection. Treat an arrival scene with the authoritative `talk_to_npc` target as a focused dialogue scene even when its narrative event is `travel`; retain the existing approval pipeline and add a defense-in-depth guard so both approved choices target the current NPC objective. Add regression coverage for candidate construction, scene approval, and the persisted read model/API-visible behavior.

**Tech Stack:** TypeScript, Vitest, existing RPG application scene generation/read-model/approval pipeline.

**Spec:** `docs/agent/NPC对话驱动叙事场景触发.md` and `docs/agent/当前开发阶段.md`.

## Global Constraints

- Fixed choices and custom NPC input continue through `/api/game/actions` → `performTurn`; no parallel dialogue route or UI-created action.
- The client receives only opaque choice tokens and labels; Action mapping remains server-side.
- A focused NPC ready scene must expose exactly two fixed dialogue choices and one custom input.
- AI/fixture sources may propose text, but the server remains authoritative for candidate actions and objective legality.
- Preserve the existing single rule CAS, pending narrative job, and scene write-back CAS pipeline.
- Only modify `ai-rpg-game`; do not modify the protected foundation sibling.

---

### Task 1: Add failing regression coverage for arrival-NPC choices

**Files:**
- Modify: `src/game/application/deterministicSceneSource.test.ts` near the existing `buildSelectableSceneCandidates` and choice-ordering tests.
- Modify: `src/game/application/approveAndWriteScene.test.ts` near the existing objective-progress approval tests.

**Interfaces:**
- Consume the existing `SceneGenerationContext`, `buildSelectableSceneCandidates`, `buildSceneChoices`, and `approveScenePerformance` APIs.
- Assert that a `travel` scene whose authoritative current objective is the NPC present at the destination returns two `talk` Actions, and that an approved focused-NPC pair cannot contain a non-target `move` action.

- [x] **Step 1: Write a failing candidate-projection test**

  Build a context matching the observed save: `job.actionSummary.kind = "move"`, `objectiveTarget.entityId` is the NPC at `currentLocation`, `buildEventState(context)` is `travel`, and `focusNpcContext` identifies that NPC. Assert:

  ```ts
  const candidates = buildSelectableSceneCandidates(context, {
    text: "那晚镖局的火光，不是意外。",
    usedFactIds: [],
  });

  expect(candidates).toHaveLength(2);
  expect(candidates.every((candidate) => candidate.action.type === "talk")).toBe(true);
  expect(candidates.every((candidate) =>
    candidate.action.type === "talk" && candidate.action.npcId === targetNpc.id,
  )).toBe(true);
  ```

- [x] **Step 2: Run the focused test and verify it fails**

  Run:

  ```bash
  npx vitest run src/game/application/deterministicSceneSource.test.ts -t "arrival.*NPC|抵达.*NPC"
  ```

  Expected: FAIL because the current projection returns one `talk` candidate and one `move` candidate for a non-dialogue/travel event.

- [x] **Step 3: Add a failing approval guard test**

  Reuse the existing `approveScenePerformance` test context with `objectiveTarget` pointing at a `talk_to_npc` target. Supply a two-choice proposal containing one target `talk` action and one reachable `move` action. Assert the result is `{ ok: false }` with the new focused-dialogue rejection code.

- [x] **Step 4: Run the approval test and verify it fails for the current implementation**

  Run:

  ```bash
  npx vitest run src/game/application/approveAndWriteScene.test.ts -t "focused NPC|目标.*对话|arrival"
  ```

  Expected: FAIL because the current approval rule only requires `.some()` selected choice to target the objective.

### Task 2: Make focused arrival scenes dialogue-only and harden approval

**Files:**
- Modify: `src/game/application/deterministicSceneSource.ts` in `buildSelectableSceneCandidates`.
- Modify: `src/game/application/approveAndWriteScene.ts` in the objective-choice validation block.

**Interfaces:**
- Preserve `buildSelectableSceneCandidates(context, currentNpcLine?)` and `approveScenePerformance(...)` signatures.
- Add no new route, Action variant, token format, or persistence field.

- [x] **Step 1: Make the minimal candidate projection change**

  When `focusedObjectiveNpc` exists, return the same support/challenge pair used by a dialogue event instead of entering the `nonDialogueCandidate` fallback. The resulting condition must cover both `event.kind === "dialogue"` and a travel/observe scene whose current authoritative objective is the present NPC.

  The branch must continue to return exactly two actions targeting the same NPC: `talk/support` and `talk/challenge`.

- [x] **Step 2: Add defense-in-depth approval validation**

  For an authoritative `talk_to_npc` objective with a focused present NPC, reject the proposal unless both approved actions are `talk` actions targeting `objectiveTarget.entityId`. Use a stable `SceneRejectionCode` such as `focused_dialogue_requires_talk_choices`, add it to the union, and keep the existing generic objective-progress check for non-dialogue scenes/objective kinds.

- [x] **Step 3: Run the focused candidate and approval tests**

  Run:

  ```bash
  npx vitest run src/game/application/deterministicSceneSource.test.ts src/game/application/approveAndWriteScene.test.ts
  ```

  Expected: PASS, including the new arrival-NPC regression tests.

### Task 3: Verify read-model and end-to-end behavior

**Files:**
- Modify: `src/game/application/gameSessionView.test.ts` only if a missing assertion is needed for the existing focused-NPC projection contract.
- Modify: `src/game/application/testing/linearMovePrefetchRegression.test.ts` only if the journey lacks an assertion that the arrival scene's two choices are both dialogue actions.

**Interfaces:**
- Use `projectGameSessionView` and the existing journey helpers; do not change component or API contracts.

- [x] **Step 1: Add the persisted/read-model regression assertion**

  After the pre-generated move lands at the target NPC, assert the focused NPC has exactly two choices and both have `presentation === "dialogue"`; assert `narrative.choices` remains empty for a focused NPC dialogue.

- [ ] **Step 2: Run the application behavior suite**

  Run:

  ```bash
  npm run test:game-application
  ```

  Expected: PASS, including the move-prefetch journey and all scene/read-model/approval tests.

  Result: 569 application tests passed; 6 persistence/logging suites could not load because this worktree's existing `node_modules` lacks the declared `@libsql/client` package.

- [x] **Step 3: Run required static and repository gates**

  Run:

  ```bash
  npm run typecheck
  npm run lint
  npm run test:boundaries
  npm run test:fast
  ```

  Expected: all commands exit successfully; no dependency-boundary or formatting changes are introduced.

- [x] **Step 4: Review the final diff and working tree**

  Run:

  ```bash
  git diff --check
  git status --short
  git diff -- src/game/application/deterministicSceneSource.ts src/game/application/approveAndWriteScene.ts src/game/application/deterministicSceneSource.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/testing/linearMovePrefetchRegression.test.ts src/game/application/gameSessionView.test.ts
  ```

  Confirm that only the focused-choice behavior, its tests, and this implementation plan changed.
