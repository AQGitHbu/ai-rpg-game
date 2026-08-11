import {
  tileIndex,
  type AreaHint,
  type Cell,
  type TileType,
  type TownBlock,
  type TownDistrictType,
  type TownPlot,
  type TownSemanticPlan
} from "@/game/domain/townState";
import type { TownRng } from "./townRandom";
import type { TerrainLayout } from "./terrain";
import type { RoadPipelineResult } from "./roads";

// 街区与地块阶段：Flood Fill 非道路可建格得街区（面积 < 6 回写 grass），
// 再从临街边界向内切分地块。纯函数：随机只来自传入 rng；Flood Fill 与
// 切分全部按行优先扫描 + 固定方向序裁决，同 seed 同输入深度相等。

/** 街区最小面积（Spec §5）：更小的连通域不成街区，由 buildBlocksAndPlots 回写 grass。 */
const MIN_BLOCK_AREA = 6;

/** 地块最小临街宽度（Spec §5）。 */
const MIN_FRONTAGE = 2;

/** 切分时单段临街宽度上限：rng 在 2–4 间取，避免地块过宽。 */
const FRONTAGE_WIDTH_MAX = 4;

/** 地块进深范围（Spec §5：3–8 格；街区不够深时以实际可占格为准）。 */
const PLOT_DEPTH_MIN = 3;
const PLOT_DEPTH_MAX = 8;

/** 尾并阶段单地块面积上限：达到上限的地块不再吸收内部剩余格，
 * 剩余格保持草/林（自然留白）。无上限时巨型街区会并出 100+ 格的
 * 怪物地块，成为大片无建筑的死区。 */
const PLOT_AREA_MAX = 24;

/** 视为道路/广场的瓦片：街区边界与临街判定共用。 */
const ROAD_TILES: ReadonlySet<TileType> = new Set<TileType>(["road_main", "road_minor", "alley", "square"]);

/** 4 邻接固定序（北南西东）：Flood Fill / 切分 / 尾并的平局裁决全依赖此序。 */
const DIRECTIONS: readonly { readonly dx: number; readonly dy: number }[] = [
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 }
];

/** 街区候选格：栅格化后仍是底图草/林的可建格（道路/广场已被改写排除）。 */
function isBlockTile(tile: TileType): boolean {
  return tile === "grass" || tile === "forest";
}

/** cell 的 4 邻接是否有道路/广场瓦片（越界视为无）。 */
function hasRoadNeighbor(cell: Cell, tiles: readonly TileType[], width: number, height: number): boolean {
  for (const direction of DIRECTIONS) {
    const x = cell.x + direction.dx;
    const y = cell.y + direction.dy;
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    if (ROAD_TILES.has(tiles[y * width + x])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// extractBlocks
// ---------------------------------------------------------------------------

/** 区位提示对质心的贴合度 [0,1]：目标点映射与 anchors.areaTarget 一致；edge 看离边距离。 */
function areaFit(area: AreaHint, centroid: { x: number; y: number }, width: number, height: number): number {
  if (area === "edge") {
    const borderDistance = Math.min(centroid.x, centroid.y, width - 1 - centroid.x, height - 1 - centroid.y);
    return 1 - borderDistance / (Math.min(width, height) / 2);
  }
  const midX = Math.floor(width / 2);
  const midY = Math.floor(height / 2);
  const target =
    area === "center"
      ? { x: midX, y: midY }
      : area === "north"
        ? { x: midX, y: Math.floor(height / 4) }
        : area === "south"
          ? { x: midX, y: Math.floor((height * 3) / 4) }
          : area === "east"
            ? { x: Math.floor((width * 3) / 4), y: midY }
            : { x: Math.floor(width / 4), y: midY };
  const distance = Math.abs(centroid.x - target.x) + Math.abs(centroid.y - target.y);
  return 1 - distance / (width + height);
}

/** district 分配：贴合度 ×100 + weight 取最高分，平局取列表靠前者（确定性）。 */
function assignDistrict(
  cells: readonly Cell[],
  districts: TownSemanticPlan["districts"],
  width: number,
  height: number
): TownDistrictType {
  if (districts.length === 0) return "reserved";
  let sumX = 0;
  let sumY = 0;
  for (const cell of cells) {
    sumX += cell.x;
    sumY += cell.y;
  }
  const centroid = { x: sumX / cells.length, y: sumY / cells.length };
  let best = districts[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const district of districts) {
    const score = areaFit(district.preferredArea, centroid, width, height) * 100 + district.weight;
    if (score > bestScore) {
      best = district;
      bestScore = score;
    }
  }
  return best.type;
}

/**
 * Flood Fill 非道路可建格 → 街区。行优先扫描起点、固定方向序 BFS，
 * 街区按发现序编号；面积 < 6 的连通域丢弃（回写 grass 由
 * buildBlocksAndPlots 完成，本函数不改 tiles）。rng 目前不消费：
 * district 分配按 brief 为纯加权确定性（保留参数以稳定门面签名）。
 */
export function extractBlocks(
  tiles: readonly TileType[],
  terrain: TerrainLayout,
  districts: TownSemanticPlan["districts"],
  _rng: TownRng
): readonly TownBlock[] {
  const { width, height, buildableMask } = terrain;
  const visited: boolean[] = new Array(width * height).fill(false);
  const blocks: TownBlock[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = tileIndex(terrain, x, y);
      if (visited[start] || !buildableMask[start] || !isBlockTile(tiles[start])) continue;
      // BFS 收集连通域（4 邻接，方向序固定）。
      const indices: number[] = [start];
      visited[start] = true;
      for (let head = 0; head < indices.length; head += 1) {
        const cx = indices[head] % width;
        const cy = Math.floor(indices[head] / width);
        for (const direction of DIRECTIONS) {
          const nx = cx + direction.dx;
          const ny = cy + direction.dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = tileIndex(terrain, nx, ny);
          if (visited[next] || !buildableMask[next] || !isBlockTile(tiles[next])) continue;
          visited[next] = true;
          indices.push(next);
        }
      }
      if (indices.length < MIN_BLOCK_AREA) continue;
      indices.sort((a, b) => a - b);
      const cells = indices.map((index) => ({ x: index % width, y: Math.floor(index / width) }));
      blocks.push({
        id: `block_${blocks.length + 1}`,
        cells,
        roadBoundaryCells: cells.filter((cell) => hasRoadNeighbor(cell, tiles, width, height)),
        districtType: assignDistrict(cells, districts, width, height)
      });
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// subdivideIntoPlots
// ---------------------------------------------------------------------------

/** 把同朝向临街格分组为沿街连续 run（北/南按同行连续 x，西/东按同列连续 y）。 */
function groupRuns(
  fronts: readonly Cell[],
  direction: { readonly dx: number; readonly dy: number }
): Cell[][] {
  const horizontal = direction.dy !== 0; // 路在北/南 → run 沿 x 展开
  const sorted = [...fronts].sort((a, b) =>
    horizontal ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y
  );
  const runs: Cell[][] = [];
  for (const cell of sorted) {
    const last = runs.length > 0 ? runs[runs.length - 1][runs[runs.length - 1].length - 1] : null;
    const continues =
      last !== null &&
      (horizontal ? last.y === cell.y && last.x + 1 === cell.x : last.x === cell.x && last.y + 1 === cell.y);
    if (continues) runs[runs.length - 1].push(cell);
    else runs.push([cell]);
  }
  return runs;
}

/** run 切成 2–4 格宽的临街段；剩 1 格并入前一段，避免孤立临街格。 */
function splitRun(run: readonly Cell[], rng: TownRng): Cell[][] {
  const chunks: Cell[][] = [];
  let start = 0;
  while (run.length - start >= MIN_FRONTAGE) {
    let span = MIN_FRONTAGE + rng.nextInt(FRONTAGE_WIDTH_MAX - MIN_FRONTAGE + 1);
    if (span > run.length - start) span = run.length - start;
    if (run.length - start - span === 1) span += 1;
    chunks.push(run.slice(start, start + span));
    start += span;
  }
  return chunks;
}

/**
 * 从临街边界向内切分地块：按固定朝向序（北南西东）取临街 run →
 * rng 切段（宽 2–4）→ 逐列向内生长（进深 rng 取 3–8，遇街区外/已占格截断）→
 * 内部剩余迭代并入相邻地块。无临街面的候选一律不产出独立地块。
 */
export function subdivideIntoPlots(
  block: TownBlock,
  tiles: readonly TileType[],
  gridWidth: number,
  rng: TownRng
): readonly TownPlot[] {
  const gridHeight = Math.floor(tiles.length / gridWidth);
  const blockIndices = new Set(block.cells.map((cell) => cell.y * gridWidth + cell.x));
  const claimed = new Map<number, number>(); // cellIndex → plot 序号
  const plotCells: number[][] = [];

  // 1. 逐朝向切分临街段并向内生长。
  for (const direction of DIRECTIONS) {
    const fronts = block.cells.filter((cell) => {
      const nx = cell.x + direction.dx;
      const ny = cell.y + direction.dy;
      if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) return false;
      return !claimed.has(cell.y * gridWidth + cell.x) && ROAD_TILES.has(tiles[ny * gridWidth + nx]);
    });
    for (const run of groupRuns(fronts, direction)) {
      if (run.length < MIN_FRONTAGE) continue; // 孤立单格留给尾并阶段
      for (const chunk of splitRun(run, rng)) {
        // 前一段生长可能吞掉后续 run 的临街格：不足 2 格不成地块。
        const available = chunk.filter((cell) => !claimed.has(cell.y * gridWidth + cell.x));
        const depth = PLOT_DEPTH_MIN + rng.nextInt(PLOT_DEPTH_MAX - PLOT_DEPTH_MIN + 1);
        if (available.length < MIN_FRONTAGE) continue;
        const indices: number[] = [];
        for (const front of available) {
          for (let step = 0; step < depth; step += 1) {
            const x = front.x - direction.dx * step; // 向内 = 背向道路
            const y = front.y - direction.dy * step;
            if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) break;
            const index = y * gridWidth + x;
            if (!blockIndices.has(index) || claimed.has(index)) break;
            claimed.set(index, plotCells.length);
            indices.push(index);
          }
        }
        plotCells.push(indices);
      }
    }
  }

  // 2. 内部剩余并入相邻地块：行优先迭代扫描直至稳定。单地块并到
  //    PLOT_AREA_MAX 封顶，剩余格不再认领（保持草/林，自然留白）。
  let changed = plotCells.length > 0;
  while (changed) {
    changed = false;
    for (const cell of block.cells) {
      const index = cell.y * gridWidth + cell.x;
      if (claimed.has(index)) continue;
      for (const direction of DIRECTIONS) {
        const nx = cell.x + direction.dx;
        const ny = cell.y + direction.dy;
        if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
        const target = claimed.get(ny * gridWidth + nx);
        if (target === undefined || plotCells[target].length >= PLOT_AREA_MAX) continue;
        claimed.set(index, target);
        plotCells[target].push(index);
        changed = true;
        break;
      }
    }
  }

  // 3. 产出 TownPlot：cells 行优先排序，frontage 由最终格集重算（含并入的临街格）。
  const plots: TownPlot[] = [];
  for (const indices of plotCells) {
    if (indices.length === 0) continue;
    const cells = [...indices].sort((a, b) => a - b).map((index) => ({
      x: index % gridWidth,
      y: Math.floor(index / gridWidth)
    }));
    plots.push({
      id: `${block.id}_plot_${plots.length + 1}`,
      blockId: block.id,
      cells,
      frontageCells: cells.filter((cell) => hasRoadNeighbor(cell, tiles, gridWidth, gridHeight)),
      district: block.districtType,
      status: "generic"
    });
  }
  return plots;
}

// ---------------------------------------------------------------------------
// buildBlocksAndPlots
// ---------------------------------------------------------------------------

export type BlockPlotResult = {
  /** roadResult.tiles 基础上：小连通域回写 grass、地块格写入 "plot"。 */
  readonly tiles: readonly TileType[];
  readonly blocks: readonly TownBlock[];
  readonly plots: readonly TownPlot[];
};

/** 街区 + 地块编排：blocks 序贯共享同一 rng，序固定 → 同 seed 深度相等。 */
export function buildBlocksAndPlots(
  roadResult: RoadPipelineResult,
  terrain: TerrainLayout,
  plan: TownSemanticPlan,
  rng: TownRng
): BlockPlotResult {
  const blocks = extractBlocks(roadResult.tiles, terrain, plan.districts, rng);
  const tiles: TileType[] = [...roadResult.tiles];

  // 面积 < 6 的连通域 = 不属于任何街区的草/林可建格 → 回写 grass。
  const blockCellIndices = new Set<number>();
  for (const block of blocks) {
    for (const cell of block.cells) blockCellIndices.add(tileIndex(terrain, cell.x, cell.y));
  }
  for (let i = 0; i < tiles.length; i += 1) {
    if (terrain.buildableMask[i] && isBlockTile(tiles[i]) && !blockCellIndices.has(i)) tiles[i] = "grass";
  }

  const plots = blocks.flatMap((block) => [...subdivideIntoPlots(block, roadResult.tiles, terrain.width, rng)]);
  for (const plot of plots) {
    for (const cell of plot.cells) tiles[tileIndex(terrain, cell.x, cell.y)] = "plot";
  }
  return { tiles, blocks, plots };
}
