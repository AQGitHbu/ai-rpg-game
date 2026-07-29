import { describe, expect, it } from "vitest";
import { createFallbackTownPlan } from "./fallbackTownPlan";
import { createFallbackTownPlan as facadeCreateFallbackTownPlan, createTownRng as facadeCreateTownRng } from "./index";

describe("createFallbackTownPlan", () => {
  it("同 seed 深度相等", () => {
    expect(createFallbackTownPlan("seed-a")).toEqual(createFallbackTownPlan("seed-a"));
  });

  it("planVersion 恒为 1", () => {
    expect(createFallbackTownPlan("seed-a").planVersion).toBe(1);
  });

  it("gridSize 恒为 32×32", () => {
    const plan = createFallbackTownPlan("seed-grid");
    expect(plan.gridSize).toEqual({ width: 32, height: 32 });
  });

  it("恒有 3 个剧情建筑：tavern@market、blacksmith@craft、house@residential", () => {
    const plan = createFallbackTownPlan("seed-buildings");
    expect(plan.requiredBuildings).toHaveLength(3);
    const byType = plan.requiredBuildings.map((building) => [building.buildingType, building.preferredDistrict]);
    expect(byType).toContainEqual(["tavern", "market"]);
    expect(byType).toContainEqual(["blacksmith", "craft"]);
    expect(byType).toContainEqual(["house", "residential"]);
    for (const building of plan.requiredBuildings) {
      expect(building.importance).toBe("story_required");
      expect(building.key.length).toBeGreaterThan(0);
    }
  });

  it("包含 market/residential/craft/reserved 四区域且权重和为 100", () => {
    const plan = createFallbackTownPlan("seed-districts");
    const types = plan.districts.map((district) => district.type);
    expect([...types].sort()).toEqual(["craft", "market", "reserved", "residential"]);
    const weightSum = plan.districts.reduce((sum, district) => sum + district.weight, 0);
    expect(weightSum).toBe(100);
  });

  it("theme 非空且同 seed 稳定；含 well 地标", () => {
    const plan = createFallbackTownPlan("seed-theme");
    expect(plan.theme.length).toBeGreaterThan(0);
    expect(plan.theme).toBe(createFallbackTownPlan("seed-theme").theme);
    expect(plan.landmarks).toHaveLength(1);
    expect(plan.landmarks[0].type).toBe("well");
  });
});

describe("town 门面", () => {
  it("index.ts 导出 createFallbackTownPlan 与 createTownRng", () => {
    expect(facadeCreateFallbackTownPlan("seed-a")).toEqual(createFallbackTownPlan("seed-a"));
    expect(facadeCreateTownRng("seed-a").next()).toBeGreaterThanOrEqual(0);
  });
});
