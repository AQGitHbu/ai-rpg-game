import { describe, expect, it } from "vitest";
import { tileIndex, type Cell, type TileType, type TownSemanticPlan } from "@/game/domain";
import { createTownRng } from "./townRandom";
import { generateTerrain, type TerrainLayout } from "./terrain";
import { placeAnchors } from "./anchors";
import {
  buildRoadNetwork,
  findRoadPath,
  minimumSpanningTreeEdges,
  type RoadPipelineResult
} from "./roads";

// ---------------------------------------------------------------------------
// findRoadPath：手工字符地形（. 草 / F 林 / W 水 / O 城外），语义与 terrain.ts 一致。
// ---------------------------------------------------------------------------

function makeTerrain(rows: readonly string[]): TerrainLayout {
  const height = rows.length;
  const width = rows[0].length;
  const baseTiles: TileType[] = [];
  for (const row of rows) {
    for (const ch of row) {
      baseTiles.push(ch === "W" ? "water" : ch === "F" ? "forest" : ch === "O" ? "outside" : "grass");
    }
  }
  const buildableMask = baseTiles.map((tile) => tile === "grass" || tile === "forest");
  const roadCost = baseTiles.map((tile) =>
    tile === "outside" ? Number.POSITIVE_INFINITY : tile === "water" ? 20 : tile === "forest" ? 3 : 1.2
  );
  return { width, height, buildableMask, baseTiles, roadCost };
}

function countTurns(cells: readonly Cell[]): number {
  let turns = 0;
  for (let i = 2; i < cells.length; i += 1) {
    const prevDx = cells[i - 1].x - cells[i - 2].x;
    const prevDy = cells[i - 1].y - cells[i - 2].y;
    const dx = cells[i].x - cells[i - 1].x;
    const dy = cells[i].y - cells[i - 1].y;
    if (dx !== prevDx || dy !== prevDy) turns += 1;
  }
  return turns;
}

const OPEN_7X7 = makeTerrain([
  ".......",
  ".......",
  ".......",
  ".......",
  ".......",
  ".......",
  "......."
]);

describe("findRoadPath", () => {
  it("无障碍地形返回曼哈顿最优路径且只转一次弯", () => {
    const path = findRoadPath({ x: 1, y: 1 }, { x: 5, y: 4 }, OPEN_7X7);
    expect(path).not.toBeNull();
    // 曼哈顿距离 7 → 8 个格；成本 7 步 × 1.2 + 一次转弯罚 0.3。
    expect(path!.cells).toHaveLength(8);
    expect(path!.cells[0]).toEqual({ x: 1, y: 1 });
    expect(path!.cells[7]).toEqual({ x: 5, y: 4 });
    expect(countTurns(path!.cells)).toBe(1);
    expect(path!.cost).toBeCloseTo(7 * 1.2 + 0.3, 5);
  });

  it("同行直线路径零转弯", () => {
    const path = findRoadPath({ x: 1, y: 3 }, { x: 5, y: 3 }, OPEN_7X7);
    expect(path).not.toBeNull();
    expect(path!.cells.every((cell) => cell.y === 3)).toBe(true);
    expect(countTurns(path!.cells)).toBe(0);
    expect(path!.cost).toBeCloseTo(4 * 1.2, 5);
  });

  it("水域高代价被绕开", () => {
    const terrain = makeTerrain([
      ".......",
      ".......",
      "...W...",
      "...W...",
      "...W...",
      ".......",
      "......."
    ]);
    const path = findRoadPath({ x: 1, y: 3 }, { x: 5, y: 3 }, terrain);
    expect(path).not.toBeNull();
    for (const cell of path!.cells) {
      expect(terrain.baseTiles[tileIndex(terrain, cell.x, cell.y)]).not.toBe("water");
    }
  });

  it("被城外整列隔断时返回 null", () => {
    const terrain = makeTerrain(["...O...", "...O...", "...O..."]);
    expect(findRoadPath({ x: 1, y: 1 }, { x: 5, y: 1 }, terrain)).toBeNull();
  });

  it("可建区包围盒外的水带不作为绕行通道（河带风险）", () => {
    // 仅 x=0 与 x=6 两列可建；row0 是覆盖全宽的水带（模拟河带溢出椭圆）。
    // 水带位于可建包围盒（y ∈ [1,2]）之外，不得借道 → 应判不可达。
    const terrain = makeTerrain(["WWWWWWW", ".OOOOO.", ".OOOOO."]);
    expect(findRoadPath({ x: 0, y: 1 }, { x: 6, y: 1 }, terrain)).toBeNull();
  });

  it("可建区包围盒内的水域仍可高代价穿越", () => {
    const terrain = makeTerrain([".W.", ".W.", ".W."]);
    const path = findRoadPath({ x: 0, y: 1 }, { x: 2, y: 1 }, terrain);
    expect(path).not.toBeNull();
    expect(path!.cost).toBeCloseTo(20 + 1.2, 5);
  });
});

// ---------------------------------------------------------------------------
// minimumSpanningTreeEdges：手工小图。
// ---------------------------------------------------------------------------

describe("minimumSpanningTreeEdges", () => {
  it("4 节点用例返回 3 条正确边", () => {
    const edges = minimumSpanningTreeEdges(
      ["a", "b", "c", "d"],
      [
        { from: "a", to: "b", cost: 1 },
        { from: "b", to: "c", cost: 2 },
        { from: "a", to: "c", cost: 4 },
        { from: "c", to: "d", cost: 1 },
        { from: "b", to: "d", cost: 5 }
      ]
    );
    expect(edges).toEqual([
      { from: "a", to: "b", cost: 1 },
      { from: "b", to: "c", cost: 2 },
      { from: "c", to: "d", cost: 1 }
    ]);
  });

  it("等代价平局取候选列表靠前者（确定性）", () => {
    const edges = minimumSpanningTreeEdges(
      ["a", "b", "c"],
      [
        { from: "a", to: "b", cost: 1 },
        { from: "a", to: "c", cost: 1 },
        { from: "b", to: "c", cost: 1 }
      ]
    );
    expect(edges).toEqual([
      { from: "a", to: "b", cost: 1 },
      { from: "a", to: "c", cost: 1 }
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildRoadNetwork：接真实 terrain/anchors 管线。
// ---------------------------------------------------------------------------

function makePlan(terrain: TownSemanticPlan["terrain"]): TownSemanticPlan {
  return {
    planVersion: 1,
    theme: "测试镇",
    gridSize: { width: 32, height: 32 },
    terrain,
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

const EW_PLAN = makePlan({ river: "none", externalRoad: "east_west" });
const NS_PLAN = makePlan({ river: "north", externalRoad: "north_south" });

function networkFor(seed: string, plan: TownSemanticPlan): {
  terrain: TerrainLayout;
  result: RoadPipelineResult;
} {
  const terrain = generateTerrain(plan, createTownRng(`${seed}:terrain`));
  const anchors = placeAnchors(plan, terrain, createTownRng(`${seed}:anchors`));
  const result = buildRoadNetwork(anchors, terrain, createTownRng(`${seed}:roads`));
  return { terrain, result };
}

/** 沿 edges（无向）从 mainGate BFS，返回可达节点 id 集。 */
function reachableFromMainGate(result: RoadPipelineResult): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of result.roadGraph.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from]);
  }
  const visited = new Set<string>([result.mainGateNodeId]);
  const queue = [result.mainGateNodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

const ROAD_TILES: readonly TileType[] = ["road_main", "road_minor", "square"];

describe("buildRoadNetwork", () => {
  it("同 seed 深度相等", () => {
    expect(networkFor("seed-a", EW_PLAN).result).toEqual(networkFor("seed-a", EW_PLAN).result);
  });

  it("mainGateNodeId 指向主城门节点", () => {
    const { result } = networkFor("seed-gate", EW_PLAN);
    expect(result.mainGateNodeId).toBe("anchor_gate_main");
    const node = result.roadGraph.nodes.find((n) => n.id === result.mainGateNodeId);
    expect(node?.kind).toBe("gate");
  });

  it("多 seed 下从 mainGate 沿 edges 可达全部 nodes", () => {
    for (const seed of ["s1", "s2", "s3", "s4"]) {
      for (const plan of [EW_PLAN, NS_PLAN]) {
        const { result } = networkFor(seed, plan);
        const visited = reachableFromMainGate(result);
        expect(visited.size).toBe(result.roadGraph.nodes.length);
      }
    }
  });

  it("tiles 中存在 road_main 与 square", () => {
    const { result } = networkFor("seed-tiles", EW_PLAN);
    expect(result.tiles).toContain("road_main");
    expect(result.tiles).toContain("square");
  });

  it("多 seed 下道路/广场格全部在 buildableMask 内，且只在道路格上改写底图", () => {
    for (const seed of ["s1", "s2", "s3", "s4"]) {
      for (const plan of [EW_PLAN, NS_PLAN]) {
        const { terrain, result } = networkFor(seed, plan);
        expect(result.tiles).toHaveLength(terrain.width * terrain.height);
        for (let i = 0; i < result.tiles.length; i += 1) {
          if (result.tiles[i] !== terrain.baseTiles[i]) {
            expect(ROAD_TILES).toContain(result.tiles[i]);
            expect(terrain.buildableMask[i]).toBe(true);
          }
        }
      }
    }
  });

  it("边数介于 MST 下限与环路预算上限之间", () => {
    for (const seed of ["s1", "s2", "s3", "s4"]) {
      const { result } = networkFor(seed, EW_PLAN);
      const nodeCount = result.roadGraph.nodes.length;
      const mstCount = nodeCount - 1;
      expect(result.roadGraph.edges.length).toBeGreaterThanOrEqual(mstCount);
      expect(result.roadGraph.edges.length).toBeLessThanOrEqual(mstCount + Math.ceil(mstCount * 0.25));
    }
  });

  it("gate/square 直连边标 main，且沿 main 边从广场可达全部城门", () => {
    for (const seed of ["s1", "s2"]) {
      const { result } = networkFor(seed, EW_PLAN);
      const kindById = new Map(result.roadGraph.nodes.map((node) => [node.id, node.kind]));
      for (const edge of result.roadGraph.edges) {
        const ends = [kindById.get(edge.from), kindById.get(edge.to)];
        if (ends.every((kind) => kind === "gate" || kind === "square")) {
          expect(edge.roadType).toBe("main");
        }
      }
      // 主干贯通：仅沿 main 边 BFS，广场到每个城门必须连通。
      const square = result.roadGraph.nodes.find((node) => node.kind === "square")!;
      const adjacency = new Map<string, string[]>();
      for (const edge of result.roadGraph.edges) {
        if (edge.roadType !== "main") continue;
        adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
        adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from]);
      }
      const visited = new Set<string>([square.id]);
      const queue = [square.id];
      while (queue.length > 0) {
        for (const next of adjacency.get(queue.shift()!) ?? []) {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
      for (const node of result.roadGraph.nodes) {
        if (node.kind === "gate") expect(visited.has(node.id)).toBe(true);
      }
    }
  });
});
