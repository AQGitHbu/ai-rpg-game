// 小镇程序化生成 demo 的领域类型：纯类型 + 冻结常量，无业务逻辑。
// 独立于 ScenarioBlueprint / GameState，不接入游戏主循环（见 Spec §3）。

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

/** demo 只用生成期两态：generic（泛化占位）/ named（剧情或已命名建筑）。 */
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
