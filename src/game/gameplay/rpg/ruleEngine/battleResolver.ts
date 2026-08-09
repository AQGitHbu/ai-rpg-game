import type { WorldState } from "@/game/domain/worldState";
import type { EnemyId } from "@/game/domain/scenarioBlueprint";
import type { GameEvent } from "@/game/domain/events";
import type { ResolvedEventStatus, StateChange, FactChange } from "@/game/domain/resolvedEvent";
import type { ResolveDeps, ResolveResult } from "./resolveByType";

// ---------------------------------------------------------------------------
// 战斗纯函数：操作 WorldState，不依赖 ScenarioBlueprint。
// 只要敌人存在且在玩家地点即可开战。
// 纯函数：不修改输入 state，不依赖 IO/Date/Math.random/AI。
// ---------------------------------------------------------------------------

export type BattleResolveDeps = Pick<ResolveDeps, "now">;

/** 校验并初始化战斗状态。 */
export function startBattle(
  ws: WorldState,
  enemyId: EnemyId,
  deps: BattleResolveDeps,
): ResolveResult {
  // 已有 active battle
  if (ws.battle.status !== "idle") {
    return { ok: false, feedback: "已有进行中的战斗。" };
  }

  // 敌人存在
  const enemy = ws.enemies.find((e) => e.id === enemyId);
  if (enemy === undefined) {
    return { ok: false, feedback: "未知敌人。" };
  }

  // 玩家位于敌人地点
  if (ws.currentLocationId !== enemy.locationId) {
    return { ok: false, feedback: "你不在该敌人所在的地点。" };
  }

  // 敌人未被击败
  if (ws.defeatedEnemyIds.includes(enemyId)) {
    return { ok: false, feedback: "该敌人已被击败。" };
  }

  const occurredAt = deps.now();
  const event: GameEvent = { type: "battle_started", enemyId, occurredAt };

  const nextWs: WorldState = {
    ...ws,
    battle: {
      status: "active",
      enemyId,
      playerHp: ws.player.stats.hp,
      enemyHp: enemy.stats.hp,
      round: 1,
    },
    eventLedger: [...ws.eventLedger, event],
  };

  const stateChanges: StateChange[] = [
    { path: "battle", description: `与${enemy.name}展开战斗`, operation: "set" },
  ];

  return {
    ok: true,
    nextWorldState: nextWs,
    events: [event],
    feedback: `战斗开始：你与${enemy.name}展开了决斗！`,
    status: "success",
    stateChanges,
    facts: [],
  };
}

/** 处理 attack/guard/flee。flee 以 withdraw 结果落账。 */
export function battleAction(
  ws: WorldState,
  action: "attack" | "guard" | "flee",
  deps: BattleResolveDeps,
): ResolveResult {
  if (ws.battle.status !== "active") {
    return { ok: false, feedback: ws.battle.status === "idle" ? "当前没有进行中的战斗。" : "战斗已经结束。" };
  }

  const battle = ws.battle;
  const enemy = ws.enemies.find((e) => e.id === battle.enemyId);
  if (enemy === undefined) {
    return { ok: false, feedback: "战斗中的敌人不存在。" };
  }

  const occurredAt = deps.now();
  const events: GameEvent[] = [];
  const player = ws.player.stats;

  // flee → withdraw 语义
  if (action === "flee") {
    events.push({
      type: "battle_resolved",
      enemyId: battle.enemyId,
      outcome: "withdraw",
      occurredAt,
    });

    const nextWs: WorldState = {
      ...ws,
      battle: { status: "resolved", enemyId: battle.enemyId, outcome: "withdraw" },
      eventLedger: [...ws.eventLedger, ...events],
    };

    return {
      ok: true,
      nextWorldState: nextWs,
      events,
      feedback: "你选择了撤退，战斗以失败告终。",
      status: "success",
      stateChanges: [{ path: "battle", description: "撤退", operation: "set" }],
      facts: [],
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

    const nextWs: WorldState = {
      ...ws,
      battle: { status: "resolved", enemyId: battle.enemyId, outcome: "victory" },
      defeatedEnemyIds: [...ws.defeatedEnemyIds, battle.enemyId],
      eventLedger: [...ws.eventLedger, ...events],
    };

    return {
      ok: true,
      nextWorldState: nextWs,
      events,
      feedback: `你击败了${enemy.name}！`,
      status: "success",
      stateChanges: [
        { path: "battle", description: `击败${enemy.name}`, operation: "set" },
        { path: "defeatedEnemyIds", description: `记录击败`, operation: "add" },
      ],
      facts: [],
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

    const nextWs: WorldState = {
      ...ws,
      battle: { status: "resolved", enemyId: battle.enemyId, outcome: "defeat" },
      eventLedger: [...ws.eventLedger, ...events],
    };

    return {
      ok: true,
      nextWorldState: nextWs,
      events,
      feedback: `你被${enemy.name}击败了……`,
      status: "failure",
      stateChanges: [{ path: "battle", description: `被${enemy.name}击败`, operation: "set" }],
      facts: [],
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

  const nextWs: WorldState = {
    ...ws,
    battle: {
      status: "active",
      enemyId: battle.enemyId,
      playerHp,
      enemyHp,
      round: battle.round + 1,
    },
    eventLedger: [...ws.eventLedger, ...events],
  };

  const playerDamage = action === "attack" ? Math.max(1, player.attack - enemy.stats.defense) : 0;

  return {
    ok: true,
    nextWorldState: nextWs,
    events,
    feedback: action === "attack"
      ? `你发起攻击，造成 ${playerDamage} 点伤害；敌人反击造成 ${counterDamage} 点伤害。`
      : `你摆出防御姿态；敌人反击造成 ${counterDamage} 点伤害。`,
    status: "success",
    stateChanges: [{ path: "battle", description: `回合 ${battle.round} 结算`, operation: "update" }],
    facts: [],
  };
}
