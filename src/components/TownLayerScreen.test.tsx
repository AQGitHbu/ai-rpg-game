import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TownLayerScreen } from "./TownLayerScreen";
import type { TownLayerView } from "@/game/application";

// ---------------------------------------------------------------------------
// TownLayerScreen（Town 第三层入口）：
// - 渲染小镇名、方位语义句子与逻辑地图；
// - 点击剧情建筑 → 选中并展示「进入」按钮 → 触发 onEnterBuilding(npcId)；
// - 「返回地图」触发 onReturnMap。
// 纯 UI 导航：不发起任何请求、不改 GameState。
// ---------------------------------------------------------------------------

function buildTownView(): TownLayerView {
  const width = 10;
  const height = 10;
  const tiles = Array.from({ length: width * height }, (_, index) =>
    Math.floor(index / width) === 5 ? ("road_main" as const) : ("grass" as const)
  );
  return {
    locationId: "loc_town",
    townName: "大石镇",
    planSource: "generated",
    snapshot: {
      snapshotVersion: 1,
      generatorVersion: "town-gen-0.1.0",
      plan: {
        planVersion: 1,
        theme: "大石镇",
        gridSize: { width, height },
        terrain: { river: "none", externalRoad: "east_west" },
        districts: [{ type: "market", preferredArea: "center", weight: 1 }],
        requiredBuildings: [],
        landmarks: []
      },
      grid: { width, height, tiles },
      roadGraph: {
        nodes: [{ id: "n-gate", x: 0, y: 5, kind: "gate" }],
        edges: []
      },
      blocks: [],
      plots: [],
      buildings: [
        {
          buildingId: "b-smith",
          plotId: "plot-1",
          definitionState: "named",
          buildingType: "blacksmith",
          displayName: "铁匠铺",
          district: "market",
          footprint: { x: 2, y: 2, width: 2, height: 2 },
          entrance: { x: 2, y: 4, direction: "south" },
          storyRequired: true,
          planKey: "story_npc_npc_smith"
        }
      ],
      mainGateNodeId: "n-gate",
      validation: { valid: true, repairCount: 0, retryCount: 0 }
    },
    stats: { buildingCount: 1, storyBuildingCount: 1, plotCount: 0 },
    interactiveBuildings: [
      {
        buildingId: "b-smith",
        buildingKey: "story_npc_npc_smith",
        displayName: "铁匠铺",
        buildingType: "blacksmith",
        npcIds: ["npc_smith"]
      }
    ],
    semanticView: {
      townName: "大石镇",
      gateArea: "west",
      buildings: [],
      sentences: ["铁匠铺位于大石镇北侧。"]
    }
  };
}

describe("TownLayerScreen", () => {
  it("渲染小镇名与方位语义句子", () => {
    render(
      <TownLayerScreen town={buildTownView()} busy={false} onEnterBuilding={vi.fn()} onReturnMap={vi.fn()} />
    );

    expect(screen.getByRole("heading", { name: "大石镇" })).toBeInTheDocument();
    expect(screen.getByText("铁匠铺位于大石镇北侧。")).toBeInTheDocument();
  });

  it("点击剧情建筑后可进入，回调绑定 NPC id", async () => {
    const onEnterBuilding = vi.fn();
    const user = userEvent.setup();
    render(
      <TownLayerScreen town={buildTownView()} busy={false} onEnterBuilding={onEnterBuilding} onReturnMap={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "铁匠铺" }));
    await user.click(screen.getByRole("button", { name: "进入铁匠铺" }));

    expect(onEnterBuilding).toHaveBeenCalledWith("npc_smith");
  });

  it("返回地图触发 onReturnMap", async () => {
    const onReturnMap = vi.fn();
    const user = userEvent.setup();
    render(
      <TownLayerScreen town={buildTownView()} busy={false} onEnterBuilding={vi.fn()} onReturnMap={onReturnMap} />
    );

    await user.click(screen.getByRole("button", { name: "返回地图" }));
    expect(onReturnMap).toHaveBeenCalledTimes(1);
  });
});
