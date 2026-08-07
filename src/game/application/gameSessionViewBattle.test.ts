import { describe, expect, it } from "vitest";
import {
  asEnemyId,
  asEndingId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
  type GameState,
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
import {
  compileScenarioBlueprint,
  initializeGameState,
  validateScenarioBlueprintCandidate
} from "@/game/gameplay/rpg/scenario";
import {
  makeValidCandidate,
  TEST_POLICY,
  TEST_PROFILE
} from "@/game/gameplay/rpg/scenario/scenarioBlueprintFixture.testutil";
import {
  projectGameSessionView,
  type GameSessionView,
} from "./gameSessionView";
import { TEST_GAME_ID } from "./applicationFixture.testutil";

// ---------------------------------------------------------------------------
// Phase 6 Task 3c：GameSessionView battle/ending read model 测试。
//
// 验证：
// - 普通场景：battle=null, ending=null, availableActions 含常规行动
// - active battle：battle 含 enemyName/playerHp/enemyHp/round, availableActions 含 battle_action
// - 结局：ending 含 name/description/outcome, availableActions 为空
// - 不泄漏 seed/blueprint/内部 ID
//
// Phase 14：createGame 只产出 1 幕起始锚点；本文件改用 makeValidCandidate 的
// 运行时扩展蓝图（runtime_expansion 阶段）驱动全部断言。boss = enemy_b（loc_d，
// hp20/atk5/def2），玩家 hp30/atk6/def4 ⇒ 每回合 attack 造成 4 伤害、5 回合击杀，
// boss 每回合反击 1 伤害。stage 3 = m3（defeat_enemy enemy_b）→ 胜利 e1 / 失败 e2。
// ---------------------------------------------------------------------------

const FIXED_TIME = "2026-07-27T12:00:00.000Z";
const ruleDeps = { now: () => FIXED_TIME };

function compileRuntimeBlueprint() {
  const compiled = compileScenarioBlueprint(
    validateScenarioBlueprintCandidate(makeValidCandidate(), {
      profile: TEST_PROFILE,
      policy: TEST_POLICY,
      phase: "runtime_expansion"
    })
  );
  if (!compiled.ok) {
    throw new Error(`fixture 蓝图应当合法：${JSON.stringify(compiled.issues)}`);
  }
  return compiled.blueprint;
}

const PIPELINE = { blueprint: compileRuntimeBlueprint() };

function buildStage3BossReadyState(): GameState {
  const intents: readonly PlayerIntent[] = [
    { type: "move", locationId: asLocationId("loc_b") },
    { type: "move", locationId: asLocationId("loc_c") },
    { type: "talk", npcId: asNpcId("npc_c") },
    { type: "take_item", itemId: asItemId("item_b") },
    { type: "move", locationId: asLocationId("loc_d") },
  ];
  let state = initializeGameState(PIPELINE.blueprint);
  for (const intent of intents) {
    const resolved = resolveAction(PIPELINE.blueprint, state, intent, ruleDeps);
    if (!resolved.ok) throw new Error(`前置行动应当成功：${resolved.code}`);
    state = reconcileQuests(PIPELINE.blueprint, resolved.state, ruleDeps).state;
  }
  return state;
}

function projectView(state: GameState, revision = 0): GameSessionView {
  return projectGameSessionView({
    gameId: TEST_GAME_ID,
    blueprint: PIPELINE.blueprint,
    state,
    revision,
    worldName: "武侠"
  });
}

const ENEMY_BOSS = asEnemyId("enemy_b");

describe("GameSessionView：普通场景状态", () => {
  it("battle=null, ending=null, availableActions 含常规行动", () => {
    const view = projectView(initializeGameState(PIPELINE.blueprint));
    expect(view.battle).toBeNull();
    expect(view.ending).toBeNull();
    expect(view.availableActions.length).toBeGreaterThan(0);
  });
});

describe("GameSessionView：active battle 状态", () => {
  it("battle 含 enemyName/playerHp/enemyHp/round", () => {
    const readyState = buildStage3BossReadyState();
    const started = startBattle(PIPELINE.blueprint, readyState, ENEMY_BOSS, ruleDeps);
    if (!started.ok) throw new Error("前置 startBattle 应当成功");

    const view = projectView(started.state);

    expect(view.battle).not.toBeNull();
    if (view.battle !== null) {
      // enemyName 来自蓝图敌人的 name
      const enemy = PIPELINE.blueprint.enemies.find((e) => e.id === ENEMY_BOSS);
      expect(view.battle.enemyName).toBe(enemy?.name);
      expect(view.battle.playerHp).toBe(30);
      expect(view.battle.enemyHp).toBe(20);
      expect(view.battle.round).toBe(1);
    }
    // availableActions 只含 battle_action（attack/guard/withdraw）
    const actionTypes = view.availableActions.map((a) => a.type);
    expect(actionTypes.every((t) => t === "battle_action")).toBe(true);
    expect(actionTypes).toHaveLength(3);
  });

  it("attack 后 battle HP 和 round 更新", () => {
    const readyState = buildStage3BossReadyState();
    const started = startBattle(PIPELINE.blueprint, readyState, ENEMY_BOSS, ruleDeps);
    if (!started.ok) throw new Error("前置 startBattle 应当成功");
    const attacked = battleAction(PIPELINE.blueprint, started.state, "attack", ruleDeps);
    if (!attacked.ok) throw new Error("attack 应当成功");

    const view = projectView(attacked.state);
    expect(view.battle).not.toBeNull();
    if (view.battle !== null) {
      expect(view.battle.playerHp).toBe(29);
      expect(view.battle.enemyHp).toBe(16);
      expect(view.battle.round).toBe(2);
    }
  });
});

describe("GameSessionView：结局状态", () => {
  it("ending 含 name/description/outcome（success）", () => {
    const readyState = buildStage3BossReadyState();
    // 模拟胜利后完成 stage 3 + 结局
    const started = startBattle(PIPELINE.blueprint, readyState, ENEMY_BOSS, ruleDeps);
    if (!started.ok) throw new Error("前置 startBattle 应当成功");
    let state = started.state;
    for (let i = 0; i < 5; i++) {
      const r = battleAction(PIPELINE.blueprint, state, "attack", ruleDeps);
      if (!r.ok) throw new Error(`第 ${i + 1} 回合 attack 应当成功`);
      state = r.state;
    }
    const reconciled = reconcileQuests(PIPELINE.blueprint, state, ruleDeps);
    const endingResult = resolveEnding(PIPELINE.blueprint, reconciled.state, ruleDeps);

    const view = projectView(endingResult.state);

    expect(view.ending).not.toBeNull();
    if (view.ending !== null) {
      const ending = PIPELINE.blueprint.endings.find((e) => e.id === asEndingId("e1"));
      expect(view.ending.name).toBe(ending?.name);
      expect(view.ending.description).toBe(ending?.description);
      expect(view.ending.outcome).toBe("success");
    }
    // 结局后无可用行动
    expect(view.availableActions).toHaveLength(0);
  });

  it("ending 含 name/description/outcome（failure）", () => {
    const readyState = buildStage3BossReadyState();
    const started = startBattle(PIPELINE.blueprint, readyState, ENEMY_BOSS, ruleDeps);
    if (!started.ok) throw new Error("前置 startBattle 应当成功");
    const withdrawn = battleAction(PIPELINE.blueprint, started.state, "withdraw", ruleDeps);
    if (!withdrawn.ok) throw new Error("withdraw 应当成功");

    const failResult = failQuest(PIPELINE.blueprint, withdrawn.state, asQuestId("m3"), ruleDeps);
    if (!failResult.ok) throw new Error("failQuest 应当成功");
    const endingResult = resolveEnding(PIPELINE.blueprint, failResult.state, ruleDeps);

    const view = projectView(endingResult.state);

    expect(view.ending).not.toBeNull();
    if (view.ending !== null) {
      const ending = PIPELINE.blueprint.endings.find((e) => e.id === asEndingId("e2"));
      expect(view.ending.name).toBe(ending?.name);
      expect(view.ending.description).toBe(ending?.description);
      expect(view.ending.outcome).toBe("failure");
    }
    expect(view.availableActions).toHaveLength(0);
  });

  it("结局后 resolved battle 不投影 HP/round", () => {
    const readyState = buildStage3BossReadyState();
    const started = startBattle(PIPELINE.blueprint, readyState, ENEMY_BOSS, ruleDeps);
    if (!started.ok) throw new Error("前置 startBattle 应当成功");
    let state = started.state;
    for (let i = 0; i < 5; i++) {
      const r = battleAction(PIPELINE.blueprint, state, "attack", ruleDeps);
      if (!r.ok) throw new Error(`第 ${i + 1} 回合 attack 应当成功`);
      state = r.state;
    }
    const reconciled = reconcileQuests(PIPELINE.blueprint, state, ruleDeps);
    const endingResult = resolveEnding(PIPELINE.blueprint, reconciled.state, ruleDeps);

    const view = projectView(endingResult.state);
    // resolved battle 不投影 active battle 摘要（无 HP/round 可展示）
    expect(view.battle).toBeNull();
  });
});

describe("GameSessionView：不泄漏敏感信息", () => {
  it("battle 视图不含 enemyId/enemy stats", () => {
    const readyState = buildStage3BossReadyState();
    const started = startBattle(PIPELINE.blueprint, readyState, ENEMY_BOSS, ruleDeps);
    if (!started.ok) throw new Error("前置 startBattle 应当成功");

    const view = projectView(started.state);
    const json = JSON.stringify(view.battle);
    expect(json).not.toContain("enemy_b");
    expect(json).not.toContain("attack");
    expect(json).not.toContain("defense");
    expect(json).not.toContain("tier");
  });

  it("ending 视图不含 endingId", () => {
    const readyState = buildStage3BossReadyState();
    const endedState: GameState = {
      ...readyState,
      ending: { endingId: asEndingId("e1"), outcome: "success" },
    };

    const view = projectView(endedState);
    const json = JSON.stringify(view.ending);
    expect(json).not.toContain("e1");
    expect(json).not.toContain("endingId");
  });
});
