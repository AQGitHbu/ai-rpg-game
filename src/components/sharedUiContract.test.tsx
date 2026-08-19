import { render, screen } from "@testing-library/react";
import { InlineButton, Panel, Tag } from "@ai-game/ui";
import { describe, expect, it, vi } from "vitest";
import type { GameSessionView } from "@/game/application";
import { LocationSceneScreen } from "./LocationSceneScreen";

describe("@ai-game/ui RPG consumer contract", () => {
  it("imports all v0.1 primitives from the package root", () => {
    render(
      <Panel title="生成状态">
        <Tag variant="info">等待生成</Tag>
        <InlineButton type="submit">继续</InlineButton>
      </Panel>,
    );

    expect(screen.getByText("生成状态").closest("section")).toHaveClass("panel");
    expect(screen.getByText("等待生成")).toHaveClass("tag--info");
    expect(screen.getByRole("button", { name: "继续" })).toHaveAttribute("type", "submit");
  });
});

/** 建筑场景契约 fixture：town scale + 绑定 NPC 的剧情建筑（LocationSceneScreen 只读 interactiveBuildings）。 */
function buildBuildingView(overrides: {
  eventKind?: string;
  narration?: string;
} = {}): GameSessionView {
  return {
    revision: 9,
    turnNumber: 8,
    gameType: "wuxia",
    setup: { storyOpening: null, worldPremise: null, characterProfile: null, narrativeStyle: null },
    player: { name: "侠客", identity: "剑客", hp: 90, attack: 10, defense: 5 },
    worldMap: {
      locations: [
        { name: "青石镇", current: true, visited: true, scale: "town", travelChoice: null },
      ],
    },
    currentLocation: {
      name: "青石镇",
      description: "灯笼沿街亮起的青石小镇。",
      scale: "town",
      actions: [],
      npcs: [{ npcId: "npc_1", name: "老板", role: "掌柜", talkChoice: null }],
      town: {
        townName: "青石镇",
        snapshot: { grid: { width: 4, height: 4, tiles: [] }, buildings: [], roadGraph: { nodes: [], edges: [] }, plots: [] },
        interactiveBuildings: [{
          buildingId: "building_1",
          displayName: "福来酒楼",
          buildingType: "tavern",
          npcId: "npc_1",
          npcName: "老板",
          isCurrentFocus: true,
        }],
      },
    },
    obtainableItems: [],
    inventory: [],
    story: { currentAct: 1, targetActs: 3, tension: 30, pacingNeed: "reveal", storyProgress: 5, currentObjectiveLabel: null, currentObjectiveChoiceToken: null },
    narrative: {
      mode: "offline",
      hasScene: true,
      ...(overrides.eventKind === undefined ? {} : { eventKind: overrides.eventKind }),
      ...(overrides.narration === undefined ? {} : { narration: overrides.narration }),
      choices: [],
      npcLine: null,
      npcDialogues: [],
    },
    narrativeGeneration: { status: "idle" },
    battle: null,
    quests: [{ name: "查明真相", description: "追寻线索", kind: "main", status: "active", objectives: [{ label: "发现秘密", completed: false }] }],
    prologueShown: true,
    prologueText: "",
    ending: null,
  };
}

function renderBuildingScene(view: GameSessionView): void {
  render(<LocationSceneScreen
    view={view}
    busy={false}
    onSubmit={vi.fn()}
    onReturnMap={vi.fn()}
    initialFocusNpcId="npc_1"
    sceneNpcName="老板"
    sceneLocationName="福来酒楼"
    sceneBuildingId="building_1"
  />);
}

describe("LocationSceneScreen building scene side note", () => {
  it("shows investigation narration over static building description inside a building scene", () => {
    renderBuildingScene(buildBuildingView({
      eventKind: "investigate",
      narration: "你翻开账册封底，夹层里露出半截烧焦的信纸，落款正是失踪商队掌事的印鉴。",
    }));

    const sideNote = screen.getByRole("region", { name: "地点旁注" });
    expect(sideNote).toHaveTextContent("你翻开账册封底");
    expect(sideNote).not.toHaveTextContent("留意着你的来意");
  });

  it("keeps static building description when entering the building without a fresh action narrative", () => {
    renderBuildingScene(buildBuildingView({
      eventKind: "observe",
      narration: "前厅的灯笼刚刚点亮。",
    }));

    const sideNote = screen.getByRole("region", { name: "地点旁注" });
    expect(sideNote).toHaveTextContent("福来酒楼里酒气、炭火和低声交谈混在一起");
    expect(sideNote).not.toHaveTextContent("前厅的灯笼刚刚点亮");
  });
});
