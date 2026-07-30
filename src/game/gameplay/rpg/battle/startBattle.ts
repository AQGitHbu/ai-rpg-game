import { finalMainActOf } from "@/game/domain";
import type {
  EnemyId,
  GameEvent,
  GameState,
  ScenarioBlueprint
} from "@/game/domain";

// ---------------------------------------------------------------------------
// Phase 6：战斗开始纯规则。
//
// start_battle { enemyId } 仅在以下条件全部满足时合法：
//   1. 未结局（state.ending === null）
//   2. 无 active battle（state.battle.status === "idle"）
//   3. 玩家位于敌人地点（state.currentLocationId === enemy.locationId）
//   4. 敌人存在且是 active stage 3 的 defeat_enemy 目标
//   5. 敌人未被击败（不在 defeatedEnemyIds 中）
//
// 成功时把 battle 置为 active，初始化双方 HP（来自蓝图 StatBlock）和 round=1，
// 追加 battle_started 事件。
// 纯函数：不修改输入 state，不依赖 application/repository/UI/Math.random/AI。
// ---------------------------------------------------------------------------

export type BattleFeedback = {
  readonly message: string;
};

export type BattleValidationCode =
  | "UNKNOWN_ENEMY"
  | "ENEMY_NOT_AT_LOCATION"
  | "BATTLE_ALREADY_ACTIVE"
  | "ENDING_REACHED"
  | "ENEMY_NOT_STAGE3_TARGET"
  | "ENEMY_ALREADY_DEFEATED"
  | "NO_ACTIVE_BATTLE";

export type BattleResolveDependencies = {
  readonly now: () => string;
};

export type StartBattleResult = {
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

export function startBattle(
  blueprint: ScenarioBlueprint,
  state: GameState,
  enemyId: EnemyId,
  deps: BattleResolveDependencies,
): StartBattleResult {
  // 1. 未结局
  if (state.ending !== null) {
    return {
      ok: false,
      code: "ENDING_REACHED",
      params: { endingId: state.ending.endingId },
      feedback: { message: "游戏已结局，无法开始战斗。" },
    };
  }

  // 2. 无 active battle
  if (state.battle.status !== "idle") {
    return {
      ok: false,
      code: "BATTLE_ALREADY_ACTIVE",
      params: {},
      feedback: { message: "已有进行中的战斗。" },
    };
  }

  // 3. 敌人存在
  const enemy = blueprint.enemies.find((e) => e.id === enemyId);
  if (enemy === undefined) {
    return {
      ok: false,
      code: "UNKNOWN_ENEMY",
      params: { enemyId },
      feedback: { message: "未知敌人。" },
    };
  }

  // 4. 玩家位于敌人地点
  if (state.currentLocationId !== enemy.locationId) {
    return {
      ok: false,
      code: "ENEMY_NOT_AT_LOCATION",
      params: { enemyId, currentLocationId: state.currentLocationId, enemyLocationId: enemy.locationId },
      feedback: { message: "你不在该敌人所在的地点。" },
    };
  }

  // 5. 敌人未被击败
  if (state.defeatedEnemyIds.includes(enemyId)) {
    return {
      ok: false,
      code: "ENEMY_ALREADY_DEFEATED",
      params: { enemyId },
      feedback: { message: "该敌人已被击败。" },
    };
  }

  // 6. 敌人是 active 终幕的 defeat_enemy 目标
  const isStage3Target = blueprint.quests.some((quest) => {
    if (quest.kind !== "main" || quest.stage !== finalMainActOf(blueprint)) return false;
    const questState = state.quests.find((qs) => qs.questId === quest.id);
    return questState?.status === "active" &&
      quest.objectives.some((obj) => obj.kind === "defeat_enemy" && obj.enemyId === enemyId);
  });
  if (!isStage3Target) {
    return {
      ok: false,
      code: "ENEMY_NOT_STAGE3_TARGET",
      params: { enemyId },
      feedback: { message: "该敌人不是当前主线任务的挑战目标。" },
    };
  }

  // 成功：初始化战斗状态
  const occurredAt = deps.now();
  const event: GameEvent = {
    type: "battle_started",
    enemyId,
    occurredAt,
  };

  const newState: GameState = {
    ...state,
    battle: {
      status: "active",
      enemyId,
      playerHp: state.player.stats.hp,
      enemyHp: enemy.stats.hp,
      round: 1,
    },
    eventLedger: [...state.eventLedger, event],
  };

  return {
    ok: true,
    state: newState,
    events: [event],
    feedback: { message: `战斗开始：你与${enemy.name}展开了决斗！` },
  };
}
