import { describe, expect, it } from "vitest";
import { tileIndex, type TownSemanticPlan } from "@/game/domain";
import { createTownRng } from "./townRandom";
import { generateTerrain, type TerrainLayout } from "./terrain";

/** 固定语义规划：绕过 fallback，直接钉住 terrain 关心的字段。 */
function makePlan(terrain: TownSemanticPlan["terrain"]): TownSemanticPlan {
  return {
    planVersion: 1,
    theme: "测试镇",
    gridSize: { width: 32, height: 32 },
    terrain,
    districts: [
      { type: "market", preferredArea: "center", weight: 35 },
      { type: "residential", preferredArea: "north", weight: 30 },
      { type: "craft", preferredArea: "east", weight: 20 },
      { type: "reserved", preferredArea: "edge", weight: 15 }
    ],
    requiredBuildings: [],
    landmarks: [{ type: "well", preferredArea: "center" }]
  };
}

const PLAIN_PLAN = makePlan({ river: "none", externalRoad: "east_west" });

function terrainFor(seed: string, plan: TownSemanticPlan = PLAIN_PLAN): TerrainLayout {
  return generateTerrain(plan, createTownRng(seed));
}

describe("generateTerrain", () => {
  it("同 seed 同 plan 深度相等", () => {
    expect(terrainFor("seed-a")).toEqual(terrainFor("seed-a"));
  });

  it("不同 seed 产生不同边界（buildableMask 不同）", () => {
    expect(terrainFor("seed-a").buildableMask).not.toEqual(terrainFor("seed-b").buildableMask);
  });

  it("三个扁平数组长度均为 width*height", () => {
    const terrain = terrainFor("seed-len");
    expect(terrain.width).toBe(32);
    expect(terrain.height).toBe(32);
    expect(terrain.buildableMask).toHaveLength(32 * 32);
    expect(terrain.baseTiles).toHaveLength(32 * 32);
    expect(terrain.roadCost).toHaveLength(32 * 32);
  });

  it("buildableMask 为 true 的格均不是城外/水域", () => {
    const terrain = terrainFor("seed-mask");
    for (let i = 0; i < terrain.buildableMask.length; i += 1) {
      if (!terrain.buildableMask[i]) continue;
      expect(terrain.baseTiles[i]).not.toBe("outside");
      expect(terrain.baseTiles[i]).not.toBe("water");
    }
  });

  it("四角在椭圆边界外：outside、不可建、roadCost=Infinity", () => {
    const terrain = terrainFor("seed-corner");
    const corners = [
      [0, 0],
      [31, 0],
      [0, 31],
      [31, 31]
    ] as const;
    for (const [x, y] of corners) {
      const index = tileIndex(terrain, x, y);
      expect(terrain.baseTiles[index]).toBe("outside");
      expect(terrain.buildableMask[index]).toBe(false);
      expect(terrain.roadCost[index]).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it("中心格可建", () => {
    const terrain = terrainFor("seed-center");
    expect(terrain.buildableMask[tileIndex(terrain, 16, 16)]).toBe(true);
  });

  it("river=north 时顶部 3 行内存在 water，且所有 water 格 roadCost=20 不可建", () => {
    const plan = makePlan({ river: "north", externalRoad: "east_west" });
    const terrain = terrainFor("seed-river", plan);
    let topWater = 0;
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        if (terrain.baseTiles[tileIndex(terrain, x, y)] === "water") topWater += 1;
      }
    }
    expect(topWater).toBeGreaterThan(0);
    for (let i = 0; i < terrain.baseTiles.length; i += 1) {
      if (terrain.baseTiles[i] !== "water") continue;
      expect(terrain.roadCost[i]).toBe(20);
      expect(terrain.buildableMask[i]).toBe(false);
    }
  });

  it("river=none 时不出现 water", () => {
    const terrain = terrainFor("seed-dry");
    expect(terrain.baseTiles.includes("water")).toBe(false);
  });

  it("forest 格数 ≤ 总面积 8%，且 forest=3 / grass=1.2 代价", () => {
    const terrain = terrainFor("seed-forest");
    let forestCount = 0;
    for (let i = 0; i < terrain.baseTiles.length; i += 1) {
      if (terrain.baseTiles[i] === "forest") {
        forestCount += 1;
        expect(terrain.roadCost[i]).toBe(3);
      }
      if (terrain.baseTiles[i] === "grass") {
        expect(terrain.roadCost[i]).toBe(1.2);
      }
    }
    expect(forestCount).toBeLessThanOrEqual(Math.floor(32 * 32 * 0.08));
  });
});
