import type {
  EnemyId,
  GameEvent,
  GameState,
  ScenarioBlueprint
} from "@/game/domain";

// ---------------------------------------------------------------------------
// Phase 6：战斗行动纯规则。
//
// battle_action { action: "attack" | "guard" | "withdraw" } 仅在 active battle
// 内合法；resolved/idle 状态一律拒绝且零写入。
//
// 回合完全确定：
//   attack  — 先造成 max(1, player.attack - enemy.defense)；
//             敌人未倒下才反击 max(1, enemy.attack - player.defense)；
//             胜利不触发反击。
//   guard   — 不造成敌伤；反击伤害固定减 2（最低 1）。
//   withdraw— 立即以失败结束 battle。
//
// 生命归零（enemyHp <= 0 → 胜利；playerHp <= 0 → 失败）。
// 胜利追加 enemy_defeated 并把 enemy ID 写入 defeatedEnemyIds；battle → resolved。
// 失败/撤退追加 battle_resolved；battle → resolved。
// 纯函数：不修改输入 state，不依赖 application/repository/UI/Math.random/AI。
// ---------------------------------------------------------------------------

import type {
  BattleFeedback,
  BattleResolveDependencies,
  BattleValidationCode,
} from "./startBattle";

export type BattleActionResult = {
  readonly ok: true;
  readonly state: GameState;
  readonly events: readonly GameEvent[];
  readonly feedback: BattleFeedback;
} | {
  readonly ok: false;
  readonly code: BattleValidationCode;
  readonly params: Record<string, string>;
  readonly feedback: BattleFeedback;
};

export type BattleAction = "attack" | "guard" | "withdraw";

export function battleAction(
  blueprint: ScenarioBlueprint,
  state: GameState,
  action: BattleAction,
  deps: BattleResolveDependencies,
): BattleActionResult {
  if (state.battle.status !== "active") {
    return {
      ok: false,
      code: "NO_ACTIVE_BATTLE",
      params: { battleStatus: state.battle.status },
      feedback: {
        message: state.battle.status === "idle"
          ? "当前没有进行中的战斗。"
          : "战斗已经结束。",
      },
    };
  }

  const battle = state.battle;
  const enemy = blueprint.enemies.find((e) => e.id === battle.enemyId);
  if (enemy === undefined) {
    // 蓝图损坏：不应发生，但防御性拒绝。
    return {
      ok: false,
      code: "UNKNOWN_ENEMY",
      params: { enemyId: battle.enemyId },
      feedback: { message: "战斗中的敌人在蓝图中不存在。" },
    };
  }

  const occurredAt = deps.now();
  const events: GameEvent[] = [];
  const player = state.player.stats;

  if (action === "withdraw") {
    // 撤退：立即以失败结束，不产生 round 事件。
    events.push({
      type: "battle_resolved",
      enemyId: battle.enemyId,
      outcome: "withdraw",
      occurredAt,
    });

    const newState: GameState = {
      ...state,
      battle: {
        status: "resolved",
        enemyId: battle.enemyId,
        outcome: "withdraw",
      },
      eventLedger: [...state.eventLedger, ...events],
    };

    return {
      ok: true,
      state: newState,
      events,
      feedback: { message: "你选择了撤退，战斗以失败告终。" },
    };
  }

  // attack 或 guard：计算伤害
  let enemyHp = battle.enemyHp;
  let playerHp = battle.playerHp;

  if (action === "attack") {
    const playerDamage = Math.max(1, player.attack - enemy.stats.defense);
    enemyHp = Math.max(0, enemyHp - playerDamage);
  }
  // guard: 不造成敌伤

  if (enemyHp <= 0) {
    // 胜利！不触发反击
    events.push({
      type: "battle_round_resolved",
      enemyId: battle.enemyId,
      round: battle.round,
      playerHp,
      enemyHp: 0,
      action,
      occurredAt,
    });
    events.push({
      type: "battle_resolved",
      enemyId: battle.enemyId,
      outcome: "victory",
      occurredAt,
    });
    events.push({
      type: "enemy_defeated",
      enemyId: battle.enemyId,
      occurredAt,
    });

    const newState: GameState = {
      ...state,
      battle: {
        status: "resolved",
        enemyId: battle.enemyId,
        outcome: "victory",
      },
      defeatedEnemyIds: [...state.defeatedEnemyIds, battle.enemyId],
      eventLedger: [...state.eventLedger, ...events],
    };

    return {
      ok: true,
      state: newState,
      events,
      feedback: { message: `你击败了${enemy.name}！` },
    };
  }

  // 敌人未倒下：反击
  let counterDamage: number;
  if (action === "guard") {
    counterDamage = Math.max(1, enemy.stats.attack - player.defense - 2);
  } else {
    counterDamage = Math.max(1, enemy.stats.attack - player.defense);
  }
  playerHp = Math.max(0, playerHp - counterDamage);

  if (playerHp <= 0) {
    // 失败
    events.push({
      type: "battle_round_resolved",
      enemyId: battle.enemyId,
      round: battle.round,
      playerHp: 0,
      enemyHp,
      action,
      occurredAt,
    });
    events.push({
      type: "battle_resolved",
      enemyId: battle.enemyId,
      outcome: "defeat",
      occurredAt,
    });

    const newState: GameState = {
      ...state,
      battle: {
        status: "resolved",
        enemyId: battle.enemyId,
        outcome: "defeat",
      },
      eventLedger: [...state.eventLedger, ...events],
    };

    return {
      ok: true,
      state: newState,
      events,
      feedback: { message: `你被${enemy.name}击败了……` },
    };
  }

  // 战斗继续
  events.push({
    type: "battle_round_resolved",
    enemyId: battle.enemyId,
    round: battle.round,
    playerHp,
    enemyHp,
    action,
    occurredAt,
  });

  const newState: GameState = {
    ...state,
    battle: {
      status: "active",
      enemyId: battle.enemyId,
      playerHp,
      enemyHp,
      round: battle.round + 1,
    },
    eventLedger: [...state.eventLedger, ...events],
  };

  return {
    ok: true,
    state: newState,
    events,
    feedback: {
      message: action === "attack"
        ? `你发起攻击，造成 ${Math.max(1, player.attack - enemy.stats.defense)} 点伤害；敌人反击造成 ${counterDamage} 点伤害。`
        : `你摆出防御姿态；敌人反击造成 ${counterDamage} 点伤害。`,
    },
  };
}
