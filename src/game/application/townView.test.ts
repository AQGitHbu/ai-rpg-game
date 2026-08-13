import { describe, expect, it } from "vitest";
import { buildTownView } from "./townView";
import type { WorldState, NpcEntry } from "@/game/domain/worldState";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createTownRuntime, bindNpcToTownSlot } from "@/game/gameplay/rpg/town";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/worldEntity";

function makeWorldWithTown(): WorldState {
  const town = bindNpcToTownSlot(
    createTownRuntime({ locationId: asLocationId("loc_0"), seed: "town-view-test" }),
    asNpcId("npc_0"),
  ).town;
  const base = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "游侠", identity: "冒险者", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_0"), name: "边陲小镇", description: "一座边陲小镇。", kind: "main",
      connectedLocationIds: [], npcIds: [asNpcId("npc_0")], availableItemIds: [], tags: [],
      scale: "town", town,
    },
    startingItemIds: [],
  });
  const npc: NpcEntry = {
    id: asNpcId("npc_0"), name: "沈掌柜", role: "关键线人", description: "掌握消息的知情人。",
    locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_0"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  return { ...base, npcs: [npc] };
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

  it("只暴露已绑定 NPC 的 slot；空闲 slot 不产生可交互条目", () => {
    const town = createTownRuntime({ locationId: asLocationId("loc_0"), seed: "town-view-test-2" });
    const ws = createInitialWorldState({
      generation: { generationId: asGenerationId("g2"), seed: "s2", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "游侠", identity: "冒险者", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: {
        id: asLocationId("loc_0"), name: "空镇", description: "一座无人小镇。", kind: "main",
        connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
        scale: "town", town,
      },
      startingItemIds: [],
    });
    const view = buildTownView(ws, "loc_0");
    expect(view).not.toBeNull();
    expect(view!.interactiveBuildings).toHaveLength(0);
  });

  it("补偿只存在地点绑定、但尚未写入 slot 的在场 NPC", () => {
    const locationId = asLocationId("loc_0");
    const npcId = asNpcId("npc_0");
    const town = createTownRuntime({ locationId, seed: "town-view-repair" });
    const base = createInitialWorldState({
      generation: { generationId: asGenerationId("g3"), seed: "s3", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "游侠", identity: "冒险者", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: {
        id: locationId, name: "青石镇", description: "一座边陲小镇。", kind: "main",
        connectedLocationIds: [], npcIds: [npcId], availableItemIds: [], tags: [], scale: "town", town,
      },
      startingItemIds: [],
    });
    const ws: WorldState = {
      ...base,
      npcs: [{
        id: npcId, name: "刘二", role: "关键线人", description: "掌握消息。", locationId,
        isCompanion: false, tags: [], met: false,
        memory: { npcId, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
      }],
    };

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
    const base = createInitialWorldState({
      generation: { generationId: asGenerationId("g-focus"), seed: "s-focus", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "游侠", identity: "冒险者", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: {
        id: locationId, name: "青石镇", description: "一座边陲小镇。", kind: "main",
        connectedLocationIds: [], npcIds: [...slotNpcIds, focusNpcId], availableItemIds: [], tags: [], scale: "town", town,
      },
      startingItemIds: [],
    });
    const npc = (id: typeof focusNpcId, name: string) => ({
      id, name, role: "旧案传讯人", description: "带着线索而来。", locationId,
      isCompanion: false, tags: [], met: false,
      memory: { npcId: id, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral" as const, goals: [] },
    });
    const view = buildTownView({
      ...base,
      npcs: [
        ...slotNpcIds.map((id, index) => npc(id, `旧人物${index + 1}`)),
        npc(focusNpcId, "当前目标"),
      ],
    }, locationId, focusNpcId);
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
