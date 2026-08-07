# Prologue Continue and Narrative Pending Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the new-game prologue continue reliably while the initial runtime narrative is pending, and make the request logs distinguish a rejected ack from a completed transition.

**Architecture:** Keep `ack_prologue` as a server-authoritative, idempotent CAS action. Exempt this marker-only action from the pending narrative action gate, while leaving ordinary rule actions blocked until the pending scene is ready. On the client, only a response without an error `code` is treated as a successful ack; the existing ensure loop continues to interpret `202/pending` as background work and `200/ready` as completion.

**Tech Stack:** React 19 client components, Next.js route handlers, TypeScript, Vitest, Testing Library, existing SQLite application facade.

## Global Constraints

- 修改范围仅限 `ai-rpg-game` worktree `.worktrees/phase14-progressive-generation`，不修改 `../ai-game-foundation`、`.foundation` 或共享 package。
- UI 只消费 `GameSessionView`，不直接读取 `GameState`、数据库、provider 或环境变量。
- `ack_prologue` 仍是唯一的序幕状态写入入口；不新增客户端推导的规则结果或持久化字段。
- `POST /api/game/narrative/ensure` 返回 `202` 表示 pending 已排队或已有任务运行；`200/ready` 才表示生成任务已完成。
- 最低验收包含 Prologue/CurrentGameScreen 组件测试、Phase 14 application 回归、`npm run typecheck` 与 `npm run test:components`。

---

### Task 1: Reproduce the pending-ack failure with regression coverage

**Files:**
- Modify: `src/game/application/phase14ProgressiveGenerationRegression.test.ts`
- Modify: `src/components/PrologueScreen.test.tsx`
- Modify: `src/components/CurrentGameScreen.test.tsx`

**Interfaces:**
- Consumes: the existing in-memory repository, runtime narrative source fixture, prologue component, and `CurrentGameScreen` fetch adapter.
- Produces: tests proving an initial AI-mode game is `narrativeGeneration.pending`, `ack_prologue` is the transition request, and Enter/Space/Escape reach the component callback.

- [x] **Step 1: Make the Phase 14 ack test create an initial pending narrative**

  Inject `mockRuntimeNarrativeSources` into `createTestDependencies`, assert `created.view.narrativeGeneration.status === "pending"`, and keep the existing assertions that the first and second ack set `prologueShown` and advance revision.

- [x] **Step 2: Add the component input regression tests**

  Verify that after the text is revealed, click, Enter, Space, and Escape each invoke `onComplete` exactly once.

- [x] **Step 3: Add the client integration regression**

  Render an active view with `prologueShown: false`, a prologue definition, and pending narrative generation; stub `POST /api/game/prologue/ack` to return a ready view; continue the prologue and assert the request body contains the current revision and the ready map is rendered. Stub ensure as `202/pending` to preserve the real response semantics.

### Task 2: Allow the marker-only ack through the pending action gate

**Files:**
- Modify: `src/game/application/performAction.ts`
- Modify: `src/components/CurrentGameScreen.tsx`

**Interfaces:**
- Consumes: `PlayerIntent.type === "ack_prologue"`, current narrative generation status, and the existing ack route response shape.
- Produces: successful CAS persistence of `prologueShown: true` during initial narrative pending, while ordinary actions remain rejected; client state changes only on a response without an error code.

- [x] **Step 1: Confirm the failing test**

  Run: `npx vitest run src/game/application/phase14ProgressiveGenerationRegression.test.ts -t "序幕播放后"`

  Expected before the fix: failure because `ack1.ok` is false while the created view is pending.

- [x] **Step 2: Exempt only `ack_prologue` from the pending gate**

  Keep the existing `ACTION_REJECTED` branch for all other intents, and change the condition so it applies only when `command.intent.type !== "ack_prologue"`. Do not bypass revision checks, rule validation, CAS, or the later `ack_prologue` no-queue behavior.

- [x] **Step 3: Stop the client from treating `200 + ACTION_REJECTED + view` as success**

  Parse the optional response `code`; switch to the returned view only when `response.ok`, `body.code` is absent, and `body.view` exists. Otherwise reload current state using the existing recovery path.

- [x] **Step 4: Run focused application and component tests**

  Run: `npx vitest run src/components/PrologueScreen.test.tsx src/components/CurrentGameScreen.test.tsx src/game/application/performAction.test.ts src/game/application/phase14ProgressiveGenerationRegression.test.ts`

  Expected: all focused tests pass, and the ordinary pending-action rejection test remains green.

### Task 3: Verify logs and document the implementation fact

**Files:**
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/Agent文档索引.md`

**Interfaces:**
- Consumes: the existing structured HTTP request log contract.
- Produces: implementation documentation for the prologue/pending boundary and the meaning of `202`.

- [x] **Step 1: Inspect the observed request sequence**

  Query `data/logs.db` with `node scripts/logs.mjs query --event http_request_completed`; confirm the failing sequence contains `POST /api/game/prologue/ack` with HTTP `200` and `resultCode: ACTION_REJECTED`, interleaved with `POST /api/game/narrative/ensure` with `202` and `resultCode: pending`. Confirm a later `ensure` can return `200/ready`.

- [x] **Step 2: Record the fixed boundary**

  Add a dated note to the map/location agent document and matching summary in the Agent index; retain the existing Phase 14 modal note.

- [x] **Step 3: Run final verification**

  Run: `npm run typecheck`; `npm run test:components`; `npm run test:app`; `npm run test:game-application`; `npm run test:fast`.

  Result: typecheck, components, app, fast, focused application tests, lint, and diff checks pass. The full `test:game-application` suite still has unrelated pre-existing story-eval/AI fixture and town-journey failures on this worktree; the Phase 14 and `performAction` suites pass. No foundation or shared-package changes were made.
