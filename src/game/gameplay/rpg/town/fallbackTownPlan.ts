import {
  TOWN_GRID_DEFAULT,
  type AreaHint,
  type TownSemanticPlan
} from "@/game/domain";
import { createTownRng } from "./townRandom";

// 确定性 fallback 语义规划：不调 AI，全部随机选择只来自 seed。
// 结构恒定（四区域 + 3 剧情建筑 + well 地标 + 32×32 网格），
// seed 只影响 theme / 地形朝向 / 区域方位等风味字段。

/** 主题固定列表：rng 选取，仅作风味文案，不影响算法参数。 */
const THEMES: readonly string[] = [
  "边陲驿镇",
  "河畔集镇",
  "林间猎镇",
  "山口商镇",
  "旷野哨镇"
] as const;

const RIVER_OPTIONS: readonly TownSemanticPlan["terrain"]["river"][] = ["none", "north", "south"];
const EXTERNAL_ROAD_OPTIONS: readonly TownSemanticPlan["terrain"]["externalRoad"][] = [
  "east_west",
  "north_south"
];

/** residential/craft 备选方位：从中 rng 取两个不同方向，market 恒居中。 */
const SIDE_AREAS: readonly AreaHint[] = ["north", "south", "east", "west"];

export function createFallbackTownPlan(seed: string): TownSemanticPlan {
  const rng = createTownRng(seed);
  const theme = rng.pick(THEMES);
  const river = rng.pick(RIVER_OPTIONS);
  const externalRoad = rng.pick(EXTERNAL_ROAD_OPTIONS);
  const [residentialArea, craftArea] = rng.shuffle(SIDE_AREAS);
  return {
    planVersion: 1,
    theme,
    gridSize: { width: TOWN_GRID_DEFAULT, height: TOWN_GRID_DEFAULT },
    terrain: { river, externalRoad },
    // 权重和恒为 100；reserved 恒贴边（后续任务据此分配街区）。
    districts: [
      { type: "market", preferredArea: "center", weight: 35 },
      { type: "residential", preferredArea: residentialArea, weight: 30 },
      { type: "craft", preferredArea: craftArea, weight: 20 },
      { type: "reserved", preferredArea: "edge", weight: 15 }
    ],
    // 固定 3 剧情建筑：与 MVP 主线交互点（酒馆/铁匠铺/宅邸）对应。
    requiredBuildings: [
      { key: "story_tavern", buildingType: "tavern", preferredDistrict: "market", importance: "story_required" },
      { key: "story_blacksmith", buildingType: "blacksmith", preferredDistrict: "craft", importance: "story_required" },
      { key: "story_house", buildingType: "house", preferredDistrict: "residential", importance: "story_required" }
    ],
    landmarks: [{ type: "well", preferredArea: "center" }]
  };
}
