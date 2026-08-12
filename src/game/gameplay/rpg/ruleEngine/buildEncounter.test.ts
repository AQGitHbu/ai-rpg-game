import { describe, expect, it } from "vitest";
import { createInitialWorldState, type EnemyEntry, type WorldState } from "@/game/domain/worldState";
import { asEnemyId, asGenerationId, asLocationId } from "@/game/domain/worldEntity";
import { buildEncounter } from "./buildEncounter";

function makeWorld(enemies: readonly EnemyEntry[]): WorldState {
  return {
    ...createInitialWorldState({
      generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: {
        id: asLocationId("loc_1"), name: "荒野", description: "荒野", kind: "main",
        connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
      },
      startingItemIds: [],
    }),
    enemies,
  };
}

const normal = (id: string, name: string): EnemyEntry => ({
  id: asEnemyId(id), name, tier: "normal", stats: { hp: 30, attack: 8, defense: 4 }, locationId: asLocationId("loc_1"), tags: [],
});

describe("buildEncounter", () => {
  it("assembles protagonist plus at most two normal enemies in stable order", () => {
    const world = makeWorld([normal("enemy_b", "乙"), normal("enemy_a", "甲"), normal("enemy_c", "丙")]);
    const encounter = buildEncounter(world, asEnemyId("enemy_b"));
    expect(encounter.map((unit) => unit.combatantId)).toEqual(["ally:protagonist", "enemy:enemy_a", "enemy:enemy_b"]);
    expect(encounter.slice(1).every((unit) => unit.stats.maxHp === 55)).toBe(true);
  });

  it("keeps a boss encounter single-target even when normals share the location", () => {
    const boss: EnemyEntry = { ...normal("enemy_boss", "首领"), tier: "boss" };
    const world = makeWorld([boss, normal("enemy_a", "甲"), normal("enemy_b", "乙")]);
    const encounter = buildEncounter(world, boss.id);
    expect(encounter.map((unit) => unit.combatantId)).toEqual(["ally:protagonist", "enemy:enemy_boss"]);
    expect(encounter[1]?.stats).toEqual({ maxHp: 120, maxEnergy: 50, attack: 18, defense: 12, speed: 10 });
  });

  it("returns no units for an unknown challenge target", () => {
    expect(buildEncounter(makeWorld([]), asEnemyId("unknown"))).toEqual([]);
  });
});
