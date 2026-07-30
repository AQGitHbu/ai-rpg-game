import {
  TOWN_GRID_MAX,
  TOWN_GRID_MIN,
  type AreaHint,
  type TownBuildingType,
  type TownDistrictType,
  type TownSemanticPlan
} from "@/game/domain";
import { generateTown, type TownGenerationInput } from "./generateTown";

// AI 小镇规划候选的校验 + 机械修复（town-plan-v1 契约的信任边界）。
// 修复只做无内容创造的机械动作：gridSize 钳制、剔除未知枚举条目、必备
// 建筑截断到 8、缺失结构回落 baseline（离线派生规划）。剧情 NPC 建筑
// 覆盖检查失败即拒绝（机械修复禁止伪造剧情建筑）；修复后的规划必须
// 通过一次 generateTown 编译验证，失败拒绝该次尝试。纯函数、无随机。

export type TownPlanRejectReason = "schema_violation" | "coverage_missing" | "compile_failed";

export type TownPlanValidationContext = {
  /** 编译验证所用 seed（与最终写入 TownRuntimeState 的 seed 一致）。 */
  readonly seed: string;
  /** 离线派生规划：覆盖检查基准 + 缺失结构的机械回落来源。 */
  readonly baseline: TownSemanticPlan;
  /** 编译验证入口：默认 generateTown；测试可注入失败实现验证拒绝路径。 */
  readonly compile?: (input: TownGenerationInput) => unknown;
};

export type TownPlanValidationResult =
  | { readonly ok: true; readonly plan: TownSemanticPlan }
  | { readonly ok: false; readonly reason: TownPlanRejectReason };

const DISTRICT_TYPES: ReadonlySet<string> = new Set<TownDistrictType>([
  "market",
  "residential",
  "craft",
  "reserved"
]);

const AREA_HINTS: ReadonlySet<string> = new Set<AreaHint>([
  "center",
  "north",
  "south",
  "east",
  "west",
  "edge"
]);

const BUILDING_TYPES: ReadonlySet<string> = new Set<TownBuildingType>([
  "tavern",
  "blacksmith",
  "house",
  "shop",
  "workshop",
  "warehouse",
  "well",
  "gatehouse"
]);

const RIVER_VALUES: ReadonlySet<string> = new Set(["north", "south", "none"]);
const EXTERNAL_ROAD_VALUES: ReadonlySet<string> = new Set(["east_west", "north_south"]);

/** 必备建筑上限（与 planFromBlueprint 的 MVP 预算一致）。 */
const MAX_REQUIRED_BUILDINGS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampGridSide(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(TOWN_GRID_MAX, Math.max(TOWN_GRID_MIN, Math.round(value)));
}

/** 剔除未知枚举后的合法区块条目；weight 非正数视为非法条目一并剔除。 */
function repairDistricts(value: unknown): TownSemanticPlan["districts"] | null {
  if (!Array.isArray(value)) return null;
  const districts = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { type, preferredArea, weight } = entry;
    if (typeof type !== "string" || !DISTRICT_TYPES.has(type)) return [];
    if (typeof preferredArea !== "string" || !AREA_HINTS.has(preferredArea)) return [];
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) return [];
    return [
      {
        type: type as TownDistrictType,
        preferredArea: preferredArea as AreaHint,
        weight: Math.round(weight)
      }
    ];
  });
  return districts.length > 0 ? districts : null;
}

function repairRequiredBuildings(value: unknown): TownSemanticPlan["requiredBuildings"] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const repaired = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { key, buildingType, preferredDistrict, displayName } = entry;
    if (typeof key !== "string" || key.trim() === "" || seen.has(key)) return [];
    if (typeof buildingType !== "string" || !BUILDING_TYPES.has(buildingType)) return [];
    if (typeof preferredDistrict !== "string" || !DISTRICT_TYPES.has(preferredDistrict)) return [];
    seen.add(key);
    return [
      {
        key,
        buildingType: buildingType as TownBuildingType,
        preferredDistrict: preferredDistrict as TownDistrictType,
        importance: "story_required" as const,
        ...(typeof displayName === "string" && displayName.trim() !== ""
          ? { displayName: displayName.trim() }
          : {})
      }
    ];
  });
  return repaired.slice(0, MAX_REQUIRED_BUILDINGS);
}

function repairLandmarks(value: unknown): TownSemanticPlan["landmarks"] | null {
  if (!Array.isArray(value)) return null;
  const landmarks = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (entry.type !== "well") return [];
    const { preferredArea } = entry;
    if (typeof preferredArea !== "string" || !AREA_HINTS.has(preferredArea)) return [];
    return [{ type: "well" as const, preferredArea: preferredArea as AreaHint }];
  });
  return landmarks.length > 0 ? landmarks : null;
}

/**
 * 校验 + 机械修复 AI 候选。任何一次拒绝都由上游计一次失败尝试
 * （3 次耗尽后 generatePendingTownPlan 降级 baseline）。
 */
export function validateTownPlanCandidate(
  candidate: unknown,
  context: TownPlanValidationContext
): TownPlanValidationResult {
  if (!isRecord(candidate)) return { ok: false, reason: "schema_violation" };
  const { baseline } = context;

  const theme =
    typeof candidate.theme === "string" && candidate.theme.trim() !== ""
      ? candidate.theme.trim()
      : baseline.theme;

  const gridSource = isRecord(candidate.gridSize) ? candidate.gridSize : {};
  const gridSize = {
    width: clampGridSide(gridSource.width, baseline.gridSize.width),
    height: clampGridSide(gridSource.height, baseline.gridSize.height)
  };

  const terrainSource = isRecord(candidate.terrain) ? candidate.terrain : {};
  const terrain = {
    river:
      typeof terrainSource.river === "string" && RIVER_VALUES.has(terrainSource.river)
        ? (terrainSource.river as TownSemanticPlan["terrain"]["river"])
        : baseline.terrain.river,
    externalRoad:
      typeof terrainSource.externalRoad === "string" &&
      EXTERNAL_ROAD_VALUES.has(terrainSource.externalRoad)
        ? (terrainSource.externalRoad as TownSemanticPlan["terrain"]["externalRoad"])
        : baseline.terrain.externalRoad
  };

  const districts = repairDistricts(candidate.districts) ?? baseline.districts;
  const landmarks = repairLandmarks(candidate.landmarks) ?? baseline.landmarks;

  const requiredBuildings = repairRequiredBuildings(candidate.requiredBuildings);
  if (requiredBuildings === null) return { ok: false, reason: "schema_violation" };

  // 剧情 NPC 建筑覆盖检查：baseline 的每个 key 必须仍然在场（buildingType
  // 允许 AI 重选，但建筑↔NPC 反查通道不可断）。
  const candidateKeys = new Set(requiredBuildings.map((entry) => entry.key));
  for (const required of baseline.requiredBuildings) {
    if (!candidateKeys.has(required.key)) return { ok: false, reason: "coverage_missing" };
  }

  const plan: TownSemanticPlan = {
    planVersion: 1,
    theme,
    gridSize,
    terrain,
    districts,
    requiredBuildings,
    landmarks
  };

  // 编译验证：修复后的规划必须能确定性产出快照，否则拒绝该次尝试。
  const compile = context.compile ?? generateTown;
  try {
    compile({ seed: context.seed, plan });
  } catch {
    return { ok: false, reason: "compile_failed" };
  }
  return { ok: true, plan };
}
