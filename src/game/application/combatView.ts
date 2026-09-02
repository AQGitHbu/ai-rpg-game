import type { ActiveBattleCombatState, BattleCombatant, CombatActionKind } from "@/game/domain/combat";
import { SKILL_ENERGY_COST } from "@/game/domain/combat";
import type { PlayerChoiceView } from "./gameSessionView";
import { deriveRuntimeChoiceToken } from "./runtimeChoiceToken";
import type { WorldState } from "@/game/domain/worldState";
import {
  MODERN_BATTLE_KEYS,
  isCombatResult,
  isCombatant,
  isEnemyIntent,
  isFiniteNumber,
  isNonEmptyString,
  isNonEmptyStringArray,
} from "./battleShapeValidation";

type ActiveBattle = Extract<WorldState["battle"], { status: "active" }>;

function isModernBattle(worldState: WorldState, battle: ActiveBattle): battle is ActiveBattle & ActiveBattleCombatState {
  if (!isNonEmptyString(battle.enemyId)
    || !isFiniteNumber(battle.playerHp) || battle.playerHp < 0
    || !isFiniteNumber(battle.enemyHp) || battle.enemyHp < 0
    || !Number.isInteger(battle.round) || battle.round < 0
    || !worldState.enemies.some((enemy) => String(enemy.id) === battle.enemyId)) return false;
  if (!Array.isArray(battle.combatants) || battle.combatants.length === 0 || !battle.combatants.every(isCombatant)) return false;
  const combatants = battle.combatants;
  const combatantIds = combatants.map((unit) => String(unit.combatantId));
  if (new Set(combatantIds).size !== combatantIds.length) return false;
  const byId = new Map(combatants.map((unit) => [String(unit.combatantId), unit]));
  const knownNpcIds = new Set(worldState.npcs.map((npc) => String(npc.id)));
  const enemySourceIds = new Set<string>();
  let protagonistCount = 0;
  let challengedEnemy: BattleCombatant | undefined;
  for (const unit of combatants) {
    if (unit.source.kind === "protagonist") {
      protagonistCount += 1;
    }
    if (unit.source.kind === "companion" && !knownNpcIds.has(String(unit.source.npcId))) return false;
    if (unit.source.kind === "enemy") {
      const enemyId = unit.source.enemyId;
      if (!worldState.enemies.some((enemy) => String(enemy.id) === String(enemyId))) return false;
      if (enemySourceIds.has(String(enemyId))) return false;
      enemySourceIds.add(String(enemyId));
      if (String(enemyId) === String(battle.enemyId)) challengedEnemy = unit;
    }
  }
  if (protagonistCount !== 1 || challengedEnemy === undefined) return false;
  if (battle.enemyIds !== undefined
    && (!isNonEmptyStringArray(battle.enemyIds)
      || battle.enemyIds.length === 0
      || new Set(battle.enemyIds).size !== battle.enemyIds.length
      || battle.enemyIds.length !== enemySourceIds.size
      || !battle.enemyIds.every((enemyId) => enemySourceIds.has(String(enemyId))))) return false;

  const turnIndex = battle.turnIndex;
  if (!isNonEmptyStringArray(battle.turnOrder)
    || battle.turnOrder.length === 0
    || new Set(battle.turnOrder).size !== battle.turnOrder.length
    || !battle.turnOrder.every((id) => byId.get(id)?.hp !== undefined && (byId.get(id)?.hp as number) > 0)
    || battle.turnOrder.length !== combatants.filter((unit) => unit.hp > 0).length
    || !Number.isInteger(turnIndex)
    || (turnIndex as number) < 0
    || (turnIndex as number) >= battle.turnOrder.length) return false;
  if (!Array.isArray(battle.enemyIntents) || !battle.enemyIntents.every(isEnemyIntent)) return false;
  const intentActors = new Set<string>();
  if (!battle.enemyIntents.every((intent) => {
    const actor = byId.get(intent.actorId);
    const target = intent.targetId === undefined ? undefined : byId.get(intent.targetId);
    if (intentActors.has(String(intent.actorId))) return false;
    intentActors.add(String(intent.actorId));
    return actor?.side === "enemies"
      && actor.hp > 0
      && (intent.targetId === undefined || (target?.side === "allies" && target.hp > 0));
  })) return false;
  if (!Array.isArray(battle.downedEnemyIds)
    || !battle.downedEnemyIds.every(isNonEmptyString)
    || new Set(battle.downedEnemyIds).size !== battle.downedEnemyIds.length) return false;
  const downedEnemySourceIds = combatants.flatMap((unit) => unit.source.kind === "enemy" && unit.hp <= 0
    ? [String(unit.source.enemyId)]
    : []);
  const downedEnemySet = new Set(downedEnemySourceIds);
  if (downedEnemySet.size !== downedEnemySourceIds.length
    || battle.downedEnemyIds.length !== downedEnemySet.size
    || !battle.downedEnemyIds.every((id) => downedEnemySet.has(String(id)))) return false;
  if (!Array.isArray(battle.lastAdvance) || !battle.lastAdvance.every(isCombatResult)) return false;
  if (new Set(battle.lastAdvance.map((result) => result.sequence)).size !== battle.lastAdvance.length) return false;
  return battle.lastAdvance.every((result) => {
    const actor = byId.get(result.actorId);
    const target = result.targetId === undefined ? undefined : byId.get(result.targetId);
    return actor !== undefined
      && (result.targetId === undefined || target !== undefined)
      && result.actorEnergyAfter <= actor.stats.maxEnergy
      && (result.targetHpAfter === undefined || (target !== undefined && result.targetHpAfter <= target.stats.maxHp));
  });
}

export type BattleCombatantView = {
  readonly slot: string;
  readonly name: string;
  readonly side: "allies" | "enemies";
  readonly current: boolean;
  readonly defeated: boolean;
  readonly hp: number;
  readonly maxHp: number;
  readonly energy: number;
  readonly maxEnergy: number;
  readonly speed: number;
  readonly guarding: boolean;
  readonly intent: "attack" | "skill" | "guard" | null;
};

export type BattleControlView = PlayerChoiceView & {
  readonly targetName?: string | null;
  readonly enabled?: boolean;
  readonly disabledReason?: string | null;
};

export type BattleAdvanceView = {
  readonly sequence: number;
  readonly round: number;
  readonly actorSlot: string;
  readonly actorName: string;
  readonly targetSlot: string | null;
  readonly targetName: string | null;
  readonly kind: "attack" | "skill" | "guard" | "flee";
  readonly damage: number;
  readonly targetHpAfter: number | null;
};

export type DisabledBattleControlView = Omit<PlayerChoiceView, "choiceToken"> & {
  readonly choiceToken: null;
  readonly targetName?: string | null;
  readonly enabled: false;
  readonly disabledReason: string;
};

export type BattleView = {
  readonly enemyName: string;
  readonly playerHp: number;
  readonly enemyHp: number;
  readonly round: number;
  readonly units?: readonly BattleCombatantView[];
  readonly controls: readonly BattleControlView[];
  readonly disabledControls?: readonly DisabledBattleControlView[];
  readonly lastAdvance?: readonly BattleAdvanceView[];
};

function closedBattleView(worldState: WorldState, battle: Extract<WorldState["battle"], { status: "active" }>): BattleView {
  return {
    enemyName: worldState.enemies.find((enemy) => enemy.id === battle.enemyId)?.name ?? "未知敌人",
    playerHp: battle.playerHp,
    enemyHp: battle.enemyHp,
    round: battle.round,
    units: [],
    controls: [],
    disabledControls: [],
    lastAdvance: [],
  };
}

function control(
  action: Extract<CombatActionKind, "attack" | "skill" | "guard" | "flee">,
  label: string,
  revision: number,
  actorId: ActiveBattleCombatState["combatants"][number]["combatantId"],
  target: ActiveBattleCombatState["combatants"][number] | undefined,
  enabled: boolean,
  disabledReason: string | null,
): BattleControlView | DisabledBattleControlView {
  const targetId = target?.combatantId;
  const command = targetId === undefined ? { actorId } : { actorId, targetId };
  const actionValue = { type: "battle_action" as const, action, command };
  if (!enabled) {
    return {
      choiceToken: null,
      label,
      targetName: target?.name ?? null,
      presentation: "battle",
      enabled: false,
      disabledReason: disabledReason ?? "当前不可用",
    };
  }
  return {
    choiceToken: deriveRuntimeChoiceToken(actionValue, revision),
    label,
    targetName: target?.name ?? null,
    presentation: "battle",
    enabled: true,
    disabledReason: null,
  };
}

/** 只投影公开战斗槽位与 opaque controls；不向客户端暴露 combatantId / actorId / targetId。 */
export function projectCombatView(
  worldState: WorldState,
  battle: Extract<WorldState["battle"], { status: "active" }>,
  revision: number,
): BattleView {
  const modern = isModernBattle(worldState, battle);
  if (!modern) {
    const hasModernShapeMarker = MODERN_BATTLE_KEYS.some((key) => key in battle);
    if (hasModernShapeMarker) return closedBattleView(worldState, battle);
    return {
      enemyName: worldState.enemies.find((enemy) => enemy.id === battle.enemyId)?.name ?? "未知敌人",
      playerHp: battle.playerHp,
      enemyHp: battle.enemyHp,
      round: battle.round,
      units: [],
      controls: [
        { choiceToken: deriveRuntimeChoiceToken({ type: "battle_action", action: "attack" }, revision), label: "攻击", targetName: null, presentation: "battle", enabled: true, disabledReason: null },
        { choiceToken: deriveRuntimeChoiceToken({ type: "battle_action", action: "guard" }, revision), label: "防御", targetName: null, presentation: "battle", enabled: true, disabledReason: null },
      ],
      disabledControls: [],
      lastAdvance: [],
    };
  }

  const currentId = battle.turnOrder[battle.turnIndex ?? -1];
  const intents = new Map(battle.enemyIntents.map((intent) => [intent.actorId, intent.kind]));
  const sideIndexes = { allies: 0, enemies: 0 };
  const slotById = new Map<string, string>();
  const units = battle.combatants.map((unit) => {
    const slot = `${unit.side === "allies" ? "ally" : "enemy"}-${sideIndexes[unit.side]++}`;
    slotById.set(String(unit.combatantId), slot);
    return {
      slot,
      name: unit.name,
      side: unit.side,
      current: unit.combatantId === currentId,
      defeated: unit.hp <= 0,
      hp: unit.hp,
      maxHp: unit.stats.maxHp,
      energy: unit.energy,
      maxEnergy: unit.stats.maxEnergy,
      speed: unit.stats.speed,
      guarding: unit.guarding,
      intent: unit.side === "enemies" && unit.hp > 0 ? intents.get(unit.combatantId) ?? null : null,
    } satisfies BattleCombatantView;
  });

  const actor = battle.combatants.find((unit) => unit.combatantId === currentId);
  const targets = battle.combatants.filter((unit) => unit.side === "enemies" && unit.hp > 0);
  const controls: BattleControlView[] = [];
  const disabledControls: DisabledBattleControlView[] = [];
  if (actor?.controller === "player" && currentId !== undefined) {
    for (const target of targets) {
      controls.push(control("attack", `攻击${target.name}`, revision, currentId, target, true, null) as BattleControlView);
      const skillControl = control(
        "skill",
        `技能·${target.name}`,
        revision,
        currentId,
        target,
        actor.energy >= SKILL_ENERGY_COST,
        actor.energy >= SKILL_ENERGY_COST ? null : `需要 ${SKILL_ENERGY_COST} 能量`,
      );
      if (skillControl.enabled === false) disabledControls.push(skillControl as DisabledBattleControlView);
      else controls.push(skillControl as BattleControlView);
    }
    controls.push(control("guard", "防御", revision, currentId, undefined, true, null) as BattleControlView);
  }

  const combatants = battle.combatants ?? [];
  const playerHp = combatants.find((unit) => unit.side === "allies")?.hp ?? battle.playerHp;
  const enemyHp = combatants.find((unit) => unit.source.kind === "enemy" && unit.source.enemyId === battle.enemyId)?.hp
    ?? combatants.find((unit) => unit.side === "enemies")?.hp
    ?? battle.enemyHp;
  const lastAdvance = (battle.lastAdvance ?? []).map((result) => {
    const actor = combatants.find((unit) => unit.combatantId === result.actorId);
    const target = result.targetId === undefined ? undefined : combatants.find((unit) => unit.combatantId === result.targetId);
    return {
      sequence: result.sequence,
      round: result.round,
      actorSlot: slotById.get(String(result.actorId)) ?? "unknown",
      actorName: actor?.name ?? "单位",
      targetSlot: target === undefined ? null : slotById.get(String(target.combatantId)) ?? null,
      targetName: target?.name ?? null,
      kind: result.kind,
      damage: result.damage,
      targetHpAfter: result.targetHpAfter ?? null,
    } satisfies BattleAdvanceView;
  });
  return {
    enemyName: worldState.enemies.find((enemy) => enemy.id === battle.enemyId)?.name ?? "未知敌人",
    playerHp,
    enemyHp,
    round: battle.round,
    units,
    controls,
    disabledControls,
    lastAdvance,
  };
}
