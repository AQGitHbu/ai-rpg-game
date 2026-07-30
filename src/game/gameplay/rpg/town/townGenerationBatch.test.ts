import { describe, expect, it } from "vitest";
import { tileIndex, type TileType, type TownSnapshot } from "@/game/domain";
import { generateTown } from "./generateTown";

// 1000 seed 批量回归（Spec §8）：全部成功且逐镇满足 §6 不变量，总耗时 < 60s。
// 断言失败时先修生成器，不放宽断言（brief Step 6）。

const SEED_COUNT = 1000;

/** 性能护栏（宽松）：1000 镇总耗时上限（毫秒）。 */
const TIME_BUDGET_MS = 60_000;

const ROAD_TILES: ReadonlySet<TileType> = new Set<TileType>(["road_main", "road_minor", "alley", "square"]);

const FORBIDDEN_UNDER_BUILDING: ReadonlySet<TileType> = new Set<TileType>([
  "road_main",
  "road_minor",
  "alley",
  "square",
  "water",
  "outside"
]);

const SIDE_OFFSETS = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  west: { dx: -1, dy: 0 },
  east: { dx: 1, dy: 0 }
} as const;

/** 主城门所在格出发、沿 4 邻接道路瓦片 BFS 的可达格集合。 */
function roadReachableSet(snapshot: TownSnapshot): Set<number> {
  const { width, height, tiles } = snapshot.grid;
  const gate = snapshot.roadGraph.nodes.find((node) => node.id === snapshot.mainGateNodeId)!;
  const start = tileIndex(snapshot.grid, gate.x, gate.y);
  const reachable = new Set<number>();
  if (!ROAD_TILES.has(tiles[start])) return reachable;
  reachable.add(start);
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const x = queue[head] % width;
    const y = Math.floor(queue[head] / width);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = tileIndex(snapshot.grid, nx, ny);
      if (reachable.has(next) || !ROAD_TILES.has(tiles[next])) continue;
      reachable.add(next);
      queue.push(next);
    }
  }
  return reachable;
}

/** 逐镇断言：违规时抛带 seed 前缀的错误，便于定位失败种子。 */
function assertTown(seed: string, snapshot: TownSnapshot): void {
  const fail = (message: string): never => {
    throw new Error(`[${seed}] ${message}`);
  };

  // 1. 剧情建筑 3 栋全存在。
  const storyTypes = snapshot.buildings
    .filter((building) => building.storyRequired)
    .map((building) => building.buildingType)
    .sort();
  if (storyTypes.join(",") !== "blacksmith,house,tavern") fail(`剧情建筑缺失: [${storyTypes.join(",")}]`);

  // 2. 从 mainGate BFS 所有 roadGraph 节点可达（图层）。
  const adjacency = new Map<string, string[]>();
  for (const edge of snapshot.roadGraph.edges) {
    (adjacency.get(edge.from) ?? adjacency.set(edge.from, []).get(edge.from)!).push(edge.to);
    (adjacency.get(edge.to) ?? adjacency.set(edge.to, []).get(edge.to)!).push(edge.from);
  }
  const reachedNodes = new Set([snapshot.mainGateNodeId]);
  const nodeQueue = [snapshot.mainGateNodeId];
  for (let head = 0; head < nodeQueue.length; head += 1) {
    for (const next of adjacency.get(nodeQueue[head]) ?? []) {
      if (!reachedNodes.has(next)) {
        reachedNodes.add(next);
        nodeQueue.push(next);
      }
    }
  }
  for (const node of snapshot.roadGraph.nodes) {
    if (!reachedNodes.has(node.id)) fail(`道路图节点不可达: ${node.id}`);
  }

  // 3. 每栋建筑门前格可寻路至 mainGate（道路瓦片层 BFS）。
  const reachableCells = roadReachableSet(snapshot);
  for (const building of snapshot.buildings) {
    const offset = SIDE_OFFSETS[building.entrance.direction];
    const x = building.entrance.x + offset.dx;
    const y = building.entrance.y + offset.dy;
    if (!reachableCells.has(tileIndex(snapshot.grid, x, y))) {
      fail(`建筑门前格不可达: ${building.buildingId} (${x},${y})`);
    }
  }

  // 4. footprint 两两不重叠；5. 建筑不覆盖 road/water/outside。
  //    最终 tiles 的 footprint 格必为 building/building_entrance：
  //    被道路/水覆写或互相覆写都会破坏该不变量。
  const seen = new Set<number>();
  for (const building of snapshot.buildings) {
    const { footprint } = building;
    for (let y = footprint.y; y < footprint.y + footprint.height; y += 1) {
      for (let x = footprint.x; x < footprint.x + footprint.width; x += 1) {
        const index = tileIndex(snapshot.grid, x, y);
        if (seen.has(index)) fail(`footprint 重叠: ${building.buildingId} (${x},${y})`);
        seen.add(index);
        const tile = snapshot.grid.tiles[index];
        if (FORBIDDEN_UNDER_BUILDING.has(tile) || tile === "plot") {
          fail(`建筑覆盖非法瓦片: ${building.buildingId} (${x},${y})=${tile}`);
        }
      }
    }
  }

  // 6. reserved 地块占比 ∈ [0.1, 0.35]（Task 5 预留率 0.2 的安全网）。
  const reservedRatio =
    snapshot.plots.filter((plot) => plot.status === "reserved").length / snapshot.plots.length;
  if (reservedRatio < 0.1 || reservedRatio > 0.35) fail(`reserved 占比越界: ${reservedRatio.toFixed(3)}`);
}

describe("generateTown 1000 seed 批量回归", () => {
  it(
    "batch-0..999 全部成功且满足全部不变量，总耗时 < 60s",
    () => {
      const startedAt = performance.now();
      for (let i = 0; i < SEED_COUNT; i += 1) {
        const seed = `batch-${i}`;
        const snapshot = generateTown({ seed }); // 抛错即测试失败
        assertTown(seed, snapshot);
        // 修复/重试计数落在 Spec §5 上限内（与 MAX_REPAIR_PASSES/MAX_RETRIES 对齐）。
        expect(snapshot.validation.repairCount, seed).toBeLessThanOrEqual(20);
        expect(snapshot.validation.retryCount, seed).toBeLessThanOrEqual(3);
      }
      const elapsed = performance.now() - startedAt;
      // 预算护栏（宽松）：CI/慢机也应达标；均值目标 < 50ms（Spec §8）。
      expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
    },
    TIME_BUDGET_MS + 30_000
  );
});
