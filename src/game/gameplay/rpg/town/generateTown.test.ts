import { describe, expect, it } from "vitest";
import { TOWN_GENERATOR_VERSION, tileIndex, type TileType } from "@/game/domain/townState";
import { createFallbackTownPlan } from "./fallbackTownPlan";
import { generateTown, TownGenerationError } from "./generateTown";

/** 门前格（入口沿朝向外移一格）可走的道路瓦片。 */
const ROAD_TILES: ReadonlySet<TileType> = new Set<TileType>(["road_main", "road_minor", "alley", "square"]);

const SIDE_OFFSETS = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  west: { dx: -1, dy: 0 },
  east: { dx: 1, dy: 0 }
} as const;

describe("generateTown", () => {
  it("demo-1 成功产出快照：版本/种子/validation 元数据齐全", () => {
    const snapshot = generateTown({ seed: "demo-1" });
    expect(snapshot.snapshotVersion).toBe(1);
    expect(snapshot.seed).toBe("demo-1");
    expect(snapshot.generatorVersion).toBe(TOWN_GENERATOR_VERSION);
    expect(snapshot.plan).toEqual(createFallbackTownPlan("demo-1"));
    expect(snapshot.grid.width).toBe(32);
    expect(snapshot.grid.height).toBe(32);
    expect(snapshot.grid.tiles).toHaveLength(32 * 32);
    expect(snapshot.validation.valid).toBe(true);
    expect(snapshot.validation.repairCount).toBeGreaterThanOrEqual(0);
    expect(snapshot.validation.repairCount).toBeLessThanOrEqual(20);
    expect(snapshot.validation.retryCount).toBeGreaterThanOrEqual(0);
    expect(snapshot.validation.retryCount).toBeLessThanOrEqual(3);
    expect(snapshot.roadGraph.nodes.some((node) => node.id === snapshot.mainGateNodeId)).toBe(true);
  });

  it("成功快照零 issue：每栋建筑门前格为道路（修复管线兜底生效）", () => {
    const snapshot = generateTown({ seed: "demo-1" });
    expect(snapshot.buildings.length).toBeGreaterThan(0);
    for (const building of snapshot.buildings) {
      const offset = SIDE_OFFSETS[building.entrance.direction];
      const x = building.entrance.x + offset.dx;
      const y = building.entrance.y + offset.dy;
      expect(ROAD_TILES.has(snapshot.grid.tiles[tileIndex(snapshot.grid, x, y)])).toBe(true);
    }
  });

  it("剧情建筑 3 栋全部存在", () => {
    const snapshot = generateTown({ seed: "demo-1" });
    const story = snapshot.buildings.filter((building) => building.storyRequired);
    expect(story.map((building) => building.buildingType).sort()).toEqual(["blacksmith", "house", "tavern"]);
  });

  it("同 seed 两次调用深度相等", () => {
    expect(generateTown({ seed: "demo-1" })).toEqual(generateTown({ seed: "demo-1" }));
  });

  it("不同 seed 的 buildings 布局不同", () => {
    const first = generateTown({ seed: "demo-1" });
    const second = generateTown({ seed: "demo-2" });
    expect(first.buildings).not.toEqual(second.buildings);
  });

  it("显式传 plan 时不走 fallback（theme 原样进入快照）", () => {
    const plan = { ...createFallbackTownPlan("demo-1"), theme: "自定义主题镇" };
    const snapshot = generateTown({ seed: "demo-1", plan });
    expect(snapshot.plan.theme).toBe("自定义主题镇");
  });

  it("TownGenerationError 携带 issues 列表", () => {
    const error = new TownGenerationError("生成失败", [
      { code: "ENTRANCE_MISSING", buildingId: "building_1" }
    ]);
    expect(error).toBeInstanceOf(Error);
    expect(error.issues).toEqual([{ code: "ENTRANCE_MISSING", buildingId: "building_1" }]);
  });
});
