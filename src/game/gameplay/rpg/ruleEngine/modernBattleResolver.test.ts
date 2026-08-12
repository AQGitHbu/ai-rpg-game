import { describe, expect, it } from "vitest";
import { createInitialWorldState, appendEnemy, type EnemyEntry, type LocationEntry, type WorldState } from "@/game/domain/worldState";
import { ENEMY_COMBAT_STATS, PLAYER_COMBAT_STATS, toStatBlock } from "@/game/domain/combat";
import { asEnemyId, asGenerationId, asLocationId } from "@/game/domain/worldEntity";
import { battleAction, startBattle } from "./battleResolver";

const deps = { now: () => "2026-08-07T12:00:00Z" };

function makeModernWorld(): WorldState {
  const location: LocationEntry = {
    id: asLocationId("loc_1"), name: "荒野", description: "test", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const base = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: toStatBlock(PLAYER_COMBAT_STATS) },
    startingLocation: location, startingItemIds: [],
  });
  const enemy = (id: string): EnemyEntry => ({
    id: asEnemyId(id), name: id, tier: "normal", stats: toStatBlock(ENEMY_COMBAT_STATS.normal), locationId: location.id, tags: [],
  });
  return { ...appendEnemy(appendEnemy(base, enemy("enemy_a")), enemy("enemy_b")), defeatedEnemyIds: [] };
}

describe("modern turn-based battle resolver", () => {
  it("starts a multi-enemy encounter with a persisted turn queue", () => {
    const result = startBattle(makeModernWorld(), asEnemyId("enemy_b"), deps);
    expect(result.ok).toBe(true);
    if (!result.ok || result.nextWorldState.battle.status !== "active") return;
    expect(result.nextWorldState.battle.enemyIds).toEqual([asEnemyId("enemy_a"), asEnemyId("enemy_b")]);
    expect(result.nextWorldState.battle.combatants?.map((unit) => unit.combatantId)).toEqual([
      "ally:protagonist", "enemy:enemy_a", "enemy:enemy_b",
    ]);
    expect(result.nextWorldState.battle.turnOrder?.[result.nextWorldState.battle.turnIndex!]).toBe("ally:protagonist");
  });

  it("resolves one player action and the queued enemy actions as one atomic command", () => {
    const started = startBattle(makeModernWorld(), asEnemyId("enemy_b"), deps);
    if (!started.ok || started.nextWorldState.battle.status !== "active") throw new Error("setup failed");
    const result = battleAction(started.nextWorldState, "attack", deps);
    expect(result.ok).toBe(true);
    if (!result.ok || result.nextWorldState.battle.status !== "active") return;
    expect(result.events.some((event) => event.type === "battle_round_resolved")).toBe(true);
    expect(result.nextWorldState.battle.combatants?.find((unit) => unit.combatantId === "ally:protagonist")?.hp).toBeLessThan(100);
    expect(result.nextWorldState.battle.round).toBe(2);
  });
});
