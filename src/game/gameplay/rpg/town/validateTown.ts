import {
  tileIndex,
  type Cell,
  type Rect,
  type RoadEdge,
  type RoadNode,
  type TileType,
  type TownBuilding,
  type TownPlot
} from "@/game/domain";

// 全局验证阶段：对生成管线的中间草稿 collect-all 检查 Spec §6 规则，
// 产出结构化 issue 列表供修复管线消费。纯函数：不修改 draft、无随机。

/** 地块最小临街宽度（Spec §5，与 blocks.ts 一致）。 */
const MIN_FRONTAGE = 2;

/** 门前格可走的道路瓦片（与 buildings.ts 判定一致）。 */
const ROAD_TILES: ReadonlySet<TileType> = new Set<TileType>(["road_main", "road_minor", "alley", "square"]);

/** 建筑 footprint 禁止覆盖的底层瓦片：道路/广场/水域/城外。 */
const FORBIDDEN_GROUND_TILES: ReadonlySet<TileType> = new Set<TileType>([
  "road_main",
  "road_minor",
  "alley",
  "square",
  "water",
  "outside"
]);

/** 4 邻接固定序（东西南北）：道路连通 BFS 的展开序。 */
const DIRECTIONS: readonly { readonly dx: number; readonly dy: number }[] = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 }
];

const SIDE_OFFSETS = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  west: { dx: -1, dy: 0 },
  east: { dx: 1, dy: 0 }
} as const;

export type TownValidationIssue =
  | { readonly code: "ANCHOR_UNREACHABLE"; readonly nodeId: string }
  | { readonly code: "ENTRANCE_MISSING"; readonly buildingId: string }
  | { readonly code: "ENTRANCE_UNREACHABLE"; readonly buildingId: string }
  | { readonly code: "BUILDING_OVERLAP"; readonly buildingId: string }
  | { readonly code: "BUILDING_ON_FORBIDDEN_TILE"; readonly buildingId: string }
  | { readonly code: "PLOT_FRONTAGE_TOO_SMALL"; readonly plotId: string };

/**
 * generateTown 内部中间结构：groundTiles 为建筑写入前的地面层
 * （道路/水域/地块），tiles 为含 building/building_entrance 的最终层。
 * 两层分开才能在建筑 stamping 后仍判定「footprint 压路/压水」。
 */
export type TownDraft = {
  readonly width: number;
  readonly height: number;
  readonly groundTiles: readonly TileType[];
  readonly tiles: readonly TileType[];
  readonly roadGraph: { readonly nodes: readonly RoadNode[]; readonly edges: readonly RoadEdge[] };
  readonly plots: readonly TownPlot[];
  readonly buildings: readonly TownBuilding[];
  readonly mainGateNodeId: string;
};

function isOnBoundary(cell: Cell, footprint: Rect): boolean {
  const right = footprint.x + footprint.width - 1;
  const bottom = footprint.y + footprint.height - 1;
  if (cell.x < footprint.x || cell.x > right || cell.y < footprint.y || cell.y > bottom) return false;
  return cell.x === footprint.x || cell.x === right || cell.y === footprint.y || cell.y === bottom;
}

/** 主城门所在格出发、沿 4 邻接道路瓦片 BFS 的可达掩码。 */
export function computeRoadReachable(draft: TownDraft): readonly boolean[] {
  const { width, height, tiles } = draft;
  const reachable: boolean[] = new Array(width * height).fill(false);
  const gate = draft.roadGraph.nodes.find((node) => node.id === draft.mainGateNodeId);
  if (gate === undefined) return reachable;
  const start = tileIndex(draft, gate.x, gate.y);
  if (!ROAD_TILES.has(tiles[start])) return reachable;
  const queue: number[] = [start];
  reachable[start] = true;
  for (let head = 0; head < queue.length; head += 1) {
    const x = queue[head] % width;
    const y = Math.floor(queue[head] / width);
    for (const direction of DIRECTIONS) {
      const nx = x + direction.dx;
      const ny = y + direction.dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = tileIndex(draft, nx, ny);
      if (reachable[next] || !ROAD_TILES.has(tiles[next])) continue;
      reachable[next] = true;
      queue.push(next);
    }
  }
  return reachable;
}

/** 道路图节点连通性：主城门出发沿 edges BFS，返回可达节点 id 集。 */
function computeGraphReachable(draft: TownDraft): ReadonlySet<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of draft.roadGraph.edges) {
    (adjacency.get(edge.from) ?? adjacency.set(edge.from, []).get(edge.from)!).push(edge.to);
    (adjacency.get(edge.to) ?? adjacency.set(edge.to, []).get(edge.to)!).push(edge.from);
  }
  const reached = new Set<string>([draft.mainGateNodeId]);
  const queue: string[] = [draft.mainGateNodeId];
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of adjacency.get(queue[head]) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

/**
 * collect-all 验证（Spec §6）：
 * 1. 道路图节点从主城门 BFS 全可达；
 * 2. 建筑入口在 footprint 边界，门前格为道路且道路层可达主城门；
 * 3. footprint 两两不相交、不压道路/水域/城外（看 groundTiles）；
 * 4. 非 reserved 地块临街 ≥ 2 格。
 */
export function validateTownDraft(draft: TownDraft): readonly TownValidationIssue[] {
  const issues: TownValidationIssue[] = [];
  const { width, height } = draft;

  // 1. 道路图连通性。
  const graphReachable = computeGraphReachable(draft);
  for (const node of draft.roadGraph.nodes) {
    if (!graphReachable.has(node.id)) issues.push({ code: "ANCHOR_UNREACHABLE", nodeId: node.id });
  }

  // 2–3. 建筑几何与入口：占格冲突按建筑序报后者。
  const roadReachable = computeRoadReachable(draft);
  const occupied = new Map<number, string>();
  for (const building of draft.buildings) {
    const { footprint, entrance } = building;
    let overlap = false;
    let forbidden = false;
    for (let y = footprint.y; y < footprint.y + footprint.height; y += 1) {
      for (let x = footprint.x; x < footprint.x + footprint.width; x += 1) {
        if (x < 0 || y < 0 || x >= width || y >= height) {
          forbidden = true;
          continue;
        }
        const index = tileIndex(draft, x, y);
        if (occupied.has(index)) overlap = true;
        else occupied.set(index, building.buildingId);
        if (FORBIDDEN_GROUND_TILES.has(draft.groundTiles[index])) forbidden = true;
      }
    }
    if (overlap) issues.push({ code: "BUILDING_OVERLAP", buildingId: building.buildingId });
    if (forbidden) issues.push({ code: "BUILDING_ON_FORBIDDEN_TILE", buildingId: building.buildingId });

    if (!isOnBoundary(entrance, footprint)) {
      issues.push({ code: "ENTRANCE_MISSING", buildingId: building.buildingId });
      continue; // 入口无效时门前格无从谈起
    }
    const offset = SIDE_OFFSETS[entrance.direction];
    const frontX = entrance.x + offset.dx;
    const frontY = entrance.y + offset.dy;
    const frontOk =
      frontX >= 0 &&
      frontY >= 0 &&
      frontX < width &&
      frontY < height &&
      roadReachable[tileIndex(draft, frontX, frontY)];
    if (!frontOk) issues.push({ code: "ENTRANCE_UNREACHABLE", buildingId: building.buildingId });
  }

  // 4. 地块临街：reserved 豁免（预留地块不承载建筑）。
  for (const plot of draft.plots) {
    if (plot.status === "reserved") continue;
    if (plot.frontageCells.length < MIN_FRONTAGE) {
      issues.push({ code: "PLOT_FRONTAGE_TOO_SMALL", plotId: plot.id });
    }
  }

  return issues;
}
