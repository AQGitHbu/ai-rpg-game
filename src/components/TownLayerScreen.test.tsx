import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TownView } from "@/game/application";
import { TownLayerScreen } from "./TownLayerScreen";
import { buildTownView } from "@/game/application/townView";
import { createTownRuntime, bindNpcToTownSlot } from "@/game/gameplay/rpg/town";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/worldEntity";
import { createInitialWorldState, type WorldState } from "@/game/domain/worldState";

function townFixture(): TownView {
  const town = bindNpcToTownSlot(
    createTownRuntime({ locationId: asLocationId("loc_0"), seed: "town-layer-fixture" }),
    asNpcId("npc_1"),
  ).town;
  const ws: WorldState = {
    ...createInitialWorldState({
      generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: {
        id: asLocationId("loc_0"), name: "边陲小镇", description: "一座边陲小镇。", kind: "main",
        connectedLocationIds: [], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
        scale: "town", town,
      },
      startingItemIds: [],
    }),
    npcs: [{
      id: asNpcId("npc_1"), name: "沈掌柜", role: "关键线人", description: "掌握消息。",
      locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    }],
  };
  return buildTownView(ws, "loc_0")!;
}

function renderTown(overrides?: { busy?: boolean }): void {
  render(<TownLayerScreen
    town={townFixture()}
    busy={overrides?.busy ?? false}
    onEnterBuilding={vi.fn()}
    onReturnMap={vi.fn()}
  />);
}

afterEach(cleanup);

describe("TownLayerScreen", () => {
  it("renders the town name, the map, and a return-to-map button", () => {
    renderTown();
    expect(screen.getByRole("region", { name: "小镇：边陲小镇" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回地图" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "小镇地图" })).toBeInTheDocument();
    expect(screen.getByText("当前剧情建筑" )).toBeInTheDocument();
  });

  it("selecting a bound interactive building shows its entry action and calls onEnterBuilding with its NPC", async () => {
    const onEnterBuilding = vi.fn();
    const town = townFixture();
    const interactive = town.interactiveBuildings[0]!;
    const user = userEvent.setup();
    render(<TownLayerScreen
      town={town}
      busy={false}
      onEnterBuilding={onEnterBuilding}
      onReturnMap={vi.fn()}
    />);
    await user.click(screen.getByRole("button", { name: interactive.displayName }));
    expect(screen.getByText("当前剧情")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `进入${interactive.displayName}` }));
    expect(onEnterBuilding).toHaveBeenCalledWith(interactive.npcId);
  });

  it("does not leak unbound story buildings as interactive entries", async () => {
    const user = userEvent.setup();
    renderTown();
    const town = townFixture();
    const interactive = town.interactiveBuildings[0]!;
    // 未绑定 NPC 的剧情建筑渲染为「未探索」占位（aria-disabled）
    const unexplored = screen.getAllByRole("button", { name: "未探索" });
    expect(unexplored.length).toBeGreaterThan(0);
    for (const entry of unexplored) {
      expect(entry).toHaveAttribute("aria-disabled", "true");
    }
    expect(interactive.buildingId).toBeDefined();
  });
});
