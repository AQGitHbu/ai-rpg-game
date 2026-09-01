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
  story?: Partial<GameSessionView["story"]>;
  narrativeChoices?: GameSessionView["narrative"]["choices"];
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
    story: {
      currentAct: 1, targetActs: 3, tension: 30, pacingNeed: "reveal", storyProgress: 5,
      currentObjectiveLabel: null, currentObjectiveChoiceToken: null,
      ...overrides.story,
      currentObjectiveChoiceTokens: [],
    },
    narrative: {
      mode: "offline",
      hasScene: true,
      ...(overrides.eventKind === undefined ? {} : { eventKind: overrides.eventKind }),
      ...(overrides.narration === undefined ? {} : { narration: overrides.narration }),
      choices: overrides.narrativeChoices ?? [],
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

function renderBuildingScene(view: GameSessionView, sceneLocationName = "福来酒楼"): void {
  render(<LocationSceneScreen
    view={view}
    busy={false}
    onSubmit={vi.fn()}
    onReturnMap={vi.fn()}
    initialFocusNpcId="npc_1"
    sceneNpcName="老板"
    sceneLocationName={sceneLocationName}
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

  it("shows the approved scene narration instead of inventing a static building description", () => {
    renderBuildingScene(buildBuildingView({
      eventKind: "observe",
      narration: "前厅的灯笼刚刚点亮。",
    }));

    const sideNote = screen.getByRole("region", { name: "地点旁注" });
    expect(sideNote).toHaveTextContent("前厅的灯笼刚刚点亮");
    expect(sideNote).not.toHaveTextContent("福来酒楼里酒气、炭火和低声交谈混在一起");
  });

  it("keeps an AI-generated scene narration when the building display name changes", () => {
    const view = buildBuildingView({ eventKind: "observe", narration: "前厅的灯笼刚刚点亮。" });
    const building = view.currentLocation.town?.interactiveBuildings[0];
    if (building === undefined) throw new Error("missing building fixture");
    const noticeBoardView: GameSessionView = {
      ...view,
      currentLocation: {
        ...view.currentLocation,
        town: {
          ...view.currentLocation.town!,
          interactiveBuildings: [{ ...building, displayName: "镇口告示栏" }],
        },
      },
    };

    renderBuildingScene(noticeBoardView, "镇口告示栏");

    const sideNote = screen.getByRole("region", { name: "地点旁注" });
    expect(sideNote).toHaveTextContent("前厅的灯笼刚刚点亮");
    expect(sideNote).not.toHaveTextContent("酒气、炭火");
  });
});

describe("LocationSceneScreen objective handoff inside a building scene", () => {
  /** 对话回合写回后的交接场景：目标切换为 visit_location，场景携带 AI 预生成的 move 交接选项。 */
  const handoffNarration = "老板压低声音道：‘脚印往北巷旧道去了，那地方原是旧镖局的仓。’";
  const handoffChoices: GameSessionView["narrative"]["choices"] = [
    { choiceToken: "c_talk_stale", label: "老板，那脚印的事你还知道多少？", presentation: "dialogue" },
    { choiceToken: "c_move_objective", label: "（放下茶钱，起身）北巷旧道是吧，我这就去瞧瞧。", presentation: "travel" },
  ];
  const handoffStory: Partial<GameSessionView["story"]> = {
    currentObjectiveLabel: "前往北巷旧道",
    currentObjectiveChoiceToken: "c_move_objective",
  };

  it("does not repeat the authoritative move choice in the action rail after dialogue handoff", () => {
    renderBuildingScene(buildBuildingView({
      eventKind: "observe",
      narration: handoffNarration,
      story: handoffStory,
      narrativeChoices: handoffChoices,
    }));

    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
    // 旧焦点的过期对白选项和移动入口都不再进入行动栏，避免重复主线入口。
    expect(screen.queryByText("那脚印的事你还知道多少")).not.toBeInTheDocument();
  });

  it("shows the handoff narration with NPC guidance over the static building description", () => {
    renderBuildingScene(buildBuildingView({
      eventKind: "observe",
      narration: handoffNarration,
      story: handoffStory,
      narrativeChoices: handoffChoices,
    }));

    const sideNote = screen.getByRole("region", { name: "地点旁注" });
    expect(sideNote).toHaveTextContent("脚印往北巷旧道去了");
    expect(sideNote).not.toHaveTextContent("福来酒楼里酒气、炭火和低声交谈混在一起");
  });

  it("falls back to a routing hint when the objective has no executable action in the current scene", () => {
    renderBuildingScene(buildBuildingView({
      eventKind: "observe",
      narration: handoffNarration,
      story: { currentObjectiveLabel: "与顾砚交谈", currentObjectiveChoiceToken: null },
      narrativeChoices: handoffChoices,
    }));

    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
    expect(screen.queryByText("主线已指向别处——与顾砚交谈")).not.toBeInTheDocument();
  });
});
