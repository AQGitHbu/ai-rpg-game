import type { LocationId, NpcId } from "./worldEntity";

// ---------------------------------------------------------------------------
// Town 层运行时状态（Task 7）：稳定建筑 slot 与 NPC↔建筑绑定。
// 权威几何（TownSnapshot）不落地运行时状态，而是由 seed 经纯生成器确定性重建。
// ---------------------------------------------------------------------------

/** 剧情建筑 slot 的展示类型（读模型标签与交互入口的分类）。 */
export type TownBuildingSlotType =
  | "tavern"
  | "blacksmith"
  | "house"
  | "guild"
  | "clinic"
  | "market";

export type TownBuildingSlot = {
  readonly slotId: string;
  readonly buildingId: string;
  readonly buildingType: TownBuildingSlotType;
  /** 由当前开局候选提供的剧情建筑名；空值时使用类型默认名。 */
  readonly displayName?: string;
  readonly boundNpcId: NpcId | null;
};

export type TownRuntimeState = {
  readonly locationId: LocationId;
  readonly seed: string;
  readonly generatorVersion: string;
  readonly slots: readonly TownBuildingSlot[];
};

// ---------------------------------------------------------------------------
// 纯生成器所需的瓦片 / 快照类型（自旧 townSnapshot.ts 迁入）。
// 生成器只消费这些类型与 worldEntity；不带旧 GameState 依赖。
// ---------------------------------------------------------------------------

export type TownPlanSource = "offline" | "generated" | "fallback";

/** 网格瓦片类型：底图（outside/grass/forest/water）+ 道路 + 地块/建筑层。 */
export type TileType =
  | "outside"
  | "grass"
  | "forest"
  | "water"
  | "road_main"
  | "road_minor"
  | "alley"
  | "square"
  | "plot"
  | "building"
  | "building_entrance"
  | "reserved";

export type Cell = { readonly x: number; readonly y: number };

export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type Direction = "north" | "south" | "east" | "west";

/** 语义规划里的模糊区位提示，由生成器解释为具体网格区域。 */
export type AreaHint = "center" | "north" | "south" | "east" | "west" | "edge";

export type TownDistrictType = "market" | "residential" | "craft" | "reserved";

/** 生成器内部建筑类型（自旧 townSnapshot.ts 迁入；slot 展示类型见 TownBuildingSlotType）。 */
export type TownBuildingType =
  | "tavern"
  | "blacksmith"
  | "house"
  | "shop"
  | "workshop"
  | "warehouse"
  | "well"
  | "gatehouse";

/** 语义规划（AI 或 fallback 产出）：只描述意图，不含具体坐标。 */
export type TownSemanticPlan = {
  readonly planVersion: 1;
  readonly theme: string;
  /** 24–40，默认 32（见 TOWN_GRID_* 常量）。 */
  readonly gridSize: { readonly width: number; readonly height: number };
  readonly terrain: {
    readonly river: "north" | "south" | "none";
    readonly externalRoad: "east_west" | "north_south";
  };
  readonly districts: readonly {
    readonly type: TownDistrictType;
    readonly preferredArea: AreaHint;
    readonly weight: number;
  }[];
  readonly requiredBuildings: readonly {
    readonly key: string;
    readonly buildingType: TownBuildingType;
    readonly preferredDistrict: TownDistrictType;
    readonly importance: "story_required";
    readonly displayName?: string;
  }[];
  readonly landmarks: readonly { readonly type: "well"; readonly preferredArea: AreaHint }[];
};

export type RoadNode = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly kind: "gate" | "intersection" | "square" | "poi";
};

export type RoadEdge = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly roadType: "main" | "minor" | "alley";
  readonly cells: readonly Cell[];
  readonly cost: number;
};

/** 道路围出的街区：Flood Fill 产物，附带临路边界格。 */
export type TownBlock = {
  readonly id: string;
  readonly cells: readonly Cell[];
  readonly roadBoundaryCells: readonly Cell[];
  readonly districtType: TownDistrictType;
};

export type PlotStatus = "occupied" | "generic" | "reserved";

/** 街区切分出的临街地块。 */
export type TownPlot = {
  readonly id: string;
  readonly blockId: string;
  readonly cells: readonly Cell[];
  readonly frontageCells: readonly Cell[];
  readonly district: TownDistrictType;
  readonly status: PlotStatus;
};

export type BuildingDefinitionState = "generic" | "named";

export type TownBuilding = {
  readonly buildingId: string;
  readonly plotId: string;
  readonly definitionState: BuildingDefinitionState;
  readonly buildingType: TownBuildingType;
  readonly displayName: string;
  readonly district: TownDistrictType;
  readonly footprint: Rect;
  readonly entrance: { readonly x: number; readonly y: number; readonly direction: Direction };
  readonly storyRequired: boolean;
  /** 剧情建筑回指 plan.requiredBuildings.key（如 story_npc_xxx），供建筑↔NPC 反查。 */
  readonly planKey?: string;
};

/** 行优先扁平网格（索引见 tileIndex）。 */
export type TownGrid = {
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly TileType[];
};

/** 权威小镇快照：生成器唯一产物；验证失败不产出快照。 */
export type TownSnapshot = {
  readonly snapshotVersion: 1;
  readonly seed: string;
  readonly generatorVersion: string;
  readonly plan: TownSemanticPlan;
  readonly grid: TownGrid;
  readonly roadGraph: { readonly nodes: readonly RoadNode[]; readonly edges: readonly RoadEdge[] };
  readonly blocks: readonly TownBlock[];
  readonly plots: readonly TownPlot[];
  readonly buildings: readonly TownBuilding[];
  readonly mainGateNodeId: string;
  readonly validation: {
    readonly valid: true;
    readonly repairCount: number;
    readonly retryCount: number;
  };
};

/** 生成器版本：算法/参数演进时提升，纳入快照便于回归钉值。 */
export const TOWN_GENERATOR_VERSION = "town-gen-0.1.0" as const;

/** 网格边长合法域（方形网格）。 */
export const TOWN_GRID_MIN = 24;
export const TOWN_GRID_MAX = 40;
export const TOWN_GRID_DEFAULT = 32;

/** 行优先扁平索引：y * width + x。 */
export function tileIndex(grid: { width: number }, x: number, y: number): number {
  return y * grid.width + x;
}
