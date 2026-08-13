# 下一幕任务交接与 NPC 对话状态修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 幕推进后明确告诉玩家下一项权威任务，不自动弹出新 NPC 对话，并让刚完成交谈的 NPC 退出焦点状态，避免重复出现同一组支持/质疑选项或再次触发同一幕推进。

**Architecture:** 保持规则层产生 `ObjectiveTransition`、世界演化具象化下一幕任务的单一路径；在场景审批共用的事件派生处把 `advanced_act` 视为任务交接场景，而不是继续沿用上一回合的 dialogue 焦点。UI 只根据权威目标变化展示“下一步”提示，提交/生成期间关闭旧对话，不再把“新增 NPC”推断为“应自动打开”。

**Tech Stack:** TypeScript, React, Next.js, Vitest, SQLite 结构化存档。

## Root-cause snapshot

- 最新存档 revision 5 / turn 2 已处于第 2 幕，活动任务目标是“与传讯人交谈”，传讯人 `met=false`。
- 同一存档的 ready scene 却仍是 `event.kind=dialogue`、`focusNpcId=npc_0（邵叔）`，并再次铸造“表示愿意支持邵叔 / 质疑邵叔的说法”。
- `LocationSceneScreen` 在 pending 从 true 变为 false 时会寻找新增 `npcId` 并自动打开，因而直接弹出传讯人。
- 行动成功反馈只把 `Action performed` 翻译成“行动已完成”，没有在后台具象化出新目标后提示权威下一步。

---

### Task 1: Freeze the next-act handoff semantics with failing application tests

**Files:**
- Modify: `src/game/application/deterministicSceneSource.test.ts`
- Modify: `src/game/application/testing/dynamicMaterializationJourney.test.ts`

- [x] **Step 1: Add a focused `advanced_act` event test**

Build a context whose completed action is a talk with 邵叔, whose objective transition is `advanced_act`, and whose current objective target is 传讯人. Assert `buildEventState` returns `observe`, selectable choices include the objective-target talk action, and no choice is a second support/challenge action for 邵叔.

- [x] **Step 2: Add the persisted journey assertion**

After the opening NPC completes act 1 and world evolution materializes the next objective NPC, assert the written scene is not a dialogue focused on the opening NPC, the HUD objective names the new NPC, and the approved choices include the new objective NPC talk entry.

- [x] **Step 3: Run tests and verify they fail for the current implementation**

Run: `npm run test:game-application -- src/game/application/deterministicSceneSource.test.ts src/game/application/testing/dynamicMaterializationJourney.test.ts`

Expected: FAIL because every dialogue resolved event currently reuses `job.focusNpcId` even when the act advanced.

---

### Task 2: Make act advancement a task-handoff scene

**Files:**
- Modify: `src/game/application/deterministicSceneSource.ts`
- Modify: `src/game/application/deterministicSceneSource.test.ts`
- Modify: `src/game/application/testing/dynamicMaterializationJourney.test.ts`

- [x] **Step 1: Change the shared event derivation**

When `context.objectiveTransition.mode === "advanced_act"`, derive an `observe` event at the current location before considering the prior resolved event kind. This shared helper is consumed by deterministic generation and approval, so generated and fallback scenes follow the same invariant.

- [x] **Step 2: Let general legal candidates drive the handoff choices**

Because the event is no longer a dialogue scene, select from legal action candidates and prioritize the new objective target. The old NPC remains available through a normal “与 NPC 交谈” entry but receives no focus-only support/challenge controls.

- [x] **Step 3: Run focused application tests**

Run: `npm run test:game-application -- src/game/application/deterministicSceneSource.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/testing/dynamicMaterializationJourney.test.ts`

Expected: PASS.

---

### Task 3: Remove implicit modal navigation and show the authoritative next task

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx`
- Modify: `src/components/AdventureGameShell.tsx`
- Modify: `src/components/AdventureGameShell.test.tsx`

- [x] **Step 1: Add failing UI state-transition tests**

Cover a pending → ready rerender that introduces 传讯人 and assert no NPC dialog opens automatically. Cover submitting an existing NPC choice and assert the old dialog closes. Cover a later ready view whose objective changed to “与传讯人交谈” and assert a status toast says “下一步：与传讯人交谈”.

- [x] **Step 2: Delete the new-NPC auto-open heuristic**

Remove `prevNpcIdsRef`/`prevPendingRef` and the effect that turns an entity-list diff into UI navigation. Close any open dialog whenever a formal dialog interaction is submitted or the view enters pending.

- [x] **Step 3: Add objective-change feedback**

Track the previous `view.story.currentObjectiveLabel`. When a ready snapshot exposes a different non-null authoritative objective, replace the generic success feedback with `下一步：<目标>`; do not infer a task from narration, NPC names, or button labels.

- [x] **Step 4: Run component tests**

Run: `npm run test:components -- src/components/AdventureGameShell.test.tsx src/components/GenerationStatusModal.test.tsx`

Expected: PASS.

---

### Task 4: Update implementation facts and run acceptance gates

**Files:**
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/Agent文档索引.md`

- [x] **Step 1: Document the handoff invariant**

Record that an act-advanced scene is a non-dialogue handoff, the previous NPC cannot remain focus, new NPC materialization never drives modal navigation, and UI next-step feedback comes from `currentObjectiveLabel`.

- [x] **Step 2: Run focused and minimum gates**

Run: `npm run test:game-application -- src/game/application/deterministicSceneSource.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/testing/dynamicMaterializationJourney.test.ts && npm run test:components -- src/components/AdventureGameShell.test.tsx && npm run test:boundaries && npm run typecheck`

Expected: every command exits zero.

- [x] **Step 3: Run full regression and inspect the diff**

Run: `npm test` and `git diff --check`.

Expected: all tests pass; no whitespace errors; latest-save behavior is covered without mutating the save.
