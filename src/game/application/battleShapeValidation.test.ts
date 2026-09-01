import { describe, expect, it } from "vitest";
import {
  MODERN_BATTLE_KEYS,
  hasExactKeys,
  hasRequiredAndOptionalKeys,
  isCombatResult,
  isCombatSource,
  isCombatStats,
  isCombatant,
  isEnemyIntent,
  isFiniteNumber,
  isNonEmptyString,
  isNonEmptyStringArray,
  isPlainRecord,
  optionalMatches,
} from "./battleShapeValidation";

const STATS = { maxHp: 30, maxEnergy: 10, attack: 5, defense: 2, speed: 3 };

const PROTAGONIST = {
  combatantId: "p1",
  side: "allies",
  controller: "player",
  source: { kind: "protagonist" },
  name: "主角",
  stats: STATS,
  hp: 30,
  energy: 10,
  guarding: false,
};

describe("battleShapeValidation — 基础原语", () => {
  it("isPlainRecord 排除 null、数组与原始值", () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord("x")).toBe(false);
  });

  it("hasExactKeys 要求键集合逐字相同", () => {
    expect(hasExactKeys({ a: 1 }, ["a"])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2 }, ["a"])).toBe(false);
  });

  it("hasRequiredAndOptionalKeys 允许可选键缺席但拒绝未知键", () => {
    expect(hasRequiredAndOptionalKeys({ a: 1 }, ["a"], ["b"])).toBe(true);
    expect(hasRequiredAndOptionalKeys({ a: 1, b: 2 }, ["a"], ["b"])).toBe(true);
    expect(hasRequiredAndOptionalKeys({ a: 1, c: 3 }, ["a"], ["b"])).toBe(false);
    expect(hasRequiredAndOptionalKeys({}, ["a"], ["b"])).toBe(false);
  });

  it("字符串与数字守卫拒绝空串、空白和非有限数", () => {
    expect(isNonEmptyString("x")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("isNonEmptyStringArray 只要求元素非空，不要求长度", () => {
    expect(isNonEmptyStringArray([])).toBe(true);
    expect(isNonEmptyStringArray(["a"])).toBe(true);
    expect(isNonEmptyStringArray(["a", ""])).toBe(false);
    expect(isNonEmptyStringArray("a")).toBe(false);
  });

  it("optionalMatches 在键缺席或为 undefined 时放行", () => {
    expect(optionalMatches({}, "x", isNonEmptyString)).toBe(true);
    expect(optionalMatches({ x: undefined }, "x", isNonEmptyString)).toBe(true);
    expect(optionalMatches({ x: "y" }, "x", isNonEmptyString)).toBe(true);
    expect(optionalMatches({ x: "" }, "x", isNonEmptyString)).toBe(false);
  });

  it("MODERN_BATTLE_KEYS 保持六键封闭集合", () => {
    expect(MODERN_BATTLE_KEYS).toEqual(["combatants", "turnOrder", "turnIndex", "enemyIntents", "downedEnemyIds", "lastAdvance"]);
  });
});

describe("battleShapeValidation — 战斗形状", () => {
  it("isCombatSource 按 kind 精确校验键集", () => {
    expect(isCombatSource({ kind: "protagonist" })).toBe(true);
    expect(isCombatSource({ kind: "companion", npcId: "npc_1" })).toBe(true);
    expect(isCombatSource({ kind: "enemy", enemyId: "enemy_1" })).toBe(true);
    expect(isCombatSource({ kind: "companion", npcId: "" })).toBe(false);
    expect(isCombatSource({ kind: "protagonist", npcId: "x" })).toBe(false);
    expect(isCombatSource({ kind: "other" })).toBe(false);
  });

  it("isCombatStats 要求闭区间合法数值", () => {
    expect(isCombatStats(STATS)).toBe(true);
    expect(isCombatStats({ ...STATS, maxHp: 0 })).toBe(false);
    expect(isCombatStats({ ...STATS, maxEnergy: -1 })).toBe(false);
    expect(isCombatStats({ ...STATS, speed: Number.NaN })).toBe(false);
    expect(isCombatStats({ ...STATS, extra: 1 })).toBe(false);
  });

  it("isCombatant 校验键集、数值边界与来源/阵营/控制器组合", () => {
    expect(isCombatant(PROTAGONIST)).toBe(true);
    expect(isCombatant({ ...PROTAGONIST, hp: -1 })).toBe(false);
    expect(isCombatant({ ...PROTAGONIST, hp: 31 })).toBe(false);
    expect(isCombatant({ ...PROTAGONIST, energy: 11 })).toBe(false);
    expect(isCombatant({ ...PROTAGONIST, guarding: "no" })).toBe(false);
    expect(isCombatant({ ...PROTAGONIST, side: "enemies" })).toBe(false);
    expect(isCombatant({ ...PROTAGONIST, controller: "rule" })).toBe(false);
    expect(isCombatant({
      ...PROTAGONIST,
      combatantId: "c1",
      side: "allies",
      controller: "rule",
      source: { kind: "companion", npcId: "npc_1" },
    })).toBe(true);
    expect(isCombatant({
      ...PROTAGONIST,
      combatantId: "e1",
      side: "enemies",
      controller: "rule",
      source: { kind: "enemy", enemyId: "enemy_1" },
    })).toBe(true);
    // enemy 不能由玩家控制，companion 不能站敌方阵营
    expect(isCombatant({
      ...PROTAGONIST,
      combatantId: "e1",
      side: "enemies",
      controller: "player",
      source: { kind: "enemy", enemyId: "enemy_1" },
    })).toBe(false);
    expect(isCombatant({
      ...PROTAGONIST,
      combatantId: "c1",
      side: "enemies",
      controller: "rule",
      source: { kind: "companion", npcId: "npc_1" },
    })).toBe(false);
  });

  it("isEnemyIntent 只接受封闭行动种类与合法目标", () => {
    expect(isEnemyIntent({ actorId: "e1", kind: "attack" })).toBe(true);
    expect(isEnemyIntent({ actorId: "e1", kind: "guard", targetId: "p1" })).toBe(true);
    expect(isEnemyIntent({ actorId: "e1", kind: "flee" })).toBe(false);
    expect(isEnemyIntent({ actorId: "", kind: "attack" })).toBe(false);
    expect(isEnemyIntent({ actorId: "e1", kind: "attack", targetId: "" })).toBe(false);
    expect(isEnemyIntent({ actorId: "e1", kind: "attack", extra: 1 })).toBe(false);
  });

  it("isCombatResult 校验整数序号、非负数值与可选字段", () => {
    expect(isCombatResult({
      round: 1, sequence: 0, actorId: "p1", kind: "attack", damage: 5, actorEnergyAfter: 2,
    })).toBe(true);
    expect(isCombatResult({
      round: 1, sequence: 0, actorId: "p1", kind: "flee", damage: 0, actorEnergyAfter: 0, targetId: "e1", targetHpAfter: 3,
    })).toBe(true);
    expect(isCombatResult({
      round: -1, sequence: 0, actorId: "p1", kind: "attack", damage: 5, actorEnergyAfter: 2,
    })).toBe(false);
    expect(isCombatResult({
      round: 1, sequence: 0.5, actorId: "p1", kind: "attack", damage: 5, actorEnergyAfter: 2,
    })).toBe(false);
    expect(isCombatResult({
      round: 1, sequence: 0, actorId: "p1", kind: "attack", damage: -1, actorEnergyAfter: 2,
    })).toBe(false);
    expect(isCombatResult({
      round: 1, sequence: 0, actorId: "p1", kind: "attack", damage: 5, actorEnergyAfter: 2, targetHpAfter: -1,
    })).toBe(false);
    expect(isCombatResult({
      round: 1, sequence: 0, actorId: "p1", kind: "talk", damage: 5, actorEnergyAfter: 2,
    })).toBe(false);
  });
});
