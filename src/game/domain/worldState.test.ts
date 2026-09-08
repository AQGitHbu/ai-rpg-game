import { describe, it, expect } from "vitest";
import {
  createInitialWorldState,
  findLocation,
  isTravelTarget,
  findNpc,
  InitialWorldStateInvariantError,
  type LocationEntry,
  type NpcEntry,
  type WorldFactEntry,
} from "./worldState";
import { asLocationId, asNpcId, asItemId, asFactId, asGenerationId } from "./worldEntity";
import { entitiesOfKind } from "./entity/entityStore";
import { validateEntityCompatibilityProjection, type EntityCompatibilityProjection } from "./entity/entityProjection";
import { createWorldStateFixture, updateWorldStateFixture } from "./testing/worldStateFixture.testutil";

describe("WorldState", () => {
  const startingLocation: LocationEntry = {
    id: asLocationId("loc_1"),
    name: "起始客栈",
    description: "测试",
    kind: "main",
    connectedLocationIds: [],
    npcIds: [],
    availableItemIds: [],
    tags: [],
    scale: "scene",
  };
  const baseInput = {
    generation: {
      generationId: asGenerationId("gen_test"),
      seed: "test-seed",
      templateVersion: "v2",
      inputDigest: "",
      gameType: "wuxia" as const,
    },
    player: { name: "测试侠客", identity: "流浪剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation,
    startingItemIds: [] as const,
  };

  /** 只改地点集合的最小投影：其余实体类型留空，由 fixture helper 编译成 store。 */
  function projectionFor(
    locations: readonly LocationEntry[],
    overrides: Partial<EntityCompatibilityProjection> = {},
  ): EntityCompatibilityProjection {
    return {
      player: baseInput.player,
      locations,
      currentLocationId: locations[0].id,
      unlockedLocationIds: locations.map((entry) => entry.id),
      visitedLocationIds: [locations[0].id],
      npcs: [],
      items: [],
      inventory: [],
      worldFacts: [],
      quests: [],
      enemies: [],
      defeatedEnemyIds: [],
      factions: [],
      ...overrides,
    };
  }

  it("createInitialWorldState 编译 schema 6 世界与 store v2，兼容数组只是投影结果", () => {
    const ws = createInitialWorldState(baseInput);
    expect(ws.version).toBe(6);
    expect(ws.entityStore.version).toBe(2);
    expect(ws.player.name).toBe("测试侠客");
    expect(ws.currentLocationId).toBe(asLocationId("loc_1"));
    expect(ws.locations).toHaveLength(1); // 起始地点必须在 locations 内，currentLocationId 不指向不存在的地点
    expect(ws.eventLedger[0]?.kind).toBe("game_initialized");
    // 开局 store 只有玩家 + 起始地点两条 record。
    expect(ws.entityStore.records).toHaveLength(2);
    expect(entitiesOfKind(ws.entityStore, "location").map((record) => record.core.id)).toEqual([asLocationId("loc_1")]);
    expect(validateEntityCompatibilityProjection(ws.entityStore, ws)).toEqual([]);
  });

  it("只给 ID 的初始物品被拒绝：不允许从 ID 伪造实体", () => {
    let thrown: unknown;
    try {
      createInitialWorldState({ ...baseInput, startingItemIds: [asItemId("item_1")] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InitialWorldStateInvariantError);
    expect((thrown as InitialWorldStateInvariantError).code).toBe("initial_item_details_required");
  });

  it("findLocation returns entry by id, undefined if missing", () => {
    const ws = createInitialWorldState(baseInput);
    const loc = findLocation(ws, asLocationId("loc_1"));
    expect(loc?.id).toBe(asLocationId("loc_1"));
    expect(findLocation(ws, asLocationId("nonexistent"))).toBeUndefined();
  });

  it("fixture 修改地点投影时重建 store：兼容数组与 record 同步增长", () => {
    const ws = createInitialWorldState(baseInput);
    const newLoc: LocationEntry = {
      id: asLocationId("loc_new"),
      name: "新地点",
      description: "测试",
      kind: "main",
      connectedLocationIds: [],
      npcIds: [],
      availableItemIds: [],
      tags: [],
      scale: "scene",
    };
    const ws2 = updateWorldStateFixture(ws, { locations: [...ws.locations, newLoc] });
    expect(findLocation(ws2, asLocationId("loc_new"))).toBeDefined();
    expect(findLocation(ws, asLocationId("loc_new"))).toBeUndefined(); // 原state不变
    expect(entitiesOfKind(ws2.entityStore, "location").map((record) => record.core.id))
      .toEqual([asLocationId("loc_1"), asLocationId("loc_new")]);
    expect(validateEntityCompatibilityProjection(ws2.entityStore, ws2)).toEqual([]);
  });

  it("允许回访已到访地点，但未到访地点仍要求当前地点相邻", () => {
    const loc1 = asLocationId("loc_1");
    const loc2 = asLocationId("loc_2");
    const loc3 = asLocationId("loc_3");
    const ws = createWorldStateFixture({
      generation: baseInput.generation,
      projection: projectionFor(
        [
          { ...startingLocation, id: loc1, connectedLocationIds: [loc2] },
          { ...startingLocation, id: loc2, name: "loc2", connectedLocationIds: [loc1, loc3] },
          { ...startingLocation, id: loc3, name: "loc3", connectedLocationIds: [loc2] },
        ],
        { visitedLocationIds: [loc1, loc2] },
      ),
    });

    expect(isTravelTarget(ws, loc2)).toBe(true);
    expect(isTravelTarget(ws, loc3)).toBe(false);
  });

  it("fixture 修改 NPC 投影时由位置组件派生名册", () => {
    const ws = createInitialWorldState(baseInput);
    const newNpc: NpcEntry = {
      id: asNpcId("npc_new"),
      name: "新NPC",
      role: "路人",
      description: "测试",
      locationId: asLocationId("loc_1"),
      isCompanion: false,
      tags: [],
      met: false,
      memory: {
        npcId: asNpcId("npc_new"),
        knownFactIds: [],
        hiddenFactIds: [],
        interactionHistory: [],
        relationship: { affinity: 0 },
        emotion: "neutral",
        goals: [],
      },
    };
    const ws2 = updateWorldStateFixture(ws, { npcs: [...ws.npcs, newNpc] });
    expect(findNpc(ws2, asNpcId("npc_new"))).toBeDefined();
    // 位置由 PositionComponent 决定：名册随之派生，不再由调用方手填。
    expect(findLocation(ws2, asLocationId("loc_1"))?.npcIds).toEqual([asNpcId("npc_new")]);
    expect(validateEntityCompatibilityProjection(ws2.entityStore, ws2)).toEqual([]);
  });

  it("accepts a bounded investigation approach without exposing fact text", () => {
    const fact: WorldFactEntry = {
      factId: asFactId("fact_trace"),
      text: "完整事实正文",
      source: "generated" as const,
      discovered: false,
      investigationLabel: "泥地上的异常痕迹",
      investigationApproaches: [
        { approachId: "follow", label: "沿痕迹追查", evidenceQuality: "clean" as const, tensionDelta: 4 },
        { approachId: "search", label: "翻查附近杂物", evidenceQuality: "noisy" as const, tensionDelta: 12 },
      ],
    };
    expect(fact.investigationApproaches).toHaveLength(2);
    expect(fact.investigationApproaches?.[0]?.label).not.toContain(fact.text);
  });
});
