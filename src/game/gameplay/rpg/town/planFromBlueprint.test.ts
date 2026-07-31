import { describe, expect, it } from "vitest";
import { asLocationId, asNpcId, type ScenarioBlueprint } from "@/game/domain";
import { compileScenarioBlueprint } from "../scenario/compileScenarioBlueprint";
import { validateScenarioBlueprintCandidate } from "../scenario/validateScenarioBlueprint";
import { TEST_POLICY, TEST_PROFILE, makeValidCandidate } from "../scenario/scenarioBlueprintFixture.testutil";
import { createFallbackTownPlan } from "./fallbackTownPlan";
import { createTownPlanFromLocation } from "./planFromBlueprint";

// fixture 蓝图本身没有 town 地点（S7 才改开局契约），测试用编译产物 + 打补丁
// 的方式给 loc_a 标 scale: "town"，与旧存档零迁移的可选字段模式一致。

function compileFixtureBlueprint(): ScenarioBlueprint {
  const validation = validateScenarioBlueprintCandidate(makeValidCandidate(), { profile: TEST_PROFILE, policy: TEST_POLICY });
  const compiled = compileScenarioBlueprint(validation);
  if (!compiled.ok) throw new Error("fixture 应当编译成功");
  return compiled.blueprint;
}

/** 给指定地点打上 scale: "town"（可选地覆盖 npcIds）。 */
function withTownScale(
  blueprint: ScenarioBlueprint,
  locationId: string,
  npcIds?: readonly string[]
): ScenarioBlueprint {
  return {
    ...blueprint,
    locations: blueprint.locations.map((location) =>
      String(location.id) === locationId
        ? {
            ...location,
            scale: "town" as const,
            ...(npcIds !== undefined ? { npcIds: npcIds.map(asNpcId) } : {})
          }
        : location
    )
  };
}

describe("createTownPlanFromLocation：离线规划派生", () => {
  it("theme 取地点名，requiredBuildings 由地点 NPC 派生（key/展示名/偏好区）", () => {
    const blueprint = withTownScale(compileFixtureBlueprint(), "loc_a");
    const plan = createTownPlanFromLocation(blueprint, "loc_a", "seed-town-1");
    expect(plan.theme).toBe("青崖镇");
    // loc_a 只有 npc_a（老掌柜 / 线人）：role 无关键词命中 → house / residential。
    expect(plan.requiredBuildings).toEqual([
      {
        key: "story_npc_npc_a",
        buildingType: "house",
        preferredDistrict: "residential",
        importance: "story_required",
        displayName: "老掌柜的居所"
      }
    ]);
  });

  it("结构基底复用 createFallbackTownPlan：gridSize/terrain/districts/landmarks 只由 seed 决定", () => {
    const blueprint = withTownScale(compileFixtureBlueprint(), "loc_a");
    const plan = createTownPlanFromLocation(blueprint, "loc_a", "seed-town-1");
    const base = createFallbackTownPlan("seed-town-1");
    expect(plan.gridSize).toEqual(base.gridSize);
    expect(plan.terrain).toEqual(base.terrain);
    expect(plan.districts).toEqual(base.districts);
    expect(plan.landmarks).toEqual(base.landmarks);
  });

  it("同蓝图同 seed 深度相等；换 seed 只影响结构基底，不影响 requiredBuildings", () => {
    const blueprint = withTownScale(compileFixtureBlueprint(), "loc_a");
    expect(createTownPlanFromLocation(blueprint, "loc_a", "seed-town-1")).toEqual(
      createTownPlanFromLocation(blueprint, "loc_a", "seed-town-1")
    );
    const other = createTownPlanFromLocation(blueprint, "loc_a", "seed-town-2");
    expect(other.requiredBuildings).toEqual(
      createTownPlanFromLocation(blueprint, "loc_a", "seed-town-1").requiredBuildings
    );
  });

  it("role 关键词映射矩阵：铁匠→blacksmith、酒保→tavern、商贩→shop、木匠→workshop", () => {
    const compiled = compileFixtureBlueprint();
    const roles: Readonly<Record<string, string>> = {
      npc_a: "铁匠",
      npc_b: "酒保",
      npc_c: "商贩",
      npc_d: "木匠"
    };
    const blueprint = withTownScale(
      {
        ...compiled,
        npcs: compiled.npcs.map((npc) => ({ ...npc, role: roles[String(npc.id)] ?? npc.role }))
      },
      "loc_a",
      ["npc_a", "npc_b", "npc_c", "npc_d"]
    );
    const plan = createTownPlanFromLocation(blueprint, "loc_a", "seed-town-1");
    expect(plan.requiredBuildings.map((entry) => entry.buildingType)).toEqual([
      "blacksmith",
      "tavern",
      "shop",
      "workshop"
    ]);
  });

  it("剧情建筑上限 8：超出按 npcIds 声明序截断", () => {
    const compiled = compileFixtureBlueprint();
    const extras = Array.from({ length: 9 }, (_, index) => ({
      ...compiled.npcs[0],
      id: asNpcId(`npc_x${index + 1}`),
      name: `镇民${index + 1}`,
      locationId: asLocationId("loc_a")
    }));
    const blueprint = withTownScale(
      { ...compiled, npcs: [...compiled.npcs, ...extras] },
      "loc_a",
      extras.map((npc) => String(npc.id))
    );
    const plan = createTownPlanFromLocation(blueprint, "loc_a", "seed-town-1");
    expect(plan.requiredBuildings).toHaveLength(8);
    expect(plan.requiredBuildings.map((entry) => entry.key)).toEqual(
      Array.from({ length: 8 }, (_, index) => `story_npc_npc_x${index + 1}`)
    );
  });

  it("地点不存在 / 非 town 层级 / NPC 引用缺失均抛错", () => {
    const blueprint = withTownScale(compileFixtureBlueprint(), "loc_a");
    expect(() => createTownPlanFromLocation(blueprint, "loc_missing", "seed-town-1")).toThrow(
      "地点引用在蓝图中不存在"
    );
    expect(() => createTownPlanFromLocation(blueprint, "loc_b", "seed-town-1")).toThrow(
      "地点不是 town 层级"
    );
    const broken = withTownScale(compileFixtureBlueprint(), "loc_a", ["npc_missing"]);
    expect(() => createTownPlanFromLocation(broken, "loc_a", "seed-town-1")).toThrow(
      "地点 NPC 引用在蓝图中不存在"
    );
  });
});
