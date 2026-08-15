# Battle Victory Next-Act Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复战斗胜利预热绕过世界演化的问题，确保完成主线战斗后能生成下一幕任务或终局结局对。

**Architecture:** 在实际胜利回合拿到权威 `WorldState + StoryState` 后，先判断是否存在 `deriveEvolutionNeed`；需要世界演化时绕过仅含场景提案的预热写回，交给现有 `generatePendingScene` 完成演化、场景审批和 CAS。无需演化时继续复用预热，保留普通战斗胜利的低延迟路径。

**Tech Stack:** TypeScript, Vitest, Next.js application/server composition root, SQLite CAS repository.

## Global Constraints

- 规则状态只能由 `WorldState + StoryState` 和 gameplay 规则产生，不能从旁白或玩家文案反推。
- 一次成功玩家回合仍只允许一次规则 CAS；场景/世界演化写回必须沿现有 narrative CAS。
- 保留现有 worktree 未提交的 UI/文档修改，不使用 destructive Git 操作，不改 `.foundation`。
- 不新增 route、兼容 facade 或版本化运行链；生产入口继续使用 `performTurn`、`generatePendingScene` 和 composition root。

---

### Task 1: Add the regression test for evolution-aware victory handoff

**Files:**
- Create: `src/game/application/server/battleScenePrewarm.test.ts`
- Test: `src/game/application/server/battleScenePrewarm.test.ts`

**Interfaces:**
- Consumes: `battleVictoryRequiresWorldEvolution(record)` from `battleScenePrewarm.ts`.
- Produces: A regression assertion covering `needs_next_act` / `needs_ending_pair` and the stable no-evolution path.

- [ ] **Step 1: Write the failing test**

  Build minimal `WorldState` and `StoryState` fixtures with `createInitialWorldState` and `createInitialStoryState`; assert the helper returns `true` for `needs_next_act` and `needs_ending_pair`, and `false` for `stable`.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run: `npx vitest run src/game/application/server/battleScenePrewarm.test.ts`

  Expected: FAIL because the helper does not exist yet.

### Task 2: Route evolution-requiring victories through normal pending-scene generation

**Files:**
- Modify: `src/game/application/server/battleScenePrewarm.ts`
- Modify: `src/game/application/server/compositionRoot.ts`
- Test: `src/game/application/server/battleScenePrewarm.test.ts`

**Interfaces:**
- Consumes: `deriveEvolutionNeed(worldState, storyState)` and the existing `generatePendingScene` orchestration.
- Produces: `battleVictoryRequiresWorldEvolution(record)` plus a victory branch that invokes `generatePendingScene` whenever the authoritative post-victory state requires world evolution.

- [ ] **Step 1: Add the pure evolution-need helper**

  Import `deriveEvolutionNeed` through the RPG world-evolution facade and implement:

  ```ts
  export function battleVictoryRequiresWorldEvolution(
    record: Pick<GameRecord, "worldState" | "storyState">,
  ): boolean {
    return deriveEvolutionNeed(record.worldState, record.storyState).kind !== "none";
  }
  ```

- [ ] **Step 2: Update the victory branch**

  In `compositionRoot.ts`, after the authoritative victory result is loaded, use the helper. If it returns `true`, call `generatePendingScene({ repository, sceneSource, worldEvolutionSource, logger, allowDeterministicFallback: true, now })` and refresh the view on `saved`; do not apply the prewarmed proposal. If generation remains pending/unavailable, allow the normal `narrativeCoordinator.ensure` fallback to queue it.

- [ ] **Step 3: Preserve the existing fast path**

  If the helper returns `false`, keep the current prewarm cache/fallback application unchanged. Ensure the final coordinator condition distinguishes “victory needs normal generation” from “victory is waiting on prewarm”, so a failed normal generation cannot leave a pending job without a recovery attempt.

- [ ] **Step 4: Run the focused tests**

  Run: `npx vitest run src/game/application/server/battleScenePrewarm.test.ts src/game/application/server/compositionRoot.test.ts src/game/application/generatePendingScene.test.ts`

  Expected: PASS.

### Task 3: Run application and static verification

**Files:**
- No additional files.

- [ ] **Step 1: Run RPG application tests**

  Run: `npm run test:game-application`

  Expected: PASS, including pending-scene, CAS, battle, and composition coverage.

- [ ] **Step 2: Run type and boundary checks**

  Run: `npm run typecheck` and `npm run test:boundaries`

  Expected: PASS with no new dependency-boundary violations.

### Task 4: Record the implementation fact in agent docs

**Files:**
- Modify: `docs/agent/战斗与结局.md`
- Modify: `docs/Agent文档索引.md`

- [ ] **Step 1: Document the handoff rule**

  State that battle prewarm is only applied directly when the authoritative victory does not require world evolution; next-act and ending-pair needs go through normal pending-scene generation before scene CAS.

- [ ] **Step 2: Verify the existing user changes remain intact**

  Run: `git status --short` and confirm the pre-existing modified files are still present and no unrelated file was rewritten.
