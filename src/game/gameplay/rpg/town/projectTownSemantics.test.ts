import { describe, expect, it } from "vitest";
import type { TownSnapshot } from "@/game/domain";
import { generateTown } from "./generateTown";
import { createFallbackTownPlan } from "./fallbackTownPlan";
import { projectTownSemanticView, type TownCompassArea } from "./projectTownSemantics";

// 语义投影测试：用 generateTown 的真实快照做输入，验证方位/邻近/句子
// 的确定性与只投影具名建筑的约束。

const TOWN_NAME = "大石镇";

/** 邻近句触发阈值（与实现内 NEARBY_DISTANCE 对齐）。 */
const NEARBY_DISTANCE = 10;

const AREA_VALUES: readonly TownCompassArea[] = [
  "center",
  "north",
  "north_east",
  "east",
  "south_east",
  "south",
  "south_west",
  "west",
  "north_west"
];

function namedBuildings(snapshot: TownSnapshot) {
  return snapshot.buildings.filter((building) => building.definitionState === "named");
}

function entranceDistance(snapshot: TownSnapshot, idA: string, idB: string): number {
  const a = snapshot.buildings.find((building) => building.buildingId === idA)!;
  const b = snapshot.buildings.find((building) => building.buildingId === idB)!;
  return Math.abs(a.entrance.x - b.entrance.x) + Math.abs(a.entrance.y - b.entrance.y);
}

describe("projectTownSemanticView：几何 → 语义投影", () => {
  const snapshot = generateTown({ seed: "demo-1" });
  const view = projectTownSemanticView(snapshot, TOWN_NAME);

  it("同快照两次投影深度相等（纯函数无随机）", () => {
    expect(projectTownSemanticView(snapshot, TOWN_NAME)).toEqual(view);
    expect(projectTownSemanticView(generateTown({ seed: "demo-1" }), TOWN_NAME)).toEqual(view);
  });

  it("只投影具名建筑，按 buildingId 数字序稳定输出", () => {
    const expectedIds = namedBuildings(snapshot)
      .map((building) => building.buildingId)
      .sort((a, b) => Number(a.replace("building_", "")) - Number(b.replace("building_", "")));
    expect(view.buildings.map((building) => building.buildingId)).toEqual(expectedIds);
    const genericIds = new Set(
      snapshot.buildings
        .filter((building) => building.definitionState === "generic")
        .map((building) => building.buildingId)
    );
    expect(view.buildings.some((building) => genericIds.has(building.buildingId))).toBe(false);
  });

  it("方位取值封闭；gateArea 有效且首句为正门句", () => {
    expect(AREA_VALUES).toContain(view.gateArea);
    for (const building of view.buildings) {
      expect(AREA_VALUES).toContain(building.area);
    }
    expect(view.sentences[0]).toMatch(new RegExp(`^${TOWN_NAME}的正门位于.+。$`));
  });

  it("nearest 是入口曼哈顿距离最小的其它具名建筑，超阈值为 null", () => {
    for (const building of view.buildings) {
      const distances = view.buildings
        .filter((other) => other.buildingId !== building.buildingId)
        .map((other) => entranceDistance(snapshot, building.buildingId, other.buildingId));
      const minDistance = Math.min(...distances);
      if (minDistance <= NEARBY_DISTANCE) {
        expect(building.nearest).not.toBeNull();
        expect(entranceDistance(snapshot, building.buildingId, building.nearest!.buildingId)).toBe(
          minDistance
        );
      } else {
        expect(building.nearest).toBeNull();
      }
    }
  });

  it("每栋具名建筑各有一条位置句；nearest 非空时有旁边句", () => {
    let expectedCount = 1; // 正门句
    for (const building of view.buildings) {
      const locationSentence =
        building.area === "center"
          ? `${building.displayName}位于${TOWN_NAME}的中心地带。`
          : expect.stringContaining(`，有${building.displayName}。`);
      expect(view.sentences).toContainEqual(locationSentence);
      expectedCount += 1;
      if (building.nearest !== null) {
        expect(view.sentences).toContain(
          `${building.displayName}的旁边是${building.nearest.displayName}。`
        );
        expectedCount += 1;
      }
    }
    expect(view.sentences).toHaveLength(expectedCount);
  });

  it("planKey 贯通：剧情建筑回指 plan key，非剧情具名建筑为 null", () => {
    const plan = {
      ...createFallbackTownPlan("demo-1"),
      requiredBuildings: createFallbackTownPlan("demo-1").requiredBuildings.map((required, index) => ({
        ...required,
        key: `story_npc_npc_${index + 1}`,
        displayName: `镇民${index + 1}的宅院`
      }))
    };
    const planned = projectTownSemanticView(generateTown({ seed: "demo-1", plan }), TOWN_NAME);
    const story = planned.buildings.filter((building) => building.storyRequired);
    expect(story.length).toBe(plan.requiredBuildings.length);
    expect(story.map((building) => building.planKey).sort()).toEqual(
      plan.requiredBuildings.map((required) => required.key).sort()
    );
    expect(story.map((building) => building.displayName).sort()).toEqual(
      plan.requiredBuildings.map((required) => required.displayName).sort()
    );
    for (const building of planned.buildings.filter((entry) => !entry.storyRequired)) {
      expect(building.planKey).toBeNull();
    }
  });
});
