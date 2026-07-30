import { describe, expect, it } from "vitest";
import { TOWN_GRID_MAX, TOWN_GRID_MIN, type TownSemanticPlan } from "@/game/domain";
import { createFallbackTownPlan } from "./fallbackTownPlan";
import { generateTown } from "./generateTown";
import {
  validateTownPlanCandidate,
  type TownPlanValidationContext
} from "./validateTownPlanCandidate";

// 校验矩阵：接受 / 机械修复 / 拒绝（schema、覆盖、编译验证失败）。
// baseline 用 fallback plan 改造出剧情 NPC 建筑，模拟离线派生规划。

const SEED = "town-plan-test-1";

function makeBaseline(): TownSemanticPlan {
  const base = createFallbackTownPlan(SEED);
  return {
    ...base,
    theme: "青崖镇",
    requiredBuildings: [
      {
        key: "story_npc_npc_a",
        buildingType: "tavern",
        preferredDistrict: "market",
        importance: "story_required",
        displayName: "老掌柜的酒楼"
      },
      {
        key: "story_npc_npc_b",
        buildingType: "blacksmith",
        preferredDistrict: "craft",
        importance: "story_required",
        displayName: "渡口船娘的铁匠铺"
      }
    ]
  };
}

function makeContext(overrides: Partial<TownPlanValidationContext> = {}): TownPlanValidationContext {
  return { seed: SEED, baseline: makeBaseline(), ...overrides };
}

/** 结构完整、全部枚举合法的 AI 候选（覆盖 baseline 全部 key）。 */
function makeValidTownCandidate(): Record<string, unknown> {
  const baseline = makeBaseline();
  return {
    theme: "  雾隐渡口镇  ",
    gridSize: { width: 28, height: 30 },
    terrain: { river: "north", externalRoad: "east_west" },
    districts: baseline.districts.map((district) => ({ ...district })),
    requiredBuildings: baseline.requiredBuildings.map((required) => ({ ...required })),
    landmarks: [{ type: "well", preferredArea: "center" }]
  };
}

describe("validateTownPlanCandidate：接受", () => {
  it("合法候选：theme trim、planVersion 强制 1、深度确定性", () => {
    const result = validateTownPlanCandidate(makeValidTownCandidate(), makeContext());
    if (!result.ok) throw new Error(`期望接受，得到 ${result.reason}`);
    expect(result.plan.planVersion).toBe(1);
    expect(result.plan.theme).toBe("雾隐渡口镇");
    expect(result.plan.gridSize).toEqual({ width: 28, height: 30 });
    expect(result.plan.terrain).toEqual({ river: "north", externalRoad: "east_west" });
    expect(validateTownPlanCandidate(makeValidTownCandidate(), makeContext())).toEqual(result);
    // 接受的规划必须能真实编译（不只是注入的 compile stub）。
    expect(() => generateTown({ seed: SEED, plan: result.plan })).not.toThrow();
  });
});

describe("validateTownPlanCandidate：机械修复", () => {
  it("gridSize 钳制到合法域；非数值回落 baseline", () => {
    const candidate = { ...makeValidTownCandidate(), gridSize: { width: 100, height: "wide" } };
    const result = validateTownPlanCandidate(candidate, makeContext());
    if (!result.ok) throw new Error("应当接受");
    expect(result.plan.gridSize.width).toBe(TOWN_GRID_MAX);
    expect(result.plan.gridSize.height).toBe(makeBaseline().gridSize.height);
    expect(result.plan.gridSize.width).toBeLessThanOrEqual(TOWN_GRID_MAX);
    expect(result.plan.gridSize.height).toBeGreaterThanOrEqual(TOWN_GRID_MIN);
  });

  it("未知枚举条目剔除：districts/landmarks 全非法时回落 baseline", () => {
    const candidate = {
      ...makeValidTownCandidate(),
      terrain: { river: "lava", externalRoad: "diagonal" },
      districts: [{ type: "slum", preferredArea: "center", weight: 50 }],
      landmarks: [{ type: "volcano", preferredArea: "center" }]
    };
    const result = validateTownPlanCandidate(candidate, makeContext());
    if (!result.ok) throw new Error("应当接受");
    const baseline = makeBaseline();
    expect(result.plan.terrain).toEqual(baseline.terrain);
    expect(result.plan.districts).toEqual(baseline.districts);
    expect(result.plan.landmarks).toEqual(baseline.landmarks);
  });

  it("requiredBuildings：非法条目剔除、key 去重、截断到 8", () => {
    const baseline = makeBaseline();
    const fillers = Array.from({ length: 9 }, (_, index) => ({
      key: `extra_${index + 1}`,
      buildingType: "house",
      preferredDistrict: "residential"
    }));
    const candidate = {
      ...makeValidTownCandidate(),
      requiredBuildings: [
        ...baseline.requiredBuildings,
        { key: "story_npc_npc_a", buildingType: "shop", preferredDistrict: "market" }, // 重复 key
        { key: "bad_enum", buildingType: "castle", preferredDistrict: "market" }, // 非法枚举
        "not_an_object",
        ...fillers
      ]
    };
    const result = validateTownPlanCandidate(candidate, makeContext());
    if (!result.ok) throw new Error("应当接受");
    expect(result.plan.requiredBuildings).toHaveLength(8);
    const keys = result.plan.requiredBuildings.map((entry) => entry.key);
    expect(keys.slice(0, 2)).toEqual(["story_npc_npc_a", "story_npc_npc_b"]);
    expect(new Set(keys).size).toBe(8);
    expect(keys).not.toContain("bad_enum");
    // 去重保留首个条目：npc_a 仍是 tavern 而非重复条目的 shop。
    expect(result.plan.requiredBuildings[0].buildingType).toBe("tavern");
  });
});

describe("validateTownPlanCandidate：拒绝", () => {
  it("非对象候选与缺失 requiredBuildings 数组 → schema_violation", () => {
    expect(validateTownPlanCandidate(null, makeContext())).toEqual({
      ok: false,
      reason: "schema_violation"
    });
    expect(validateTownPlanCandidate("{}", makeContext())).toEqual({
      ok: false,
      reason: "schema_violation"
    });
    const candidate = { ...makeValidTownCandidate(), requiredBuildings: "none" };
    expect(validateTownPlanCandidate(candidate, makeContext())).toEqual({
      ok: false,
      reason: "schema_violation"
    });
  });

  it("剧情 NPC 建筑覆盖缺失 → coverage_missing（机械修复禁止伪造）", () => {
    const candidate = {
      ...makeValidTownCandidate(),
      requiredBuildings: [
        { key: "story_npc_npc_a", buildingType: "tavern", preferredDistrict: "market" }
        // story_npc_npc_b 缺失。
      ]
    };
    expect(validateTownPlanCandidate(candidate, makeContext())).toEqual({
      ok: false,
      reason: "coverage_missing"
    });
  });

  it("编译验证失败 → compile_failed（注入失败编译入口）", () => {
    const failingCompile = () => {
      throw new Error("编译失败");
    };
    expect(
      validateTownPlanCandidate(makeValidTownCandidate(), makeContext({ compile: failingCompile }))
    ).toEqual({ ok: false, reason: "compile_failed" });
  });
});
