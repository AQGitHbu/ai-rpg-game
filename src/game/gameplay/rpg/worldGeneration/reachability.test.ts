import { describe, it, expect } from "vitest";
import { analyzeLocationReachability } from "./reachability";
import type { LocationDefinitionCandidate } from "@/game/domain/worldEntity";

function loc(id: string, connected: readonly string[]): LocationDefinitionCandidate {
  return {
    id, name: id, description: "d", kind: "main",
    connectedLocationIds: connected, npcIds: [], availableItemIds: [], tags: [],
  };
}

describe("analyzeLocationReachability", () => {
  it("连通的开放地图：所有地点可达", () => {
    const locations = [
      loc("loc_a", ["loc_b"]),
      loc("loc_b", ["loc_a", "loc_c"]),
      loc("loc_c", ["loc_b"]),
    ];
    const result = analyzeLocationReachability({ locations, startingLocationId: "loc_a" });
    expect([...result.reachableLocationIds].sort()).toEqual(["loc_a", "loc_b", "loc_c"]);
    expect(result.unreachableLocationIds).toEqual([]);
  });

  it("孤立地点不可达", () => {
    const locations = [
      loc("loc_a", ["loc_b"]),
      loc("loc_b", ["loc_a"]),
      loc("loc_orphan", []),
    ];
    const result = analyzeLocationReachability({ locations, startingLocationId: "loc_a" });
    expect(result.unreachableLocationIds).toEqual(["loc_orphan"]);
  });

  it("只经孤立分支连接的地点不可达", () => {
    const locations = [
      loc("loc_a", []),
      loc("loc_b", ["loc_b"]), // 自环：仍不可达
    ];
    const result = analyzeLocationReachability({ locations, startingLocationId: "loc_a" });
    expect(result.unreachableLocationIds).toContain("loc_b");
  });

  it("起始地点不存在：全部列为不可达（由 validator 另报 starting_location_missing）", () => {
    const locations = [loc("loc_a", [])];
    const result = analyzeLocationReachability({ locations, startingLocationId: "loc_missing" });
    expect(result.unreachableLocationIds).toEqual(["loc_a"]);
    expect(result.reachableLocationIds).toEqual([]);
  });
});
