import { describe, expect, it } from "vitest";
import type { TileType, TownBuilding, TownPlot } from "@/game/domain";
import { validateTownDraft, type TownDraft } from "./validateTown";

// ---------------------------------------------------------------------------
// 手工 12×12 双横路网格：便于逐条注入缺陷验证 issue 码。
// 图例：M=road_main、.=grass；建筑由用例叠加到 tiles（groundTiles 不含建筑）。
// ---------------------------------------------------------------------------

const ROWS = [
  "............",
  "............",
  "............",
  "............",
  "............",
  "MMMMMMMMMMMM",
  "MMMMMMMMMMMM",
  "............",
  "............",
  "............",
  "............",
  "............"
] as const;

const WIDTH = 12;
const HEIGHT = 12;

function makeGroundTiles(): TileType[] {
  const tiles: TileType[] = [];
  for (const row of ROWS) {
    for (const ch of row) tiles.push(ch === "M" ? "road_main" : "grass");
  }
  return tiles;
}

/** footprint 全格写 building、入口格写 building_entrance（模拟最终 tiles）。 */
function stampBuilding(tiles: TileType[], building: TownBuilding): void {
  const { footprint, entrance } = building;
  for (let y = footprint.y; y < footprint.y + footprint.height; y += 1) {
    for (let x = footprint.x; x < footprint.x + footprint.width; x += 1) {
      tiles[y * WIDTH + x] = "building";
    }
  }
  tiles[entrance.y * WIDTH + entrance.x] = "building_entrance";
}

function makeBuilding(overrides: Partial<TownBuilding>): TownBuilding {
  return {
    buildingId: "building_1",
    plotId: "block_1_plot_1",
    definitionState: "generic",
    buildingType: "house",
    displayName: "一户普通民居·1",
    district: "residential",
    footprint: { x: 2, y: 2, width: 3, height: 3 },
    // 门前格 (3,5) 是 road_main → 默认建筑完全合法。
    entrance: { x: 3, y: 4, direction: "south" },
    storyRequired: false,
    ...overrides
  };
}

function makePlot(overrides: Partial<TownPlot>): TownPlot {
  return {
    id: "block_1_plot_1",
    blockId: "block_1",
    cells: [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
      { x: 2, y: 3 },
      { x: 3, y: 3 },
      { x: 4, y: 3 },
      { x: 2, y: 4 },
      { x: 3, y: 4 },
      { x: 4, y: 4 }
    ],
    frontageCells: [
      { x: 2, y: 4 },
      { x: 3, y: 4 }
    ],
    district: "residential",
    status: "occupied",
    ...overrides
  };
}

/** 合法基线 draft：单建筑门朝南开向主路，双 gate 有边相连。 */
function makeDraft(overrides: Partial<TownDraft>): TownDraft {
  const groundTiles = makeGroundTiles();
  const tiles = [...groundTiles];
  const building = makeBuilding({});
  stampBuilding(tiles, building);
  return {
    width: WIDTH,
    height: HEIGHT,
    groundTiles,
    tiles,
    roadGraph: {
      nodes: [
        { id: "gate_main", x: 0, y: 5, kind: "gate" },
        { id: "gate_secondary", x: 11, y: 6, kind: "gate" }
      ],
      edges: [
        {
          id: "road_edge_1",
          from: "gate_main",
          to: "gate_secondary",
          roadType: "main",
          cells: [],
          cost: 1
        }
      ]
    },
    plots: [makePlot({})],
    buildings: [building],
    mainGateNodeId: "gate_main",
    ...overrides
  };
}

/** 缺陷建筑注入辅助：以基线 ground 重新 stamping 全部建筑。 */
function draftWithBuildings(buildings: readonly TownBuilding[]): TownDraft {
  const groundTiles = makeGroundTiles();
  const tiles = [...groundTiles];
  for (const building of buildings) stampBuilding(tiles, building);
  return makeDraft({ groundTiles, tiles, buildings });
}

describe("validateTownDraft", () => {
  it("合法 draft 返回空 issue 列表", () => {
    expect(validateTownDraft(makeDraft({}))).toEqual([]);
  });

  it("入口缺失（entrance 不在 footprint 边界）→ ENTRANCE_MISSING", () => {
    const building = makeBuilding({
      footprint: { x: 1, y: 1, width: 4, height: 4 },
      entrance: { x: 2, y: 2, direction: "south" } // 内部格，不是边界
    });
    const issues = validateTownDraft(draftWithBuildings([building]));
    expect(issues).toContainEqual({ code: "ENTRANCE_MISSING", buildingId: "building_1" });
  });

  it("门前格非道路 → ENTRANCE_UNREACHABLE", () => {
    // 门朝北：门前格 (3,1) 是 grass，非道路。
    const building = makeBuilding({ entrance: { x: 3, y: 2, direction: "north" } });
    const issues = validateTownDraft(draftWithBuildings([building]));
    expect(issues).toContainEqual({ code: "ENTRANCE_UNREACHABLE", buildingId: "building_1" });
  });

  it("门前格是道路但与主城门道路不连通 → ENTRANCE_UNREACHABLE", () => {
    // 孤立巷道格 (3,1)：门前是 alley，但与 y=5 主路不相连。
    const groundTiles = makeGroundTiles();
    groundTiles[1 * WIDTH + 3] = "alley";
    const tiles = [...groundTiles];
    const building = makeBuilding({ entrance: { x: 3, y: 2, direction: "north" } });
    stampBuilding(tiles, building);
    const issues = validateTownDraft(makeDraft({ groundTiles, tiles, buildings: [building] }));
    expect(issues).toContainEqual({ code: "ENTRANCE_UNREACHABLE", buildingId: "building_1" });
  });

  it("建筑压路（groundTiles 为 road_main）→ BUILDING_ON_FORBIDDEN_TILE", () => {
    // footprint y ∈ [4,6] 跨过 y=5 的主路。
    const building = makeBuilding({
      footprint: { x: 2, y: 4, width: 3, height: 3 },
      entrance: { x: 2, y: 4, direction: "west" }
    });
    const issues = validateTownDraft(draftWithBuildings([building]));
    expect(issues).toContainEqual({ code: "BUILDING_ON_FORBIDDEN_TILE", buildingId: "building_1" });
  });

  it("建筑压水域 → BUILDING_ON_FORBIDDEN_TILE", () => {
    const groundTiles = makeGroundTiles();
    for (let x = 0; x < WIDTH; x += 1) groundTiles[2 * WIDTH + x] = "water"; // y=2 一行水
    const tiles = [...groundTiles];
    const building = makeBuilding({});
    stampBuilding(tiles, building);
    const issues = validateTownDraft(makeDraft({ groundTiles, tiles, buildings: [building] }));
    expect(issues).toContainEqual({ code: "BUILDING_ON_FORBIDDEN_TILE", buildingId: "building_1" });
  });

  it("两建筑 footprint 相交 → BUILDING_OVERLAP（报后者）", () => {
    const first = makeBuilding({});
    const second = makeBuilding({
      buildingId: "building_2",
      plotId: "block_1_plot_2",
      footprint: { x: 3, y: 2, width: 3, height: 3 }, // 与 first (2..4,2..4) 相交
      entrance: { x: 4, y: 4, direction: "south" }
    });
    const issues = validateTownDraft(draftWithBuildings([first, second]));
    expect(issues).toContainEqual({ code: "BUILDING_OVERLAP", buildingId: "building_2" });
    expect(issues).not.toContainEqual({ code: "BUILDING_OVERLAP", buildingId: "building_1" });
  });

  it("道路图节点从主城门不可达 → ANCHOR_UNREACHABLE（主城门自身不报）", () => {
    const issues = validateTownDraft(
      makeDraft({
        roadGraph: {
          nodes: [
            { id: "gate_main", x: 0, y: 5, kind: "gate" },
            { id: "gate_secondary", x: 11, y: 6, kind: "gate" }
          ],
          edges: []
        }
      })
    );
    expect(issues).toContainEqual({ code: "ANCHOR_UNREACHABLE", nodeId: "gate_secondary" });
    expect(issues).not.toContainEqual({ code: "ANCHOR_UNREACHABLE", nodeId: "gate_main" });
  });

  it("非 reserved 地块临街 < 2 → PLOT_FRONTAGE_TOO_SMALL；reserved 豁免", () => {
    const narrow = makePlot({ id: "block_1_plot_9", frontageCells: [{ x: 2, y: 4 }], status: "generic" });
    const reserved = makePlot({ id: "block_1_plot_10", frontageCells: [], status: "reserved" });
    const draft = makeDraft({});
    const issues = validateTownDraft({ ...draft, plots: [...draft.plots, narrow, reserved] });
    expect(issues).toContainEqual({ code: "PLOT_FRONTAGE_TOO_SMALL", plotId: "block_1_plot_9" });
    expect(issues).not.toContainEqual({ code: "PLOT_FRONTAGE_TOO_SMALL", plotId: "block_1_plot_10" });
  });

  it("collect-all：多缺陷 draft 一次返回全部 issue", () => {
    const onRoad = makeBuilding({
      buildingId: "building_2",
      plotId: "block_1_plot_2",
      footprint: { x: 6, y: 4, width: 2, height: 3 }, // 压 y=5/6 主路
      entrance: { x: 6, y: 4, direction: "west" }
    });
    const noRoadDoor = makeBuilding({
      buildingId: "building_3",
      plotId: "block_1_plot_3",
      footprint: { x: 8, y: 1, width: 2, height: 2 },
      entrance: { x: 8, y: 1, direction: "north" } // 门前 (8,0) 是 grass
    });
    const issues = validateTownDraft(draftWithBuildings([makeBuilding({}), onRoad, noRoadDoor]));
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain("BUILDING_ON_FORBIDDEN_TILE");
    expect(codes).toContain("ENTRANCE_UNREACHABLE");
  });
});
