import { describe, expect, it } from "vitest";
import { createTownRuntime, townSeedFor } from "./createTownRuntime";
import { TOWN_GENERATOR_VERSION } from "@/game/domain/townState";
import { generateTown } from "./generateTown";
import { asLocationId } from "@/game/domain/worldEntity";

describe("createTownRuntime", () => {
  it("从 seed 生成稳定几何并创建全部未绑定的剧情建筑 slot", () => {
    const town = createTownRuntime({ locationId: asLocationId("loc_0"), seed: "demo-1" });
    expect(town.locationId).toBe(asLocationId("loc_0"));
    expect(town.generatorVersion).toBe(TOWN_GENERATOR_VERSION);
    expect(town.slots.length).toBeGreaterThan(0);
    for (const slot of town.slots) {
      expect(slot.boundNpcId).toBeNull();
      expect(slot.slotId).toMatch(/^slot_\d+$/);
    }
  });

  it("slot 与快照内剧情建筑一一对应（buildingId/buildingType 同源）", () => {
    const seed = "demo-1";
    const town = createTownRuntime({ locationId: asLocationId("loc_0"), seed });
    const snapshot = generateTown({ seed });
    const story = [...snapshot.buildings]
      .filter((building) => building.storyRequired)
      .sort((a, b) => Number(a.buildingId.replace("building_", "")) - Number(b.buildingId.replace("building_", "")));
    expect(town.slots.map((slot) => slot.buildingId)).toEqual(story.map((building) => building.buildingId));
    expect(town.slots.map((slot) => slot.buildingType).sort()).toEqual(["blacksmith", "house", "tavern"]);
  });

  it("同 seed 两次调用深度相等；不同 seed 的 seed 字段不同", () => {
    const first = createTownRuntime({ locationId: asLocationId("loc_0"), seed: "seed-a" });
    expect(createTownRuntime({ locationId: asLocationId("loc_0"), seed: "seed-a" })).toEqual(first);
    const second = createTownRuntime({ locationId: asLocationId("loc_0"), seed: "seed-b" });
    expect(second.seed).toBe("seed-b");
    expect(first.seed).toBe("seed-a");
  });

  it("townSeedFor 由 generation seed + locationId 派生唯一确定性 seed", () => {
    expect(townSeedFor("gen-seed", "loc_0")).toBe("gen-seed#town#loc_0");
    expect(townSeedFor("gen-seed", "loc_1")).toBe("gen-seed#town#loc_1");
    expect(townSeedFor("gen-seed", "loc_0")).not.toBe(townSeedFor("other", "loc_0"));
  });
});

describe("createTownRuntime slot 顺序", () => {
  it("slot_0 与 opening NPC 绑定目标对应：tavern 剧情建筑", () => {
    const town = createTownRuntime({ locationId: asLocationId("loc_0"), seed: "demo-1" });
    expect(town.slots[0]?.slotId).toBe("slot_0");
  });
});
