import type { EnemyId, NpcId, StatBlock } from "./worldEntity";

declare const combatantIdBrand: unique symbol;

/** 单场战斗内稳定、不可由客户端构造的单位标识。 */
export type CombatantId = string & { readonly [combatantIdBrand]: "CombatantId" };

export function asCombatantId(raw: string): CombatantId {
  return raw as CombatantId;
}

/** 参与战斗的静态属性；不随战斗回合变化。 */
export type CombatStats = {
  readonly maxHp: number;
  readonly maxEnergy: number;
  readonly attack: number;
  readonly defense: number;
  readonly speed: number;
};

/** 战斗中的可变资源。 */
export type CombatResources = {
  readonly hp: number;
  readonly energy: number;
  readonly guarding: boolean;
};

export type CombatActionKind = "attack" | "skill" | "guard" | "flee";
export type EnemyActionKind = Exclude<CombatActionKind, "flee">;
export type CombatSide = "allies" | "enemies";
export type CombatController = "player" | "rule";

export type CombatantSource =
  | { readonly kind: "protagonist" }
  | { readonly kind: "companion"; readonly npcId: NpcId }
  | { readonly kind: "enemy"; readonly enemyId: EnemyId };

export type BattleCombatant = CombatResources & {
  readonly combatantId: CombatantId;
  readonly side: CombatSide;
  readonly controller: CombatController;
  readonly source: CombatantSource;
  readonly name: string;
  readonly stats: CombatStats;
};

export type CombatCommand = {
  readonly actorId: CombatantId;
  readonly kind: CombatActionKind;
  readonly targetId?: CombatantId;
};

export type CombatActionResult = {
  readonly round: number;
  readonly sequence: number;
  readonly actorId: CombatantId;
  readonly targetId?: CombatantId;
  readonly kind: CombatActionKind;
  readonly damage: number;
  readonly actorEnergyAfter: number;
  readonly targetHpAfter?: number;
};

export type EnemyIntent = {
  readonly actorId: CombatantId;
  readonly kind: EnemyActionKind;
  readonly targetId?: CombatantId;
};

/** active battle 的多单位扩展；旧字段由 BattleState 保留用于存档读取兼容。 */
export type ActiveBattleCombatState = {
  readonly round: number;
  readonly combatants: readonly BattleCombatant[];
  readonly turnOrder: readonly CombatantId[];
  readonly turnIndex: number;
  readonly enemyIntents: readonly EnemyIntent[];
  readonly downedEnemyIds: readonly EnemyId[];
  readonly lastAdvance: readonly CombatActionResult[];
};

export const PLAYER_COMBAT_STATS: CombatStats = {
  maxHp: 100,
  maxEnergy: 40,
  attack: 20,
  defense: 10,
  speed: 12,
};

export const ENEMY_COMBAT_STATS: Readonly<Record<"normal" | "boss", CombatStats>> = {
  normal: { maxHp: 55, maxEnergy: 30, attack: 13, defense: 7, speed: 8 },
  boss: { maxHp: 120, maxEnergy: 50, attack: 18, defense: 12, speed: 10 },
};

export const SKILL_ENERGY_COST = 20;
export const ATTACK_ENERGY_GAIN = 10;
export const GUARD_ENERGY_GAIN = 15;
export const SKILL_MULTIPLIER = 1.6;
export const GUARD_MULTIPLIER = 0.5;

/** 旧存档/测试夹具的三项 StatBlock 到正式 CombatStats 的确定性投影。 */
export function combatStatsFromLegacy(stats: StatBlock, fallback: CombatStats = PLAYER_COMBAT_STATS): CombatStats {
  const maxHp = typeof stats.maxHp === "number" && Number.isFinite(stats.maxHp) && stats.maxHp > 0
    ? stats.maxHp
    : stats.hp;
  const maxEnergy = typeof stats.maxEnergy === "number" && Number.isFinite(stats.maxEnergy) && stats.maxEnergy > 0
    ? stats.maxEnergy
    : fallback.maxEnergy;
  const speed = typeof stats.speed === "number" && Number.isFinite(stats.speed) && stats.speed > 0
    ? stats.speed
    : fallback.speed;
  return {
    maxHp,
    maxEnergy,
    attack: stats.attack,
    defense: stats.defense,
    speed,
  };
}

/** 写回既有 WorldState StatBlock 时保留旧 hp 字段，同时携带正式属性。 */
export function toStatBlock(stats: CombatStats): StatBlock {
  return {
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    maxEnergy: stats.maxEnergy,
    attack: stats.attack,
    defense: stats.defense,
    speed: stats.speed,
  };
}

export function initialCombatResources(stats: CombatStats, energyRatio = 0.5): CombatResources {
  return {
    hp: stats.maxHp,
    energy: Math.max(0, Math.min(stats.maxEnergy, Math.floor(stats.maxEnergy * energyRatio))),
    guarding: false,
  };
}
