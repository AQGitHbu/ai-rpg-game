# Narrative Flow Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复“当前目标与赵文远交谈，却把同一 API 返回的非焦点闲聊当成正式对白”的故障，并把 NPC 对话入口、AI 响应用途和剧情可继续性固化为可执行契约。

**Architecture:** `NarrativeSceneState.npcDialogues` 为每条持久化台词记录显式 `speechPurpose`（`focus` 或 `ambient`），审批写回不再只保存文本来源。`gameSessionView` 只把经审批的焦点台词当成正式对话；当前权威 talk 目标若尚无焦点场景，无论旧场景里是否有该 NPC 的环境闲聊，都投影为空白、不可自由输入、带单一权威 `ask` 的 `startChoice`，由 NPC 点击立即提交并触发白名单 provider。剧情流矩阵与 UI 回归覆盖 generated/fixture、旧存档缺字段、同地点换 NPC、pending/failed 和已恢复正式对白。

**Tech Stack:** TypeScript 5.8、Vitest 3、React Testing Library、Next.js 16；不新增依赖、不修改 provider 调用预算或存档版本。

**Spec:** `docs/游戏设计原则.md`、`docs/agent/NPC对话驱动叙事场景触发.md`、`docs/agent/剧情连续性与结构化记忆.md`

## Global Constraints

- AI 只提出场景与台词；Action、choice token、目标推进、CAS 和可执行入口仍由服务端裁决。
- 新字段必须兼容当前 `record_version=1` 中缺少 `speechPurpose` 的场景；旧记录按 `npcLine.npcId` 推断焦点，其余一律视为环境闲聊。
- 未生成正式焦点场景时不得展示 deterministic NPC 台词、环境闲聊或自由输入；NPC 点击只提交一次当前 revision 的权威 `ask`。
- `provider_pending` / `provider_failed` 保留 typed 状态，read model 不以 fallback 文案伪装成功。
- 不修改 `WorldState.version`、`StoryState.version`、SQLite schema、AI timeout/maxTokens/retry 或 provider 白名单。
- 先写失败测试，再做最小实现；每个任务完成后运行列出的 targeted tests。

---

### Task 1: Persist NPC speech purpose instead of inferring it from text

**Files:**
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/domain/narrative.test.ts`
- Modify: `src/game/application/approveAndWriteScene.test.ts`

**Interfaces:**
- Consumes: `buildNpcDialoguePages(npcs, options)` and the existing `focusNpcId`/`generatedNpcLines` inputs.
- Produces: `NpcDialogueInScene.speechPurpose?: "focus" | "ambient"`; every new `buildNpcDialoguePages` result contains the field, while the parser accepts old entries without it.

- [x] **Step 1: Write the failing domain test**

```ts
const dialogues = buildNpcDialoguePages(npcs, {
  focusNpcId: "npc_old",
  focusSpeech: "去找赵文远。",
  generatedNpcLines: new Map([["npc_zhao", "晚风有些凉。"]]),
  speechSource: "generated",
});
expect(dialogues.map((entry) => [entry.npcId, entry.speechPurpose])).toEqual([
  ["npc_old", "focus"],
  ["npc_zhao", "ambient"],
]);
```

- [x] **Step 2: Run the test and verify it fails**

Run: `npm test -- src/game/domain/narrative.test.ts src/game/application/approveAndWriteScene.test.ts`

Expected: FAIL because `speechPurpose` is absent.

- [x] **Step 3: Implement the persisted purpose and compatible parser**

Add the optional field to the domain type and parser allow-list, validate only `focus | ambient`, and write `focus` exactly for the approved `npcLine.npcId`; write `ambient` for every other page, including deterministic legacy/fixture pages.

- [x] **Step 4: Run the targeted tests**

Run: `npm test -- src/game/domain/narrative.test.ts src/game/application/approveAndWriteScene.test.ts`

Expected: PASS.

### Task 2: Make unstarted objective dialogue an explicit provider entry state

**Files:**
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/game/application/gameSessionView.test.ts`

**Interfaces:**
- Consumes: `NpcDialogueInScene.speechPurpose`, `scene.npcLine`, current `talk_to_npc` objective, ready scene registry and `dialogueResume`.
- Produces: a `NpcDialogueView` for an unstarted objective NPC with `speechPages=[]`, `choices=[]`, `freeInputEnabled=false`, and `startChoice` bound to `{type:"talk", dialogueAct:"ask"}` at the current revision.

- [x] **Step 1: Add the exact Zhao Wenyuan regression**

Construct a generated handoff scene whose `npcLine` belongs to the old NPC, whose `npcDialogues` contains Zhao as `{speechPurpose:"ambient", speechSource:"generated"}`, and whose new active objective is `talk_to_npc` Zhao. Assert:

```ts
expect(zhao.speechPages).toEqual([]);
expect(zhao.choices).toEqual([]);
expect(zhao.freeInputEnabled).toBe(false);
expect(zhao.startChoice?.label).toBe("与赵文远交谈");
```

- [x] **Step 2: Add the legacy compatibility matrix**

Repeat the handoff case with no `speechPurpose`; because Zhao is not `scene.npcLine.npcId`, assert it is inferred as ambient and receives the same `startChoice`. Keep a control case where a ready dialogue scene names Zhao in `npcLine` and has two approved Zhao choices; assert its generated speech, two choices and free input remain available.

- [x] **Step 3: Run the failing read-model tests**

Run: `npm test -- src/game/application/gameSessionView.test.ts`

Expected: FAIL because ambient text currently makes the new objective NPC look formally ready.

- [x] **Step 4: Implement one classification rule**

Remove deterministic `handoffDialogueChoices`. Treat `handoffFocusNpc` as “formal dialogue not started” regardless of an ambient page in the previous scene. A supplied page is formal only when `speechPurpose="focus"`, or for old records when its NPC matches `scene.npcLine.npcId`. Formal ready scenes keep their approved scene choices; unstarted targets get only `startChoice` and never receive fallback/ambient pages or free input.

- [x] **Step 5: Run the read-model tests**

Run: `npm test -- src/game/application/gameSessionView.test.ts`

Expected: PASS.

### Task 3: Prove clicking the target starts the real provider turn

**Files:**
- Modify: `src/components/AdventureGameShell.test.tsx`
- Modify: `src/game/application/performTurn.test.ts`

**Interfaces:**
- Consumes: the `startChoice` emitted by Task 2 and the existing `LocationSceneScreen` click handler.
- Produces: exactly one `/api/game/actions` interaction for the authoritative ask; `performTurn` classifies it as `npc_fixed_choice` provider work and retains typed pending/failed semantics.

- [x] **Step 1: Add a component regression using generated ambient text**

Render a target dialogue with `speechPages=[]`, no fixed choices/free input, and `startChoice`. Click the NPC card and assert `onSubmit` receives the start token once, the old ambient text is absent, and the inline “正在等待赵文远回应” state is visible.

- [x] **Step 2: Add/extend the application trigger assertion**

Use a current talk objective and approved runtime ask token. Assert the committed narrative job has `sceneRequestKind="npc_response"`, `triggerKind="npc_fixed_choice"`, and `focusNpcId` equal to the target NPC; no rule-only scene is written.

- [x] **Step 3: Run component and perform-turn tests**

Run: `npm test -- src/components/AdventureGameShell.test.tsx src/game/application/performTurn.test.ts`

Expected: PASS.

### Task 4: Lock the end-to-end continuity contract and documentation

**Files:**
- Modify: `src/game/application/testing/dynamicMaterializationJourney.test.ts`
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `docs/agent/剧情连续性与结构化记忆.md`
- Modify: `docs/Agent文档索引.md`

**Interfaces:**
- Consumes: domain speech purpose, read-model start state, provider job trigger and current objective progression.
- Produces: a journey assertion that a newly materialized same-location NPC cannot consume ambient dialogue as its formal opening and that the first click enters provider pending before the formal ready scene.

- [x] **Step 1: Extend the dynamic materialization journey**

After the first NPC completes its handoff and the new NPC becomes the talk target, assert the pre-talk view contains no speech/free input for the new NPC and exposes `startChoice`; submit it, assert provider pending targets the new NPC, generate the scene, then assert two approved choices, free input and `source="generated"` focus speech.

- [x] **Step 2: Update canonical implementation facts**

Document the distinction between `speechPurpose=ambient` and `focus`, the one-click `ask` bootstrap, the legacy inference rule, and the invariant that API success alone does not make a non-focus line a formal response.

- [x] **Step 3: Run focused journey and architecture gates**

Run: `npm test -- src/game/application/testing/dynamicMaterializationJourney.test.ts`

Run: `npm run test:game-domain`

Run: `npm run test:game-application`

Run: `npm run test:components`

Run: `npm run test:boundaries`

Expected: PASS.

- [x] **Step 4: Run final verification**

Run: `npm run typecheck`

Run: `npm run lint`

Run: `npm test`

Run: `npm run build`

Expected: all commands PASS; no current-save reset is required because missing `speechPurpose` is inferred safely.
