import { describe, expect, it } from "vitest";
import {
  ENEMY_COMBAT_STATS,
  PLAYER_COMBAT_STATS,
  asCombatantId,
  combatStatsFromLegacy,
  initialCombatResources,
} from "./combat";

describe("combat domain contract", () => {
  it("keeps rule-owned five-stat profiles stable", () => {
    expect(PLAYER_COMBAT_STATS).toEqual({
      maxHp: 100,
      maxEnergy: 40,
      attack: 20,
      defense: 10,
      speed: 12,
    });
    expect(ENEMY_COMBAT_STATS.normal).toEqual({
      maxHp: 55,
      maxEnergy: 30,
      attack: 13,
      defense: 7,
      speed: 8,
    });
    expect(ENEMY_COMBAT_STATS.boss).toEqual({
      maxHp: 120,
      maxEnergy: 50,
      attack: 18,
      defense: 12,
      speed: 10,
    });
  });

  it("initializes half energy without mutating static stats", () => {
    expect(initialCombatResources(PLAYER_COMBAT_STATS)).toEqual({
      hp: 100,
      energy: 20,
      guarding: false,
    });
    expect(PLAYER_COMBAT_STATS).toEqual(expect.objectContaining({ maxEnergy: 40 }));
  });

  it("projects legacy three-stat saves into the five-stat contract", () => {
    expect(combatStatsFromLegacy({ hp: 80, attack: 11, defense: 4 })).toEqual({
      maxHp: 80,
      maxEnergy: 40,
      attack: 11,
      defense: 4,
      speed: 12,
    });
  });

  it("keeps combatant IDs opaque at the domain boundary", () => {
    expect(asCombatantId("ally-0")).toBe("ally-0");
  });
});
