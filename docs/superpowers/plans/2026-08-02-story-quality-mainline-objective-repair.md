# AI 主线目标链修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 medium/long/open 蓝图中重复主线目标导致任务解锁后立即连锁完成的问题，使主线阶段、事实揭示、物品获取和结局战斗形成可实际游玩的连续链条。

**Architecture:** 先在确定性 fallback 蓝图模板中提供不重复且可达的中长线目标序列；再用 scenario prompt 将该序列作为严格结构契约传给真实 AI。保留 short 的既有三幕兼容行为，避免改变旧 fixture 语义。通过单元测试、完整离线 journey 和 typecheck 验证。

**Tech Stack:** TypeScript, Vitest, RPG scenario blueprint validator, SQLite story-eval journey.

## Global Constraints

- 不绕过 `validateScenarioBlueprintCandidate`、`compileScenarioBlueprint` 或规则任务 reconciliation。
- 不修改 `F:\AI2\ai-game-foundation` 或 `.foundation` junction。
- 保持 short 三幕既有 `talk_to_npc + obtain_item` 目标契约与 fixture pin。
- 所有真实 AI 质量结论必须来自完整 artifact，不能把 calls-only 产物计入分数。

---

### Task 1: Pin the regression in the fallback blueprint

**Files:**
- Modify: `src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts`
- Modify: `src/game/gameplay/rpg/scenario/createFallbackBlueprint.ts`

**Interfaces:**
- Existing `createFallbackBlueprint(input, seed)` remains unchanged.
- The test will inspect `candidate.quests` objective signatures and validate the generated medium/long candidates through the existing validator.

- [x] **Step 1: Add a failing long/medium regression test**

  Generate `gameLength: "long"` and `gameLength: "medium"` candidates. Assert that main stages 1..N have these target signatures where present:

  ```ts
  [
    "visit_location:loc_2",
    "talk_to_npc:npc_2",
    "obtain_item:item_key",
    "discover_fact:fact_gen_1",
    "discover_fact:fact_gen_2",
    "visit_location:loc_4",
    "talk_to_npc:npc_4",
    "defeat_enemy:enemy_boss",
  ]
  ```

  Also assert that no main-stage objective signature is repeated and that `validateScenarioBlueprintCandidate` returns no issues.

- [x] **Step 2: Run the focused test and verify it fails**

  Run:

  ```powershell
  npx vitest run src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts
  ```

  Expected: FAIL because the current medium/long template repeats `visit_location:loc_2`, `talk_to_npc:npc_2`, and `discover_fact:fact_gen_1`.

- [x] **Step 3: Implement the minimal target sequence**

  In `createFallbackBlueprint.ts`, replace the rotating `MID_OBJECTIVES` selection for `mainActs > 3` with the fixed sequence above, using entries `act - 2` for the non-final stages. Keep the existing legacy short branch for `mainActs === 3 && act === 2`. Leave the final stage’s `defeat_enemy:enemy_boss` construction unchanged.

- [x] **Step 4: Run the focused test and verify it passes**

  Run the same Vitest command. Expected: all tests in the file pass, including the existing short fixture pin and stage-2 item regression.

### Task 2: Make the scenario prompt preserve the repaired chain

**Files:**
- Modify: `src/game/application/server/ai/scenarioPrompt.ts`
- Test: `src/game/application/server/ai/scenarioPrompt.test.ts`

**Interfaces:**
- `buildScenarioPromptMessages(request, profiles)` keeps its signature and continues to use the repaired fallback candidate as `contractTemplate`.

- [x] **Step 1: Add prompt assertions**

  Assert that the prompt explicitly states that every main-stage objective must be a new actionable target, must not repeat an earlier main-stage objective, and must not be already satisfied when the preceding stage unlocks it. Assert that the long contract template contains the repaired target sequence.

- [x] **Step 2: Implement the prompt rule**

  Add a concise Chinese rule beside the objective enum section: “主线每一幕必须推动新的可验证目标；不得重复前面主线幕的同一 objective kind+target；不得让新解锁任务的目标在解锁前已满足。” Keep the generated template as the authoritative ID/reference example.

- [x] **Step 3: Run focused prompt and scenario tests**

  Run:

  ```powershell
  npx vitest run src/game/application/server/ai/scenarioPrompt.test.ts src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts
  ```

  Expected: all tests pass.

### Task 3: Verify the game-quality signal offline and update the record

**Files:**
- Modify: `docs/agent/AI内容质量评估.md`
- Modify: `docs/agent/物品与任务奖励.md` if the template version changes.
- Modify: this plan’s execution log.

**Interfaces:**
- Offline story-eval journey must still produce complete artifacts and branch evidence tests must remain green.

- [x] **Step 1: Run targeted application tests and typecheck**

  Run:

  ```powershell
  npx vitest run src/game/application/testing/storyEvalJourney.test.ts src/game/application/phase4ExplorationRegression.test.ts src/game/gameplay/rpg/quests/quests.test.ts
  npm run typecheck
  ```

  Expected: all targeted tests pass and TypeScript exits 0.

- [x] **Step 2: Run the offline quality journey**

  Run:

  ```powershell
  npm run journey:story-eval
  ```

  Expected: replay/branch coverage remains green; the offline full-journey fixture must not regress.

- [x] **Step 3: Record the repair and next real-AI rerun**

  Document that the prior stage jump was caused by a repeated target in the shared blueprint template, not by the thinking flag. The next real-AI test must recapture a fresh blueprint after this fix before running another thinking A/B.

- [x] **Step 4: Run repository hygiene checks**

  Run:

  ```powershell
  git diff --check
  ```

  Expected: no whitespace errors.

## Execution Log (2026-08-02)

- The red regression reproduced the old medium/long target repetition; the repaired `fallback-5` chain passed the new progression assertions and all 59 fallback tests.
- Prompt and validator coverage passed; validator rejection maps to the existing `unreachable_ending` recovery path rather than allowing an invalid blueprint into runtime.
- Offline journey, `test:fast`, full `npm test`, typecheck, lint, build and `git diff --check` passed. Full test result: 149 files, 1616 passed, 4 skipped; lint remains at five pre-existing warnings.
- The next real-AI run must generate a new complete artifact after `fallback-5`; pre-fix captured artifacts remain useful for diagnosis but are not valid post-fix A/B inputs.
- A follow-up target-selection hardening now projects `activeMainObjective` with its legal action key into the director context and mechanically prioritizes it; branch coverage targets still override this preference. The replay fingerprint excludes this deterministic derived field so the committed golden fixtures remain valid.
- After this follow-up, full repository tests passed at 149 files / 1618 passed / 4 skipped, with typecheck, fast gates, build, offline journey, lint (five existing warnings) and diff hygiene green.
