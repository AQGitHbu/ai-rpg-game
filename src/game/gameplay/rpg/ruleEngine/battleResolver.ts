import type { WorldState, BattleStartSnapshot } from "@/game/domain/worldState";
import type { EnemyId } from "@/game/domain/worldEntity";
import type { GameEvent } from "@/game/domain/events";
import type { StateChange } from "@/game/domain/resolvedEvent";
import type { ResolveDeps, ResolveResult } from "./resolveByType";
import type { ActiveBattleCombatState, BattleCombatant, CombatActionKind, CombatCommand } from "@/game/domain/combat";
import { buildEncounter } from "./buildEncounter";
import { advanceUntilPlayerDecision } from "./advanceBattle";
import { createTurnOrder } from "./combatMath";
import { applyEntityMutations } from "@/game/gameplay/rpg/entityWorld";

// ---------------------------------------------------------------------------
// 战斗纯函数：操作 WorldState，不依赖世界生成聚合。
// 只要敌人存在且在玩家地点即可开战。
// 纯函数：不修改输入 state，不依赖 IO/Date/Math.random/AI。
// ---------------------------------------------------------------------------

export type BattleResolveDeps = Pick<ResolveDeps, "now">;

type ActiveBattle = Extract<WorldState["battle"], { status: "active" }>;

function isModernBattle(battle: ActiveBattle): battle is ActiveBattle & ActiveBattleCombatState {
  return Array.isArray(battle.combatants)
    && Array.isArray(battle.turnOrder)
    && Array.isArray(battle.enemyIntents)
    && Array.isArray(battle.downedEnemyIds)
    && Array.isArray(battle.lastAdvance)
    && typeof battle.turnIndex === "number";
}

function snapshotHp(combatants: readonly BattleCombatant[], enemyId: EnemyId): { playerHp: number; enemyHp: number } {
  const playerHp = combatants.find((unit) => unit.side === "allies")?.hp ?? 0;
  const enemyHp = combatants.find((unit) => unit.source.kind === "enemy" && unit.source.enemyId === enemyId)?.hp
    ?? combatants.find((unit) => unit.side === "enemies")?.hp
    ?? 0;
  return { playerHp, enemyHp };
}

function activeBattleState(enemyId: EnemyId, enemyIds: readonly EnemyId[], state: ActiveBattleCombatState, battleKey?: string, preBattleSnapshot?: BattleStartSnapshot): ActiveBattle {
  const hp = snapshotHp(state.combatants, enemyId);
  return {
    status: "active",
    enemyId,
    enemyIds,
    playerHp: hp.playerHp,
    enemyHp: hp.enemyHp,
    ...(battleKey === undefined ? {} : { battleKey }),
    ...(preBattleSnapshot === undefined ? {} : { preBattleSnapshot }),
    ...state,
  };
}

function modernFeedback(results: readonly ActiveBattleCombatState["lastAdvance"][number][], combatants: readonly BattleCombatant[]): string {
  if (results.length === 0) return "轮到你行动。";
  return results.map((result) => {
    const actor = combatants.find((unit) => unit.combatantId === result.actorId)?.name ?? "单位";
    if (result.kind === "guard") return `${actor}采取防御姿态。`;
    if (result.kind === "flee") return `${actor}撤出了战斗。`;
    return `${actor}${result.kind === "skill" ? "施放技能" : "攻击"}${result.damage > 0 ? `，造成 ${result.damage} 点伤害` : ""}。`;
  }).join(" ");
}

function modernResult(
  ws: WorldState,
  battle: ActiveBattle,
  command: CombatActionKind,
  advanced: ReturnType<typeof advanceUntilPlayerDecision>,
  deps: BattleResolveDeps,
): ResolveResult {
  const occurredAt = deps.now();
  const enemyIds = battle.enemyIds ?? [battle.enemyId];
  const hp = snapshotHp(advanced.state.combatants, battle.enemyId);
  const roundEvent: GameEvent = {
    type: "battle_round_resolved",
    enemyId: battle.enemyId,
    round: advanced.state.round,
    playerHp: hp.playerHp,
    enemyHp: hp.enemyHp,
    action: command === "flee" ? "withdraw" : command,
    results: advanced.results,
    occurredAt,
  };
  const events: GameEvent[] = [roundEvent];
  const outcome = advanced.outcome;
  if (outcome === null) {
    const nextBattle = activeBattleState(
      battle.enemyId,
      enemyIds,
      advanced.state,
      battle.battleKey,
      battle.preBattleSnapshot,
    );
    const nextWs: WorldState = { ...ws, battle: nextBattle, eventLedger: [...ws.eventLedger, roundEvent] };
    return {
      ok: true,
      nextWorldState: nextWs,
      events,
      feedback: modernFeedback(advanced.results, advanced.state.combatants),
      status: "success",
      stateChanges: [{ path: "battle", description: `回合 ${advanced.state.round} 结算`, operation: "update" }],
      facts: [],
    };
  }

  events.push({ type: "battle_resolved", enemyId: battle.enemyId, enemyIds, outcome, occurredAt });
  for (const defeatedId of advanced.state.downedEnemyIds) {
    events.push({ type: "enemy_defeated", enemyId: defeatedId, occurredAt });
  }
  // 现代遭遇可先击倒一个敌人再撤退；resolver 保留当下结算事实，应用层在
  // withdraw/defeat 时用完整战前快照回滚，因此两层语义都保持一致。
  const mutation = applyEntityMutations(ws, advanced.state.downedEnemyIds.map((enemyId) => ({ kind: "set_enemy_defeated" as const, enemyId, defeated: true })));
  if (!mutation.ok) return { ok: false, feedback: "战斗世界状态不一致。" };
  const nextWs: WorldState = {
    ...mutation.worldState,
    battle: { status: "resolved", enemyId: battle.enemyId, outcome, ...(battle.battleKey === undefined ? {} : { battleKey: battle.battleKey }) },
    eventLedger: [...mutation.worldState.eventLedger, ...events],
  };
  const firstEnemy = ws.enemies.find((enemy) => enemy.id === battle.enemyId);
  const label = outcome === "victory" ? `你击败了${firstEnemy?.name ?? "敌人"}！`
    : outcome === "withdraw" ? "你选择了撤退，战斗以失败告终。"
      : `你被${firstEnemy?.name ?? "敌人"}击败了……`;
  return {
    ok: true,
    nextWorldState: nextWs,
    events,
    feedback: label,
    status: outcome === "defeat" ? "failure" : "success",
    stateChanges: [{ path: "battle", description: outcome === "victory" ? "战斗胜利" : "战斗结束", operation: "set" }],
    facts: [],
  };
}

function modernBattleAction(
  ws: WorldState,
  action: CombatActionKind,
  deps: BattleResolveDeps,
  requestedCommand?: Omit<CombatCommand, "kind">,
): ResolveResult {
  if (ws.battle.status !== "active" || !isModernBattle(ws.battle)) return { ok: false, feedback: "当前战斗状态不可推进。" };
  const battle = ws.battle;
  const actorId = battle.turnOrder[battle.turnIndex];
  const actor = battle.combatants.find((unit) => unit.combatantId === actorId);
  if (actor === undefined || actor.controller !== "player") return { ok: false, feedback: "尚未轮到玩家行动。" };
  if (requestedCommand?.actorId !== undefined && requestedCommand.actorId !== actorId) {
    return { ok: false, feedback: "战斗行动者与当前回合不匹配。" };
  }
  const requestedTargetId = requestedCommand?.actorId === actorId ? requestedCommand.targetId : undefined;
  const command: CombatCommand = {
    actorId,
    kind: action,
    targetId: action === "attack" || action === "skill"
      ? requestedTargetId ?? battle.combatants.find((unit) => unit.side === "enemies" && unit.hp > 0)?.combatantId
      : undefined,
  };
  try {
    const advanced = advanceUntilPlayerDecision(battle, command);
    return modernResult(ws, battle, action, advanced, deps);
  } catch (error) {
    return { ok: false, feedback: error instanceof Error ? error.message : "战斗行动无效。" };
  }
}

/** 校验并初始化战斗状态。 */
export function startBattle(
  ws: WorldState,
  enemyId: EnemyId,
  deps: BattleResolveDeps,
): ResolveResult {
  // resolved 只表示上一场战斗的结果；没有 active battle 时可以重新挑战
  // 尚未击败的敌人，避免撤退后界面仍有“挑战”按钮却永远被规则拒绝。
  if (ws.battle.status === "active") {
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

  const encounter = buildEncounter(ws, enemyId);
  if (typeof ws.player.stats.maxEnergy === "number" && typeof ws.player.stats.speed === "number" && encounter.length >= 2) {
    const enemyIds = encounter
      .filter((unit): unit is BattleCombatant & { readonly source: { readonly kind: "enemy"; readonly enemyId: EnemyId } } => unit.source.kind === "enemy")
      .map((unit) => unit.source.enemyId);
    const initial: ActiveBattleCombatState = {
      round: 1,
      combatants: encounter,
      turnOrder: createTurnOrder(encounter),
      turnIndex: 0,
      enemyIntents: [],
      downedEnemyIds: [],
      lastAdvance: [],
    };
    const advanced = advanceUntilPlayerDecision(initial, null);
    const occurredAt = deps.now();
    const event: GameEvent = { type: "battle_started", enemyId, enemyIds, occurredAt };
    const preBattleSnapshot: BattleStartSnapshot = {
      entityStore: ws.entityStore,
      eventLedger: ws.eventLedger,
    };
    const nextWs: WorldState = {
      ...ws,
      battle: activeBattleState(enemyId, enemyIds, advanced.state, occurredAt, preBattleSnapshot),
      eventLedger: [...ws.eventLedger, event],
    };
    return {
      ok: true,
      nextWorldState: nextWs,
      events: [event],
      feedback: `战斗开始：你与${enemy.name}${enemyIds.length > 2 ? `等 ${enemyIds.length} 名敌人` : "展开了战斗"}！`,
      status: "success",
      stateChanges: [{ path: "battle", description: `与${enemy.name}展开战斗`, operation: "set" }],
      facts: [],
    };
  }

  const occurredAt = deps.now();
  const event: GameEvent = { type: "battle_started", enemyId, occurredAt };
  const preBattleSnapshot: BattleStartSnapshot = {
    entityStore: ws.entityStore,
    eventLedger: ws.eventLedger,
  };

  const nextWs: WorldState = {
    ...ws,
    battle: {
      status: "active",
      enemyId,
      playerHp: ws.player.stats.hp,
      enemyHp: enemy.stats.hp,
      round: 1,
      battleKey: occurredAt,
      preBattleSnapshot,
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

/** 处理 attack/guard/flee。flee 保留规则兼容，但不再由正式 UI 暴露。 */
export function battleAction(
  ws: WorldState,
  action: CombatActionKind,
  deps: BattleResolveDeps,
  requestedCommand?: Omit<CombatCommand, "kind">,
): ResolveResult {
  if (ws.battle.status !== "active") {
    return { ok: false, feedback: ws.battle.status === "idle" ? "当前没有进行中的战斗。" : "战斗已经结束。" };
  }

  const battle = ws.battle;
  if (isModernBattle(battle)) return modernBattleAction(ws, action, deps, requestedCommand);
  if (action === "skill") return { ok: false, feedback: "旧战斗存档暂不支持技能行动。" };
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

    const mutation = applyEntityMutations(ws, [{ kind: "set_enemy_defeated", enemyId: battle.enemyId, defeated: true }]);
    if (!mutation.ok) return { ok: false, feedback: "战斗世界状态不一致。" };
    const nextWs: WorldState = {
      ...mutation.worldState,
      battle: { status: "resolved", enemyId: battle.enemyId, outcome: "victory" },
      eventLedger: [...mutation.worldState.eventLedger, ...events],
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
    // 非终结回合只改 hp 与 round，其余字段整份带过去：这里曾是逐字段重建的形状，
    // 而正是那个形状让 preBattleSnapshot / battleKey 被悄悄漏掉（快照是战败/撤退唯一
    // 可恢复的世界，落盘校验又要求 active battle 必带它）。展开现存 battle 才能保证
    // ActiveBattle 以后新增的可选字段也不会再丢。
    battle: { ...battle, playerHp, enemyHp, round: battle.round + 1 },
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
