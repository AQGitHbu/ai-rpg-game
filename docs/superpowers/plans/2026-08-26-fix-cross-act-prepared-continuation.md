# Fix Cross-Act Prepared Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复正式 NPC 收尾回合跨幕预生成 prepared continuation 时引用旧任务身份，导致 AI 返回成功但场景审批失败并显示“NPC回应生成失败”的问题。

**Architecture:** 保持 provider、场景审批和 CAS 链不变，只修正 prepared continuation 投影器在递归进入下一主线任务后使用的任务上下文。用跨幕 fixture 锁定 descriptor 的 quest/objective/arrival NPC 元数据，再用现有 prepared 审批测试确认生成结果可被接受。

**Tech Stack:** TypeScript 5.8、Vitest 3、现有 RPG domain/gameplay/application 链路、SQLite/AI 审计日志。

**Spec:** `docs/agent/运行时AI导演与场景表演.md`、`docs/agent/NPC对话驱动叙事场景触发.md`。

## Global Constraints

- 不改变 provider 触发白名单、AI retry 预算、场景审批规则、行动裁决、存档 schema 或 continuation 消费语义。
- 只修改 `ai-rpg-game`；不修改 `../ai-game-foundation` 或共享 package。
- 保留当前用户存档，不清档、不删除 SQLite 文件，不输出密钥或完整敏感配置。
- 跨幕 descriptor 的 `questId`、`objectiveIndex`、`objectiveKey`、消费组、后继和 arrival NPC 必须来自递归当前 `activeQuest`。
- AI 仍只提供 prepared scene 的自然语言 seed；图结构、合法候选和 token 仍由服务端维护。

## Task 1: Add a failing cross-act descriptor regression

**Files:**

- Modify: `src/game/gameplay/rpg/preparedContinuation/candidates.test.ts`
- Read: `src/game/gameplay/rpg/preparedContinuation/candidates.ts`

- [x] **Step 1: Build the reproduced cross-act fixture**

Extend the prepared continuation test fixture with an active current quest whose next objective is an item, plus an already-materialized next-act quest whose first objective is a move followed by a talk objective. Set the transition to the current quest's item objective and assert the projected move descriptor uses the next quest's ID, index `0`, and arrival NPC.

- [x] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npx vitest run src/game/gameplay/rpg/preparedContinuation/candidates.test.ts -t "跨幕|next act|next quest"
```

Expected: FAIL because the current implementation emits the outer quest ID/objectives and misses the next quest's arrival NPC.

## Task 2: Fix recursive prepared descriptor ownership

**Files:**

- Modify: `src/game/gameplay/rpg/preparedContinuation/candidates.ts`
- Test: `src/game/gameplay/rpg/preparedContinuation/candidates.test.ts`

- [x] **Step 1: Use `activeQuest` for move descriptors**

In the `visit_location` branch, resolve `arrivalNpc` from `activeQuest.objectives`, and build `objectiveKey`, `consumptionGroupKey`, `authority.questId`, and `authority.objectiveIndex` from `activeQuest`. Keep the trigger location, server-authored candidates, and successor walk unchanged.

- [x] **Step 2: Use `activeQuest` consistently for battle descriptors**

In the `defeat_enemy` branch, use `activeQuest.id` for the descriptor objective key, consumption group, and authority quest ID so a recursive next-act battle boundary cannot retain the outer task identity.

- [x] **Step 3: Run focused and related tests**

Run:

```bash
npx vitest run src/game/gameplay/rpg/preparedContinuation/candidates.test.ts src/game/application/approvePreparedContinuation.test.ts
npm run test:game-gameplay
npm run test:game-application
```

Expected: PASS, including existing same-quest move/battle coverage and the new cross-act regression.

## Task 3: Document and verify the production path

**Files:**

- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/Agent文档索引.md` only if the implementation-fact index entry needs a dated note

- [x] **Step 1: Record the cross-act authority rule**

Document that prepared continuation projection must keep the recursively active quest's identity and objective metadata when a scene job materializes the next act; AI output must be checked against that server-authored descriptor.

- [x] **Step 2: Run final checks proportional to the change**

Run:

```bash
npx vitest run src/game/gameplay/rpg/preparedContinuation/candidates.test.ts src/game/application/approvePreparedContinuation.test.ts
npm run typecheck
npm run lint
git diff --check
```

Confirm the current persisted save is unchanged and the diff contains only the planned code, tests, plan, and documentation updates.
