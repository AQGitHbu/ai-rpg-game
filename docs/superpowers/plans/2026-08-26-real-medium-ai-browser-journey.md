# Real Medium AI Browser Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用用户指定的 Chrome 完成一局真实 API 驱动的中篇 RPG，并将生产运行时收口为“AI 文本只能 generated；失败只进入 failed/retry，永不展示或写回 deterministic fallback”。

**Architecture:** 生产 composition root 继续只装配 live/unavailable source，显式 offline fixture 仍服务零网络回归。读模型移除对缺失 NPC 台词的即时 deterministic 合成：已审批 scene 有文本才展示，权威 talk 目标缺少正式 focus 台词时只下发单一 `ask` 重新进入 provider；真实 Chrome 旅程使用独立 SQLite 与独立 AI audit run，逐幕核对 UI、持久化 scene source、重试与终局。

**Tech Stack:** TypeScript 5.8、React 19、Next.js 16、Vitest 3、Chrome browser control、SQLite、真实 OpenAI-compatible AI provider。

**Spec:** `docs/游戏设计原则.md`、`docs/agent/AI环境.md`、`docs/agent/运行时AI导演与场景表演.md`、`docs/agent/NPC对话驱动叙事场景触发.md`、`docs/agent/AI文本审计.md`

## Global Constraints

- 真实运行只接受 `NarrativeSceneState.source="generated"` 的 provider 文本；`source="fixture"` 和 `【fallback】` 只能存在于显式 offline fixture 测试。
- AI transport、解析、schema 或审批失败必须持久化 `provider_failed`，由玩家对同一 job 手动重试；不得自动切换 deterministic source。
- `source="rule"` 只允许承载战斗回合、移动、物品等规则结果，不伪装 AI 旁白或 NPC 台词。
- 使用独立临时 `GAME_DB_PATH` 和 `AI_TEXT_AUDIT_RUN_ID`，不覆盖玩家当前存档；不输出或记录 API key、Authorization、cookie 或完整 URL。
- 中篇旅程必须从创建新局开始，跨 5 幕抵达 ending，至少 15 个成功规则回合；固定对白与自由输入各至少一次，并覆盖移动、调查/事实、取物、战斗、跨幕交接与 reload。
- 每个玩家可见 provider scene 都从 audit 的 `story_text.source` 证明为 `generated`；任何 `fixture`、`【fallback】`、无入口状态或目标/场景冲突都算失败。
- 不新增并行 API、read model 或 source；所有修复进入现有 domain → gameplay → application → UI 单一路径。

---

### Task 1: Remove runtime-synthesized fallback dialogue

**Files:**
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/game/application/gameSessionView.test.ts`
- Modify: `src/components/AdventureGameShell.test.tsx`

**Interfaces:**
- Consumes: `NarrativeSceneState.npcLine`, `NpcDialogueInScene.speechPages/speechPurpose/speechSource`, current authoritative `talk_to_npc` objective.
- Produces: `NpcDialogueView` that displays only persisted/approved speech; missing formal focus speech produces `speechPages=[]`, `choices=[]`, `freeInputEnabled=false`, and one authoritative `startChoice`.

- [ ] **Step 1: Add failing read-model regressions**

Add one generated ready scene with a focus NPC but no usable `npcLine`/focus page, and one present non-focus NPC without a generated ambient page. Assert both receive no synthesized `【fallback】` text; the focus target receives only `startChoice`, while the non-focus NPC has no submit action.

- [ ] **Step 2: Run the focused tests and verify the old fallback path fails**

Run: `npm test -- src/game/application/gameSessionView.test.ts src/components/AdventureGameShell.test.tsx`

Expected: FAIL because `projectGameSessionView` still calls `composeDeterministicNpcLine` / `composeIdleNpcLine` when persisted speech is missing.

- [ ] **Step 3: Remove read-time synthesis and make missing focus speech a provider start state**

Delete both deterministic speech imports from `gameSessionView.ts`. Build `speechPages` only from a usable persisted page or `scene.npcLine`; otherwise return `[]`. Extend `requiresFormalDialogueStart` to include an authoritative focus target without `speechPurpose="focus"` speech, and keep choices/free input/give actions disabled until a generated focus scene is written.

- [ ] **Step 4: Run application and component gates**

Run: `npm test -- src/game/application/gameSessionView.test.ts src/components/AdventureGameShell.test.tsx`

Run: `npm run test:game-application`

Run: `npm run test:components`

Expected: PASS; explicit fixture scenes continue displaying their persisted fixture pages, but production projection never creates fallback text.

### Task 2: Lock production source and retry invariants

**Files:**
- Modify: `src/game/application/server/compositionRoot.audit.test.ts`
- Modify: `src/game/application/server/ai/sourceFactory.test.ts`
- Modify: `src/game/application/gameSessionView.test.ts`

**Interfaces:**
- Consumes: `createOpeningGenerationSource`, `createSceneSource`, `createWorldEvolutionSource`, provider failed/pending runtime union.
- Produces: regression proof that missing/failed AI config yields typed failure, generated validation failure yields `provider_failed`, and no production entry point persists or projects `fixture` text.

- [ ] **Step 1: Add a production composition regression**

Create entry points with unavailable AI sources and assert create/scene generation returns stable `AI_CALL_FAILED` or `AI_RESPONSE_INVALID`; inspect the saved runtime and assert it is failed rather than ready fixture. Add a source-factory assertion that none of the production factories returns deterministic implementations.

- [ ] **Step 2: Add a player-view retry regression**

Project `provider_failed` for a current NPC job and assert the view exposes the stable failure modal/job key, contains neither `【fallback】` nor new talk choices, and manual retry preserves the same job identity.

- [ ] **Step 3: Run server/application tests**

Run: `npm test -- src/game/application/server/compositionRoot.audit.test.ts src/game/application/server/ai/sourceFactory.test.ts src/game/application/gameSessionView.test.ts`

Expected: PASS with zero network calls.

### Task 3: Run a complete real medium game in Chrome

**Files:**
- Create: `docs/superpowers/reports/2026-08-26-real-medium-ai-browser-journey.md`
- Inspect: `logs/ai-text-audit/<dedicated-run-id>/events.jsonl`

**Interfaces:**
- Consumes: the worktree dev server, its dedicated SQLite database and audit run, and the Chrome-controlled UI.
- Produces: a turn-by-turn report containing act, objective, UI action, resulting state, source proof and quality observation, ending with a completed medium-game ending.

- [ ] **Step 1: Prepare isolated real-AI runtime**

Run `npm run env:bootstrap` and `npm run env:check` without printing values. Start the worktree server on an unused localhost port with a dedicated `/tmp/ai-rpg-real-medium.sqlite`, `AI_TEXT_AUDIT=full`, `GAME_API_AUDIT=full`, and a dedicated run ID.

- [ ] **Step 2: Create a medium game through Chrome**

Open the localhost page in the user-selected Chrome, choose 武侠 + 中篇, provide non-sensitive fictional setup text, submit, wait for generated opening, acknowledge the prologue, and record act 1 source/quality.

- [ ] **Step 3: Play every authoritative objective to completion**

For each UI state, inspect the visible objective and available controls before acting. Use the authoritative map/town/building/NPC/item/battle controls, alternate fixed choices with at least one free-text NPC reply, reload once after a ready scene, retry any provider failure through the displayed retry control, and continue until the ending view appears. Record every successful revision and any inconsistency before changing code.

- [ ] **Step 4: Verify the audit and persistence invariants**

Query the dedicated JSONL/SQLite without exposing secrets. Assert every `story_text` provider write has `source="generated"`, no visible/API body contains `【fallback】`, no ready provider scene has `source="fixture"`, all pending jobs terminate in ready or explicit failed/retry, the journey has at least 15 successful turns, and the final state contains an ending.

### Task 4: Repair every reproduced continuity or quality defect

**Files:**
- Modify: the smallest owning production module identified by the Task 3 reproduction.
- Modify: the same module's colocated unit/application/component test.
- Modify: `docs/superpowers/reports/2026-08-26-real-medium-ai-browser-journey.md`

**Interfaces:**
- Consumes: one exact browser reproduction, audit call/job IDs, before/after objective and source classification.
- Produces: one failing regression per distinct defect, the minimal implementation fix, and a replayed Chrome checkpoint proving the defect no longer occurs.

- [ ] **Step 1: Convert each observed defect into a failing automated regression**

For a state defect, reconstruct the exact `WorldState + StoryState` in the owning gameplay/application test. For a UI defect, construct the exact `GameSessionView`. For an AI format/approval defect, use the audited sanitized response shape in the live-source parser/approval test without copying secrets.

- [ ] **Step 2: Implement the minimal authoritative fix**

Change the owning rule, parser, approval, prepared-continuation projection or UI projection. Do not add fallback text, client-authored actions, new provider triggers or compatibility routes.

- [ ] **Step 3: Run the targeted test and affected layer suite**

Run the colocated test first, followed by the relevant `test:game-domain`, `test:game-gameplay`, `test:game-application`, `test:components` or `test:app` command.

- [ ] **Step 4: Reload Chrome and replay from a fresh isolated medium game**

After code changes, restart/reload the local app, create a fresh dedicated database/run ID, and repeat the affected path. A patch is accepted only when the browser-visible state and audit both satisfy the invariant.

### Task 5: Document, verify, merge and clean up

**Files:**
- Modify: `docs/游戏设计原则.md`
- Modify: `docs/游戏开发规范.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`
- Modify: `docs/agent/AI文本审计.md`
- Modify: `docs/Agent文档索引.md`
- Modify: `docs/superpowers/reports/2026-08-26-real-medium-ai-browser-journey.md`

**Interfaces:**
- Consumes: final implementation and Chrome/audit evidence.
- Produces: canonical production no-fallback contract, reproducible real-journey evidence and a clean `main` with no feature branch/worktree.

- [ ] **Step 1: Update design principle and implementation facts**

Add the project-wide principle: production AI-authored narrative accepts only approved `generated` content; call/parse/approval failure enters failed/manual-retry and never switches to deterministic/fixture/default prose. Clarify that rule-owned movement/battle/item resolution may remain `source="rule"` but must not impersonate AI narrative. Update implementation docs accordingly and replace stale handoff wording with the single authoritative `ask` entry.

- [ ] **Step 2: Run final verification**

Run: `npm run lint`

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run test:fast`

Run: `npm run build`

Run: `npm run phase:status`

Expected: all PASS.

- [ ] **Step 3: Commit and deliver through the repository workflow**

Commit the reviewed worktree, then from clean `main` run `npm run branch:merge -- codex/real-medium-ai-journey`; verify the worktree and local branch are removed and `main` is clean.
