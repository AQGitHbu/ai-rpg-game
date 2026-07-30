import {
  locationScaleOf,
  type ScenarioBlueprint,
  type TownBuildingType,
  type TownDistrictType,
  type TownSemanticPlan
} from "@/game/domain";
import { createFallbackTownPlan } from "./fallbackTownPlan";

// 离线（非 AI）小镇规划：由已编译蓝图的地点事实确定性派生。
// 结构基底复用 createFallbackTownPlan（terrain/districts/landmarks 只由 seed
// 决定），theme 换成地点名，requiredBuildings 换成该地点 NPC 派生的剧情建筑
// （key = story_npc_<npcId>，供建筑↔NPC 反查）。纯函数：同蓝图同 seed 深度相等。

/** NPC role 关键词 → 建筑类型（按声明序首个命中生效；全不命中回 house）。 */
const ROLE_BUILDING_RULES: readonly {
  readonly keywords: readonly string[];
  readonly buildingType: TownBuildingType;
}[] = [
  { keywords: ["铁匠", "锻", "smith"], buildingType: "blacksmith" },
  { keywords: ["酒", "掌柜", "店家", "tavern"], buildingType: "tavern" },
  { keywords: ["商", "贩", "店", "merchant"], buildingType: "shop" },
  { keywords: ["匠", "工", "artisan"], buildingType: "workshop" }
] as const;

/** 建筑类型 → 展示名后缀（displayName = `<NPC名>的<后缀>`）。 */
const TYPE_DISPLAY_SUFFIX: Readonly<Record<TownBuildingType, string>> = {
  tavern: "酒楼",
  blacksmith: "铁匠铺",
  house: "居所",
  shop: "铺子",
  workshop: "工坊",
  warehouse: "货栈",
  well: "水井",
  gatehouse: "门楼"
};

/** 建筑类型 → 偏好区域（与 fallbackTownPlan 的四区结构对应）。 */
const TYPE_PREFERRED_DISTRICT: Readonly<Record<TownBuildingType, TownDistrictType>> = {
  tavern: "market",
  blacksmith: "craft",
  house: "residential",
  shop: "market",
  workshop: "craft",
  warehouse: "market",
  well: "market",
  gatehouse: "reserved"
};

/** 剧情建筑上限：超出取地点 npcIds 声明序前 8 个（MVP 可见建筑预算）。 */
const MAX_REQUIRED_BUILDINGS = 8;

function buildingTypeForRole(role: string): TownBuildingType {
  for (const rule of ROLE_BUILDING_RULES) {
    if (rule.keywords.some((keyword) => role.includes(keyword))) return rule.buildingType;
  }
  return "house";
}

/**
 * 由蓝图地点派生离线小镇规划。地点必须存在且 scale 为 "town"，否则抛错
 * （调用方经 locationScaleOf 预判，抛错代表编程错误而非数据分支）。
 */
export function createTownPlanFromLocation(
  blueprint: ScenarioBlueprint,
  locationId: string,
  seed: string
): TownSemanticPlan {
  const location = blueprint.locations.find((entry) => String(entry.id) === locationId);
  if (location === undefined) {
    throw new Error("小镇规划派生失败：地点引用在蓝图中不存在");
  }
  if (locationScaleOf(location) !== "town") {
    throw new Error("小镇规划派生失败：地点不是 town 层级");
  }
  const base = createFallbackTownPlan(seed);
  const npcById = new Map(blueprint.npcs.map((npc) => [String(npc.id), npc]));
  const requiredBuildings = location.npcIds.slice(0, MAX_REQUIRED_BUILDINGS).map((npcId) => {
    const npc = npcById.get(String(npcId));
    if (npc === undefined) {
      throw new Error("小镇规划派生失败：地点 NPC 引用在蓝图中不存在");
    }
    const buildingType = buildingTypeForRole(npc.role);
    return {
      key: `story_npc_${String(npcId)}`,
      buildingType,
      preferredDistrict: TYPE_PREFERRED_DISTRICT[buildingType],
      importance: "story_required" as const,
      displayName: `${npc.name}的${TYPE_DISPLAY_SUFFIX[buildingType]}`
    };
  });
  return {
    ...base,
    theme: location.name,
    requiredBuildings
  };
}
