import {
  tileIndex,
  type Cell,
  type Direction,
  type PlotStatus,
  type Rect,
  type TileType,
  type TownBuilding,
  type TownBuildingType,
  type TownDistrictType,
  type TownPlot,
  type TownSemanticPlan
} from "@/game/domain";
import type { TownRng } from "./townRandom";
import type { RoadPipelineResult } from "./roads";
import type { BlockPlotResult } from "./blocks";

// 建筑放置阶段：剧情建筑按 Spec §5 评分选地块 → 每 gate 一个 gatehouse →
// 泛化建筑补到占用率 0.65 → 剩余地块按预留率 0.2 标 reserved。纯函数：
// 随机只来自传入 rng（泛化洗牌/选型）；评分与最近地块平局一律按 plot.id
// 字典序裁决，同 seed 同输入深度相等。

/** 地块占用率（Spec §5）：有建筑的地块数 ≤ round(总数 × 0.65)。 */
const OCCUPANCY_RATIO = 0.65;

/** 预留率（Spec §5）：空余地块中 round(总数 × 0.2) 个标 reserved。 */
const RESERVE_RATIO = 0.2;

/** footprint 最小边长（Spec §5：最小 2×2，放不下则整地块降 reserved）。 */
const FOOTPRINT_MIN = 2;

/** 评分权重（Spec §5 评分公式）。 */
const WEIGHT_DISTRICT_MATCH = 30;
const WEIGHT_AREA_FIT = 20;
const WEIGHT_ROAD_FRONTAGE = 15;
const WEIGHT_LANDMARK_PROXIMITY = 15;
const WEIGHT_STORY_PREFERENCE = 25;

/** roadFrontage 归一化分母：临街 ≥ 4 格视为满分。 */
const FRONTAGE_NORM = 4;

/** 各类型期望占地（格）：areaFit 用 min/max 比值贴合；兼作 footprint 边长上限依据。 */
const DESIRED_AREA: Readonly<Record<TownBuildingType, number>> = {
  tavern: 12,
  blacksmith: 10,
  house: 8,
  shop: 8,
  workshop: 10,
  warehouse: 12,
  well: 4,
  gatehouse: 4
};

/** footprint 边长上限 = ceil(√期望面积)：大地块上不再产出 2×9 / 11×5
 * 的畸形建筑，余格留作院子（plot）。 */
function maxSideOf(buildingType: TownBuildingType): number {
  return Math.max(FOOTPRINT_MIN, Math.ceil(Math.sqrt(DESIRED_AREA[buildingType])));
}

/** footprint 按类型收缩到边长上限：临街边保持贴街，切向保低坐标端（确定性）。 */
function clampFootprint(footprint: Rect, frontSide: Direction, maxSide: number): Rect {
  const width = Math.min(footprint.width, maxSide);
  const height = Math.min(footprint.height, maxSide);
  const x = frontSide === "east" ? footprint.x + footprint.width - width : footprint.x;
  const y = frontSide === "south" ? footprint.y + footprint.height - height : footprint.y;
  return { x, y, width, height };
}

/** 剧情建筑固定中文名表；表外类型兜底用 requiredBuilding.key。 */
const REQUIRED_NAMES: Readonly<Partial<Record<TownBuildingType, string>>> = {
  tavern: "福来酒楼",
  blacksmith: "铁匠铺",
  house: "张宅"
};

/** 泛化建筑类型池：按地块所在区域 rng 选取。 */
const GENERIC_TYPES: Readonly<Record<TownDistrictType, readonly TownBuildingType[]>> = {
  market: ["shop", "warehouse"],
  residential: ["house"],
  craft: ["workshop", "warehouse"],
  reserved: ["warehouse"]
};

/** 泛化建筑 displayName 模板：`模板·序号`（序号按类型独立递增）。 */
const GENERIC_NAMES: Readonly<Partial<Record<TownBuildingType, string>>> = {
  shop: "一间临街店铺",
  house: "一户普通民居",
  workshop: "一处街坊工坊",
  warehouse: "一座货栈"
};

/** 入口门前格允许的道路瓦片（与 blocks.ts 判定一致）。 */
const ROAD_TILES: ReadonlySet<TileType> = new Set<TileType>(["road_main", "road_minor", "alley", "square"]);

/** 4 朝向固定序（北南西东）：临街面判定与入口扫描的平局裁决依赖此序。 */
const SIDES: readonly Direction[] = ["north", "south", "west", "east"];

const SIDE_OFFSETS: Readonly<Record<Direction, { readonly dx: number; readonly dy: number }>> = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  west: { dx: -1, dy: 0 },
  east: { dx: 1, dy: 0 }
};

export type BuildingPlacementResult = {
  /** blockPlots.tiles 基础上：building/building_entrance/reserved 写入。 */
  readonly tiles: readonly TileType[];
  /** 与入参 plots 同序，status 更新为 occupied/generic/reserved。 */
  readonly plots: readonly TownPlot[];
  readonly buildings: readonly TownBuilding[];
};

// ---------------------------------------------------------------------------
// 地块几何：footprint 与临街主朝向
// ---------------------------------------------------------------------------

/** 地块几何预计算：footprint 为 null 表示放不下（降 reserved）。 */
type PlotGeometry = {
  readonly plot: TownPlot;
  readonly footprint: Rect | null;
  /** 临街格最多的 bounding box 边（平局按北南西东序）。 */
  readonly frontSide: Direction;
  readonly centroid: Cell;
};

function boundingBox(cells: readonly Cell[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = cells[0].x;
  let maxX = cells[0].x;
  let minY = cells[0].y;
  let maxY = cells[0].y;
  for (const cell of cells) {
    if (cell.x < minX) minX = cell.x;
    if (cell.x > maxX) maxX = cell.x;
    if (cell.y < minY) minY = cell.y;
    if (cell.y > maxY) maxY = cell.y;
  }
  return { minX, maxX, minY, maxY };
}

/** 临街主朝向：数各 bounding box 边上的临街格，取最多者（固定序平局）。 */
function pickFrontSide(plot: TownPlot, box: ReturnType<typeof boundingBox>): Direction {
  const counts: Record<Direction, number> = { north: 0, south: 0, west: 0, east: 0 };
  for (const cell of plot.frontageCells) {
    if (cell.y === box.minY) counts.north += 1;
    if (cell.y === box.maxY) counts.south += 1;
    if (cell.x === box.minX) counts.west += 1;
    if (cell.x === box.maxX) counts.east += 1;
  }
  let best: Direction = SIDES[0];
  for (const side of SIDES) {
    if (counts[side] > counts[best]) best = side;
  }
  return best;
}

/**
 * 单轴内缩（交叉轴用）：优先两侧各缩 1；长度 3 时只缩 1 侧（keepLo 决定保留哪侧）；
 * 长度 2 不缩；不足 2 返回 null（放不下）。
 */
function insetAxis(lo: number, hi: number, keepLo: boolean): { lo: number; hi: number } | null {
  const size = hi - lo + 1;
  if (size < FOOTPRINT_MIN) return null;
  if (size === FOOTPRINT_MIN) return { lo, hi };
  if (size === FOOTPRINT_MIN + 1) return keepLo ? { lo, hi: hi - 1 } : { lo: lo + 1, hi };
  return { lo: lo + 1, hi: hi - 1 };
}

/**
 * 临街轴内缩：临街侧贴街不缩、背街侧缩 1（长度 ≥ 3 时）。若临街侧也缩，
 * 建筑与道路间永隔一圈 plot 环带，入口只能靠修复管线开 1 格巷道打通，
 * 视觉上建筑全部离路。
 */
function insetFrontAxis(lo: number, hi: number, frontAtLo: boolean): { lo: number; hi: number } | null {
  const size = hi - lo + 1;
  if (size < FOOTPRINT_MIN) return null;
  if (size === FOOTPRINT_MIN) return { lo, hi };
  return frontAtLo ? { lo, hi: hi - 1 } : { lo: lo + 1, hi };
}

/**
 * 地块内最大矩形（兼作内缩失败的兜底）：直方图法逐行扫描，面积优先，
 * 平局取行小→列小（确定性）；不足 2×2 返回 null。尾并产生的 L 形地块
 * bounding box 内缩常失败，若直接降 reserved 会把预留率抽高到 0.5+，
 * 远离 Spec §5 的 0.2（Task 6 批量回归断言 reserved 占比 ≤ 0.35）。
 */
function largestRectIn(cells: readonly Cell[]): Rect | null {
  const box = boundingBox(cells);
  const width = box.maxX - box.minX + 1;
  const height = box.maxY - box.minY + 1;
  const inside: boolean[] = new Array(width * height).fill(false);
  for (const cell of cells) inside[(cell.y - box.minY) * width + (cell.x - box.minX)] = true;

  let best: Rect | null = null;
  const heights: number[] = new Array(width).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) heights[x] = inside[y * width + x] ? heights[x] + 1 : 0;
    // 每列向左右扩张至高度不足：O(w²) 枚举，地块尺寸小，确定性优先。
    for (let left = 0; left < width; left += 1) {
      let minHeight = heights[left];
      for (let right = left; right < width; right += 1) {
        if (heights[right] < minHeight) minHeight = heights[right];
        if (minHeight < FOOTPRINT_MIN) break;
        const rectWidth = right - left + 1;
        if (rectWidth < FOOTPRINT_MIN) continue;
        const area = rectWidth * minHeight;
        if (best === null || area > best.width * best.height) {
          best = {
            x: box.minX + left,
            y: box.minY + y - minHeight + 1,
            width: rectWidth,
            height: minHeight
          };
        }
      }
    }
  }
  return best;
}

/**
 * footprint = 地块 bounding box 内缩（最小 2×2）：临街轴贴街（临街侧
 * 不缩、背街侧缩 1），交叉轴两侧各缩 1。内缩后必须全部落在地块格内
 * （尾并产生的 L 形地块可能不满足）→ 退而取地块内最大矩形；
 * 仍不足 2×2 才 null 降 reserved。
 */
function computeGeometry(plot: TownPlot): PlotGeometry {
  const box = boundingBox(plot.cells);
  const frontSide = pickFrontSide(plot, box);
  let sumX = 0;
  let sumY = 0;
  for (const cell of plot.cells) {
    sumX += cell.x;
    sumY += cell.y;
  }
  const centroid = { x: Math.round(sumX / plot.cells.length), y: Math.round(sumY / plot.cells.length) };

  // 临街轴贴街；交叉轴长度 3 时固定保留低坐标侧（确定性）。
  const frontHorizontal = frontSide === "north" || frontSide === "south";
  const xRange = frontHorizontal
    ? insetAxis(box.minX, box.maxX, true)
    : insetFrontAxis(box.minX, box.maxX, frontSide === "west");
  const yRange = frontHorizontal
    ? insetFrontAxis(box.minY, box.maxY, frontSide === "north")
    : insetAxis(box.minY, box.maxY, true);
  if (xRange === null || yRange === null) {
    return { plot, footprint: largestRectIn(plot.cells), frontSide, centroid };
  }

  const cellSet = new Set(plot.cells.map((cell) => `${cell.x},${cell.y}`));
  for (let y = yRange.lo; y <= yRange.hi; y += 1) {
    for (let x = xRange.lo; x <= xRange.hi; x += 1) {
      if (!cellSet.has(`${x},${y}`)) return { plot, footprint: largestRectIn(plot.cells), frontSide, centroid };
    }
  }
  return {
    plot,
    footprint: {
      x: xRange.lo,
      y: yRange.lo,
      width: xRange.hi - xRange.lo + 1,
      height: yRange.hi - yRange.lo + 1
    },
    frontSide,
    centroid
  };
}

// ---------------------------------------------------------------------------
// 入口选择
// ---------------------------------------------------------------------------

/** footprint 某边的边界格（坐标升序）。 */
function boundaryCells(footprint: Rect, side: Direction): Cell[] {
  const cells: Cell[] = [];
  const right = footprint.x + footprint.width - 1;
  const bottom = footprint.y + footprint.height - 1;
  if (side === "north" || side === "south") {
    const y = side === "north" ? footprint.y : bottom;
    for (let x = footprint.x; x <= right; x += 1) cells.push({ x, y });
  } else {
    const x = side === "west" ? footprint.x : right;
    for (let y = footprint.y; y <= bottom; y += 1) cells.push({ x, y });
  }
  return cells;
}

/**
 * 入口：优先「门前格（外侧邻格）为道路/巷道」的边界格，扫描序 =
 * 临街主朝向 → 其余朝向固定序、格坐标升序。四方向都不邻路时退为
 * 临街主朝向边中点（门前格非路，留给 Task 6 修复管线开巷道）。
 */
function selectEntrance(
  footprint: Rect,
  frontSide: Direction,
  tiles: readonly TileType[],
  width: number,
  height: number
): TownBuilding["entrance"] {
  const sides = [frontSide, ...SIDES.filter((side) => side !== frontSide)];
  for (const side of sides) {
    for (const cell of boundaryCells(footprint, side)) {
      const x = cell.x + SIDE_OFFSETS[side].dx;
      const y = cell.y + SIDE_OFFSETS[side].dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if (ROAD_TILES.has(tiles[y * width + x])) return { x: cell.x, y: cell.y, direction: side };
    }
  }
  const edge = boundaryCells(footprint, frontSide);
  const middle = edge[Math.floor((edge.length - 1) / 2)];
  return { x: middle.x, y: middle.y, direction: frontSide };
}

// ---------------------------------------------------------------------------
// Spec §5 评分
// ---------------------------------------------------------------------------

function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** 距离贴合度 [0,1]：目标缺失记 0（如手工网格无 roadGraph 节点）。 */
function proximity(centroid: Cell, target: Cell | undefined, gridSpan: number): number {
  if (target === undefined) return 0;
  return 1 - manhattan(centroid, target) / gridSpan;
}

/**
 * 剧情建筑评分（Spec §5）：districtMatch·30 + areaFit·20 + roadFrontage·15 +
 * landmarkProximity·15 + storyPreference·25。areaFit 用 footprint 面积对
 * 类型期望面积的 min/max 比值；storyPreference 解释为「靠近中心广场的
 * 主动线偏好」（剧情建筑要在玩家动线上）。
 */
function scoreRequiredPlot(
  buildingType: TownBuildingType,
  preferredDistrict: TownDistrictType,
  geometry: PlotGeometry,
  wellCell: Cell | undefined,
  squareCell: Cell | undefined,
  gridSpan: number
): number {
  const footprint = geometry.footprint!;
  const area = footprint.width * footprint.height;
  const desired = DESIRED_AREA[buildingType];
  const districtMatch = geometry.plot.district === preferredDistrict ? 1 : 0;
  const areaFit = Math.min(area, desired) / Math.max(area, desired);
  const roadFrontage = Math.min(1, geometry.plot.frontageCells.length / FRONTAGE_NORM);
  const landmarkProximity = proximity(geometry.centroid, wellCell, gridSpan);
  const storyPreference = proximity(geometry.centroid, squareCell, gridSpan);
  return (
    districtMatch * WEIGHT_DISTRICT_MATCH +
    areaFit * WEIGHT_AREA_FIT +
    roadFrontage * WEIGHT_ROAD_FRONTAGE +
    landmarkProximity * WEIGHT_LANDMARK_PROXIMITY +
    storyPreference * WEIGHT_STORY_PREFERENCE
  );
}

// ---------------------------------------------------------------------------
// placeBuildings
// ---------------------------------------------------------------------------

export function placeBuildings(
  plan: TownSemanticPlan,
  blockPlots: BlockPlotResult,
  roadResult: RoadPipelineResult,
  rng: TownRng
): BuildingPlacementResult {
  const { width, height } = plan.gridSize;
  const gridSpan = width + height;
  const geometries = blockPlots.plots.map(computeGeometry);
  const available = new Set(
    geometries.filter((geometry) => geometry.footprint !== null).map((geometry) => geometry.plot.id)
  );

  const nodes = roadResult.roadGraph.nodes;
  const wellNode = nodes.find((node) => node.kind === "poi");
  const squareNode = nodes.find((node) => node.kind === "square");
  const gateNodes = nodes.filter((node) => node.kind === "gate");

  const buildings: TownBuilding[] = [];
  const place = (
    geometry: PlotGeometry,
    buildingType: TownBuildingType,
    definitionState: TownBuilding["definitionState"],
    displayName: string,
    storyRequired: boolean
  ): void => {
    // 按类型裁剪到边长上限（临街边保持贴街）：裁剪后仍是原 footprint
    // 的子矩形，必落在地块格内。
    const footprint = clampFootprint(geometry.footprint!, geometry.frontSide, maxSideOf(buildingType));
    buildings.push({
      buildingId: `building_${buildings.length + 1}`,
      plotId: geometry.plot.id,
      definitionState,
      buildingType,
      displayName,
      district: geometry.plot.district,
      footprint,
      entrance: selectEntrance(footprint, geometry.frontSide, blockPlots.tiles, width, height),
      storyRequired
    });
    available.delete(geometry.plot.id);
  };

  // 1. 剧情建筑：全部可用地块评分取最高，平局按 plot.id 字典序取小。
  for (const required of plan.requiredBuildings) {
    let best: PlotGeometry | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const geometry of geometries) {
      if (!available.has(geometry.plot.id)) continue;
      const score = scoreRequiredPlot(
        required.buildingType,
        required.preferredDistrict,
        geometry,
        wellNode,
        squareNode,
        gridSpan
      );
      if (score > bestScore || (score === bestScore && best !== null && geometry.plot.id < best.plot.id)) {
        best = geometry;
        bestScore = score;
      }
    }
    if (best === null) continue; // 无可用地块：留给 Task 6 验证/重试兜底
    place(best, required.buildingType, "named", REQUIRED_NAMES[required.buildingType] ?? required.key, true);
  }

  // 2. 基础建筑：well 已是锚点不占地块；每 gate 一个 gatehouse，取距门最近
  //    的可用地块（曼哈顿，平局按 plot.id 字典序）。
  gateNodes.forEach((gate, order) => {
    let best: PlotGeometry | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const geometry of geometries) {
      if (!available.has(geometry.plot.id)) continue;
      const distance = manhattan(geometry.centroid, gate);
      if (distance < bestDistance || (distance === bestDistance && best !== null && geometry.plot.id < best.plot.id)) {
        best = geometry;
        bestDistance = distance;
      }
    }
    if (best === null) return;
    place(best, "gatehouse", "named", `城门哨所·${order + 1}`, false);
  });

  // 3. 泛化建筑：rng 洗牌可用地块，补到占用率 0.65；类型按区域池 rng 选，
  //    displayName = 类型模板 + 按类型递增序号。
  const occupancyTarget = Math.round(blockPlots.plots.length * OCCUPANCY_RATIO);
  const genericCount = new Map<TownBuildingType, number>();
  const candidates = rng.shuffle(geometries.filter((geometry) => available.has(geometry.plot.id)));
  for (const geometry of candidates) {
    if (buildings.length >= occupancyTarget) break;
    const buildingType = rng.pick(GENERIC_TYPES[geometry.plot.district]);
    const sequence = (genericCount.get(buildingType) ?? 0) + 1;
    genericCount.set(buildingType, sequence);
    place(geometry, buildingType, "generic", `${GENERIC_NAMES[buildingType]}·${sequence}`, false);
  }

  // 4. 状态回写：有建筑 → occupied；预留配额 round(总数 × 0.2) 优先给
  //    放不下 footprint 的地块，不足再按地块原序补；超出配额的一律
  //    generic（空地）——否则细小地块多的 seed 会把预留率抽到 0.45+，
  //    远离 Spec §5 的 0.2。
  const occupiedIds = new Set(buildings.map((building) => building.plotId));
  const reserveTarget = Math.round(blockPlots.plots.length * RESERVE_RATIO);
  const statusById = new Map<string, PlotStatus>();
  let reservedCount = 0;
  for (const geometry of geometries) {
    if (occupiedIds.has(geometry.plot.id)) statusById.set(geometry.plot.id, "occupied");
  }
  for (const geometry of geometries) {
    if (statusById.has(geometry.plot.id) || geometry.footprint !== null) continue;
    if (reservedCount < reserveTarget) {
      statusById.set(geometry.plot.id, "reserved");
      reservedCount += 1;
    } else statusById.set(geometry.plot.id, "generic");
  }
  // 配额未满时按面积升序补（tie 按 id）：小地块优先预留，大地块避免
  // 整块变成深色死区。
  const byAreaAsc = [...geometries].sort(
    (a, b) => a.plot.cells.length - b.plot.cells.length || (a.plot.id < b.plot.id ? -1 : 1)
  );
  for (const geometry of byAreaAsc) {
    if (statusById.has(geometry.plot.id)) continue;
    if (reservedCount < reserveTarget) {
      statusById.set(geometry.plot.id, "reserved");
      reservedCount += 1;
    } else statusById.set(geometry.plot.id, "generic");
  }

  // 5. 瓦片写入：reserved 地块整块 → reserved；建筑 footprint → building，
  //    入口格覆写 building_entrance。
  const tiles: TileType[] = [...blockPlots.tiles];
  const grid = { width };
  for (const plot of blockPlots.plots) {
    if (statusById.get(plot.id) !== "reserved") continue;
    for (const cell of plot.cells) tiles[tileIndex(grid, cell.x, cell.y)] = "reserved";
  }
  for (const building of buildings) {
    const { footprint, entrance } = building;
    for (let y = footprint.y; y < footprint.y + footprint.height; y += 1) {
      for (let x = footprint.x; x < footprint.x + footprint.width; x += 1) {
        tiles[tileIndex(grid, x, y)] = "building";
      }
    }
    tiles[tileIndex(grid, entrance.x, entrance.y)] = "building_entrance";
  }

  const plots = blockPlots.plots.map((plot) => ({ ...plot, status: statusById.get(plot.id)! }));
  return { tiles, plots, buildings };
}
