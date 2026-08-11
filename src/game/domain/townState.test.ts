import { describe, expect, it } from "vitest";
import {
  tileIndex,
  TOWN_GENERATOR_VERSION,
  TOWN_GRID_DEFAULT,
  type TownBuildingSlot,
  type TownRuntimeState,
} from "./townState";
import { asLocationId, asNpcId } from "./worldEntity";

describe("townState helpers", () => {
  it("tileIndex 以行优先计算扁平索引", () => {
    expect(tileIndex({ width: 8 }, 3, 2)).toBe(2 * 8 + 3);
    expect(tileIndex({ width: 32 }, 0, 0)).toBe(0);
    expect(tileIndex({ width: 32 }, 31, 31)).toBe(32 * 32 - 1);
  });

  it("导出生成器版本与网格默认尺寸", () => {
    expect(TOWN_GENERATOR_VERSION).toBe("town-gen-0.1.0");
    expect(TOWN_GRID_DEFAULT).toBe(32);
  });
});

describe("TownRuntimeState shape", () => {
  it("承载稳定 slot 列表与绑定关系", () => {
    const slots: readonly TownBuildingSlot[] = [
      { slotId: "slot_0", buildingId: "building_1", buildingType: "tavern", boundNpcId: asNpcId("npc_0") },
      { slotId: "slot_1", buildingId: "building_3", buildingType: "blacksmith", boundNpcId: null },
      { slotId: "slot_2", buildingId: "building_5", buildingType: "house", boundNpcId: null },
    ];
    const town: TownRuntimeState = {
      locationId: asLocationId("loc_0"),
      seed: "seed#town#loc_0",
      generatorVersion: TOWN_GENERATOR_VERSION,
      slots,
    };
    expect(town.slots).toHaveLength(3);
    expect(town.slots[0]?.boundNpcId).toBe(asNpcId("npc_0"));
    expect(town.slots[2]?.boundNpcId).toBeNull();
    expect(town.slots.map((slot) => slot.buildingType)).toEqual(["tavern", "blacksmith", "house"]);
  });
});
