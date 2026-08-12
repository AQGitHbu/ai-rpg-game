import { describe, expect, it } from "vitest";
import {
  ENEMY_COMBAT_STATS,
  PLAYER_COMBAT_STATS,
  asCombatantId,
  type ActiveBattleCombatState,
  type BattleCombatant,
} from "@/game/domain/combat";
import { asEnemyId } from "@/game/domain/worldEntity";
import { advanceUntilPlayerDecision } from "./advanceBattle";
import { createTurnOrder } from "./combatMath";

function ally(id: string, speed = PLAYER_COMBAT_STATS.speed, hp = PLAYER_COMBAT_STATS.maxHp): BattleCombatant {
  return {
    combatantId: asCombatantId(id), side: "allies", controller: "player",
    source: { kind: "companion", npcId: id as never }, name: id,
    stats: { ...PLAYER_COMBAT_STATS, speed }, hp, energy: 20, guarding: false,
  };
}

function enemy(id: string, speed = ENEMY_COMBAT_STATS.normal.speed, hp = ENEMY_COMBAT_STATS.normal.maxHp): BattleCombatant {
  return {
    combatantId: asCombatantId(id), side: "enemies", controller: "rule",
    source: { kind: "enemy", enemyId: asEnemyId(id) }, name: id,
    stats: { ...ENEMY_COMBAT_STATS.normal, speed }, hp, energy: 20, guarding: false,
  };
}

function state(combatants: readonly BattleCombatant[]): ActiveBattleCombatState {
  return {
    round: 1,
    combatants,
    turnOrder: createTurnOrder(combatants),
    turnIndex: 0,
    enemyIntents: [],
    downedEnemyIds: [],
    lastAdvance: [],
  };
}

describe("advanceUntilPlayerDecision", () => {
  it("automatically resolves a faster enemy before the first player decision", () => {
    const result = advanceUntilPlayerDecision(state([ally("ally:protagonist"), enemy("enemy:fast", 20)]), null);
    expect(result.outcome).toBeNull();
    expect(result.state.turnOrder[result.state.turnIndex]).toBe("ally:protagonist");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.actorId).toBe("enemy:fast");
  });

  it("runs the current player command and then all rule units until the next player turn", () => {
    const result = advanceUntilPlayerDecision(
      state([ally("ally:protagonist"), enemy("enemy:1")]),
      { actorId: asCombatantId("ally:protagonist"), kind: "attack", targetId: asCombatantId("enemy:1") },
    );
    expect(result.outcome).toBeNull();
    expect(result.results.map((entry) => entry.actorId)).toEqual(["ally:protagonist", "enemy:1"]);
    expect(result.state.combatants.find((unit) => unit.combatantId === "enemy:1")?.hp).toBeLessThan(55);
  });

  it("stops at each player-controlled unit, leaving the next command to the caller", () => {
    const result = advanceUntilPlayerDecision(
      state([ally("ally:a", 14), ally("ally:b", 12), enemy("enemy:1", 8, 200)]),
      { actorId: asCombatantId("ally:a"), kind: "guard" },
    );
    expect(result.results.map((entry) => entry.actorId)).toEqual(["ally:a"]);
    expect(result.state.turnOrder[result.state.turnIndex]).toBe("ally:b");
  });

  it("skips a defeated enemy and reports victory without an extra counterattack", () => {
    const result = advanceUntilPlayerDecision(
      state([ally("ally:protagonist"), enemy("enemy:1", 8, 14)]),
      { actorId: asCombatantId("ally:protagonist"), kind: "attack", targetId: asCombatantId("enemy:1") },
    );
    expect(result.outcome).toBe("victory");
    expect(result.results).toHaveLength(1);
    expect(result.state.downedEnemyIds).toEqual([asEnemyId("enemy:1")]);
  });
});
