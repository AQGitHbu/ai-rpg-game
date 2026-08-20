# Investigation Choice Scenes Code Review and Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review the `feat/investigation-choice-scenes` worktree, fix every confirmed correctness or regression issue, verify the branch, and fast-forward it into `main` while safely removing the worktree and branch.

**Architecture:** Treat the branch as a cross-layer RPG change. Review the domain/rule contracts first, then the application scene approval and CAS boundaries, then the read-model/UI projections and end-to-end journeys. Any fix must preserve opaque-token input, single rule CAS plus independent scene CAS, deterministic fallback, and the existing mainline investigation flow.

**Tech Stack:** TypeScript, React, Next.js, Vitest, SQLite, npm scripts, Git worktrees.

## Global Constraints

- All player-visible choices remain server-approved opaque tokens; clients must not construct or parse business action keys.
- Successful player actions use one rule-state CAS; scene generation uses a separate atomic scene write-back CAS.
- AI and fixture sources may propose investigation approaches only; rules and approval own facts, costs, evidence, tension, and progression.
- Investigation, movement, and item pickup remain synchronous immediate-scene paths unless evolution requires `needs_next_act` or `needs_ending_pair`.
- Fallback scenes remain playable and are never marked as generated AI output.
- The worktree must be cleaned through the repository’s `npm run branch:merge -- <branch>` workflow; do not use `git worktree remove` or recursive deletion.

---

### Task 1: Establish the review baseline

**Files:**
- Review: `src/game/domain/action.ts`, `src/game/domain/approvedChoice.ts`, `src/game/domain/events.ts`, `src/game/domain/openingGenerationCandidate.ts`, `src/game/domain/storyState.ts`, `src/game/domain/worldState.ts`
- Review: `src/game/gameplay/rpg/ruleEngine/`, `src/game/gameplay/rpg/openingGeneration/`, `src/game/gameplay/rpg/worldEvolution/`
- Review: `src/game/application/buildChoiceMap.ts`, `src/game/application/gameSessionView.ts`, `src/game/application/performTurn.ts`
- Review: `src/game/application/approveAndWriteScene.ts`, `src/game/application/generatePendingScene.ts`, `src/game/application/sceneGenerationContext.ts`, `src/game/application/sceneSource.ts`
- Review: `src/components/LocationSceneScreen.tsx`, `src/components/AdventureGameShell.tsx`

**Interfaces:**
- Consumes: `main...feat/investigation-choice-scenes` diff and the branch’s existing tests.
- Produces: A recorded list of confirmed defects, affected contracts, and the smallest regression test for each defect.

- [x] **Step 1: Check repository and worktree cleanliness**

Run:

```powershell
git -C .worktrees/investigation-choice-scenes status --short --branch
git worktree list --porcelain
git diff --check main...feat/investigation-choice-scenes
```

Expected: The target worktree is clean, registered, and the diff has no whitespace errors.

- [x] **Step 2: Run the branch’s focused investigation and scene tests**

Run:

```powershell
npm test -- --runInBand src/game/application/testing/investigationChoiceJourney.test.ts src/game/application/testing/investigationFlowJourney.test.ts src/game/gameplay/rpg/ruleEngine src/game/application/buildChoiceMap.test.ts src/game/application/gameSessionView.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingScene.test.ts src/components/LocationSceneScreen.test.tsx
```

Expected: Record the first failing test and its stack before changing implementation. If the Vitest version rejects `--runInBand`, rerun the same file list without that option.

- [x] **Step 3: Inspect changed code against the documented contracts**

Trace each path end-to-end: opaque approach token → `actionConverter` → `performTurn` → rule resolution/reconciliation → pending job; scene proposal → approval → scene write-back → `GameSessionView`; and stale/tampered/repeated token rejection. Mark only behavior backed by a failing test, a type/runtime error, or a direct contract violation as a fix.

### Task 2: Repair confirmed rule, token, or state-transition defects

**Files:**
- Modify only the affected implementation among `src/game/gameplay/rpg/ruleEngine/`, `src/game/domain/`, `src/game/application/actionConverter.ts`, `src/game/application/buildChoiceMap.ts`, `src/game/application/gameSessionView.ts`, and `src/game/application/performTurn.ts`
- Test: The colocated failing test or the smallest affected test file under the same directory

**Interfaces:**
- Consumes: The baseline defect list from Task 1.
- Produces: Correct investigation approach validation, automatic discovery behavior, objective reconciliation, opaque choice projection, and single-CAS action handling.

- [x] **Step 1: Add or strengthen a regression test for each confirmed defect**

Each test must assert the externally meaningful contract, such as:

```ts
expect(result.kind).toBe("ok");
expect(nextState.worldState.eventLedger.at(-1)?.type).toBe("fact_discovered");
expect(nextState.storyState.quest.activeObjectives[0]?.kind).toBe("visit_location");
expect(repository.applyState).toHaveBeenCalledTimes(1);
```

For invalid, stale, or tampered tokens, assert zero state writes and the stable error code.

- [x] **Step 2: Implement the smallest rule/application correction**

Preserve the existing `Action` union and `/api/game/actions` route. Do not add a client-supplied fact ID, approach ID, cost, evidence, or parallel write path. Keep automatic discovery as a rule result only; it must not create a second pending job or scene-side fact mutation.

- [x] **Step 3: Run the affected domain/gameplay/application tests**

Run:

```powershell
npm run test:game-domain
npm run test:game-gameplay
npm run test:game-application
```

Expected: PASS, with no unrelated test suppression or snapshot weakening.

### Task 3: Repair confirmed scene approval, persistence, or immediate-path defects

**Files:**
- Modify only the affected implementation among `src/game/application/sceneGenerationContext.ts`, `src/game/application/sceneSource.ts`, `src/game/application/approveAndWriteScene.ts`, `src/game/application/generatePendingScene.ts`, `src/game/application/deterministicSceneSource.ts`, `src/game/application/server/ai/liveScenePerformanceSource.ts`, `src/game/application/server/ai/liveWorldEvolutionSource.ts`, `src/game/application/server/persistence/sqliteGameRepository.ts`, and `src/game/gameplay/rpg/worldEvolution/`
- Test: The smallest affected scene, source, repository, or journey test

**Interfaces:**
- Consumes: Confirmed scene/CAS defects from Task 1 and rule outputs from Task 2.
- Produces: Safe approach proposal parsing/approval, correct method-specific result scenes, correct immediate investigation consumption, valid persistence across reload, and preserved world-evolution safeguards.

- [x] **Step 1: Add regression tests around the broken boundary**

Cover the exact failure with a focused assertion: invalid proposal references are dropped or rejected without unauthorized state, valid approaches retain their semantic cost/evidence result, immediate scenes do not call live AI, queue entries are consumed exactly once, and `needs_next_act`/`needs_ending_pair` still use the full orchestration path.

- [x] **Step 2: Implement the smallest approval/CAS/persistence correction**

Keep approved choices and scenes tied to the post-write-back revision. Preserve zero-write behavior on CAS conflict and never persist raw proposal objects or client-derived identifiers.

- [x] **Step 3: Run focused scene and persistence tests**

Run:

```powershell
npm test -- src/game/application/sceneGenerationContext.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingScene.test.ts src/game/application/deterministicSceneSource.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts
```

Expected: PASS.

### Task 4: Repair confirmed UI, fallback, and journey regressions

**Files:**
- Modify only the affected implementation among `src/components/LocationSceneScreen.tsx`, `src/components/AdventureGameShell.tsx`, `src/components/CurrentGameScreen.tsx`, `src/game/application/deterministicEvolutionBeats.ts`, `src/game/application/deterministicEvolutionSource.ts`, and `src/game/application/gameSessionView.ts`
- Test: The smallest affected component, fallback, or journey test
- Documentation: Update the affected `docs/agent/*.md`, `docs/策划文档/*.md`, or `docs/Agent文档索引.md` only when the fix changes an implementation or player-visible fact.

**Interfaces:**
- Consumes: Confirmed read-model/UI/fallback defects from earlier tasks.
- Produces: Dynamic investigation result narration that is visible in the correct scene, deterministic fallback with actionable clue-to-location causality, and journeys that remain playable after reload.

- [x] **Step 1: Add regression tests for the observed player-visible failure**

Assert the rendered text and action availability from `GameSessionView`; do not infer correctness from implementation details alone. For fallback text, assert the clue and target-location facts are both present without exposing system metadata.

- [x] **Step 2: Implement the minimal projection or fallback correction**

Keep UI navigation separate from rule actions. Do not make static building copy override a fresh `investigate`, `item`, or `travel` narrative, and do not make fallback text claim it came from AI.

- [x] **Step 3: Run component and journey tests**

Run:

```powershell
npm run test:components
npm run test:foundation-journey
npm test -- src/game/application/testing/investigationChoiceJourney.test.ts src/game/application/testing/investigationFlowJourney.test.ts
```

Expected: PASS.

### Task 5: Complete acceptance and merge safely

**Files:**
- Review: All branch changes and the final diff against `main`
- Modify: Only files required by a confirmed defect or its regression test

**Interfaces:**
- Consumes: Completed fixes and tests from Tasks 2–4.
- Produces: A verified branch fast-forwarded into `main`, with the source worktree and local feature branch removed by the repository workflow.

- [x] **Step 1: Run the full project acceptance gates in the feature worktree**

Run:

```powershell
npm run check:standards
npm run lint
npm run typecheck
npm run test:boundaries
npm test
npm run build
npm run phase:status
```

Expected: Every command exits successfully; investigate-related tests and docs remain present in the final diff.

- [x] **Step 2: Review the final diff and commit fixes**

Run:

```powershell
git diff --check main...HEAD
git status --short --branch
git diff --stat main...HEAD
git log --oneline main..HEAD
```

Commit only the review plan, regression tests, implementation fixes, and required documentation updates. The feature worktree must be clean before merge.

- [ ] **Step 3: Fast-forward merge and clean up the branch/worktree**

From the repository main worktree, run:

```powershell
npm run branch:merge -- feat/investigation-choice-scenes
```

Expected: The script verifies clean `main` and target worktree, fast-forwards `main`, safely unlinks `.foundation` if present, prunes the worktree, and deletes the merged local branch. Do not replace it with `git worktree remove`, recursive deletion, or force branch deletion.

- [ ] **Step 4: Verify the merged repository state**

Run:

```powershell
git status --short --branch
git worktree list --porcelain
git branch --list feat/investigation-choice-scenes
git log --oneline --decorate -3
```

Expected: `main` is clean and contains the reviewed commits; `.worktrees/investigation-choice-scenes` and the local feature branch no longer exist.
