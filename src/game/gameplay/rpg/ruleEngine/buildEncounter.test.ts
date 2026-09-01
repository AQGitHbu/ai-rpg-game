import { describe, expect, it } from "vitest";
import { createInitialWorldState, type EnemyEntry, type WorldState } from "@/game/domain/worldState";
import { asEnemyId, asGenerationId, asLocationId, asNpcId } from "@/game/domain/worldEntity";
import { createEntityStore, projectEntityStore, type NpcEntityRecord } from "@/game/domain/entity";
import { COMPANION_COMBAT_STATS } from "@/game/domain/combat";
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

function companionRecord(id: string, locationId: ReturnType<typeof asLocationId>, options?: {
  readonly isCompanion?: boolean;
  readonly lifecycle?: "active" | "inactive";
  readonly locationId?: ReturnType<typeof asLocationId>;
}): NpcEntityRecord {
  return {
    core: { id: asNpcId(id), kind: "npc", name: id, createdAtTurn: 0, lifecycle: options?.lifecycle ?? "active" },
    identity: {
      role: "同行者", description: "同行者", tags: [],
      anchors: {
        selfConcept: "同行者", values: ["守望"], speechStyle: "简短",
        capabilityBoundaries: ["不会飞"], taboos: [],
      },
    },
    position: { locationId: options?.locationId ?? locationId, locationOrder: 0 },
    dynamicState: { isCompanion: options?.isCompanion ?? true, met: true, emotion: "neutral", goals: [] },
    knowledge: { entries: [] },
    relationships: { outgoing: [] },
    history: { interactions: [] },
  };
}

function addNpcs(world: WorldState, records: readonly NpcEntityRecord[]): WorldState {
  const store = createEntityStore([...world.entityStore.records, ...records]);
  const projection = projectEntityStore(store);
  return { ...world, entityStore: store, ...projection, enemies: world.enemies };
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

  it("selects one active same-location companion from authoritative records in stable id order", () => {
    const locationId = asLocationId("loc_1");
    const world = addNpcs(
      makeWorld([normal("enemy_a", "敌人")]),
      [
        companionRecord("npc_z", locationId),
        companionRecord("npc_a", locationId),
        companionRecord("npc_inactive", locationId, { lifecycle: "inactive" }),
        companionRecord("npc_elsewhere", locationId, { locationId: asLocationId("loc_elsewhere") }),
        companionRecord("npc_not_companion", locationId, { isCompanion: false }),
      ],
    );
    // Compatibility arrays are intentionally stale: selection must use the entity store.
    const staleNpcs = world.npcs.map((npc) => ({ ...npc, isCompanion: false }));
    const encounter = buildEncounter({ ...world, npcs: staleNpcs }, asEnemyId("enemy_a"));
    expect(encounter.map((unit) => unit.combatantId)).toEqual([
      "ally:protagonist", "companion:npc_a", "enemy:enemy_a",
    ]);
    expect(encounter[1]).toMatchObject({
      side: "allies", controller: "rule", source: { kind: "companion", npcId: asNpcId("npc_a") },
      name: "npc_a", stats: COMPANION_COMBAT_STATS,
    });
  });
});
