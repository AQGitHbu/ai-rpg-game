# P0 Atomic Narrative Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将运行时叙事从“两个合法动作包装成对白”改为“一次只生成一个原子事件”，并让对白选项真正进入 NPC 对话回合，同时按事件需要懒生成调查事实、物品和敌人。

**Architecture:** 在 domain 增加事件类型与对白响应选择的结构化契约；导演只确定一个事件及其授权目标，编剧负责场景表现和对白响应，NPC 演员接收玩家本轮话语后生成回应。规则层继续独占状态写入，application 负责事件编排与 CAS，read model 在原子事件进行中隐藏无关场景动作。运行时扩展通过独立审批和编译器按需追加 fact/item/enemy，并将新资源绑定到当前地点/事件。

**Tech Stack:** TypeScript, React 19, Vitest, SQLite CAS repository, existing three-role runtime narrative sources.

## Global Constraints

- 规则负责裁决，AI 只返回结构化候选；AI 不得直接写入 `GameState`、`eventLedger` 或规则结果。
- 客户端只提交 `choiceToken + revision`；不得暴露 `actionKey`、事实 ID、导演计划或生成诊断。
- 运行时生成必须遵守现有 domain → gameplay → application 边界，不修改 foundation/shared package。
- CAS 冲突丢弃本次生成结果，不重复写入剧情记忆或蓝图。
- 旧存档中的缺省叙事字段必须安全读取；旧的 `narrative_choice` 事件保持只读兼容。

---

### Task 1: 建立原子叙事事件和对白响应契约

**Files:**
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/domain/events.ts`
- Modify: `src/game/gameplay/rpg/narrative/types.ts`
- Modify: `src/game/gameplay/rpg/narrative/approveDirectorProposal.ts`
- Modify: `src/game/gameplay/rpg/narrative/approveSceneScript.ts`
- Test: `src/game/domain/narrative.test.ts`
- Test: `src/game/gameplay/rpg/narrative/approveDirectorProposal.test.ts`
- Test: `src/game/gameplay/rpg/narrative/approveSceneScript.test.ts`

**Interfaces:**
- `NarrativeEventKind = "dialogue" | "investigate" | "item" | "battle" | "travel" | "observe"`.
- `NarrativeEventState = { kind, focusNpcId?, factId?, itemId?, enemyId?, locationId? }` with at most one target matching `kind`.
- `NarrativeChoiceState` gains `choiceKind: "dialogue_response" | "world_action"` and optional `dialogueIntent`; world choices retain `actionKey`.
- `DirectorProposal` gains optional `eventKind` and target ID fields for backwards-compatible fixtures; approval returns a normalized event kind.
- `NarrativeTriggerContext` gains `initial_opening` and `dialogue_response`, preserving existing `talk`, `free_input`, and follow-up variants.

- [ ] **Step 1: Add the discriminated event and choice types, keeping old fields optional for old saves.**
- [ ] **Step 2: Add `dialogue_response` and `narrative_dialogue_choice` event shapes without removing the old event.**
- [ ] **Step 3: Make director approval infer a dialogue event for `initial_opening`/`talk` with a present focus NPC, otherwise validate the declared event target.**
- [ ] **Step 4: Make writer approval accept dialogue choices without rule action keys, while continuing to validate two legal world-action choices.**
- [ ] **Step 5: Add unit tests for dialogue choice approval, event target validation, and legacy world-action fixtures.**
- [ ] **Step 6: Run `npm run test:game-domain` and the two narrative approval test files.**

### Task 2: Rewire director → writer → NPC around one event

**Files:**
- Modify: `src/game/application/createGame.ts`
- Modify: `src/game/application/runtimeNarrativeContexts.ts`
- Modify: `src/game/application/orchestrateNarrativeScene.ts`
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.ts`
- Modify: `src/game/application/internal/runtimeNarrativeFallbacks.ts`
- Test: `src/game/application/orchestrateNarrativeScene.test.ts`
- Test: `src/game/application/runtimeNarrativeContexts.test.ts`
- Test: `src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts`

**Interfaces:**
- Initial pending state carries `triggerContext: { kind: "initial_opening"; npcId }`.
- `DirectorContext` exposes the safe trigger context and one-event contract.
- `NpcLineContext` exposes `playerMessage` when the current trigger is a dialogue response/free input.
- `orchestrateNarrativeScene` persists `scene.event`; dialogue scenes persist writer labels as `dialogue_response` choices with semantic intent, while world events persist rule-bound choices.

- [ ] **Step 1: Add initial trigger context and project pending dialogue input into NPC context only for the addressed NPC.**
- [ ] **Step 2: Update director and writer prompts to select one event and produce actual conversational response labels for dialogue scenes.**
- [ ] **Step 3: Normalize old fixtures to a dialogue event when the trigger is an opening/talk and keep action candidates available only as world-event routes.**
- [ ] **Step 4: Build fallback dialogue choices such as asking the situation and challenging the recent repair, never `talk:`/`investigate:` labels.**
- [ ] **Step 5: Add orchestration tests asserting one event and actual dialogue labels.**
- [ ] **Step 6: Run the focused application and live-source tests.**

### Task 3: Execute dialogue responses and make the active event exclusive

**Files:**
- Modify: `src/game/application/performAction.ts`
- Modify: `src/game/application/handleNpcDialogue.ts`
- Modify: `src/game/application/locationAdventureView.ts`
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/components/AdventureGameShell.tsx`
- Modify: `src/components/NpcDialoguePanel.tsx`
- Modify: `src/components/LocationSceneScreen.tsx`
- Test: `src/game/application/performAction.test.ts`
- Test: `src/game/application/locationAdventureView.test.ts`
- Test: `src/game/application/gameSessionView.test.ts`
- Test: `src/components/NpcDialoguePanel.test.tsx`
- Test: `src/components/AdventureGameShell.test.tsx`

**Interfaces:**
- A `dialogue_response` choice is resolved by token to a pending next scene and never passed to `findAvailableActionByKey`.
- A pending or ready atomic narrative event returns no unrelated observe/investigate/item/battle hotspots.
- `NarrativeSceneView.eventKind` is safe UI metadata; IDs remain server-only.

- [ ] **Step 1: Add the dialogue-response branch in `performAction` with a structured trigger context and audit event.**
- [ ] **Step 2: Preserve world-action routing and add the previous selected dialogue intent to the next pending generation.**
- [ ] **Step 3: Filter `locationScene.interactions` and scene NPCs while an event is pending/active; keep only the focus NPC for dialogue events.**
- [ ] **Step 4: Render the generated focus NPC dialogue as the single active interaction and keep review clues read-only.**
- [ ] **Step 5: Add regression tests for no parallel hotspots and dialogue response pending transitions.**
- [ ] **Step 6: Run `npm run test:game-application` and `npm run test:components`.**

### Task 4: Add event-scoped lazy fact/item/enemy expansion

**Files:**
- Modify: `src/game/gameplay/rpg/narrative/types.ts`
- Modify: `src/game/gameplay/rpg/narrative/approveBlueprintExpansion.ts`
- Modify: `src/game/gameplay/rpg/narrative/compileBlueprintExpansion.ts`
- Modify: `src/game/application/orchestrateNarrativeScene.ts`
- Modify: `src/game/application/generatePendingNarrativeScene.ts`
- Modify: `src/game/gameplay/rpg/actions/index.ts`
- Modify: `src/game/gameplay/rpg/actions/validateIntent.ts`
- Modify: `src/game/gameplay/rpg/actions/resolveAction.ts`
- Test: `src/game/gameplay/rpg/narrative/approveBlueprintExpansion.test.ts`
- Test: `src/game/gameplay/rpg/narrative/compileBlueprintExpansion.test.ts`
- Test: `src/game/gameplay/rpg/actions/index.test.ts`

**Interfaces:**
- Expansion approval permits at most one event-scoped `newFact`, `newItem`, or `newEnemy` per scene, subject to existing budget and reference gates.
- Fact expansion appends an undiscovered world fact and binds it to the active scene; item expansion appends one item and binds it to the current location; enemy expansion appends one enemy at the current location and can only be started by the matching approved event.
- IDs are minted server-side; AI-supplied IDs are never persisted.

- [ ] **Step 1: Add proposal and approval shapes for one fact/item/enemy, including length, stat, location, and budget checks.**
- [ ] **Step 2: Compile the approved resource into blueprint and state in the same CAS boundary as the generated scene.**
- [ ] **Step 3: Expose only the newly authorized resource as the next event target; do not add all future facts/items/enemies to generic action projection.**
- [ ] **Step 4: Add tests proving one-resource expansion, server-minted IDs, and no unrelated resource leakage.**
- [ ] **Step 5: Run gameplay narrative/action tests and the Phase 14 regression suite.**

### Task 5: Update implementation documentation and run acceptance gates

**Files:**
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `docs/Agent文档索引.md`

- [ ] **Step 1: Document the atomic event contract and the split between dialogue responses and world actions.**
- [ ] **Step 2: Document event-exclusive read-model behavior and lazy resource ownership.**
- [ ] **Step 3: Run `npm run lint`, `npm run typecheck`, `npm run test:fast`, `npm run test`, and `npm run build`.**
- [ ] **Step 4: Record any pre-existing failures separately from failures introduced by this change.**
