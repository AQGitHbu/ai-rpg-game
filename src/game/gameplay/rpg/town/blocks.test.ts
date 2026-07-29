import { describe, expect, it } from "vitest";
import {
  tileIndex,
  type Cell,
  type TileType,
  type TownSemanticPlan
} from "@/game/domain";
import { createTownRng } from "./townRandom";
import { generateTerrain, type TerrainLayout } from "./terrain";
import { placeAnchors } from "./anchors";
import { buildRoadNetwork, type RoadPipelineResult } from "./roads";
import { buildBlocksAndPlots, extractBlocks, subdivideIntoPlots } from "./blocks";

// ---------------------------------------------------------------------------
// 手工字符网格（. 草 / F 林 / M 主路 / W 水 / O 城外）。道路格底图视为草地
// （道路只栅格化在可建格上，语义与 roads.ts 一致）。
// ---------------------------------------------------------------------------

function makeGrid(rows: readonly string[]): { terrain: TerrainLayout; tiles: TileType[] } {
  const height = rows.length;
  const width = rows[0].length;
  const baseTiles: TileType[] = [];
  const tiles: TileType[] = [];
  for (const row of rows) {
    for (const ch of row) {
      const base: TileType = ch === "W" ? "water" : ch === "F" ? "forest" : ch === "O" ? "outside" : "grass";
      baseTiles.push(base);
      tiles.push(ch === "M" ? "road_main" : base);
    }
  }
  const buildableMask = baseTiles.map((tile) => tile === "grass" || tile === "forest");
  const roadCost = baseTiles.map((tile) =>
    tile === "outside" ? Number.POSITIVE_INFINITY : tile === "water" ? 20 : tile === "forest" ? 3 : 1.2
  );
  return { terrain: { width, height, buildableMask, baseTiles, roadCost }, tiles };
}

/** 十字路（x∈{5,6} 与 y∈{5,6} 两条宽 2 道路）切出 4 个 5×5 街区。 */
const CROSS_12X12 = makeGrid([
  ".....MM.....",
  ".....MM.....",
  ".....MM.....",
  ".....MM.....",
  ".....MM.....",
  "MMMMMMMMMMMM",
  "MMMMMMMMMMMM",
  ".....MM.....",
  ".....MM.....",
  ".....MM.....",
  ".....MM.....",
  ".....MM....."
]);

/** 十字路 + 西北角被道路切出 2×2 森林小连通域（面积 4 < 6）。 */
const POCKET_12X12 = makeGrid([
  "FFM..MM.....",
  "FFM..MM.....",
  "MMM..MM.....",
  ".....MM.....",
  ".....MM.....",
  "MMMMMMMMMMMM",
  "MMMMMMMMMMMM",
  ".....MM.....",
  ".....MM.....",
  ".....MM.....",
  ".....MM.....",
  ".....MM....."
]);

const DISTRICTS: TownSemanticPlan["districts"] = [
  { type: "residential", preferredArea: "north", weight: 30 },
  { type: "market", preferredArea: "south", weight: 40 }
];

function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

// ---------------------------------------------------------------------------
// extractBlocks
// ---------------------------------------------------------------------------

describe("extractBlocks", () => {
  it("十字路把 12×12 切成 4 个 25 格街区（行优先编号）", () => {
    const blocks = extractBlocks(CROSS_12X12.tiles, CROSS_12X12.terrain, DISTRICTS, createTownRng("b"));
    expect(blocks.map((block) => block.id)).toEqual(["block_1", "block_2", "block_3", "block_4"]);
    for (const block of blocks) expect(block.cells).toHaveLength(25);
  });

  it("roadBoundaryCells 恰为紧贴道路的街区格（行优先序）", () => {
    const blocks = extractBlocks(CROSS_12X12.tiles, CROSS_12X12.terrain, DISTRICTS, createTownRng("b"));
    // block_1 = 西北 5×5：东侧 x=4 一列 + 南侧 y=4 一行，角格 (4,4) 只出现一次。
    expect(blocks[0].roadBoundaryCells).toEqual([
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 4, y: 2 },
      { x: 4, y: 3 },
      { x: 0, y: 4 },
      { x: 1, y: 4 },
      { x: 2, y: 4 },
      { x: 3, y: 4 },
      { x: 4, y: 4 }
    ]);
  });

  it("面积 < 6 的连通域不成街区", () => {
    const blocks = extractBlocks(POCKET_12X12.tiles, POCKET_12X12.terrain, DISTRICTS, createTownRng("b"));
    expect(blocks).toHaveLength(4);
    // 西北剩余 16 格成为 block_1；2×2 森林口袋不在任何街区里。
    expect(blocks[0].cells).toHaveLength(16);
    const allCells = new Set(blocks.flatMap((block) => block.cells.map(cellKey)));
    for (const pocket of ["0,0", "1,0", "0,1", "1,1"]) expect(allCells.has(pocket)).toBe(false);
  });

  it("district 按质心区位匹配度 + weight 确定性分配", () => {
    const blocks = extractBlocks(CROSS_12X12.tiles, CROSS_12X12.terrain, DISTRICTS, createTownRng("b"));
    // 北侧两街区贴 north 提示 → residential；南侧两街区贴 south → market。
    expect(blocks.map((block) => block.districtType)).toEqual([
      "residential",
      "residential",
      "market",
      "market"
    ]);
  });
});

// ---------------------------------------------------------------------------
// subdivideIntoPlots
// ---------------------------------------------------------------------------

const ROAD_TILES: readonly TileType[] = ["road_main", "road_minor", "alley", "square"];

function isRoadAdjacent(cell: Cell, tiles: readonly TileType[], width: number): boolean {
  const height = tiles.length / width;
  return [
    { x: cell.x, y: cell.y - 1 },
    { x: cell.x, y: cell.y + 1 },
    { x: cell.x - 1, y: cell.y },
    { x: cell.x + 1, y: cell.y }
  ].some(
    (n) =>
      n.x >= 0 && n.x < width && n.y >= 0 && n.y < height && ROAD_TILES.includes(tiles[n.y * width + n.x])
  );
}

describe("subdivideIntoPlots", () => {
  it("每个地块临街 ≥ 2、互不重叠、全部落在街区内", () => {
    const blocks = extractBlocks(CROSS_12X12.tiles, CROSS_12X12.terrain, DISTRICTS, createTownRng("b"));
    const block = blocks[0];
    const blockCells = new Set(block.cells.map(cellKey));
    const plots = subdivideIntoPlots(block, CROSS_12X12.tiles, 12, createTownRng("plots"));
    expect(plots.length).toBeGreaterThanOrEqual(1);
    const seen = new Set<string>();
    for (const plot of plots) {
      expect(plot.blockId).toBe(block.id);
      expect(plot.district).toBe(block.districtType);
      expect(plot.status).toBe("generic");
      expect(plot.frontageCells.length).toBeGreaterThanOrEqual(2);
      const plotCells = new Set(plot.cells.map(cellKey));
      for (const frontage of plot.frontageCells) {
        expect(plotCells.has(cellKey(frontage))).toBe(true);
        expect(isRoadAdjacent(frontage, CROSS_12X12.tiles, 12)).toBe(true);
      }
      for (const cell of plot.cells) {
        expect(blockCells.has(cellKey(cell))).toBe(true);
        expect(seen.has(cellKey(cell))).toBe(false);
        seen.add(cellKey(cell));
      }
    }
  });

  it("同 seed 复现", () => {
    const blocks = extractBlocks(CROSS_12X12.tiles, CROSS_12X12.terrain, DISTRICTS, createTownRng("b"));
    const first = subdivideIntoPlots(blocks[1], CROSS_12X12.tiles, 12, createTownRng("again"));
    const second = subdivideIntoPlots(blocks[1], CROSS_12X12.tiles, 12, createTownRng("again"));
    expect(first).toEqual(second);
  });

  it("无临街面的街区不产出任何地块", () => {
    const open = makeGrid([
      "......",
      "......",
      "......",
      "......",
      "......",
      "......"
    ]);
    const blocks = extractBlocks(open.tiles, open.terrain, DISTRICTS, createTownRng("b"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].roadBoundaryCells).toHaveLength(0);
    expect(subdivideIntoPlots(blocks[0], open.tiles, 6, createTownRng("plots"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildBlocksAndPlots
// ---------------------------------------------------------------------------

function makePlan(): TownSemanticPlan {
  return {
    planVersion: 1,
    theme: "测试镇",
    gridSize: { width: 32, height: 32 },
    terrain: { river: "none", externalRoad: "east_west" },
    districts: [
      { type: "market", preferredArea: "center", weight: 35 },
      { type: "residential", preferredArea: "north", weight: 30 },
      { type: "craft", preferredArea: "east", weight: 20 },
      { type: "reserved", preferredArea: "edge", weight: 15 }
    ],
    requiredBuildings: [],
    landmarks: [{ type: "well", preferredArea: "center" }]
  };
}

/** 12×12 手工 tiles 包成最小 RoadPipelineResult（本阶段只消费 tiles）。 */
function fakeRoadResult(tiles: readonly TileType[]): RoadPipelineResult {
  return { roadGraph: { nodes: [], edges: [] }, tiles, mainGateNodeId: "anchor_gate_main" };
}

function realPipeline(seed: string): { terrain: TerrainLayout; plan: TownSemanticPlan; roads: RoadPipelineResult } {
  const plan = makePlan();
  const terrain = generateTerrain(plan, createTownRng(`${seed}:terrain`));
  const anchors = placeAnchors(plan, terrain, createTownRng(`${seed}:anchors`));
  const roads = buildRoadNetwork(anchors, terrain, createTownRng(`${seed}:roads`));
  return { terrain, plan, roads };
}

describe("buildBlocksAndPlots", () => {
  it("小连通域回写 grass，plot 格写入 plot", () => {
    const plan = { ...makePlan(), gridSize: { width: 12, height: 12 }, districts: DISTRICTS };
    const result = buildBlocksAndPlots(
      fakeRoadResult(POCKET_12X12.tiles),
      POCKET_12X12.terrain,
      plan,
      createTownRng("pocket")
    );
    // 2×2 森林口袋（面积 4 < 6）→ grass。
    for (const cell of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]) {
      expect(result.tiles[tileIndex({ width: 12 }, cell.x, cell.y)]).toBe("grass");
    }
    // 全部 plot 格写入 "plot"，且 tiles 中 plot 数量与地块格总数一致。
    let plotCellCount = 0;
    for (const plot of result.plots) {
      plotCellCount += plot.cells.length;
      for (const cell of plot.cells) {
        expect(result.tiles[tileIndex({ width: 12 }, cell.x, cell.y)]).toBe("plot");
      }
    }
    expect(result.tiles.filter((tile) => tile === "plot")).toHaveLength(plotCellCount);
  });

  it("真实管线：同 seed 深度相等", () => {
    const { terrain, plan, roads } = realPipeline("seed-a");
    const first = buildBlocksAndPlots(roads, terrain, plan, createTownRng("seed-a:blocks"));
    const second = buildBlocksAndPlots(roads, terrain, plan, createTownRng("seed-a:blocks"));
    expect(first).toEqual(second);
  });

  it("真实管线多 seed：街区 ≥ 6 格、地块临街 ≥ 2、plot 格一致", () => {
    for (const seed of ["s1", "s2", "s3"]) {
      const { terrain, plan, roads } = realPipeline(seed);
      const result = buildBlocksAndPlots(roads, terrain, plan, createTownRng(`${seed}:blocks`));
      expect(result.blocks.length).toBeGreaterThan(0);
      expect(result.plots.length).toBeGreaterThan(0);
      const blockIds = new Set(result.blocks.map((block) => block.id));
      for (const block of result.blocks) {
        expect(block.cells.length).toBeGreaterThanOrEqual(6);
        expect(plan.districts.map((d) => d.type)).toContain(block.districtType);
      }
      const seen = new Set<string>();
      for (const plot of result.plots) {
        expect(blockIds.has(plot.blockId)).toBe(true);
        expect(plot.frontageCells.length).toBeGreaterThanOrEqual(2);
        for (const cell of plot.cells) {
          expect(seen.has(cellKey(cell))).toBe(false);
          seen.add(cellKey(cell));
          expect(result.tiles[tileIndex(terrain, cell.x, cell.y)]).toBe("plot");
        }
      }
    }
  });
});
