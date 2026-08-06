# Pending Stale Retry and Generation Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a runtime narrative task recover from a concurrent revision change, prevent a stale result from leaving a save permanently pending, and show safe three-role generation progress in the preparation modal.

**Architecture:** Keep the durable pending marker and SQLite CAS contract. When a generated scene loses a CAS race but the save is still pending at the same location, rebase the already-generated scene onto the latest save and retry the CAS without another AI call; the coordinator also performs a bounded fresh retry for an unrecoverable stale result. Expose only role-stage counts through a process-local server progress registry and project them into the client view; the registry is cleared when the task reaches a terminal result.

**Tech Stack:** TypeScript, Next.js/React, Vitest, SQLite repository/CAS.

## Global Constraints

- Do not modify `../ai-game-foundation`, `.foundation`, or any `@ai-game/*` package.
- Preserve the prior worktree changes; edit only the runtime narrative, server view, modal, tests, and routed implementation docs.
- Never expose prompts, provider responses, API keys, model names, action keys, IDs, or diagnostics to the client.
- Progress is an operational count only: three role stages (`director`, `writer`, `npc`), with retry attempt shown separately; it is not game state or narrative content.
- A CAS conflict must never apply an old location, old battle, old ending, or old player state over a newer save.
- All retries are bounded; a persistent persistence failure remains observable as unavailable and must not spin indefinitely.

---

### Task 1: Rebase stale generated scenes and add bounded coordinator retry

**Files:**
- Modify: `src/game/application/generatePendingNarrativeScene.ts`
- Modify: `src/game/application/server/ai/runtimeNarrativeTaskCoordinator.ts`
- Test: `src/game/application/generatePendingNarrativeScene.test.ts`
- Test: `src/game/application/server/ai/runtimeNarrativeTaskCoordinator.test.ts`

**Interfaces:**
- `generatePendingNarrativeScene` still returns `"saved" | "not_pending" | "cleared" | "stale" | "unavailable"`.
- A stale scene may be rebased only when the latest save is still active, pending, scene-less, not in battle/ending, and at the same location; otherwise it returns `"stale"` without writing.
- `RuntimeNarrativeTaskCoordinator` retries a returned `"stale"` result at most twice with a new trace suffix, then returns the last result.

- [ ] **Step 1: Add failing tests for stale rebase and bounded retry.**

Create a repository fixture whose first scene CAS returns `STALE_GAME_REVISION`, then exposes a latest pending save with only `prologueShown`/revision changed; assert the generated scene is saved using the latest revision and latest state is preserved. Add a coordinator test where the injected run returns `"stale"` repeatedly and assert it runs no more than three times.

- [ ] **Step 2: Run the focused tests and verify they fail.**

Run:

```powershell
npm exec vitest run src/game/application/generatePendingNarrativeScene.test.ts src/game/application/server/ai/runtimeNarrativeTaskCoordinator.test.ts
```

Expected: the stale rebase test remains `"stale"` after the first CAS conflict and the coordinator calls its run only once.

- [ ] **Step 3: Implement rebase and bounded retry.**

After the normal scene save returns `STALE_GAME_REVISION`, reload the game. If the latest record still satisfies the pending/rebase guard, reconstruct the ledger, narrative idle/currentScene, and story memory from the latest state while retaining the generated scene; apply it with the latest revision. In `RuntimeNarrativeTaskCoordinator`, wrap `generatePendingNarrativeScene` in a loop with `MAX_STALE_RETRIES = 2`, retrying only `"stale"` and using `${traceId}-stale-retry-${attempt}`.

- [ ] **Step 4: Run the focused tests and verify they pass.**

Run the command from Step 2; expected PASS with no unbounded retry.

---

### Task 2: Add safe role-stage progress from the background task

**Files:**
- Modify: `src/game/application/orchestrateNarrativeScene.ts`
- Modify: `src/game/application/generatePendingNarrativeScene.ts`
- Modify: `src/game/application/server/ai/runtimeNarrativeTaskCoordinator.ts`
- Modify: `src/game/application/server/compositionRoot.ts`
- Modify: `src/game/application/gameSessionView.ts`
- Test: `src/game/application/orchestrateNarrativeScene.test.ts`
- Test: `src/game/application/server/ai/runtimeNarrativeTaskCoordinator.test.ts`
- Test: `src/game/application/gameSessionView.test.ts`

**Interfaces:**
- Internal progress: `{ completedCalls: number; totalCalls: 3; currentRole: "director" | "writer" | "npc"; attempt: number }`.
- `GeneratePendingNarrativeSceneDependencies.progressObserver` receives the game ID plus the internal progress and terminal status.
- `NarrativeGenerationView` exposes pending progress as `{ completedCalls, totalCalls, currentRole, attempt }`; ready remains `{ status: "ready" }`.

- [ ] **Step 1: Add failing tests for role progress and safe view projection.**

Use mock role sources to emit progress after director/writer/NPC requests and assert the observer receives bounded counts. Project a pending state with progress and assert the public view contains only the numeric count, role label, and attempt, while an idle/ready state contains no progress.

- [ ] **Step 2: Run the focused tests and verify they fail.**

Run:

```powershell
npm exec vitest run src/game/application/orchestrateNarrativeScene.test.ts src/game/application/gameSessionView.test.ts src/game/application/server/ai/runtimeNarrativeTaskCoordinator.test.ts
```

Expected: the new progress callbacks/types are absent or the projection is missing.

- [ ] **Step 3: Implement progress callbacks and server registry projection.**

Emit role progress only from the orchestrator, keep the registry keyed by game ID in the server composition root, pass the observer through the coordinator, and enrich only the active pending `GameSessionView`. Clear the registry when the task saves, clears, becomes stale/unavailable, or is no longer pending. Do not persist progress in `GameState`.

- [ ] **Step 4: Run the focused tests and verify they pass.**

Run the command from Step 2; expected PASS and no prompt/provider data in the view.

---

### Task 3: Render progress and stop polling on terminal/error states

**Files:**
- Modify: `src/components/NarrativeGenerationModal.tsx`
- Modify: `src/components/CurrentGameScreen.tsx`
- Test: `src/components/NarrativeGenerationModal.test.tsx`
- Test: `src/components/CurrentGameScreen.test.tsx`

**Interfaces:**
- The modal displays `已完成 N / 3 个角色 API 阶段` and the current role/attempt when pending progress exists; it keeps a deterministic fallback message when progress is absent.
- `CurrentGameScreen` polls current state while pending, performs an ensure at mount/transition and after an ensure failure, and stops scheduling once current is ready or the ensure endpoint reports unavailable.

- [ ] **Step 1: Add failing UI tests.**

Render the modal with `completedCalls=1`, `totalCalls=3`, `currentRole="writer"`, `attempt=1` and assert the count and role text. Mock current/ensure responses so a terminal ready view stops scheduling and a `503 unavailable` ensure response does not keep posting forever.

- [ ] **Step 2: Run the focused UI tests and verify they fail.**

Run:

```powershell
npm exec vitest run src/components/NarrativeGenerationModal.test.tsx src/components/CurrentGameScreen.test.tsx
```

Expected: the modal has no progress copy and the unavailable polling case continues scheduling.

- [ ] **Step 3: Implement the modal and polling state machine.**

Use the projected progress only for display; do not infer AI success from HTTP 200/202. Keep GET current polling separate from ensure retry, add a bounded backoff for ensure failures, and surface an unavailable status so the modal can stop waiting instead of silently looping forever.

- [ ] **Step 4: Run the focused UI tests and verify they pass.**

Run the command from Step 2; expected PASS with no timer/`act` warnings.

---

### Task 4: Update implementation facts and run acceptance checks

**Files:**
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/Agent文档索引.md`

- [ ] **Step 1: Document stale recovery, bounded retry, progress semantics, and polling behavior.**

Add a dated maintenance note stating that a prologue/CAS revision race rebases or retries instead of leaving pending, progress counts role stages rather than HTTP polling requests, and unavailable polling is terminal for the current UI session.

- [ ] **Step 2: Run all focused regression suites.**

Run the generator, coordinator, view, modal, shell, and current-game test files together; expected PASS.

- [ ] **Step 3: Run typecheck, lint, and fast gates.**

Run `npm run typecheck`, `npm run lint`, and `npm run test:fast`; expected no errors. Existing unrelated lint warnings may remain reported separately.

