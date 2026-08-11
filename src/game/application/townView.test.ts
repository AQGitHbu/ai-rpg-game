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