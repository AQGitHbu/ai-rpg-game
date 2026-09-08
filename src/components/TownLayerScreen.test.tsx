import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentAssetBindingView, TownView } from "@/game/application";
import { TownLayerScreen } from "./TownLayerScreen";
import { buildTownView } from "@/game/application/townView";
import { createTownRuntime, bindNpcToTownSlot } from "@/game/gameplay/rpg/town";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/worldEntity";
import type { WorldState } from "@/game/domain/worldState";
import { createWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";

function townFixture(): TownView {
  const locationId = asLocationId("loc_0");
  const npcId = asNpcId("npc_1");
  const town = bindNpcToTownSlot(
    createTownRuntime({ locationId, seed: "town-layer-fixture" }),
    npcId,
  ).town;
  const ws: WorldState = createWorldStateFixture({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    projection: {
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      locations: [{
        id: locationId, name: "边陲小镇", description: "一座边陲小镇。", kind: "main",
        connectedLocationIds: [], npcIds: [npcId], availableItemIds: [], tags: [],
        scale: "town", town,
      }],
      currentLocationId: locationId,
      unlockedLocationIds: [locationId],
      visitedLocationIds: [locationId],
      npcs: [{
        id: npcId, name: "沈掌柜", role: "关键线人", description: "掌握消息。",
        locationId, isCompanion: false, tags: [], met: true,
        memory: { npcId, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
      }],
      items: [],
      inventory: [],
      worldFacts: [],
      quests: [],
      enemies: [],
      defeatedEnemyIds: [],
      factions: [],
    },
  });
  return buildTownView(ws, "loc_0")!;
}

function renderTown(overrides?: { busy?: boolean }): void {
  render(<TownLayerScreen
    town={townFixture()}
    gameType="wuxia"
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
    expect(screen.getByRole("group", { name: "小镇地图" })).toBeInTheDocument();
    expect(screen.getByText("可进入建筑" )).toBeInTheDocument();
  });

  it("renders the preset art for known buildings without exposing hidden story building types", () => {
    const { container } = render(<TownLayerScreen
      town={townFixture()}
      gameType="wuxia"
      busy={false}
      onEnterBuilding={vi.fn()}
      onReturnMap={vi.fn()}
    />);
    const interactive = townFixture().interactiveBuildings[0]!;
    const interactiveArt = container.querySelector(
      `image[href="/assets/town/${interactive.buildingType}.webp"]`,
    );
    expect(interactiveArt).toBeInTheDocument();
    expect(container.querySelector("[data-building-art]")).toHaveAttribute("aria-hidden", "true");
  });

  it("selecting a bound interactive building shows its entry action and calls onEnterBuilding with its NPC", async () => {
    const onEnterBuilding = vi.fn();
    const town = townFixture();
    const interactive = town.interactiveBuildings[0]!;
    const user = userEvent.setup();
    render(<TownLayerScreen
      town={town}
      gameType="wuxia"
      busy={false}
      onEnterBuilding={onEnterBuilding}
      onReturnMap={vi.fn()}
    />);
    await user.click(screen.getByRole("button", { name: interactive.displayName }));
    expect(screen.queryByText("当前剧情")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `进入${interactive.displayName}` }));
    expect(onEnterBuilding).toHaveBeenCalledWith(interactive.npcId);
  });

  it("only marks the actual focus NPC as current story", async () => {
    const town = townFixture();
    const focusNpcId = town.interactiveBuildings[0]!.npcId;
    const focusedTown = { ...town, interactiveBuildings: town.interactiveBuildings.map((entry) => ({
      ...entry,
      isCurrentFocus: entry.npcId === focusNpcId,
    })) };
    const user = userEvent.setup();
    render(<TownLayerScreen
      town={focusedTown}
      gameType="wuxia"
      busy={false}
      onEnterBuilding={vi.fn()}
      onReturnMap={vi.fn()}
    />);
    await user.click(screen.getByRole("button", { name: town.interactiveBuildings[0]!.displayName }));
    expect(screen.getByText("当前剧情")).toBeInTheDocument();
  });

  it("does not render a permanent temporary-meeting panel", () => {
    renderTown();
    expect(screen.queryByRole("group", { name: "镇口临时会面" })).not.toBeInTheDocument();
    expect(screen.queryByText(/不占用固定建筑/)).not.toBeInTheDocument();
  });

  it("does not expose unbound story buildings or generic buildings as fake controls", () => {
    const { container } = render(<TownLayerScreen
      town={townFixture()}
      gameType="wuxia"
      busy={false}
      onEnterBuilding={vi.fn()}
      onReturnMap={vi.fn()}
    />);
    const town = townFixture();
    const interactive = town.interactiveBuildings[0]!;
    expect(screen.queryByRole("button", { name: "未探索" })).not.toBeInTheDocument();
    expect(container.querySelectorAll(".town-demo-building--unexplored").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button").filter((button) =>
      button.getAttribute("aria-label") === interactive.displayName,
    )).toHaveLength(1);
  });

  it("does not use historic Chinese roofs in a science-fiction town", () => {
    const { container } = render(<TownLayerScreen town={townFixture()} gameType="science_fiction"
      busy={false} onEnterBuilding={vi.fn()} onReturnMap={vi.fn()} />);
    expect(container.querySelector("image")).toBeNull();
    expect(container.querySelector(".town-demo-tile")).toBeInTheDocument();
  });

  it("never renders a supplied image for an unexplored story building", () => {
    const town = townFixture();
    const visible = new Set(town.interactiveBuildings.map((entry) => entry.buildingId));
    const hidden = town.snapshot.buildings.find((entry) => entry.storyRequired && !visible.has(entry.buildingId))!;
    expect(hidden).toBeDefined();
    const secret: ContentAssetBindingView = {
      bindingKey: "opaque-hidden", requestKey: "r1", kind: "town_building", gameType: "wuxia",
      variant: hidden.buildingType, status: "ready",
      image: { assetId: "hidden-roof", version: "1", src: "/assets/generated/hidden-roof.webp", width: 512, height: 512, source: "generated" },
    };
    const { container } = render(<TownLayerScreen town={town} gameType="wuxia" busy={false}
      visualAssets={{ scopeKey: "scope-a", townBuildings: { [hidden.buildingId]: secret } }}
      onEnterBuilding={vi.fn()} onReturnMap={vi.fn()} />);
    expect(container.innerHTML).not.toContain(secret.image.src);
    expect(container.querySelectorAll("[data-building-art] image")).toHaveLength(
      town.snapshot.buildings.filter((entry) => !entry.storyRequired || visible.has(entry.buildingId)).length,
    );
    expect(container.querySelector(".town-demo-building--unexplored")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps keyboard entry usable after all roof images fail", async () => {
    const town = townFixture();
    const onEnterBuilding = vi.fn();
    const { container } = render(<TownLayerScreen town={town} gameType="wuxia" busy={false}
      onEnterBuilding={onEnterBuilding} onReturnMap={vi.fn()} />);
    for (const image of container.querySelectorAll("image")) fireEvent.error(image);
    expect(container.querySelector("image")).toBeNull();
    const entry = town.interactiveBuildings[0]!;
    fireEvent.keyDown(screen.getByRole("button", { name: entry.displayName }), { key: "Enter" });
    await userEvent.click(screen.getByRole("button", { name: `进入${entry.displayName}` }));
    expect(onEnterBuilding).toHaveBeenCalledWith(entry.npcId);
  });
});
