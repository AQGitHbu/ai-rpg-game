# NPC Second Dialogue Options Regression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复最新 main 当前存档中 NPC 完成一次正式对话后，下一次仍应是正式焦点对话却丢失两个固定选项的问题，并用至少五幕、三名 NPC 的真实浏览器旅程验证不会回归。

**Architecture:** 先从当前 SQLite 存档的 `GameSessionView` 和 AI 审计事件确认第二次对话的权威 `StoryState`、scene event、choice registry 与 NPC focus 投影。根因已确认在 `deriveObjectiveTransition`：规则层把“NPC 已 met”误当作两轮对话目标已完成，未检查 `dialogueSession.completed`；这又让 `performTurn` 错误地产生 `sceneRequestKind="npc_handoff"`，AI 合法地返回零 choices。修复集中在 gameplay 目标转换判定与 application 执行回归测试，保持服务端 opaque choice、单次 action CAS、NPC 对话两轮规则和 provider 白名单不变；再用真实 AI/当前存档验证五幕长链。

**Tech Stack:** TypeScript 5.8、Vitest 3、Next.js 16、SQLite 当前开发存档、Codex in-app Browser、现有 AI 审计 CLI。

**Spec:** 用户请求；实现契约见 `docs/agent/NPC对话驱动叙事场景触发.md`、`docs/agent/地图与地点冒险.md` 与 `docs/游戏开发规范.md`。

## Global Constraints

- 直接在最新 `main` 修改；不创建或使用 feature worktree。
- 遵守 TDD：先写能复现当前存档语义的失败回归测试，再写最小修复，再运行相关测试。
- 每个 ready 焦点 NPC 场景必须投影两个语义不同的固定对白选择和一个自定义输入；非焦点 NPC、交接收尾和目标已切换场景不得伪造正式选项。
- 不改变行动规则、NPC 两轮会话完成条件、opaque token 合同、provider 触发白名单、存档 schema 或 AI retry 预算。
- 实机测试使用当前 `db/rpg.sqlite` 存档和 `.env.local`；不删除当前存档，不清空 SQLite，不读取或输出任何密钥。
- 实机至少推进 5 幕，并覆盖至少 3 名不同 NPC 的正式对话；任一失败必须修复后从失败点复测，直到链路恢复。
- 实现事实变化按 `aq-update-docs` 更新 `docs/agent/` 与必要的索引；不修改共享 foundation。

---

### Task 1: Baseline current save and reproduce the missing-choice transition

**Files:**

- Read: `db/rpg.sqlite`, `src/game/application/gameSessionView.ts`, `src/components/LocationSceneScreen.tsx`
- Read: `logs/ai-text-audit/` current run after browser reproduction
- Modify: none

**Interfaces:**

- Consumes: `GET /api/game/current`, current `GameSessionView`, current SQLite record and browser-visible NPC dialogue.
- Produces: exact reproduction sequence, including revision/turn/act, NPC id, `narrative.eventKind`, `narrative.choices`, `narrative.npcDialogues[].choices`, `freeInputEnabled`, and the relevant audit run id.

- [x] **Step 1: Start the main worktree dev server and inspect current save**

Run `npm run env:check`, then start `npm run dev -- --hostname 127.0.0.1 --port 3310`. Open `http://127.0.0.1:3310/` in the in-app Browser and capture only visible UI state plus the current SQLite record; do not inspect cookies, local storage, or environment values.

- [x] **Step 2: Reproduce one NPC's first and second formal dialogue**

Open the current focus NPC, record the first state where two choices are visible, submit one fixed choice, wait until the scene is ready, reopen the same/next authoritative NPC, and record whether the next formal NPC dialogue has exactly two choices and `freeInputEnabled=true`.

- [x] **Step 3: Confirm the root-state mismatch before editing code**

Compare the two snapshots for `story.currentObjectiveLabel`, `narrative.eventKind`, `narrative.npcLine`, `narrative.npcDialogues`, `narrativeGeneration`, and the audit `game_api`/`story_text` events. Identify whether the loss is caused by scene projection, stale-focus demotion, scene choice registry validation, or UI reducer synchronization.

---

### Task 2: Add a failing application/UI regression test

**Files:**

- Modify: `src/game/gameplay/rpg/narrativeContext/deriveObjectiveTransition.test.ts`
- Modify: `src/game/application/performTurn.test.ts`
- Test: same file

**Interfaces:**

- Consumes: the exact current-save state shape captured in Task 1: `dialogueSession={turnCount:1, requiredTurns:2, completed:false}` while the NPC has `met=true`.
- Produces: deterministic failing assertions that an incomplete two-turn talk remains the current objective and that the pending job uses `sceneRequestKind="npc_response"`; completed sessions retain handoff behavior.

- [x] **Step 1: Write the failing test before production changes**

Construct the smallest fixture that preserves the reproduced `StoryState.narrative`, objective NPC, present NPC, scene event, scene choices, registry, revision, and dialogue session values. Assert:

```ts
expect(transition.completed).toEqual([]);
expect(transition.after?.objectiveIndex).toBe(0);
expect(transition.mode).toBe("unchanged");
expect(pendingJob.sceneRequestKind).toBe("npc_response");
```

Also retain an assertion that the reproduced stale/handoff state does not regain formal choices when the authoritative objective has moved away from that NPC.

- [x] **Step 2: Run the focused test and verify it fails**

Run `npx vitest run <selected-test-file> -t "second|第二次|two fixed|两个.*选项"`. Expected result: the current main implementation returns zero or non-two choices for the reproduced formal dialogue state.

---

### Task 3: Implement the minimal root-cause fix

**Files:**

- Modify: `src/game/gameplay/rpg/narrativeContext/deriveObjectiveTransition.ts`
- Modify: `src/game/application/performTurn.ts` only if the focused execution test proves the transition fix is insufficient
- Test: the regression test from Task 2

**Interfaces:**

- Consumes: the existing objective transition and dialogue-session contracts.
- Produces: an incomplete two-turn talk stays a normal `npc_response` provider job, so the approved ready scene must expose two fixed choices plus free input; only a completed session can use local handoff semantics.

- [x] **Step 1: Change only the failing boundary**

Preserve the existing distinction between `dialogueSession.completed=false` and a final handoff. Make objective transition/current-objective derivation session-aware for the active `talk_to_npc` objective: `npc.met` records contact, while only a matching completed dialogue session satisfies the objective. Keep `handoffFocusNpc`, `singleChoiceDialogueHandoff`, non-dialogue objective demotion, and invalid/stale token filtering unchanged.

- [x] **Step 2: Run the focused regression test**

Run the exact focused Vitest command again. Expected: PASS, with the old handoff/non-focus assertions still PASS.

- [x] **Step 3: Run related application and component tests**

Run `npm run test:game-application` and `npm run test:components`; fix any contract regressions before proceeding.

---

### Task 4: Real five-act, three-NPC browser journey

**Files:**

- Read: current browser UI, `logs/ai-text-audit/<runId>/events.jsonl`
- Modify: production/tests only if a real failure is reproduced

**Interfaces:**

- Consumes: current main worktree server, current SQLite save, AI provider from `.env.local`.
- Produces: auditable evidence of at least 5 act transitions and formal dialogue with at least 3 distinct NPC ids, with every ready focus dialogue exposing two choices and custom input.

- [x] **Step 1: Resume the current save without clearing it**

Reload the browser, verify the current HUD objective and act, and continue from the saved position. Do not create a replacement game or call the dev clear route.

- [x] **Step 2: Verify every dialogue boundary**

For each of at least three NPCs, record the NPC name/id, act, revision, visible choice count, and `freeInputEnabled` before submitting. Submit at least one fixed choice per NPC and confirm the next ready response remains usable or presents the explicitly documented handoff state.

- [x] **Step 3: Reach five acts and test navigation between them**

Use only visible approved choices/travel entries. After each provider scene settles, verify the HUD act increases or remains correctly in-progress, the target NPC changes only when authoritative state changes, and returning to an old location does not restore stale choices.

- [x] **Step 4: Fix and repeat any failure**

If any scene has zero/one choices while its NPC is the authoritative ready focus, stop the journey, add a focused regression test, implement the minimal fix, run related tests, restart the server, and resume from a safe persisted state. Do not mask a provider failure as a deterministic success.

- [x] **Step 5: Verify audit boundaries**

Run `npm run ai-text-audit -- list` and query the run for `ai_call`, `game_api`, and `story_text`. Confirm formal NPC choices use the permitted provider path and local handoff/travel/revisit actions do not introduce forbidden provider calls.

实机结果：使用 `db/rpg.sqlite` 当前存档在 `http://127.0.0.1:3310/` 继续推进至 `currentAct=5/targetActs=5`、`storyProgress=100`；老陈、黑衣人、赵文远三名 NPC 各完成两轮正式对话。赵文远首次和第二次 ready 回应均在浏览器可见两个固定选项与自定义输入；幕边界“继续追查下一幕线索”也成功编排出第 4 幕。

---

### Task 5: Final gates, documentation, and main verification

**Files:**

- Modify: relevant `docs/agent/<system>.md` and `docs/Agent文档索引.md` only if implementation facts changed
- Read: `.agents/commands/aq-update-docs.md` or repository shared equivalent

**Interfaces:**

- Consumes: fixed production code, focused tests, five-act browser evidence.
- Produces: clean verified main change with documentation and no hidden regression.

- [x] **Step 1: Update implementation documentation**

Apply the documentation routing checklist. Document the corrected formal-focus predicate and the distinction between a two-choice ready dialogue and a one-button handoff; do not add obsolete API/version names.

- [x] **Step 2: Run final quality gates**

Run `npm run check:standards`, `npm run typecheck`, `npm run lint`, `npm run test:boundaries`, `npm run test:fast`, the related suites, `npm test`, `npm run build`, and `npm run phase:status`.

- [x] **Step 3: Review the diff and report main status**

Run `git diff --check`, `git status --short`, and summarize the root cause, test evidence, five-act/three-NPC journey, and any pre-existing main modifications without discarding them.
