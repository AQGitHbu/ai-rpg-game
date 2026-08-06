# Progressive Generation Stall and Dialogue UI Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure runtime narrative generation reaches a terminal scene state after an unexpected task failure, keep ready narrative behind the map/location navigation, and expose two valid fallback dialogue responses for the focused NPC.

**Architecture:** Keep the existing pending/ensure/CAS contract. Make the application generation boundary convert unexpected orchestration failures into a deterministic fallback scene and persist it; the coordinator remains a non-blocking trigger. Production initial opening uses one bounded role attempt to avoid repeating the same provider/schema failure for minutes, while later scenes retain the existing retry budget. Make the UI overlay depend on explicit local scene navigation, while the read model treats a fallback dialogue scene as containing its focused NPC even when legacy/fallback state lacks `npcDialogues`.

**Tech Stack:** TypeScript, Next.js/React, Vitest, SQLite repository/CAS.

## Global Constraints

- Do not modify `../ai-game-foundation`, `.foundation`, or any `@ai-game/*` package.
- Preserve existing staged user changes in this worktree; edit only the files needed for this fix.
- AI output remains untrusted; fallback content must be deterministic and genre-neutral or derived from the current NPC/action labels.
- Narrative choice writes must continue through the existing `narrative_choice` application path and CAS semantics.
- Run the focused component/application tests, then `npm run typecheck` and the relevant fast checks.

---

### Task 1: Make unexpected narrative task failures terminal

**Files:**
- Modify: `src/game/application/generatePendingNarrativeScene.ts`
- Modify: `src/game/application/orchestrateNarrativeScene.ts`
- Test: `src/game/application/generatePendingNarrativeScene.test.ts`
- Test: `src/game/application/orchestrateNarrativeScene.test.ts`

**Interfaces:**
- `generatePendingNarrativeScene` continues to return `saved | not_pending | cleared | stale | unavailable`.
- `orchestrateNarrativeScene` exposes or reuses a deterministic fallback builder that can construct a valid two-choice scene from the current state and legal action candidates when orchestration throws.

- [x] **Step 1: Add a failing regression test for an orchestration exception.**

  Inject a runtime source/repository fixture that causes the generation boundary to throw, then assert that the repository receives one CAS write with `narrative.currentScene.source === "fallback"` and `narrative.generation.status === "idle"`.

- [x] **Step 2: Run the focused test and verify it fails.**

  Run `npm exec vitest run src/game/application/generatePendingNarrativeScene.test.ts`; expected result is a failure because the thrown generation currently escapes to the coordinator and leaves `pending` unchanged.

- [x] **Step 3: Implement deterministic fallback recovery at the application boundary.**

  Catch unexpected orchestration errors after the pending eligibility check, construct the same controlled fallback shape used by normal source/approval exhaustion, append the normal `narrative_scene_presented` event, reduce story memory, and CAS-write `currentScene` plus `generation: { status: "idle" }`. Return `"saved"` when that CAS succeeds, `"stale"` for a revision conflict, and `"unavailable"` only when persistence itself cannot be completed.

- [x] **Step 4: Run the focused tests and verify they pass.**

  Run `npm exec vitest run src/game/application/generatePendingNarrativeScene.test.ts src/game/application/orchestrateNarrativeScene.test.ts`; expected result is PASS, including the existing normal fallback tests.

### Task 2: Keep ready dialogue behind map → location → NPC navigation

**Files:**
- Modify: `src/components/AdventureGameShell.tsx`
- Test: `src/components/AdventureGameShell.test.tsx`

**Interfaces:**
- `activeDialogue` is opened only by an explicit NPC/building interaction while the shell is in the location/town scene context.
- A ready `view.narrative.eventKind === "dialogue"` does not mutate local `screen` or automatically open an overlay.

- [x] **Step 1: Add a failing UI test.**

  Render a ready dialogue view with `narrative.currentScene` and assert that the initial shell shows the map button, does not show the NPC dialogue dialog, then after clicking the current-location entry and the NPC hotspot it shows the dialogue dialog.

- [x] **Step 2: Run the focused component test and verify it fails.**

  Run `npm exec vitest run src/components/AdventureGameShell.test.tsx`; expected failure is that the dialog is present before the map/location/NPC clicks.

- [x] **Step 3: Remove the automatic ready-dialogue selection path.**

  Keep `selectedDialogue` as the only source for `activeDialogue`; preserve pending modal behavior and world-event overlays, and leave the existing explicit `onOpenDialogue`/`handleEnterBuilding` callbacks unchanged.

- [x] **Step 4: Run the focused component test and verify it passes.**

  Run `npm exec vitest run src/components/AdventureGameShell.test.tsx`; expected result is PASS.

### Task 3: Project fallback dialogue choices and correct fallback copy

**Files:**
- Modify: `src/game/application/orchestrateNarrativeScene.ts`
- Modify: `src/game/application/locationAdventureView.ts`
- Test: `src/game/application/locationAdventureView.test.ts`
- Test: `src/game/application/orchestrateNarrativeScene.test.ts`

**Interfaces:**
- Every fallback dialogue scene has two `choiceKind: "dialogue_response"` choices with valid `dialogueIntent` values.
- `projectDialogues` includes the event focus NPC in the scene even if `npcDialogues` is absent, so those two choices reach `NpcDialoguePanel`.

- [x] **Step 1: Add failing projection and fallback tests.**

  Build a dialogue fallback scene with `event.focusNpcId`, two dialogue choices, and no `npcDialogues`; assert that the focused NPC view has exactly two choices. Assert that fallback labels do not contain the unrelated “太空站” wording and remain valid for a government-office NPC.

- [x] **Step 2: Run the focused application tests and verify they fail.**

  Run `npm exec vitest run src/game/application/locationAdventureView.test.ts src/game/application/orchestrateNarrativeScene.test.ts`; expected failure is zero projected choices and the hardcoded wrong fallback label.

- [x] **Step 3: Implement the minimal fallback/read-model fix.**

  In the fallback builder, derive the focused NPC from the resolved dialogue event and add a deterministic `npcDialogues` entry with a safe composed speech page when no generated line exists. Replace the hardcoded genre-specific second label with a neutral response such as “追问这件事的具体缘由”. In the projection, use the dialogue event focus as the authoritative in-scene NPC and allow its current scene choices through even when the optional `npcDialogues` array is absent.

- [x] **Step 4: Run the focused application tests and verify they pass.**

  Run `npm exec vitest run src/game/application/locationAdventureView.test.ts src/game/application/orchestrateNarrativeScene.test.ts`; expected result is PASS.

### Task 4: Update implementation facts and run acceptance checks

**Files:**
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/Agent文档索引.md`

- [x] **Step 1: Document the terminal failure recovery and navigation/fallback behavior.**

  Add a dated maintenance note stating that unexpected pending-task failures now persist deterministic fallback/idle when CAS is available, ready narrative never auto-opens an NPC overlay from the map layer, and fallback dialogue always supplies two visible responses for its focus NPC.

- [x] **Step 2: Run all focused regression suites.**

  Run `npm exec vitest run src/components/AdventureGameShell.test.tsx src/game/application/generatePendingNarrativeScene.test.ts src/game/application/locationAdventureView.test.ts src/game/application/orchestrateNarrativeScene.test.ts`; expected result is PASS.

- [x] **Step 3: Run typecheck and relevant fast gates.**

  Run `npm run typecheck` and `npm run test:fast`; expected result is PASS, with any pre-existing unrelated failures reported separately.
