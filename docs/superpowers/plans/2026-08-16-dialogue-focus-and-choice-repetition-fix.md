# Dialogue Focus and Choice Repetition Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a completed NPC conversation from reopening the same support/challenge pair and make deterministic/live-repair dialogue choices vary from the current NPC context and interaction history.

**Architecture:** Keep the authoritative objective and scene-focus decision in the application read model. A dialogue scene remains a two-choice focus only while its NPC is the current talk objective or the story is explicitly ready for an ending decision; otherwise it is projected as a normal ask entry. Centralize deterministic dialogue-choice copy in a context-aware pure function that uses role, structured history, objective context, and scene identity as variation inputs. The live partial-repair path reuses this contextual fallback without changing NPC names or applying name blacklists.

**Tech Stack:** TypeScript, Vitest, SQLite-backed `WorldState`/`StoryState`, application read model, live scene source with deterministic fallback.

## Global Constraints

- Fixed choices remain server-issued opaque tokens and continue through the existing `performTurn`/CAS path.
- NPC names are never blocked, corrected, or replaced; variation comes from state and context.
- AI proposes presentation only; objective progression, legal actions, and NPC knowledge remain rule-controlled.
- Every changed production module keeps its existing application/domain boundary and receives focused regression coverage.
- Run `npm run typecheck`, affected Vitest suites, `npm run test:boundaries`, and `git diff --check` before handoff.

---

### Task 1: Reproduce the stale-focus loop at the read-model boundary

**Files:**
- Modify: `src/game/application/gameSessionView.test.ts`
- Reference: `src/game/application/gameSessionView.ts:436-489`

**Interfaces:**
- Consumes: a ready dialogue scene with two approved choices targeting one NPC while the authoritative objective has advanced to a non-dialogue objective.
- Produces: a failing regression proving the old NPC must not retain two support/challenge choices after the talk objective is satisfied.

- [ ] **Step 1: Add the failing regression**

Use the existing stale-focus fixtures. Set the reveal cursor/current objective to the item objective after the NPC talk objective, keep the scene event focused on that same NPC, and set the NPC to `met: true`. Assert that the NPC view has `freeInputEnabled === false`, exactly one ordinary ask choice, and no two-choice focus pair.

- [ ] **Step 2: Run the focused test and verify it fails**

```powershell
npm exec vitest run src/game/application/gameSessionView.test.ts -t "completed talk focus"
```

Expected: FAIL because the current projection preserves the same NPC as a two-choice focus whenever the persisted scene event is dialogue.

### Task 2: Close a completed dialogue focus without blocking explicit re-entry

**Files:**
- Modify: `src/game/application/gameSessionView.ts:436-489`
- Test: `src/game/application/gameSessionView.test.ts`

**Interfaces:**
- Consumes: `currentObjectiveNpcId`, `pairedDialogueNpcId`, `scene.event`, `storyState.endingAllowed`, and `storyState.evolution.status`.
- Produces: a focus-validity rule that retains two-choice dialogue only for the current talk objective or an explicit ending decision; otherwise the NPC becomes a normal one-choice ask entry.

- [ ] **Step 1: Add the focus-validity rule**

Treat a persisted pair as active only when `currentObjectiveNpcId` equals the persisted focus NPC, or when `storyState.endingAllowed === true` or `storyState.evolution.status === "needs_ending_pair"`. If the objective is an item, fact, location, or enemy objective, mark the old dialogue focus stale even when the NPC remains mechanically talkable because it was previously released.

- [ ] **Step 2: Preserve response text while demoting old choices**

Keep the current `npcLine` and speech pages available for the immediate response, but set the projected `focusNpcId` to `null` for a stale focus. The existing fallback talk choice then becomes the only way to deliberately start another conversation.

- [ ] **Step 3: Run the focused regression and existing handoff/ending tests**

```powershell
npm exec vitest run src/game/application/gameSessionView.test.ts
```

Expected: PASS.

### Task 3: Make deterministic dialogue choices context-aware

**Files:**
- Modify: `src/game/application/deterministicSceneSource.ts:54-115,300-317`
- Test: `src/game/application/deterministicSceneSource.test.ts`

**Interfaces:**
- Consumes: `SceneGenerationContext`, including `job`, `focusNpcContext`, `objectiveTarget`, current location, and approved candidate actions.
- Produces: stable but varied support/challenge labels for the same NPC across different dialogue turns, without NPC-name correction.

- [ ] **Step 1: Add the failing variation test**

Create two contexts for the same “旧案传讯人” NPC with different `job.actionId`/turn and structured recent interaction state. Assert that both pairs target support/challenge, but the support and challenge labels are not identical across the two contexts.

- [ ] **Step 2: Implement a pure deterministic variation selector**

Replace the role-only dialogue label helper with a context-based helper. Select from role-appropriate variants using a deterministic hash of `job.actionId`, `job.turnNumber`, NPC ID/role, latest structured dialogue act, objective entity ID, and current scene context. Use role and approved fact/topic categories only for wording; never blacklist or rewrite `npc.name`, and never include hidden fact text.

- [ ] **Step 3: Preserve action semantics and replay determinism**

Keep support/challenge actions, candidate IDs, semantic validation, and opaque token derivation unchanged. Identical contexts must still produce identical labels; changed turns or structured context must be able to produce a different pair.

- [ ] **Step 4: Run deterministic scene tests**

```powershell
npm exec vitest run src/game/application/deterministicSceneSource.test.ts
```

Expected: PASS, including existing deterministic replay tests.

### Task 4: Ensure live partial repair inherits contextual choice variation

**Files:**
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts:275-300`
- Test: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`

**Interfaces:**
- Consumes: the contextual deterministic scene source from Task 3.
- Produces: partial live repair output whose fallback choices vary with current scene context instead of repeating the role-only pair.

- [ ] **Step 1: Add the failing partial-repair regression**

Use the existing `npc_line_only` fixture twice with the same NPC role but different job/context identity. Assert that both proposals preserve the live NPC line and that their choice labels differ.

- [ ] **Step 2: Route repair through the contextual deterministic source**

Keep the existing behavior of preserving a valid live `npcLine`, but ensure the deterministic proposal used for repair is the Task 3 context-aware output. Do not reuse a prior scene’s labels merely because the AI response was partial.

- [ ] **Step 3: Retain provenance logging**

Keep `scene_generation_repaired` logging so mixed results remain observable; do not solve repetition by pretending fallback choices were fully AI-generated.

- [ ] **Step 4: Run live-source tests**

```powershell
npm exec vitest run src/game/application/server/ai/liveScenePerformanceSource.test.ts
```

Expected: PASS, including invalid JSON, partial repair, and fallback behavior.

### Task 5: Document the completed-focus and variation contract

**Files:**
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`

- [ ] **Step 1: Record the read-model rule**

State that after a talk objective is satisfied, the previous NPC remains readable for the immediate response but loses automatic support/challenge choices when the authoritative next objective is not another talk objective.

- [ ] **Step 2: Record the fallback variation rule**

State that deterministic and live-partial-repair choice copy derives from structured context/history and is not keyed only by NPC role or corrected by NPC name.

### Task 6: Run the complete verification gate

**Files:**
- No additional production files.

- [ ] **Step 1: Run affected tests**

```powershell
npm exec vitest run src/game/application/gameSessionView.test.ts src/game/application/deterministicSceneSource.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts
```

- [ ] **Step 2: Run type and boundary checks**

```powershell
npm run typecheck
npm run test:boundaries
```

- [ ] **Step 3: Run the full test suite**

```powershell
npm test -- --run --maxWorkers=1
```

- [ ] **Step 4: Check the diff**

```powershell
git diff --check
```

Expected: all commands pass, with no NPC-name correction logic and no repeated support/challenge pair after the current objective leaves the talk phase.
