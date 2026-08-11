import { tileIndex, type Cell, type RoadEdge, type RoadNode, type TileType } from "@/game/domain/townState";
import type { TownRng } from "./townRandom";
import type { TerrainLayout } from "./terrain";
import type { TownAnchor } from "./anchors";

// 道路管线：全锚点两两 A* 得候选边 → Prim MST（起点主城门）→ 绕路系数补环 →
// 栅格化（主干宽 3 / 支路宽 2 / 广场 5×5）。纯函数：随机只来自传入 rng；
// A*/Prim/Dijkstra 平局全部按固定次序裁决，同 seed 同输入深度相等。

/** 已有路复用代价（Spec §5）：后续边重寻路时压低已成路格，促使道路合流。 */
const EXISTING_ROAD_COST = 0.4;

/** A* 转弯惩罚（Spec §5）。 */
const TURN_PENALTY = 0.3;

/** 补环阈值：图上距离 ÷ 直连成本 ≥ 此值才值得加边（Spec §5）。 */
const LOOP_DETOUR_RATIO = 1.8;

/** 附加环路边数上限占 MST 边数比例（Spec §5）。 */
const LOOP_EXTRA_EDGE_RATIO = 0.25;

/** 主干/支路半幅膨胀与广场尺寸（Spec §5：宽 3 / 宽 2 / 5×5）。 */
const MAIN_ROAD_OFFSETS: readonly number[] = [-1, 0, 1];
const MINOR_ROAD_OFFSETS: readonly number[] = [0, 1];
const SQUARE_HALF = 2;

/** 4 邻接固定展开序（东西南北）：保证 A* 平局确定性。 */
const DIRECTIONS: readonly { readonly dx: number; readonly dy: number }[] = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 }
];

export type RoadPipelineResult = {
  readonly roadGraph: { readonly nodes: readonly RoadNode[]; readonly edges: readonly RoadEdge[] };
  readonly tiles: readonly TileType[];
  readonly mainGateNodeId: string;
};

// ---------------------------------------------------------------------------
// A*（带转弯罚，4 邻接）
// ---------------------------------------------------------------------------

/**
 * 搜索域（河带绕行风险的处理，见上游审查）：可建格恒可走；水域等
 * 「有限代价但不可建」的格只在可建区包围盒内可走。河带覆盖椭圆外的
 * 整幅水行位于包围盒外，被确定性排除，路径不会沿河带绕出小镇边界。
 */
function computeSearchDomain(terrain: TerrainLayout): readonly boolean[] {
  const { width, height, buildableMask, roadCost } = terrain;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!buildableMask[tileIndex(terrain, x, y)]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const domain: boolean[] = new Array(width * height).fill(false);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = tileIndex(terrain, x, y);
      domain[index] =
        buildableMask[index] ||
        (Number.isFinite(roadCost[index]) && x >= minX && x <= maxX && y >= minY && y <= maxY);
    }
  }
  return domain;
}

type HeapEntry = {
  readonly f: number;
  readonly sequence: number;
  readonly stateKey: number;
};

/** 二叉最小堆：f 相同按入堆序，保证展开次序确定。 */
function heapPush(heap: HeapEntry[], entry: HeapEntry): void {
  heap.push(entry);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heapLess(heap[i], heap[parent])) {
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    } else break;
  }
}

function heapLess(a: HeapEntry, b: HeapEntry): boolean {
  return a.f < b.f || (a.f === b.f && a.sequence < b.sequence);
}

function heapPop(heap: HeapEntry[]): HeapEntry {
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (left < heap.length && heapLess(heap[left], heap[smallest])) smallest = left;
      if (right < heap.length && heapLess(heap[right], heap[smallest])) smallest = right;
      if (smallest === i) break;
      [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
      i = smallest;
    }
  }
  return top;
}

/**
 * 带转弯惩罚的 4 邻接 A*。状态 =（格, 进入方向），方向 4（起点用哨兵 4 表示
 * 无方向，转弯不罚首步）。成本 = 逐格进入代价之和 + 0.3 × 转弯数；启发式
 * 用曼哈顿距离 × 0.4（全局最低格代价），可采纳。cells 含起终点。
 */
export function findRoadPath(
  from: Cell,
  to: Cell,
  terrain: TerrainLayout
): { cells: readonly Cell[]; cost: number } | null {
  const { width, height, roadCost } = terrain;
  const domain = computeSearchDomain(terrain);
  const fromIndex = tileIndex(terrain, from.x, from.y);
  const toIndex = tileIndex(terrain, to.x, to.y);
  if (!domain[fromIndex] || !domain[toIndex]) return null;

  // stateKey = cellIndex * 5 + dir（dir 4 = 起点无方向）。
  const stateCount = width * height * 5;
  const bestG = new Float64Array(stateCount).fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(stateCount).fill(-1);
  const heuristic = (index: number): number =>
    (Math.abs((index % width) - to.x) + Math.abs(Math.floor(index / width) - to.y)) *
    EXISTING_ROAD_COST;

  const startKey = fromIndex * 5 + 4;
  bestG[startKey] = 0;
  const heap: HeapEntry[] = [];
  let sequence = 0;
  heapPush(heap, { f: heuristic(fromIndex), sequence: sequence++, stateKey: startKey });

  while (heap.length > 0) {
    const { stateKey } = heapPop(heap);
    const cellIndex = Math.floor(stateKey / 5);
    const direction = stateKey % 5;
    const g = bestG[stateKey];
    if (cellIndex === toIndex) {
      // 回溯 previous 链得到 cells（起点 → 终点）。
      const cells: Cell[] = [];
      for (let key = stateKey; key !== -1; key = previous[key]) {
        const index = Math.floor(key / 5);
        cells.push({ x: index % width, y: Math.floor(index / width) });
      }
      cells.reverse();
      return { cells, cost: g };
    }
    const x = cellIndex % width;
    const y = Math.floor(cellIndex / width);
    for (let d = 0; d < DIRECTIONS.length; d += 1) {
      const nx = x + DIRECTIONS[d].dx;
      const ny = y + DIRECTIONS[d].dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nextIndex = tileIndex(terrain, nx, ny);
      if (!domain[nextIndex]) continue;
      const turn = direction !== 4 && direction !== d ? TURN_PENALTY : 0;
      const nextG = g + roadCost[nextIndex] + turn;
      const nextKey = nextIndex * 5 + d;
      if (nextG < bestG[nextKey]) {
        bestG[nextKey] = nextG;
        previous[nextKey] = stateKey;
        heapPush(heap, { f: nextG + heuristic(nextIndex), sequence: sequence++, stateKey: nextKey });
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prim MST
// ---------------------------------------------------------------------------

/**
 * Prim：以 nodeIds[0] 为起点，每轮取「连接树内外、成本最小」的候选边；
 * 等代价取候选列表靠前者（顺序稳定）。图不连通时只覆盖起点连通分量。
 */
export function minimumSpanningTreeEdges(
  nodeIds: readonly string[],
  candidates: readonly { from: string; to: string; cost: number }[]
): readonly { from: string; to: string; cost: number }[] {
  if (nodeIds.length === 0) return [];
  const inTree = new Set<string>([nodeIds[0]]);
  const result: { from: string; to: string; cost: number }[] = [];
  while (inTree.size < nodeIds.length) {
    let best: { from: string; to: string; cost: number } | null = null;
    for (const candidate of candidates) {
      if (inTree.has(candidate.from) === inTree.has(candidate.to)) continue;
      if (best === null || candidate.cost < best.cost) best = candidate;
    }
    if (best === null) break;
    result.push(best);
    inTree.add(best.from);
    inTree.add(best.to);
  }
  return result;
}

// ---------------------------------------------------------------------------
// buildRoadNetwork
// ---------------------------------------------------------------------------

type CandidateEdge = { readonly from: string; readonly to: string; readonly cost: number };

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Dijkstra（O(n²) 顺序扫描 + 严格小于更新，平局按节点/边序确定）。 */
function dijkstra(
  nodeIds: readonly string[],
  edges: readonly CandidateEdge[],
  from: string
): { readonly distance: ReadonlyMap<string, number>; readonly prevEdge: ReadonlyMap<string, CandidateEdge> } {
  const distance = new Map<string, number>(nodeIds.map((id) => [id, Number.POSITIVE_INFINITY]));
  const prevEdge = new Map<string, CandidateEdge>();
  const done = new Set<string>();
  distance.set(from, 0);
  for (let round = 0; round < nodeIds.length; round += 1) {
    let current: string | null = null;
    for (const id of nodeIds) {
      if (done.has(id)) continue;
      if (current === null || distance.get(id)! < distance.get(current)!) current = id;
    }
    if (current === null || distance.get(current)! === Number.POSITIVE_INFINITY) break;
    done.add(current);
    for (const edge of edges) {
      const other = edge.from === current ? edge.to : edge.to === current ? edge.from : null;
      if (other === null || done.has(other)) continue;
      const next = distance.get(current)! + edge.cost;
      if (next < distance.get(other)!) {
        distance.set(other, next);
        prevEdge.set(other, edge);
      }
    }
  }
  return { distance, prevEdge };
}

function toNodeKind(kind: TownAnchor["kind"]): RoadNode["kind"] {
  if (kind === "gate") return "gate";
  if (kind === "square") return "square";
  return "poi";
}

/** 沿路径逐格膨胀写瓦片：越界或不可建的格跳过（膨胀不越出 buildableMask）。 */
function stampPath(
  tiles: TileType[],
  terrain: TerrainLayout,
  cells: readonly Cell[],
  offsets: readonly number[],
  tile: TileType
): void {
  for (const cell of cells) {
    for (const dy of offsets) {
      for (const dx of offsets) {
        const x = cell.x + dx;
        const y = cell.y + dy;
        if (x < 0 || y < 0 || x >= terrain.width || y >= terrain.height) continue;
        const index = tileIndex(terrain, x, y);
        if (terrain.buildableMask[index]) tiles[index] = tile;
      }
    }
  }
}

export function buildRoadNetwork(
  anchors: readonly TownAnchor[],
  terrain: TerrainLayout,
  rng: TownRng
): RoadPipelineResult {
  const nodes: RoadNode[] = anchors.map((anchor) => ({
    id: anchor.id,
    x: anchor.cell.x,
    y: anchor.cell.y,
    kind: toNodeKind(anchor.kind)
  }));
  const cellById = new Map(anchors.map((anchor) => [anchor.id, anchor.cell]));
  const kindById = new Map(nodes.map((node) => [node.id, node.kind]));
  const mainGateNodeId = nodes.find((node) => node.kind === "gate")?.id ?? nodes[0].id;

  // 1. 候选边：全锚点两两 A*（锚点序），不可达对丢弃。
  const candidates: CandidateEdge[] = [];
  for (let i = 0; i < anchors.length; i += 1) {
    for (let j = i + 1; j < anchors.length; j += 1) {
      const path = findRoadPath(anchors[i].cell, anchors[j].cell, terrain);
      if (path !== null) candidates.push({ from: anchors[i].id, to: anchors[j].id, cost: path.cost });
    }
  }

  // 2. Prim MST：主城门起步，覆盖全部可达锚点。
  const nodeIds = [mainGateNodeId, ...nodes.map((node) => node.id).filter((id) => id !== mainGateNodeId)];
  const mstEdges = minimumSpanningTreeEdges(nodeIds, candidates);
  const accepted: CandidateEdge[] = [...mstEdges];
  const acceptedKeys = new Set(mstEdges.map((edge) => pairKey(edge.from, edge.to)));

  // 3. 补环：剩余候选 rng 洗牌后依次评估，绕路系数 ≥ 1.8 且未超预算才加。
  let loopBudget = Math.ceil(mstEdges.length * LOOP_EXTRA_EDGE_RATIO);
  const loopCandidates = rng.shuffle(
    candidates.filter((candidate) => !acceptedKeys.has(pairKey(candidate.from, candidate.to)))
  );
  for (const candidate of loopCandidates) {
    if (loopBudget <= 0) break;
    const detour = dijkstra(nodeIds, accepted, candidate.from).distance.get(candidate.to)!;
    if (detour / candidate.cost >= LOOP_DETOUR_RATIO) {
      accepted.push(candidate);
      acceptedKeys.add(pairKey(candidate.from, candidate.to));
      loopBudget -= 1;
    }
  }

  // 4. 主干判定：gate/square 直连边恒为 main；此外每个 gate 沿图上最短路
  //    走到 square 的沿途边也标 main（保证城门到广场的主干贯通存在）。
  const trunkKeys = new Set<string>();
  for (const candidate of accepted) {
    const bothTrunk = [candidate.from, candidate.to].every((id) => {
      const kind = kindById.get(id);
      return kind === "gate" || kind === "square";
    });
    if (bothTrunk) trunkKeys.add(pairKey(candidate.from, candidate.to));
  }
  const squareNodeId = nodes.find((node) => node.kind === "square")?.id;
  if (squareNodeId !== undefined) {
    for (const node of nodes) {
      if (node.kind !== "gate") continue;
      const { prevEdge } = dijkstra(nodeIds, accepted, node.id);
      for (let at = squareNodeId; at !== node.id; ) {
        const edge = prevEdge.get(at);
        if (edge === undefined) break; // gate 与 square 不连通（仅极端地形）
        trunkKeys.add(pairKey(edge.from, edge.to));
        at = edge.from === at ? edge.to : edge.from;
      }
    }
  }

  // 5. 逐边重寻路：已成路格代价压至 0.4，促使后续边并入已有路。
  const workingCost = [...terrain.roadCost];
  const workingTerrain: TerrainLayout = { ...terrain, roadCost: workingCost };
  const edges: RoadEdge[] = accepted.map((candidate, order) => {
    const path = findRoadPath(cellById.get(candidate.from)!, cellById.get(candidate.to)!, workingTerrain);
    if (path === null) {
      // 复用只会压低成本，候选可达则重寻路必可达；触发即为内部错误。
      throw new Error(`buildRoadNetwork: 重寻路失败 ${candidate.from} → ${candidate.to}`);
    }
    for (const cell of path.cells) {
      const index = tileIndex(terrain, cell.x, cell.y);
      workingCost[index] = Math.min(workingCost[index], EXISTING_ROAD_COST);
    }
    return {
      id: `road_edge_${order + 1}`,
      from: candidate.from,
      to: candidate.to,
      roadType: trunkKeys.has(pairKey(candidate.from, candidate.to)) ? "main" : "minor",
      cells: path.cells,
      cost: path.cost
    };
  });

  // 6. 栅格化：先支路（宽 2）再主干（宽 3）再广场（5×5），后写覆盖前写。
  const tiles: TileType[] = [...terrain.baseTiles];
  for (const edge of edges) {
    if (edge.roadType === "minor") stampPath(tiles, terrain, edge.cells, MINOR_ROAD_OFFSETS, "road_minor");
  }
  for (const edge of edges) {
    if (edge.roadType === "main") stampPath(tiles, terrain, edge.cells, MAIN_ROAD_OFFSETS, "road_main");
  }
  const squareOffsets: number[] = [];
  for (let offset = -SQUARE_HALF; offset <= SQUARE_HALF; offset += 1) squareOffsets.push(offset);
  for (const anchor of anchors) {
    if (anchor.kind === "square") stampPath(tiles, terrain, [anchor.cell], squareOffsets, "square");
  }

  return { roadGraph: { nodes, edges }, tiles, mainGateNodeId };
}
