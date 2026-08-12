import type {
  ActiveBattleCombatState,
  BattleCombatant,
  CombatActionKind,
  CombatCommand,
  CombatActionResult,
  CombatantId,
} from "@/game/domain/combat";
import { ATTACK_ENERGY_GAIN, GUARD_ENERGY_GAIN, SKILL_ENERGY_COST } from "@/game/domain/combat";
import { calculateDamage, chooseEnemyAction, chooseEnemyTarget, createTurnOrder, multiplierForAction } from "./combatMath";

export type CombatOutcome = "victory" | "defeat" | "withdraw" | null;

export type AdvanceBattleResult = {
  readonly state: ActiveBattleCombatState;
  readonly results: readonly CombatActionResult[];
  readonly outcome: CombatOutcome;
};

function aliveOnSide(combatants: readonly BattleCombatant[], side: BattleCombatant["side"]): boolean {
  return combatants.some((unit) => unit.side === side && unit.hp > 0);
}

function outcomeOf(combatants: readonly BattleCombatant[]): CombatOutcome {
  if (!aliveOnSide(combatants, "enemies")) return "victory";
  if (!aliveOnSide(combatants, "allies")) return "defeat";
  return null;
}

function nextLivingIndex(order: readonly CombatantId[], index: number, combatants: readonly BattleCombatant[]): number {
  let cursor = index;
  while (cursor < order.length) {
    const unit = combatants.find((candidate) => candidate.combatantId === order[cursor]);
    if (unit !== undefined && unit.hp > 0) return cursor;
    cursor += 1;
  }
  return cursor;
}

function rebuildForNextRound(state: ActiveBattleCombatState): ActiveBattleCombatState {
  const nextRound = state.round + 1;
  const order = createTurnOrder(state.combatants);
  const enemyIntents = order
    .map((id) => state.combatants.find((unit) => unit.combatantId === id))
    .filter((unit): unit is BattleCombatant => unit !== undefined && unit.side === "enemies")
    .map((unit) => ({
      actorId: unit.combatantId,
      kind: chooseEnemyAction(unit, nextRound),
      targetId: chooseEnemyTarget(unit, state.combatants),
    }));
  return { ...state, round: nextRound, turnOrder: order, turnIndex: 0, enemyIntents, lastAdvance: [] };
}

function executeCommand(
  combatants: readonly BattleCombatant[],
  command: CombatCommand,
  round: number,
  sequence: number,
): { readonly combatants: readonly BattleCombatant[]; readonly result: CombatActionResult; readonly outcome: CombatOutcome } {
  const actor = combatants.find((unit) => unit.combatantId === command.actorId);
  if (actor === undefined || actor.hp <= 0) throw new Error("战斗行动者已失效");

  const actorAtStart = { ...actor, guarding: false };
  const next = combatants.map((unit) => unit.combatantId === actor.combatantId ? actorAtStart : unit);
  if (command.kind === "flee") {
    return {
      combatants: next,
      result: { round, sequence, actorId: actor.combatantId, kind: command.kind, damage: 0, actorEnergyAfter: actor.energy },
      outcome: "withdraw",
    };
  }

  if (command.kind === "guard") {
    const updated = next.map((unit) => unit.combatantId === actor.combatantId
      ? { ...unit, guarding: true, energy: Math.min(unit.stats.maxEnergy, unit.energy + GUARD_ENERGY_GAIN) }
      : unit);
    const current = updated.find((unit) => unit.combatantId === actor.combatantId)!;
    return {
      combatants: updated,
      result: { round, sequence, actorId: actor.combatantId, kind: command.kind, damage: 0, actorEnergyAfter: current.energy },
      outcome: outcomeOf(updated),
    };
  }

  if (command.kind === "skill" && actor.energy < SKILL_ENERGY_COST) throw new Error("能量不足");
  const target = next.find((unit) => unit.combatantId === command.targetId && unit.side !== actor.side && unit.hp > 0);
  if (target === undefined) throw new Error("战斗目标已失效");
  const damage = calculateDamage(actor.stats, target.stats, multiplierForAction(command.kind), target.guarding);
  const updated = next.map((unit) => {
    if (unit.combatantId === actor.combatantId) {
      return {
        ...unit,
        energy: command.kind === "skill"
          ? unit.energy - SKILL_ENERGY_COST
          : Math.min(unit.stats.maxEnergy, unit.energy + ATTACK_ENERGY_GAIN),
      };
    }
    if (unit.combatantId === target.combatantId) return { ...unit, hp: Math.max(0, unit.hp - damage) };
    return unit;
  });
  const currentActor = updated.find((unit) => unit.combatantId === actor.combatantId)!;
  const currentTarget = updated.find((unit) => unit.combatantId === target.combatantId)!;
  const downedEnemyIds = currentTarget.hp <= 0 && currentTarget.source.kind === "enemy"
    ? [currentTarget.source.enemyId]
    : [];
  return {
    combatants: updated,
    result: {
      round, sequence, actorId: actor.combatantId, targetId: target.combatantId,
      kind: command.kind, damage, actorEnergyAfter: currentActor.energy, targetHpAfter: currentTarget.hp,
    },
    outcome: outcomeOf(updated),
  };
}

function commandForRuleUnit(state: ActiveBattleCombatState, actor: BattleCombatant): CombatCommand {
  const intent = state.enemyIntents.find((entry) => entry.actorId === actor.combatantId);
  const kind: CombatActionKind = intent?.kind ?? chooseEnemyAction(actor, state.round);
  return {
    actorId: actor.combatantId,
    kind: kind === "skill" && actor.energy < SKILL_ENERGY_COST ? "attack" : kind,
    targetId: intent?.targetId ?? chooseEnemyTarget(actor, state.combatants),
  };
}

/**
 * 执行一个玩家单位的指令，并自动推进后续规则单位，直到下一名玩家单位需要决策或战斗结束。
 * `command=null` 用于开战时处理比玩家更快的敌人。
 */
export function advanceUntilPlayerDecision(
  initialState: ActiveBattleCombatState,
  command: CombatCommand | null,
): AdvanceBattleResult {
  let state: ActiveBattleCombatState = { ...initialState, lastAdvance: [] };
  let combatants = [...state.combatants];
  let results: CombatActionResult[] = [];
  let outcome: CombatOutcome = null;
  let commandPending = command;
  let sequence = 0;

  while (outcome === null) {
    const orderIndex = nextLivingIndex(state.turnOrder, state.turnIndex, combatants);
    if (orderIndex >= state.turnOrder.length) {
      state = rebuildForNextRound({ ...state, combatants, turnIndex: orderIndex });
      combatants = [...state.combatants];
      continue;
    }

    const actor = combatants.find((unit) => unit.combatantId === state.turnOrder[orderIndex]);
    if (actor === undefined) {
      state = { ...state, turnIndex: orderIndex + 1 };
      continue;
    }

    if (actor.controller === "player" && commandPending === null) {
      state = { ...state, combatants, turnIndex: orderIndex, lastAdvance: results };
      break;
    }

    const commandToRun = actor.controller === "player"
      ? commandPending
      : commandForRuleUnit({ ...state, combatants }, actor);
    if (commandToRun === null || commandToRun.actorId !== actor.combatantId) {
      throw new Error("战斗行动者与当前回合不匹配");
    }

    const executed = executeCommand(combatants, commandToRun, state.round, sequence);
    sequence += 1;
    combatants = [...executed.combatants];
    results.push(executed.result);
    outcome = executed.outcome;
    commandPending = null;
    state = { ...state, combatants, turnIndex: orderIndex + 1 };
  }

  const downedEnemyIds = Array.from(new Set([
    ...initialState.downedEnemyIds,
    ...combatants
      .filter((unit): unit is BattleCombatant & { readonly source: Extract<BattleCombatant["source"], { readonly kind: "enemy" }> } => unit.side === "enemies" && unit.hp <= 0 && unit.source.kind === "enemy")
      .map((unit) => unit.source.enemyId),
  ]));

  return {
    state: { ...state, combatants, downedEnemyIds, lastAdvance: results },
    results,
    outcome,
  };
}
