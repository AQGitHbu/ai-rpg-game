import { describe, expect, it } from "vitest";
import { ENEMY_COMBAT_STATS, PLAYER_COMBAT_STATS, asCombatantId, type BattleCombatant } from "@/game/domain/combat";
import { calculateDamage, chooseEnemyAction, chooseEnemyTarget, createTurnOrder } from "./combatMath";

const unit = (id: string, side: "allies" | "enemies", speed: number, hp = 100): BattleCombatant => ({
  combatantId: asCombatantId(id), side, controller: side === "allies" ? "player" : "rule",
  source: side === "allies" ? { kind: "protagonist" } : { kind: "enemy", enemyId: id as never },
  name: id, stats: { ...PLAYER_COMBAT_STATS, speed }, hp, energy: 20, guarding: false,
});

describe("combatMath", () => {
  it("uses the proportional integer damage formula and guard reduction", () => {
    expect(calculateDamage(PLAYER_COMBAT_STATS, ENEMY_COMBAT_STATS.normal, 1, false)).toBe(14);
    expect(calculateDamage(PLAYER_COMBAT_STATS, ENEMY_COMBAT_STATS.normal, 1.6, false)).toBe(23);
    expect(calculateDamage(PLAYER_COMBAT_STATS, ENEMY_COMBAT_STATS.normal, 1.6, true)).toBe(11);
  });

  it("sorts speed descending with stable ally tie-break", () => {
    expect(createTurnOrder([
      unit("enemy:slow", "enemies", 8), unit("ally:b", "allies", 12),
      unit("ally:a", "allies", 12), unit("enemy:fast", "enemies", 14),
    ])).toEqual(["enemy:fast", "ally:a", "ally:b", "enemy:slow"]);
  });

  it("uses deterministic normal and boss intent cycles", () => {
    expect(chooseEnemyAction({ ...unit("enemy:normal", "enemies", 8), stats: ENEMY_COMBAT_STATS.normal }, 3)).toBe("skill");
    expect(chooseEnemyAction({ ...unit("enemy:boss", "enemies", 8), stats: ENEMY_COMBAT_STATS.boss }, 3)).toBe("guard");
  });

  it("targets the lowest current HP ratio with stable tie-break", () => {
    expect(chooseEnemyTarget(unit("enemy:1", "enemies", 8), [
      unit("ally:b", "allies", 12, 50), unit("ally:a", "allies", 12, 50),
      unit("enemy:1", "enemies", 8),
    ])).toBe("ally:a");
  });
});
