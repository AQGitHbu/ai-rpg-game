import { describe, expect, it } from "vitest";
import {
  tileIndex,
  type Cell,
  type Rect,
  type TileType,
  type TownBuilding,
  type TownSemanticPlan
} from "@/game/domain/townState";
import { createTownRng } from "./townRandom";
import { generateTerrain, type TerrainLayout } from "./terrain";
import { placeAnchors } from "./anchors";
import { buildRoadNetwork, type RoadPipelineResult } from "./roads";
import { buildBlocksAndPlots, type BlockPlotResult } from "./blocks";
import { placeBuildings, type BuildingPlacementResult } from "./buildings";

// ---------------------------------------------------------------------------
// 真实管线：terrain → anchors → roads → blocks/plots → placeBuildings。
// plan 与 fallback 结构一致（3 剧情建筑 + well 地标），但为纯手工常量。
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
    requiredBuildings: [
      { key: "story_tavern", buildingType: "tavern", preferredDistrict: "market", importance: "story_required" },
      { key: "story_blacksmith", buildingType: "blacksmith", preferredDistrict: "craft", importance: "story_required" },
      { key: "story_house", buildingType: "house", preferredDistrict: "residential", importance: "story_required" }
    ],
    landmarks: [{ type: "well", preferredArea: "center" }]
  };
}

type PipelineCase = {
  readonly plan: TownSemanticPlan;
  readonly terrain: TerrainLayout;
  readonly roads: RoadPipelineResult;
  readonly blockPlots: BlockPlotResult;
};

function realCase(seed: string): PipelineCase {
  const plan = makePlan();
  const terrain = generateTerrain(plan, createTownRng(`${seed}:terrain`));
  const anchors = placeAnchors(plan, terrain, createTownRng(`${seed}:anchors`));
  const roads = buildRoadNetwork(anchors, terrain, createTownRng(`${seed}:roads`));
  const blockPlots = buildBlocksAndPlots(roads, terrain, plan, createTownRng(`${seed}:blocks`));
  return { plan, terrain, roads, blockPlots };
}

function run(seed: string, pipeline: PipelineCase): BuildingPlacementResult {
  return placeBuildings(pipeline.plan, pipeline.blockPlots, pipeline.roads, createTownRng(`${seed}:buildings`));
}

const SEEDS = ["s1", "s2", "s3"] as const;

function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

function footprintCells(footprint: Rect): Cell[] {
  const cells: Cell[] = [];
  for (let y = footprint.y; y < footprint.y + footprint.height; y += 1) {
    for (let x = footprint.x; x < footprint.x + footprint.width; x += 1) {
      cells.push({ x, y });
    }
  }
  return cells;
}

function isOnFootprintBoundary(cell: Cell, footprint: Rect): boolean {
  return (
    cell.x === footprint.x ||
    cell.x === footprint.x + footprint.width - 1 ||
    cell.y === footprint.y ||
    cell.y === footprint.y + footprint.height - 1
  );
}

// ---------------------------------------------------------------------------
// 剧情建筑
// ---------------------------------------------------------------------------

describe("placeBuildings 剧情建筑", () => {
  it("3 个剧情建筑全部放置：storyRequired、named、固定中文名", () => {
    for (const seed of SEEDS) {
      const pipeline = realCase(seed);
      const result = run(seed, pipeline);
      const story = result.buildings.filter((building) => building.storyRequired);
      expect(story).toHaveLength(3);
      expect(story.map((building) => building.buildingType).sort()).toEqual(["blacksmith", "house", "tavern"]);
      for (const building of story) expect(building.definitionState).toBe("named");
      const nameByType = new Map(story.map((building) => [building.buildingType, building.displayName]));
      expect(nameByType.get("tavern")).toBe("福来酒楼");
      expect(nameByType.get("blacksmith")).toBe("铁匠铺");
      expect(nameByType.get("house")).toBe("张宅");
    }
  });

  it("手工十字网格：tavern 评分落在 preferredDistrict = market", () => {
    // 12×12 十字路切 4 个 5×5 街区：北两块 residential、南两块 market。
    const rows = [
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
    ];
    const height = rows.length;
    const width = rows[0].length;
    const baseTiles: TileType[] = [];
    const tiles: TileType[] = [];
    for (const row of rows) {
      for (const ch of row) {
        baseTiles.push("grass");
        tiles.push(ch === "M" ? "road_main" : "grass");
      }
    }
    const terrain: TerrainLayout = {
      width,
      height,
      buildableMask: baseTiles.map(() => true),
      baseTiles,
      roadCost: baseTiles.map(() => 1.2)
    };
    const plan: TownSemanticPlan = {
      ...makePlan(),
      gridSize: { width, height },
      districts: [
        { type: "residential", preferredArea: "north", weight: 30 },
        { type: "market", preferredArea: "south", weight: 40 }
      ],
      requiredBuildings: [
        { key: "story_tavern", buildingType: "tavern", preferredDistrict: "market", importance: "story_required" }
      ],
      landmarks: []
    };
    const roads: RoadPipelineResult = { roadGraph: { nodes: [], edges: [] }, tiles, mainGateNodeId: "none" };
    const blockPlots = buildBlocksAndPlots(roads, terrain, plan, createTownRng("cross:blocks"));
    const result = placeBuildings(plan, blockPlots, roads, createTownRng("cross:buildings"));
    const tavern = result.buildings.find((building) => building.buildingType === "tavern");
    expect(tavern).toBeDefined();
    expect(tavern!.district).toBe("market");
    expect(tavern!.storyRequired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// footprint / entrance / tiles 不变量
// ---------------------------------------------------------------------------

describe("placeBuildings 几何不变量", () => {
  it("footprint 两两不相交、全部落在原 plot 格上（不覆盖 road/water/outside）", () => {
    for (const seed of SEEDS) {
      const pipeline = realCase(seed);
      const result = run(seed, pipeline);
      expect(result.buildings.length).toBeGreaterThan(0);
      const plotById = new Map(pipeline.blockPlots.plots.map((plot) => [plot.id, plot]));
      const seen = new Set<string>();
      for (const building of result.buildings) {
        const plot = plotById.get(building.plotId);
        expect(plot).toBeDefined();
        const plotCells = new Set(plot!.cells.map(cellKey));
        expect(building.footprint.width).toBeGreaterThanOrEqual(2);
        expect(building.footprint.height).toBeGreaterThanOrEqual(2);
        for (const cell of footprintCells(building.footprint)) {
          // 落在原 plot 格上 ⇒ 必然不覆盖 road/water/outside。
          expect(plotCells.has(cellKey(cell))).toBe(true);
          expect(pipeline.blockPlots.tiles[tileIndex(pipeline.terrain, cell.x, cell.y)]).toBe("plot");
          expect(seen.has(cellKey(cell))).toBe(false);
          seen.add(cellKey(cell));
        }
      }
    }
  });

  it("每个建筑 entrance 在 footprint 边界，tiles 写入 building/building_entrance", () => {
    for (const seed of SEEDS) {
      const pipeline = realCase(seed);
      const result = run(seed, pipeline);
      expect(result.tiles).toHaveLength(pipeline.blockPlots.tiles.length);
      for (const building of result.buildings) {
        const { entrance, footprint } = building;
        expect(isOnFootprintBoundary(entrance, footprint)).toBe(true);
        expect(["north", "south", "west", "east"]).toContain(entrance.direction);
        for (const cell of footprintCells(footprint)) {
          const tile = result.tiles[tileIndex(pipeline.terrain, cell.x, cell.y)];
          if (cell.x === entrance.x && cell.y === entrance.y) expect(tile).toBe("building_entrance");
          else expect(tile).toBe("building");
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 地块状态 / 泛化建筑 / 复现
// ---------------------------------------------------------------------------

describe("placeBuildings 地块状态与复现", () => {
  it("plot 状态与建筑一致：occupied ↔ 有建筑；reserved 格写入 reserved", () => {
    for (const seed of SEEDS) {
      const pipeline = realCase(seed);
      const result = run(seed, pipeline);
      expect(result.plots.map((plot) => plot.id)).toEqual(pipeline.blockPlots.plots.map((plot) => plot.id));
      const occupiedIds = new Set(result.buildings.map((building) => building.plotId));
      expect(occupiedIds.size).toBe(result.buildings.length); // 一地块一建筑
      for (const plot of result.plots) {
        if (occupiedIds.has(plot.id)) expect(plot.status).toBe("occupied");
        else expect(["generic", "reserved"]).toContain(plot.status);
        if (plot.status === "reserved") {
          for (const cell of plot.cells) {
            expect(result.tiles[tileIndex(pipeline.terrain, cell.x, cell.y)]).toBe("reserved");
          }
        }
      }
      // 占用率 ≤ 0.65（向上取整容差 1：剧情/门楼建筑数可能超过极小镇的配额）。
      const occupiedCount = result.plots.filter((plot) => plot.status === "occupied").length;
      expect(occupiedCount).toBeLessThanOrEqual(Math.ceil(result.plots.length * 0.65) + 1);
      expect(result.plots.some((plot) => plot.status === "reserved")).toBe(true);
    }
  });

  it("泛化建筑 definitionState 为 generic，displayName 按模板 + 序号", () => {
    for (const seed of SEEDS) {
      const pipeline = realCase(seed);
      const result = run(seed, pipeline);
      const generic = result.buildings.filter(
        (building) => !building.storyRequired && building.buildingType !== "gatehouse"
      );
      expect(generic.length).toBeGreaterThan(0);
      for (const building of generic) {
        expect(building.definitionState).toBe("generic");
        expect(building.displayName).toMatch(/^一[间户处座].+·\d+$/);
      }
    }
  });

  it("每个 gate 一个 gatehouse（named、非剧情）", () => {
    for (const seed of SEEDS) {
      const pipeline = realCase(seed);
      const result = run(seed, pipeline);
      const gates = pipeline.roads.roadGraph.nodes.filter((node) => node.kind === "gate");
      const gatehouses = result.buildings.filter((building) => building.buildingType === "gatehouse");
      expect(gatehouses).toHaveLength(gates.length);
      for (const gatehouse of gatehouses) {
        expect(gatehouse.definitionState).toBe("named");
        expect(gatehouse.storyRequired).toBe(false);
        expect(gatehouse.displayName).toContain("城门哨所");
      }
    }
  });

  it("同 seed 深度相等", () => {
    const pipeline = realCase("repeat");
    const first = run("repeat", pipeline);
    const second = run("repeat", pipeline);
    expect(first).toEqual(second);
  });

  it("buildingId 连续且与 buildings 序一致", () => {
    const pipeline = realCase("s1");
    const result = run("s1", pipeline);
    expect(result.buildings.map((building: TownBuilding) => building.buildingId)).toEqual(
      result.buildings.map((_, index) => `building_${index + 1}`)
    );
  });
});
