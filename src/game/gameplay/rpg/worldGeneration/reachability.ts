import type { LocationDefinitionCandidate } from "@/game/domain/scenarioBlueprint";

// ---------------------------------------------------------------------------
// Task 13：世界地点连通性与解锁路径分析（纯图算法，零 IO）。
//
// candidate 生成的世界应是一个无向连通的开放地点图：玩家可从起始地点步行到达
// 所有 main 地点。若某 main 地点不可达（孤立或只经隐藏地点），则玩家永远无法
// 抵达该地点的任务/敌人/物品，属于结构性缺陷。
//
// hidden 地点默认不参与开放连通（需通过剧情解锁路径）；本分析把 hidden 地点
// 视为解锁候选，返回不可达的 main 地点。
// ---------------------------------------------------------------------------

export type LocationReachabilityAnalysis = {
  readonly reachableLocationIds: readonly string[];
  readonly unreachableLocationIds: readonly string[];
};

/** 无向连通 BFS：从 startingLocationId 出发，沿 connectedLocationIds 遍历。 */
export function analyzeLocationReachability(input: {
  readonly locations: readonly LocationDefinitionCandidate[];
  readonly startingLocationId: string;
}): LocationReachabilityAnalysis {
  const { locations, startingLocationId } = input;
  const byId = new Map(locations.map((l) => [l.id, l]));
  const start = byId.get(startingLocationId);
  if (start === undefined) {
    // 起始地点不存在：由 validator 单独报 starting_location_missing。
    return { reachableLocationIds: [], unreachableLocationIds: locations.map((l) => l.id) };
  }

  const visited = new Set<string>([startingLocationId]);
  const queue: string[] = [startingLocationId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const loc = byId.get(current);
    if (loc === undefined) continue;
    for (const next of loc.connectedLocationIds) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  const reachable = locations.filter((l) => visited.has(l.id)).map((l) => l.id);
  const unreachable = locations.filter((l) => !visited.has(l.id)).map((l) => l.id);
  return { reachableLocationIds: reachable, unreachableLocationIds: unreachable };
}
