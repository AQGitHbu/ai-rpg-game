# Background Narrative Prefetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start every causally determined narrative generation task immediately in the background, hide opening-scene latency behind the prologue, remove redundant talk confirmation, and recover scene candidate shortages without inventing client-side state.

**Architecture:** `PendingNarrativeJob` remains the durable source of truth. The server composition root queues it through the existing in-process deduplicating coordinator immediately after create/turn commits, while `/api/game/narrative/ensure` remains an idempotent recovery trigger. Scene write-back preserves the monotonic `prologueShown` metadata inside the SQLite write transaction, and candidate shortage invokes one approved pacing evolution before scene performance.

**Tech Stack:** TypeScript, Next.js App Router, React, Vitest, SQLite/libSQL, deterministic fallback sources.

## Global Constraints

- Preserve the six canonical `/api/game/**` routes; do not add a background-generation route.
- Preserve exactly one rule CAS per successful player action and one independent scene write-back CAS.
- The browser continues to send only opaque choice tokens or focus-NPC free text.
- AI remains proposal-only; automatic recovery uses the same evolution approval, budget, ID minting, scene approval, and fallback path.
- `prologueShown` is monotonic UI metadata: once true it may never be overwritten to false by a concurrent scene write-back.
- Do not modify `.foundation`, `../ai-game-foundation`, `docs/共同规范/`, or any `@ai-game/*` package.

---

### Task 1: Record the latency-hiding design rule and executable plan

**Files:**
- Modify: `docs/游戏设计原则.md`
- Create: `docs/superpowers/plans/2026-08-13-background-narrative-prefetch.md`

**Interfaces:**
- Produces the cross-system rule used by Tasks 2–5.

- [x] **Step 1: Add the design principle**

Add a principle stating that once no unconsumed player decision can affect the next content, generation must start immediately in the background and may overlap reading, transitions, and animation. It must also state the converse: choice-dependent branches cannot be generated as if selected.

- [x] **Step 2: Verify documentation placement**

Run: `rg -n "后续内容已经不再受玩家选择影响|后台生成" docs/游戏设计原则.md`

Expected: one stable cross-system principle in the design-principles document.

---

### Task 2: Make prologue acknowledgement and scene write-back concurrency-safe

**Files:**
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.test.ts`
- Modify: `src/game/application/server/compositionRoot.ts`
- Modify: `src/game/application/testing/prologueAckPreservesSceneChoices.test.ts`

**Interfaces:**
- Consumes: `GameRepository.applySceneWriteBack`, `commitState`.
- Produces: monotonic preservation of `StoryState.prologueShown` and retryable idempotent acknowledgement.

- [x] **Step 1: Write the failing persistence test**

Create a game whose stored state has `prologueShown: true`, then call `applySceneWriteBack` with a stale snapshot whose `nextStoryState.prologueShown` is false. Assert the saved state remains true and revision advances exactly once.

```ts
expect(result).toMatchObject({ ok: true, record: { revision: 1 } });
if (result.ok) expect(result.record.storyState.prologueShown).toBe(true);
```

- [x] **Step 2: Run the test and verify the overwrite**

Run: `npm run test:game-application -- src/game/application/server/persistence/sqliteGameRepository.test.ts`

Expected: FAIL because `applySceneWriteBack` currently serializes the stale full `nextStoryState` unchanged.

- [x] **Step 3: Merge monotonic metadata inside the write transaction**

Implement `applySceneWriteBack` as its own write transaction. Read and validate the current record under the transaction, reject a mismatched revision, then serialize:

```ts
const mergedStoryState: StoryState = {
  ...input.nextStoryState,
  prologueShown: current.record.storyState.prologueShown || input.nextStoryState.prologueShown,
};
```

Atomically update world JSON, merged story JSON, and `revision + 1`, then return the persisted record.

- [x] **Step 4: Retry acknowledgement after a concurrent scene revision**

In `ackPrologue`, return success immediately when already acknowledged. Otherwise retry one fresh read/metadata commit after `STALE_GAME_REVISION`; do not increment revision for the metadata commit.

- [x] **Step 5: Verify focused concurrency tests**

Run: `npm run test:game-application -- src/game/application/server/persistence/sqliteGameRepository.test.ts src/game/application/testing/prologueAckPreservesSceneChoices.test.ts`

Expected: PASS; scene choices remain valid and `prologueShown` remains true in both write orders.

---

### Task 3: Queue durable narrative work immediately and prefetch behind the prologue

**Files:**
- Modify: `src/game/application/server/ai/_shared/ensureCoordinator.ts`
- Create: `src/game/application/server/ai/_shared/ensureCoordinator.test.ts`
- Modify: `src/game/application/server/compositionRoot.ts`
- Modify: `src/components/CurrentGameScreen.tsx`
- Modify: `src/components/CurrentGameScreen.test.tsx`

**Interfaces:**
- Consumes: `BackgroundEnsureCoordinator`, `generatePendingScene`, persisted `PendingNarrativeJob`.
- Produces: `queuePendingNarrative(traceId?: string): Promise<EnsureResult>` shared by create, successful non-combat turns, and narrative ensure.

- [x] **Step 1: Write failing coordinator and prologue tests**

Assert duplicate ensures for the same `gameId:jobId` start one task and return `queued` then `already_running`. Update the prologue component test to expect `ensureNarrative()` before acknowledgement while the prologue remains visible.

- [x] **Step 2: Run focused tests and verify current delayed behavior**

Run: `npm run test:game-application -- src/game/application/server/ai/_shared/ensureCoordinator.test.ts && npm run test:components -- src/components/CurrentGameScreen.test.tsx`

Expected: FAIL because the coordinator lacks coverage and `CurrentGameScreen` gates ensure on `prologueShown`.

- [x] **Step 3: Wire one deduplicating coordinator in the composition root**

Key work by both game and job identity:

```ts
key: `${current.record.gameId}:${generation.job.jobId}`
```

`createGame` queues after persistence succeeds. `performTurn` queues only when the persisted updated view is pending, after constructing the response view. `ensureNarrativeScene` returns success for `queued`, `already_running`, and `not_pending`; only `unavailable` is an error.

- [x] **Step 4: Prefetch while keeping the prologue stable**

Change `CurrentGameScreen` so any pending view triggers the idempotent ensure/poll loop, including `prologueShown: false`. Keep rendering the prologue until acknowledgement and remove its full-screen `GenerationStatusModal`; the disabled button text remains the acknowledgement feedback.

- [x] **Step 5: Verify focused server/UI tests**

Run: `npm run test:game-application -- src/game/application/server/ai/_shared/ensureCoordinator.test.ts && npm run test:components -- src/components/CurrentGameScreen.test.tsx`

Expected: PASS; opening generation begins during reading and acknowledgement does not display a full-screen action modal.

---

### Task 4: Remove redundant talk confirmation and recover candidate shortage

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx`
- Modify: `src/components/AdventureGameShell.test.tsx`
- Modify: `src/game/application/deterministicEvolutionSource.ts`
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/generatePendingScene.test.ts`

**Interfaces:**
- Consumes: approved talk `choiceToken`, `buildSelectableSceneCandidates`, `evolveWorld`.
- Produces: one-click explicit talk submission and `scene_candidate_shortage` pacing recovery.

- [x] **Step 1: Write the failing one-click talk test**

Click a rendered action whose label is `与老板交谈` and assert `onSubmit` is called immediately with its existing opaque token. Clicking the NPC portrait/card still only opens inspection dialogue.

- [x] **Step 2: Write the failing candidate-shortage test**

Build a pending record at an isolated location with no NPC. Assert `generatePendingScene` performs approved pacing evolution, creates enough legal candidates, and saves a ready scene instead of returning `unavailable` or remaining pending.

- [x] **Step 3: Implement one-click explicit talk**

When a rendered choice matches an NPC talk action, open an already-ready focus dialogue; otherwise retain the dialogue identity for auto-open and immediately submit the clicked token. Do not synthesize or parse tokens.

- [x] **Step 4: Implement approved shortage recovery**

After normal evolution, build the scene context and count `buildSelectableSceneCandidates(context)`. When fewer than two exist, request one `{ kind: "pacing", pacingNeed: "complicate" }` evolution with reason `scene_candidate_shortage`, rebuild the preview/context, and continue through the normal scene source and approval. Extend the deterministic pacing source so a no-action shortage proposal adds a reachable NPC, or a connected location plus NPC when the current town is full.

- [x] **Step 5: Replace false waiting copy with an invariant error**

The UI must not claim that an idle, non-pending empty scene is progressing. Render a stable recovery/error message; normal shortage recovery occurs before scene write-back and should prevent this state.

- [x] **Step 6: Verify focused application and component tests**

Run: `npm run test:game-application -- src/game/application/generatePendingScene.test.ts && npm run test:components -- src/components/AdventureGameShell.test.tsx`

Expected: PASS; no extra explicit-talk click and no pending loop from a one-candidate scene.

---

### Task 5: Synchronize implementation facts and run acceptance

**Files:**
- Modify: `docs/策划文档/AI生成RPG_MVP.md`
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `docs/Agent文档索引.md`

**Interfaces:**
- Consumes all implementation tasks.
- Produces current player-visible and implementation documentation.

- [x] **Step 1: Update player and agent documentation**

Document immediate background generation after the last causally relevant choice, silent prologue prefetch, server-side persisted-job queueing, idempotent ensure recovery, one-click explicit talk, monotonic prologue metadata, and approved candidate-shortage evolution.

- [x] **Step 2: Run focused gates**

Run:

```text
npm run test:game-application
npm run test:components
npm run test:app
npm run typecheck
npm run lint
npm run test:boundaries
```

- [x] **Step 3: Run repository acceptance**

Run:

```text
npm run check:standards
npm run test:fast
npm test
npm run build
npm run phase:status
```

Expected: every command exits zero.

---

## Self-Review

### Requirement coverage

- [x] Records the requested design principle in `docs/游戏设计原则.md`.
- [x] Prefetches the opening scene during the prologue without hiding a branch choice.
- [x] Queues all persisted non-combat narrative work immediately on the server.
- [x] Keeps client ensure as restart/network recovery and deduplicates concurrent triggers.
- [x] Prevents concurrent acknowledgement from being overwritten or invalidating scene tokens.
- [x] Removes the explicit talk double click while preserving portrait inspection.
- [x] Recovers fewer-than-two-candidate scenes through the existing approved evolution path.
- [x] Replaces misleading idle waiting text and updates player/agent implementation facts.

### Placeholder scan

- [x] No `TBD`, `TODO`, compatibility facade, new route, or unbounded retry is present.
- [x] Every task names exact files, behavior, tests, and commands.

### Type consistency

- [x] The coordinator consumes the existing persisted job and `GeneratePendingSceneResult`.
- [x] Scene shortage recovery reuses `EvolutionNeed`, `WorldDeltaProposal`, and the canonical scene approval/write-back.
- [x] The client continues to consume `GameSessionView` and opaque tokens only.

### Completion rule

The work is complete only when the opening scene normally finishes during prologue reading, every post-choice pending job is queued without another player click, acknowledgement cannot regress, explicit talk is one click, candidate shortage cannot strand a pending save, and all focused/full gates pass.
