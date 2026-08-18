# Natural Dialogue Choice Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NPC response options story-continuous without hard-coded keyword classification: ground them in the active quest, NPC speakable facts, structured dialogue history, and approved fact references. Keep player dialogue direct and visible actions executable/parenthesized.

**Architecture:** Carry the current NPC line as a structured projection (`text` plus `usedFactIds`), while choice grounding comes from the active quest, NPC speakable facts, and structured dialogue history rather than scanning prose or role names. Live AI may phrase talk labels naturally, but the server still owns candidate IDs/actions and applies the direct-speech/action formatter at approval. Deterministic and partial-live fallback share the same structured policy.

**Tech Stack:** TypeScript, Vitest, Next.js, SQLite-backed game state.

## Global Constraints

- Historical dialogue remains in the NPC generation context for continuity.
- Talk choices must remain exactly two distinct opaque-token actions.
- Current NPC text may be displayed and used for continuity, but must not be classified with hard-coded topic keywords or copied verbatim into either choice.
- Candidate IDs/actions remain server-authoritative; no client-side action parsing is introduced.
- Action wording is presentation only: battle effects come from the server-side `Action`, never from parsing the visible parentheses.

---

### Task 1: Lock the regression at the deterministic candidate boundary

**Files:**
- Modify: `src/game/application/deterministicSceneSource.test.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- Modify: `src/game/application/approveAndWriteScene.test.ts`

**Interfaces:**
- Consumes: `buildSelectableSceneCandidates(context, currentNpcLine?)`, `parseScenePerformanceJson`, and `approveScenePerformance`.
- Produces: tests proving a line about directions/messages yields natural follow-ups without copying the line or its tail, and that the current line still wins over `previousDialogue`.

- [x] **Step 1: Replace the old tail-quote assertions**

Use a current line with multiple unrelated cues and assert that both labels omit the full line and that changing only the prose/role does not select a hard-coded category; structured fact cards and dialogue history should determine the fallback pair.

- [x] **Step 2: Run the focused tests and verify they fail**

Run:

```powershell
npm exec vitest run src/game/application/deterministicSceneSource.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/approveAndWriteScene.test.ts
```

Expected: the old implementation failed because it guessed a category from NPC prose and replaced story context with fixed templates.

### Task 2: Replace prose keyword matching with structured story grounding

**Files:**
- Modify: `src/game/application/deterministicSceneSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts` only if parser comments/tests need alignment
- Modify: `src/game/application/approveAndWriteScene.ts` only if approval comments/tests need alignment

**Interfaces:**
- Consumes: the active quest summary, focus NPC fact cards, structured previous dialogue, and an optional current-line fact-reference projection.
- Produces: the existing `SceneChoiceCandidate` actions plus deterministic fallback labels; live labels can be generated from the same context without changing candidate authority.

- [x] **Step 1: Remove hard-coded cue selection**

Remove the `dialogueChoiceGuidance` keyword classifier and role-name branches from talk choice generation. Use structured priority instead: previous `dialogueAct`, current-line `usedFactIds`/focus speakable facts, active quest summary, then a generic evidence-oriented pair.

```ts
support: "请把你刚才提到的这条线索的来历、时间和地点说清楚，我好按眼前的主线核对。"
challenge: "这条线索还不能直接下结论；哪一件原始证物能把它和眼前的主线联系起来？"
```

For a live scene, prompt the model with the active quest and fact cards and allow it to turn the same grounding into natural direct player speech. Candidate IDs/actions remain server-owned.

- [x] **Step 2: Preserve structured history precedence**

Keep the previous `dialogueAct/topic` ahead of the fact pool for subsequent turns; pass the current NPC line's `usedFactIds` when available so fallback labels never infer a topic from stale prose.

- [x] **Step 3: Run the focused tests and verify they pass**

Run the Task 1 command and confirm all deterministic, live-parser, and approval tests pass.

### Task 3: Update documentation and validate the live path

**Files:**
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `src/game/application/deterministicSceneSource.test.ts` if final copy contracts need exact regression coverage

**Interfaces:**
- Consumes: the semantic cue policy from Task 2.
- Produces: documented behavior and verified build/runtime behavior.

- [x] **Step 1: Document that current NPC text is semantic context, not quoted option copy**

State that generated scenes may still use deterministic server-authoritative candidate labels, but those labels must ask for a next checkable detail and may not echo the current NPC line.

- [x] **Step 2: Run quality gates**

```powershell
npm run typecheck
npm run lint
npm test -- --run
git diff --check
```

- [x] **Step 3: Start an isolated fresh game and verify one dialogue turn**

Use a separate database/port if the user’s 3000 service has an active save. Confirm the new scene reports two options whose labels do not contain the NPC line or its final 14-character tail, then select one option and confirm the next NPC line produces another semantically relevant pair.
