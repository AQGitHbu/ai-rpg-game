import { describe, expect, it } from "vitest";
import { buildTownView } from "./townView";
import type { LocationEntry, NpcEntry, PlayerState, WorldState } from "@/game/domain/worldState";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import { createWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import { createTownRuntime, bindNpcToTownSlot } from "@/game/gameplay/rpg/town";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/worldEntity";

// ---------------------------------------------------------------------------
// Fixture：单地点小镇世界。起始地点与其名册、NPC 条目一次传入完整兼容投影，
// 由 worldStateFixture 组装 entityStore 后再投影，禁止 spread 单条 legacy 数组。
// ---------------------------------------------------------------------------

const PLAYER: PlayerState = { name: "游侠", identity: "冒险者", stats: { hp: 100, attack: 10, defense: 5 } };

function generationOf(generationId: string, seed: string): GenerationMetadata {
  return {
    generationId: asGenerationId(generationId), seed, templateVersion: "v2", inputDigest: "", gameType: "wuxia",
  };
}

function townNpc(id: NpcEntry["id"], name: string, role: string, description: string): NpcEntry {
  return {
    id, name, role, description,
    locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: false,
    memory: {
      npcId: id, knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
      relationship: { affinity: 0 }, emotion: "neutral", goals: [],
    },
  };
}

function townWorld(input: {
  readonly generation: GenerationMetadata;
  readonly location: LocationEntry;
  readonly npcs: readonly NpcEntry[];
}): WorldState {
  return createWorldStateFixture({
    generation: input.generation,
    projection: {
      player: PLAYER,
      locations: [input.location],
      currentLocationId: input.location.id,
      unlockedLocationIds: [input.location.id],
      visitedLocationIds: [input.location.id],
      npcs: input.npcs,
      items: [],
      inventory: [],
      worldFacts: [],
      quests: [],
      enemies: [],
      defeatedEnemyIds: [],
      factions: [],
    },
  });
}

function makeWorldWithTown(): WorldState {
  const town = bindNpcToTownSlot(
    createTownRuntime({ locationId: asLocationId("loc_0"), seed: "town-view-test" }),
    asNpcId("npc_0"),
  ).town;
  return townWorld({
    generation: generationOf("g1", "s"),
    location: {
      id: asLocationId("loc_0"), name: "边陲小镇", description: "一座边陲小镇。", kind: "main",
      connectedLocationIds: [], npcIds: [asNpcId("npc_0")], availableItemIds: [], tags: [],
      scale: "town", town,
    },
    npcs: [townNpc(asNpcId("npc_0"), "沈掌柜", "关键线人", "掌握消息的知情人。")],
  });
}

describe("buildTownView", () => {
  it("为 town 地点返回含快照与可交互建筑条目的视图", () => {
    const ws = makeWorldWithTown();
    const view = buildTownView(ws, "loc_0");
    expect(view).not.toBeNull();
    expect(view!.townName).toBe("边陲小镇");
    expect(view!.snapshot.grid.width).toBe(32);
    expect(view!.snapshot.grid.height).toBe(32);
    expect(view!.snapshot.buildings.length).toBeGreaterThan(0);
    expect(view!.interactiveBuildings.length).toBe(1); // 只有 npc_0 绑定
    expect(view!.interactiveBuildings[0]?.npcId).toBe("npc_0");
    expect(view!.interactiveBuildings[0]?.npcName).toBe("沈掌柜");
  });

  it("开局候选建筑名覆盖类型默认名，并同步到交互条目与快照", () => {
    const locationId = asLocationId("loc_0");
    const npcId = asNpcId("npc_0");
    const town = bindNpcToTownSlot(
      createTownRuntime({ locationId, seed: "named-town-view", openingBuildingName: "听雨客栈" }),
      npcId,
    ).town;
    const view = buildTownView(townWorld({
      generation: generationOf("g-named", "s-named"),
      location: {
        id: locationId, name: "青石镇", description: "一座边陲小镇。", kind: "main",
        connectedLocationIds: [], npcIds: [npcId], availableItemIds: [], tags: [], scale: "town", town,
      },
      npcs: [townNpc(npcId, "沈掌柜", "关键线人", "掌握消息的知情人。")],
    }), locationId);

    expect(view?.interactiveBuildings[0]?.displayName).toBe("听雨客栈");
    expect(view?.snapshot.buildings.find((building) => building.buildingId === town.slots[0]?.buildingId)?.displayName)
      .toBe("听雨客栈");
  });

  it("只暴露已绑定 NPC 的 slot；空闲 slot 不产生可交互条目", () => {
    const town = createTownRuntime({ locationId: asLocationId("loc_0"), seed: "town-view-test-2" });
    const ws = townWorld({
      generation: generationOf("g2", "s2"),
      location: {
        id: asLocationId("loc_0"), name: "空镇", description: "一座无人小镇。", kind: "main",
        connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
        scale: "town", town,
      },
      npcs: [],
    });
    const view = buildTownView(ws, "loc_0");
    expect(view).not.toBeNull();
    expect(view!.interactiveBuildings).toHaveLength(0);
  });

  it("补偿只存在地点绑定、但尚未写入 slot 的在场 NPC", () => {
    const locationId = asLocationId("loc_0");
    const npcId = asNpcId("npc_0");
    const town = createTownRuntime({ locationId, seed: "town-view-repair" });
    const ws = townWorld({
      generation: generationOf("g3", "s3"),
      location: {
        id: locationId, name: "青石镇", description: "一座边陲小镇。", kind: "main",
        connectedLocationIds: [], npcIds: [npcId], availableItemIds: [], tags: [], scale: "town", town,
      },
      npcs: [townNpc(npcId, "刘二", "关键线人", "掌握消息。")],
    });

    const view = buildTownView(ws, locationId);
    expect(view?.interactiveBuildings).toEqual([
      expect.objectContaining({ npcId: "npc_0", npcName: "刘二", isCurrentFocus: false }),
    ]);
  });

  it("满槽时把当前目标人物投影到高亮剧情建筑，不生成临时会面面板", () => {
    const locationId = asLocationId("loc_0");
    let town = createTownRuntime({ locationId, seed: "town-view-focus" });
    const slotNpcIds = town.slots.map((_, index) => asNpcId(`npc_slot_${index}`));
    for (const npcId of slotNpcIds) town = bindNpcToTownSlot(town, npcId).town;
    const focusNpcId = asNpcId("npc_focus");
    const ws = townWorld({
      generation: generationOf("g-focus", "s-focus"),
      location: {
        id: locationId, name: "青石镇", description: "一座边陲小镇。", kind: "main",
        connectedLocationIds: [], npcIds: [...slotNpcIds, focusNpcId], availableItemIds: [], tags: [], scale: "town", town,
      },
      npcs: [
        ...slotNpcIds.map((id, index) => townNpc(id, `旧人物${index + 1}`, "旧案传讯人", "带着线索而来。")),
        townNpc(focusNpcId, "当前目标", "旧案传讯人", "带着线索而来。"),
      ],
    });
    const view = buildTownView(ws, locationId, focusNpcId);
    expect(view?.interactiveBuildings).toHaveLength(town.slots.length);
    expect(view?.interactiveBuildings.filter((entry) => entry.isCurrentFocus)).toEqual([
      expect.objectContaining({ npcId: "npc_focus", npcName: "当前目标" }),
    ]);
  });

  it("非 town 地点返回 null", () => {
    const ws = makeWorldWithTown();
    // loc_0 是 town，但假设有另一个 scene 地点
    const view = buildTownView(ws, "nonexistent");
    expect(view).toBeNull();
  });

  it("快照不包含 seed/free slots/generator 内部字段", () => {
    const ws = makeWorldWithTown();
    const view = buildTownView(ws, "loc_0");
    const serialized = JSON.stringify(view!.snapshot);
    expect(serialized).not.toMatch(/"seed"/);
    expect(serialized).not.toMatch(/"generatorVersion"/);
    expect(serialized).not.toMatch(/"plan"/);
    expect(serialized).not.toMatch(/"validation"/);
  });
});
