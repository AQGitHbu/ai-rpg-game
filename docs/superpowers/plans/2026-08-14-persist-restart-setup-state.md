# Persist Restart Setup State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the new-game setup screen visible after a player chooses “重新开始” and refreshes the page, while preserving the existing ended-save CAS validation when the replacement game is submitted.

**Architecture:** Store only the opaque ending identity and expected revision in `sessionStorage`, because the restart form is a browser-session UI intent rather than a new server-side game state. On every current-game response, restore the setup screen only when that marker matches the current ended view; otherwise remove stale storage and render the authoritative server result. Clear the marker after a successful replacement-game creation.

**Tech Stack:** React client component, TypeScript, Vitest, Testing Library, Next.js App Router.

## Global Constraints

- Modify only `ai-rpg-game` and do not change `.foundation`, `ai-game-foundation`, or shared foundation documents.
- Preserve the canonical `/api/game` restart payload `{ identity, expectedRevision }` and the server-side replacement CAS.
- Do not delete the ended save when the player only opens the setup form; the save remains protected until the new game is submitted.
- Use `sessionStorage` only in client-side code and tolerate unavailable or malformed browser storage without blocking the page.
- Run the affected component tests, typecheck, and relevant fast checks before handoff.

---

### Task 1: Persist and restore the restart-form UI intent

**Files:**
- Modify: `src/components/CurrentGameScreen.tsx`
- Test: `src/components/CurrentGameScreen.test.tsx`

**Interfaces:**
- Add a private browser-session marker with `{ identity: string; expectedRevision: number }`.
- `CurrentGameScreen` continues to pass the same `restart` prop to `NewGameSetupForm`; no API or application types change.

- [ ] **Step 1: Add a failing refresh regression test**

Extend the ending-restart tests to:

1. Render an ended view and click “重新开始”.
2. Unmount the component, render it again with the same ended current-game response, and assert the setup heading is shown instead of the ending region.
3. Add a stale-marker case that seeds a different identity/revision and asserts the ending region remains authoritative.

Expected initial result: the refresh regression fails because the second mount has no restart marker and renders the ending panel.

- [ ] **Step 2: Implement safe session marker helpers**

In `CurrentGameScreen.tsx`, define a private storage key and helpers that:

- serialize only `identity` and integer `expectedRevision`;
- read and validate the object shape before use;
- remove malformed or stale markers;
- catch `sessionStorage` access errors so private-mode/browser restrictions fall back to the server-rendered ending.

- [ ] **Step 3: Restore matching restart state and clear it after creation**

When the current response is an ended active view, compare its `ending.restartIdentity` and response revision with the stored marker. If both match, set `phase: "restart"`; otherwise clear the marker and keep `phase: "active"`.

When “重新开始” is clicked, write the marker before setting `phase: "restart"`. When `handleCreated` runs after a successful POST, remove the marker before reloading the current game.

- [ ] **Step 4: Run the focused tests**

Run:

```text
npm run test:components -- src/components/CurrentGameScreen.test.tsx
```

Expected: the refresh and stale-marker tests pass, and all existing `CurrentGameScreen` tests remain green.

### Task 2: Verify the affected application boundary

**Files:**
- No additional production files.

- [ ] **Step 1: Run type and component checks**

Run:

```text
npm run typecheck
npm run test:components
npm run test:boundaries
```

Expected: all commands pass without API or dependency-boundary changes.

- [ ] **Step 2: Inspect the final diff and confirm scope**

Run:

```text
git diff --check
git status --short
```

Expected: only the restart UI component, its regression test, and this plan are changed in `real-browser-playtest`.
