import { describe, expect, it } from "vitest";
import {
  asEnemyId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
  asEndingId,
  type GameState,
  type NewGameInput,
} from "@/game/domain";
import {
  resolveAction,
  type PlayerIntent,
} from "@/game/gameplay/rpg/actions";
import {
  startBattle,
  battleAction,
} from "@/game/gameplay/rpg/battle";
import { reconcileQuests, failQuest, resolveEnding } from "@/game/gameplay/rpg/quests";
import { reconcileStoryMemory } from "@/game/gameplay/rpg/narrative";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { performAction, type PerformActionDependencies } from "./performAction";
import {
  createFakeGameRepository,
  runScenarioPipeline,
  TEST_CREATED_AT,
  TEST_GAME_ID
} from "./applicationFixture.testutil";
import {
  type ApplyResolvedActionResult,
  type GameRecord,
} from "./server/persistence/gameRepository";

// ---------------------------------------------------------------------------
// Phase 6 Task 3b：performAction 战斗路由 + ending resolution 测试。
//
// 验证：
// - start_battle intent 被 performAction 路由到 battle facade
// - battle_action intent 被 performAction 路由到 battle facade
// - 战斗胜利后 reconcileQuests 完成 stage 3，resolveEnding 写入成功结局
// - 战斗撤退后 failQuest 标记 stage 3 failed，resolveEnding 写入失败结局
// - 每次只调用一次 applyResolvedAction（单次 CAS 写入）
// - 拒绝时零写入
// - 结局后所有 action 安全拒绝
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;
const PIPELINE = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);

const FIXED_TIME = "2026-07-27T10:00:00.000Z";
const ruleDeps = { now: () => FIXED_TIME };

/** 前进到 stage 3 active 且玩家在 boss 地点（loc_4）的状态。 */
function buildStage3BossReadyState(): GameState {
  const intents: readonly PlayerIntent[] = [
    { type: "move", locationId: asLocationId("loc_2") },
    { type: "move", locationId: asLocationId("loc_3") },
    { type: "talk", npcId: asNpcId("npc_3") },
    { type: "take_item", itemId: asItemId("item_key") },
    { type: "move", locationId: asLocationId("loc_4") },
  ];
  let state = PIPELINE.state;
  for (const intent of intents) {
    const resolved = resolveAction(PIPELINE.blueprint, state, intent, ruleDeps);
    if (!resolved.ok) throw new Error(`前置行动应当成功：${resolved.code}`);
    state = reconcileQuests(PIPELINE.blueprint, resolved.state, ruleDeps).state;
  }
  // 确认 stage 3 active
  const m3Status = state.quests.find((q) => q.questId === asQuestId("quest_m3"))?.status;
  if (m3Status !== "active") throw new Error(`前置应当 stage 3 active，实际：${m3Status}`);
  return state;
}

/** 构造已开始战斗的状态（battle active，round 1）。 */
function buildBattleActiveState(): GameState {
  const state = buildStage3BossReadyState();
  const result = startBattle(PIPELINE.blueprint, state, asEnemyId("enemy_boss"), ruleDeps);
  if (!result.ok) throw new Error("前置 startBattle 应当成功");
  return result.state;
}

function buildActiveRecord(state: GameState = buildStage3BossReadyState(), revision = 5): GameRecord {
  return {
    gameId: TEST_GAME_ID,
    blueprint: PIPELINE.blueprint,
    state,
    revision,
    createdAt: TEST_CREATED_AT
  };
}

function buildPerformDeps(
  repository: ReturnType<typeof createFakeGameRepository>,
  overrides: Partial<PerformActionDependencies> = {}
): PerformActionDependencies {
  return {
    repository,
    now: () => FIXED_TIME,
    ...overrides
  };
}

/** 构造 applyResult：把 nextState 写回并递增 revision。 */
function makeApplyResult(record: GameRecord, nextState: GameState): ApplyResolvedActionResult {
  return {
    ok: true,
    record: { ...record, state: nextState, revision: record.revision + 1 }
  };
}

const ENEMY_BOSS = asEnemyId("enemy_boss");

// ===========================================================================
// start_battle 路由
// ===========================================================================

describe("performAction：start_battle 路由", () => {
  it("start_battle 成功 → 路由到 battle facade，单次写入，battle active", async () => {
    const repository = createFakeGameRepository();
    const readyState = buildStage3BossReadyState();
    const record = buildActiveRecord(readyState);
    repository.setCurrentResult({ ok: true, status: "active", record });

    // 独立复跑 battle facade 得到期望的最终 state
    const battleResult = startBattle(PIPELINE.blueprint, readyState, ENEMY_BOSS, ruleDeps);
    if (!battleResult.ok) throw new Error("前置 startBattle 应当成功");
    // start_battle 后不需 reconcileQuests（没有任务状态变化）
    // 但需要 resolveEnding（幂等，不会有变化）
    const endingResult = resolveEnding(PIPELINE.blueprint, battleResult.state, ruleDeps);
    // Phase 11：performAction 在 CAS 前归约 storyMemory，期望 state 须含同构 memory。
    const expectedState = { ...endingResult.state, storyMemory: reconcileStoryMemory({ state: endingResult.state }) };

    repository.setApplyResult(makeApplyResult(record, expectedState));

    const result = await performAction(
      { intent: { type: "start_battle", enemyId: ENEMY_BOSS }, expectedRevision: record.revision },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 恰好一次写入
    expect(repository.applyCalls).toHaveLength(1);
    expect(repository.applyCalls[0].nextState).toEqual(expectedState);
    // battle active
    const savedBattle = repository.applyCalls[0].nextState.battle;
    expect(savedBattle.status).toBe("active");
    if (savedBattle.status === "active") {
      expect(savedBattle.enemyId).toBe(ENEMY_BOSS);
      expect(savedBattle.playerHp).toBe(30);
      expect(savedBattle.enemyHp).toBe(20);
      expect(savedBattle.round).toBe(1);
    }
    // 事件含 battle_started
    const tailTypes = repository.applyCalls[0].nextState.eventLedger
      .slice(readyState.eventLedger.length)
      .map((e) => e.type);
    expect(tailTypes).toContain("battle_started");
  });

  it("start_battle 在非 boss 地点被拒 → ACTION_REJECTED，零写入", async () => {
    const repository = createFakeGameRepository();
    const readyState = buildStage3BossReadyState();
    // 玩家不在 boss 地点
    const awayState = { ...readyState, currentLocationId: asLocationId("loc_3") };
    const record = buildActiveRecord(awayState);
    repository.setCurrentResult({ ok: true, status: "active", record });

    const result = await performAction(
      { intent: { type: "start_battle", enemyId: ENEMY_BOSS }, expectedRevision: record.revision },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(repository.applyCalls).toHaveLength(0);
  });
});

describe("performAction：战斗中的 intent 隔离", () => {
  it("active battle 时 move 直接被拒绝，零写入且不改变当前战斗", async () => {
    const repository = createFakeGameRepository();
    const activeState = buildBattleActiveState();
    const record = buildActiveRecord(activeState);
    repository.setCurrentResult({ ok: true, status: "active", record });

    const result = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_3") }, expectedRevision: record.revision },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    if (result.code !== "ACTION_REJECTED") return;
    expect(result.feedback.message).toContain("战斗进行中");
    expect(repository.applyCalls).toHaveLength(0);
    expect(record.state.battle.status).toBe("active");
    expect(record.state.currentLocationId).toBe(asLocationId("loc_4"));
  });
});

// ===========================================================================
// battle_action 路由 — 胜利路径
// ===========================================================================

describe("performAction：battle_action 胜利路径", () => {
  it("连续 attack 击杀 boss → quest_completed + ending_reached(success) 单次写入", async () => {
    const repository = createFakeGameRepository();
    const battleState = buildBattleActiveState();
    const record = buildActiveRecord(battleState, 6);
    repository.setCurrentResult({ ok: true, status: "active", record });

    // 独立复跑 4 次 attack（不击杀）
    let expectedState = battleState;
    for (let i = 0; i < 4; i++) {
      const r = battleAction(PIPELINE.blueprint, expectedState, "attack", ruleDeps);
      if (!r.ok) throw new Error(`第 ${i + 1} 回合 attack 应当成功`);
      expectedState = r.state;
    }
    // 第 5 次 attack 击杀 boss
    const finalAttack = battleAction(PIPELINE.blueprint, expectedState, "attack", ruleDeps);
    if (!finalAttack.ok) throw new Error("第 5 回合 attack 应当成功");
    expectedState = finalAttack.state;
    // reconcileQuests → stage 3 completed
    const reconciled = reconcileQuests(PIPELINE.blueprint, expectedState, ruleDeps);
    expectedState = reconciled.state;
    // resolveEnding → e1 success ending
    const endingResult = resolveEnding(PIPELINE.blueprint, expectedState, ruleDeps);
    expectedState = endingResult.state;

    // 模拟 4 次 attack 的 performAction 调用（repository 每次返回更新后的 state）
    let currentRevision = 6;
    let currentState = battleState;
    for (let i = 0; i < 4; i++) {
      const intermediateRecord = buildActiveRecord(currentState, currentRevision);
      repository.setCurrentResult({ ok: true, status: "active", record: intermediateRecord });
      const r = battleAction(PIPELINE.blueprint, currentState, "attack", ruleDeps);
      if (!r.ok) throw new Error(`第 ${i + 1} 回合 attack 应当成功`);
      const intermediateEnding = resolveEnding(PIPELINE.blueprint, r.state, ruleDeps);
      repository.setApplyResult(makeApplyResult(intermediateRecord, intermediateEnding.state));
      const result = await performAction(
        { intent: { type: "battle_action", action: "attack" }, expectedRevision: currentRevision },
        buildPerformDeps(repository)
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        currentRevision = result.view.revision;
        currentState = intermediateEnding.state;
      }
    }

    // 第 5 次 attack：击杀 boss
    const finalRecord = buildActiveRecord(currentState, currentRevision);
    repository.setCurrentResult({ ok: true, status: "active", record: finalRecord });
    repository.setApplyResult(makeApplyResult(finalRecord, expectedState));

    const result = await performAction(
      { intent: { type: "battle_action", action: "attack" }, expectedRevision: currentRevision },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 最后一次 applyCall 含击杀 + quest_completed + ending_reached
    const lastCall = repository.applyCalls[repository.applyCalls.length - 1];
    const tailTypes = lastCall.nextState.eventLedger
      .slice(currentState.eventLedger.length)
      .map((e) => e.type);
    expect(tailTypes).toContain("battle_round_resolved");
    expect(tailTypes).toContain("battle_resolved");
    expect(tailTypes).toContain("enemy_defeated");
    expect(tailTypes).toContain("quest_completed");
    expect(tailTypes).toContain("ending_reached");
    // ending state
    expect(lastCall.nextState.ending).toEqual({
      endingId: asEndingId("ending_1"),
      outcome: "success",
    });
    // stage 3 completed
    const m3Status = lastCall.nextState.quests.find(
      (q) => q.questId === asQuestId("quest_m3")
    )?.status;
    expect(m3Status).toBe("completed");
  });
});

// ===========================================================================
// battle_action 路由 — 撤退失败路径
// ===========================================================================

describe("performAction：battle_action 撤退失败路径", () => {
  it("withdraw → quest_failed + ending_reached(failure) 单次写入", async () => {
    const repository = createFakeGameRepository();
    const battleState = buildBattleActiveState();
    const record = buildActiveRecord(battleState, 6);
    repository.setCurrentResult({ ok: true, status: "active", record });

    // 独立复跑 withdraw + failQuest + resolveEnding
    const withdrawResult = battleAction(PIPELINE.blueprint, battleState, "withdraw", ruleDeps);
    if (!withdrawResult.ok) throw new Error("withdraw 应当成功");
    let expectedState = withdrawResult.state;
    // failQuest stage 3
    const failResult = failQuest(PIPELINE.blueprint, expectedState, asQuestId("quest_m3"), ruleDeps);
    if (!failResult.ok) throw new Error("failQuest 应当成功");
    expectedState = failResult.state;
    // resolveEnding → e2 failure ending
    const endingResult = resolveEnding(PIPELINE.blueprint, expectedState, ruleDeps);
    expectedState = endingResult.state;

    repository.setApplyResult(makeApplyResult(record, expectedState));

    const result = await performAction(
      { intent: { type: "battle_action", action: "withdraw" }, expectedRevision: 6 },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(repository.applyCalls).toHaveLength(1);
    // 事件包含 battle_resolved + quest_failed + ending_reached
    const tailTypes = repository.applyCalls[0].nextState.eventLedger
      .slice(battleState.eventLedger.length)
      .map((e) => e.type);
    expect(tailTypes).toContain("battle_resolved");
    expect(tailTypes).toContain("quest_failed");
    expect(tailTypes).toContain("ending_reached");
    // ending state
    expect(repository.applyCalls[0].nextState.ending).toEqual({
      endingId: asEndingId("ending_2"),
      outcome: "failure",
    });
    // stage 3 failed
    const m3Status = repository.applyCalls[0].nextState.quests.find(
      (q) => q.questId === asQuestId("quest_m3")
    )?.status;
    expect(m3Status).toBe("failed");
  });
});

// ===========================================================================
// battle_action 拒绝
// ===========================================================================

describe("performAction：battle_action 拒绝", () => {
  it("无 active battle 时 battle_action 被拒 → ACTION_REJECTED，零写入", async () => {
    const repository = createFakeGameRepository();
    const readyState = buildStage3BossReadyState();
    const record = buildActiveRecord(readyState);
    repository.setCurrentResult({ ok: true, status: "active", record });

    const result = await performAction(
      { intent: { type: "battle_action", action: "attack" }, expectedRevision: record.revision },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(repository.applyCalls).toHaveLength(0);
  });
});

// ===========================================================================
// 结局后安全拒绝
// ===========================================================================

describe("performAction：结局后安全拒绝", () => {
  it("结局后任何 action → ACTION_REJECTED，零写入", async () => {
    const repository = createFakeGameRepository();
    const endedState: GameState = {
      ...buildStage3BossReadyState(),
      ending: { endingId: asEndingId("ending_1"), outcome: "success" },
    };
    const record = buildActiveRecord(endedState);
    repository.setCurrentResult({ ok: true, status: "active", record });

    // observe should be rejected
    const result = await performAction(
      { intent: { type: "observe", locationId: endedState.currentLocationId }, expectedRevision: record.revision },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(repository.applyCalls).toHaveLength(0);
  });

  it("结局后 start_battle → ACTION_REJECTED，零写入", async () => {
    const repository = createFakeGameRepository();
    const endedState: GameState = {
      ...buildStage3BossReadyState(),
      ending: { endingId: asEndingId("ending_1"), outcome: "success" },
    };
    const record = buildActiveRecord(endedState);
    repository.setCurrentResult({ ok: true, status: "active", record });

    const result = await performAction(
      { intent: { type: "start_battle", enemyId: ENEMY_BOSS }, expectedRevision: record.revision },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(repository.applyCalls).toHaveLength(0);
  });
});

// ===========================================================================
// battle_action 中途保存后 reload 一致性
// ===========================================================================

describe("performAction：battle 中途保存后 reload", () => {
  it("attack 后保存的 state reload 后 battle 一致", async () => {
    const repository = createFakeGameRepository();
    const battleState = buildBattleActiveState();
    const record = buildActiveRecord(battleState, 6);
    repository.setCurrentResult({ ok: true, status: "active", record });

    // 独立复跑 attack
    const attackResult = battleAction(PIPELINE.blueprint, battleState, "attack", ruleDeps);
    if (!attackResult.ok) throw new Error("attack 应当成功");
    const endingResult = resolveEnding(PIPELINE.blueprint, attackResult.state, ruleDeps);
    const expectedState = endingResult.state;

    repository.setApplyResult(makeApplyResult(record, expectedState));

    const result = await performAction(
      { intent: { type: "battle_action", action: "attack" }, expectedRevision: 6 },
      buildPerformDeps(repository)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // saved state 中 battle 仍 active
    const savedBattle = repository.applyCalls[0].nextState.battle;
    expect(savedBattle.status).toBe("active");
    if (savedBattle.status === "active") {
      expect(savedBattle.enemyHp).toBe(16); // 20 - 4
      expect(savedBattle.playerHp).toBe(29); // 30 - 1
      expect(savedBattle.round).toBe(2);
    }
  });
});
