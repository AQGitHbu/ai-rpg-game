import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TownMapSvg } from "./TownMapSvg";
import type { TownSnapshot } from "@/game/application";

// ---------------------------------------------------------------------------
// Town demo Task 8：SVG 地图组件测试。
// 渲染由 snapshot 数据确定性驱动：底图每格一个 rect；每座建筑一个
// role="button" 的可点击矩形（aria-label=displayName）；点击建筑回调
// buildingId、点击空白处回调 null；storyRequired 建筑有高亮描边样式；
// 调试开关（地块边界/路网节点）默认关闭。
// ---------------------------------------------------------------------------

/** 手工构造的 10×10 小快照：2 座建筑（1 座剧情必需）、1 个地块、2 个路网节点。 */
function buildSnapshotFixture(): TownSnapshot {
  const width = 10;
  const height = 10;
  const tiles = Array.from({ length: width * height }, (_, index) => {
    const y = Math.floor(index / width);
    return y === 5 ? ("road_main" as const) : ("grass" as const);
  });
  return {
    snapshotVersion: 1,
    seed: "fixture-seed",
    generatorVersion: "town-gen-0.1.0",
    plan: {
      planVersion: 1,
      theme: "测试小镇",
      gridSize: { width, height },
      terrain: { river: "none", externalRoad: "east_west" },
      districts: [{ type: "market", preferredArea: "center", weight: 1 }],
      requiredBuildings: [],
      landmarks: []
    },
    grid: { width, height, tiles },
    roadGraph: {
      nodes: [
        { id: "n-gate", x: 0, y: 5, kind: "gate" },
        { id: "n-square", x: 5, y: 5, kind: "square" }
      ],
      edges: [
        {
          id: "e-1",
          from: "n-gate",
          to: "n-square",
          roadType: "main",
          cells: [{ x: 1, y: 5 }],
          cost: 5
        }
      ]
    },
    blocks: [],
    plots: [
      {
        id: "plot-1",
        blockId: "block-1",
        cells: [
          { x: 2, y: 2 },
          { x: 3, y: 2 }
        ],
        frontageCells: [{ x: 2, y: 4 }],
        district: "market",
        status: "occupied"
      }
    ],
    buildings: [
      {
        buildingId: "b-tavern",
        plotId: "plot-1",
        definitionState: "named",
        buildingType: "tavern",
        displayName: "金穗酒馆",
        district: "market",
        footprint: { x: 2, y: 2, width: 3, height: 2 },
        entrance: { x: 3, y: 4, direction: "south" },
        storyRequired: true
      },
      {
        buildingId: "b-house",
        plotId: "plot-1",
        definitionState: "generic",
        buildingType: "house",
        displayName: "河畔民居",
        district: "residential",
        footprint: { x: 6, y: 6, width: 2, height: 2 },
        entrance: { x: 6, y: 8, direction: "south" },
        storyRequired: false
      }
    ],
    mainGateNodeId: "n-gate",
    validation: { valid: true, repairCount: 0, retryCount: 0 }
  };
}

function renderMap(overrides?: {
  selectedBuildingId?: string | null;
  onSelectBuilding?: (buildingId: string | null) => void;
  showPlotBorders?: boolean;
  showRoadNodes?: boolean;
  showAiBuildingArt?: boolean;
}) {
  const onSelectBuilding = overrides?.onSelectBuilding ?? vi.fn();
  const utils = render(
    <TownMapSvg
      snapshot={buildSnapshotFixture()}
      selectedBuildingId={overrides?.selectedBuildingId ?? null}
      onSelectBuilding={onSelectBuilding}
      showPlotBorders={overrides?.showPlotBorders}
      showRoadNodes={overrides?.showRoadNodes}
      showAiBuildingArt={overrides?.showAiBuildingArt}
    />
  );
  return { ...utils, onSelectBuilding };
}

describe("TownMapSvg：底图与建筑渲染", () => {
  it("为每个格子渲染一个底图 rect（10×10 = 100 个）", () => {
    const { container } = renderMap();

    expect(container.querySelectorAll(".town-demo-tile")).toHaveLength(100);
  });

  it("为每座建筑渲染一个 role=button 的可点击矩形，aria-label 为 displayName", () => {
    renderMap();

    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "金穗酒馆" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "河畔民居" })).toBeInTheDocument();
  });

  it("storyRequired 建筑带高亮描边样式，普通建筑没有", () => {
    renderMap();

    expect(screen.getByRole("button", { name: "金穗酒馆" })).toHaveClass(
      "town-demo-building--story"
    );
    expect(screen.getByRole("button", { name: "河畔民居" })).not.toHaveClass(
      "town-demo-building--story"
    );
  });

  it("选中建筑带选中样式", () => {
    renderMap({ selectedBuildingId: "b-house" });

    expect(screen.getByRole("button", { name: "河畔民居" })).toHaveClass(
      "town-demo-building--selected"
    );
    expect(screen.getByRole("button", { name: "金穗酒馆" })).not.toHaveClass(
      "town-demo-building--selected"
    );
  });
});

describe("TownMapSvg：点击交互", () => {
  it("点击建筑触发 onSelectBuilding(buildingId)，且不重复触发空白回调", async () => {
    const user = userEvent.setup();
    const { onSelectBuilding } = renderMap();

    await user.click(screen.getByRole("button", { name: "金穗酒馆" }));

    expect(onSelectBuilding).toHaveBeenCalledTimes(1);
    expect(onSelectBuilding).toHaveBeenCalledWith("b-tavern");
  });

  it("点击地图空白处触发 onSelectBuilding(null)", async () => {
    const user = userEvent.setup();
    const { container, onSelectBuilding } = renderMap();

    const svg = container.querySelector("[data-town-map]");
    expect(svg).not.toBeNull();
    await user.click(svg as Element);

    expect(onSelectBuilding).toHaveBeenCalledTimes(1);
    expect(onSelectBuilding).toHaveBeenCalledWith(null);
  });

  it("键盘 Enter 也能选中建筑（role=button 可达性）", async () => {
    const user = userEvent.setup();
    const { onSelectBuilding } = renderMap();

    const building = screen.getByRole("button", { name: "河畔民居" });
    building.focus();
    await user.keyboard("{Enter}");

    expect(onSelectBuilding).toHaveBeenCalledWith("b-house");
  });
});

describe("TownMapSvg：调试开关", () => {
  it("默认不渲染地块边界与路网节点覆盖层", () => {
    const { container } = renderMap();

    expect(container.querySelector("[data-plot-borders]")).toBeNull();
    expect(container.querySelector("[data-road-nodes]")).toBeNull();
  });

  it("showPlotBorders 渲染每个地块格子的边界 rect", () => {
    const { container } = renderMap({ showPlotBorders: true });

    const layer = container.querySelector("[data-plot-borders]");
    expect(layer).not.toBeNull();
    expect(layer?.querySelectorAll("rect")).toHaveLength(2);
  });

  it("showRoadNodes 渲染每个路网节点的圆点", () => {
    const { container } = renderMap({ showRoadNodes: true });

    const layer = container.querySelector("[data-road-nodes]");
    expect(layer).not.toBeNull();
    expect(layer?.querySelectorAll("circle")).toHaveLength(2);
  });

  it("默认不渲染建筑贴图层", () => {
    const { container } = renderMap();

    expect(container.querySelector("[data-building-art]")).toBeNull();
  });

  it("showAiBuildingArt 按 buildingType 叠加 demo 预生成贴图到 footprint", () => {
    const { container } = renderMap({ showAiBuildingArt: true });

    const layer = container.querySelector("[data-building-art]");
    expect(layer).not.toBeNull();
    const images = layer?.querySelectorAll("image") ?? [];
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("href")).toBe("/assets/town-experiment/tavern.jpg");
    expect(images[1]?.getAttribute("href")).toBe("/assets/town-experiment/house.jpg");
  });
});
