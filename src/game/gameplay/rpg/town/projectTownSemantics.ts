import type { TownBuilding, TownBuildingType, TownSnapshot } from "@/game/domain";

// 几何 → 语义反向投影：把权威快照坐标翻译成叙事 AI 与玩家可读的空间语义
// （九宫方位、邻近关系、确定性模板句子）。纯函数、无随机：同快照深度相等。
// AI 永不接触坐标——它只消费本模块产出的封闭词汇语义。

/** 九宫方位（相对小镇网格三等分）。 */
export type TownCompassArea =
  | "center"
  | "north"
  | "north_east"
  | "east"
  | "south_east"
  | "south"
  | "south_west"
  | "west"
  | "north_west";

const AREA_LABELS: Readonly<Record<TownCompassArea, string>> = {
  center: "中心",
  north: "北侧",
  north_east: "东北角",
  east: "东侧",
  south_east: "东南角",
  south: "南侧",
  south_west: "西南角",
  west: "西侧",
  north_west: "西北角"
};

/** 建筑语义条目：叙事上下文与 UI 档案共用的坐标无关视图。 */
export type TownSemanticBuilding = {
  readonly buildingId: string;
  /** 剧情建筑回指 plan.requiredBuildings.key；非剧情建筑为 null。 */
  readonly planKey: string | null;
  readonly displayName: string;
  readonly buildingType: TownBuildingType;
  readonly area: TownCompassArea;
  readonly storyRequired: boolean;
  /** 最近的具名建筑（曼哈顿距离，平局按 buildingId 字典序）；孤例为 null。 */
  readonly nearest: { readonly displayName: string; readonly buildingId: string } | null;
};

export type TownSemanticView = {
  readonly townName: string;
  /** 主门所在方位。 */
  readonly gateArea: TownCompassArea;
  /** 具名建筑（剧情 + named）语义条目，按 buildingId 数字序稳定输出。 */
  readonly buildings: readonly TownSemanticBuilding[];
  /** 确定性模板句子（如「铁匠铺位于大石镇北侧」），供 prompt 与旁白直接引用。 */
  readonly sentences: readonly string[];
};

/** 邻近句触发阈值（格）：入口曼哈顿距离 ≤ 阈值才称「旁边」。 */
const NEARBY_DISTANCE = 10;

function centroidOf(building: TownBuilding): { readonly x: number; readonly y: number } {
  return {
    x: building.footprint.x + (building.footprint.width - 1) / 2,
    y: building.footprint.y + (building.footprint.height - 1) / 2
  };
}

/** 三等分九宫：先按行分 north/center/south，再按列分 west/center/east。 */
function areaOf(x: number, y: number, width: number, height: number): TownCompassArea {
  const col = x < width / 3 ? "west" : x >= (2 * width) / 3 ? "east" : "center";
  const row = y < height / 3 ? "north" : y >= (2 * height) / 3 ? "south" : "center";
  if (row === "center" && col === "center") return "center";
  if (row === "center") return col as TownCompassArea;
  if (col === "center") return row as TownCompassArea;
  return `${row}_${col}` as TownCompassArea;
}

function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** buildingId 数字序（building_2 < building_10）：快照生成序即放置序。 */
function buildingOrder(a: TownBuilding, b: TownBuilding): number {
  const numA = Number(a.buildingId.replace("building_", ""));
  const numB = Number(b.buildingId.replace("building_", ""));
  return numA - numB;
}

/**
 * 快照 → 语义投影。只投影具名建筑（definitionState === "named"）：
 * 泛化建筑对叙事只是背景，不进入位置语义，避免 prompt 噪音。
 */
export function projectTownSemanticView(snapshot: TownSnapshot, townName: string): TownSemanticView {
  const { width, height } = snapshot.grid;
  const named = [...snapshot.buildings]
    .filter((building) => building.definitionState === "named")
    .sort(buildingOrder);

  const gateNode = snapshot.roadGraph.nodes.find((node) => node.id === snapshot.mainGateNodeId);
  const gateArea = gateNode === undefined ? "center" : areaOf(gateNode.x, gateNode.y, width, height);

  const buildings: TownSemanticBuilding[] = named.map((building) => {
    const centroid = centroidOf(building);
    let nearest: TownSemanticBuilding["nearest"] = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const other of named) {
      if (other.buildingId === building.buildingId) continue;
      const distance = manhattan(building.entrance, other.entrance);
      if (
        distance < nearestDistance ||
        (distance === nearestDistance && nearest !== null && other.buildingId < nearest.buildingId)
      ) {
        nearest = { displayName: other.displayName, buildingId: other.buildingId };
        nearestDistance = distance;
      }
    }
    return {
      buildingId: building.buildingId,
      planKey: building.planKey ?? null,
      displayName: building.displayName,
      buildingType: building.buildingType,
      area: areaOf(centroid.x, centroid.y, width, height),
      storyRequired: building.storyRequired,
      nearest: nearest !== null && nearestDistance <= NEARBY_DISTANCE ? nearest : null
    };
  });

  const sentences: string[] = [`${townName}的正门位于${AREA_LABELS[gateArea]}。`];
  for (const building of buildings) {
    sentences.push(
      building.area === "center"
        ? `${building.displayName}位于${townName}的中心地带。`
        : `在${townName}的${AREA_LABELS[building.area]}，有${building.displayName}。`
    );
    if (building.nearest !== null) {
      sentences.push(`${building.displayName}的旁边是${building.nearest.displayName}。`);
    }
  }

  return { townName, gateArea, buildings, sentences };
}
