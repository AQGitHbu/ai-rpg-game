import type {
  BattleCombatant,
  CombatActionResult,
  CombatStats,
  CombatantSource,
  EnemyIntent,
} from "@/game/domain/combat";

// ---------------------------------------------------------------------------
// 战斗形状共享守卫：`combatView` 的运行时读模型与持久化严格解析器对现代多单位
// 战斗做同一套封闭形状判定。两处曾各自维护约 100 行近乎相同的校验，任何一边
// 单独调整都会造成读模型与存档解析漂移，因此收敛到本模块统一维护。
// 本模块只做结构形状判定：不裁决战斗规则、不读取 WorldState、不接触 provider。
// ---------------------------------------------------------------------------

export const MODERN_BATTLE_KEYS = ["combatants", "turnOrder", "turnIndex", "enemyIntents", "downedEnemyIds", "lastAdvance"] as const;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

export function hasRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function optionalMatches(value: Record<string, unknown>, key: string, predicate: (entry: unknown) => boolean): boolean {
  return !(key in value) || value[key] === undefined || predicate(value[key]);
}

/** 所有元素都是非空字符串；长度是否必须 >0 由调用方自行追加判定。 */
export function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

export function isCombatSource(value: unknown): value is CombatantSource {
  if (!isPlainRecord(value)) return false;
  if (value.kind === "protagonist") return hasExactKeys(value, ["kind"]);
  if (value.kind === "companion") return hasExactKeys(value, ["kind", "npcId"]) && isNonEmptyString(value.npcId);
  if (value.kind === "enemy") return hasExactKeys(value, ["kind", "enemyId"]) && isNonEmptyString(value.enemyId);
  return false;
}

export function isCombatStats(value: unknown): value is CombatStats {
  return isPlainRecord(value)
    && hasExactKeys(value, ["maxHp", "maxEnergy", "attack", "defense", "speed"])
    && isFiniteNumber(value.maxHp) && value.maxHp > 0
    && isFiniteNumber(value.maxEnergy) && value.maxEnergy >= 0
    && isFiniteNumber(value.attack) && value.attack >= 0
    && isFiniteNumber(value.defense) && value.defense >= 0
    && isFiniteNumber(value.speed) && value.speed >= 0;
}

export function isCombatant(value: unknown): value is BattleCombatant {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["combatantId", "side", "controller", "source", "name", "stats", "hp", "energy", "guarding"])
    || !isNonEmptyString(value.combatantId)
    || (value.side !== "allies" && value.side !== "enemies")
    || (value.controller !== "player" && value.controller !== "rule")
    || !isCombatSource(value.source)
    || !isNonEmptyString(value.name)
    || !isCombatStats(value.stats)
    || !isFiniteNumber(value.hp) || value.hp < 0 || value.hp > value.stats.maxHp
    || !isFiniteNumber(value.energy) || value.energy < 0 || value.energy > value.stats.maxEnergy
    || typeof value.guarding !== "boolean") return false;
  if (value.source.kind === "protagonist") return value.side === "allies" && value.controller === "player";
  if (value.source.kind === "companion") return value.side === "allies" && value.controller === "rule";
  return value.side === "enemies" && value.controller === "rule";
}

export function isEnemyIntent(value: unknown): value is EnemyIntent {
  return isPlainRecord(value)
    && hasRequiredAndOptionalKeys(value, ["actorId", "kind"], ["targetId"])
    && isNonEmptyString(value.actorId)
    && (value.kind === "attack" || value.kind === "skill" || value.kind === "guard")
    && optionalMatches(value, "targetId", isNonEmptyString);
}

export function isCombatResult(value: unknown): value is CombatActionResult {
  return isPlainRecord(value)
    && hasRequiredAndOptionalKeys(value, ["round", "sequence", "actorId", "kind", "damage", "actorEnergyAfter"], ["targetId", "targetHpAfter"])
    && Number.isInteger(value.round) && (value.round as number) >= 0
    && Number.isInteger(value.sequence) && (value.sequence as number) >= 0
    && isNonEmptyString(value.actorId)
    && optionalMatches(value, "targetId", isNonEmptyString)
    && (value.kind === "attack" || value.kind === "skill" || value.kind === "guard" || value.kind === "flee")
    && isFiniteNumber(value.damage) && value.damage >= 0
    && isFiniteNumber(value.actorEnergyAfter) && value.actorEnergyAfter >= 0
    && optionalMatches(value, "targetHpAfter", (entry) => isFiniteNumber(entry) && entry >= 0);
}
