import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameSessionView } from "@/game/application";
import { AdventureGameShell } from "./AdventureGameShell";
import { LocationSceneScreen } from "./LocationSceneScreen";
import { postAction, type ActionOutcome } from "./gameActionRequest";
import { buildTownView } from "@/game/application/townView";
import { createTownRuntime, bindNpcToTownSlot } from "@/game/gameplay/rpg/town";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/worldEntity";
import { createInitialWorldState, type WorldState } from "@/game/domain/worldState";

vi.mock("./gameActionRequest", () => ({
  postAction: vi.fn(async () => ({ kind: "rejected", message: "stop" })),
}));

const TOKENS = {
  dialogueOne: "c_0000000000000001",
  dialogueTwo: "c_0000000000000002",
  travel: "c_0000000000000003",
  explore: "c_0000000000000004",
  item: "c_0000000000000005",
  battle: "c_0000000000000006",
} as const;

function choice(choiceToken: string, label: string, presentation: "dialogue" | "travel" | "explore" | "item" | "battle") {
  return { choiceToken, label, presentation } as const;
}

/** 构建合法的 TownView fixture：稳定几何 + npc_1 绑定一个剧情建筑。 */
function townViewFixture(): NonNullable<GameSessionView["currentLocation"]["town"]> {
  const town = bindNpcToTownSlot(
    createTownRuntime({ locationId: asLocationId("loc_0"), seed: "shell-town-fixture" }),
    asNpcId("npc_1"),
  ).town;
  const ws: WorldState = {
    ...createInitialWorldState({
      generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: {
        id: asLocationId("loc_0"), name: "客栈", description: "一间客栈", kind: "main",
        connectedLocationIds: [], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
        scale: "town", town,
      },
      startingItemIds: [],
    }),
    npcs: [{
      id: asNpcId("npc_1"), name: "老板", role: "路人", description: "客栈老板。",
      locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    }],
  };
  return buildTownView(ws, "loc_0")!;
}

function buildView(): GameSessionView {
  return {
    revision: 9,
    turnNumber: 8,
    gameType: "wuxia",
    setup: { storyOpening: null, worldPremise: null, characterProfile: null, narrativeStyle: null },
    player: { name: "侠客", identity: "剑客", hp: 90, attack: 10, defense: 5 },
    worldMap: {
      locations: [
        { name: "客栈", current: true, visited: true, scale: "scene", travelChoice: null },
        { name: "街道", current: false, visited: false, scale: "scene", travelChoice: choice(TOKENS.travel, "前往街道", "travel") },
      ],
    },
    currentLocation: {
      name: "客栈", description: "一间客栈", scale: "scene",
      actions: [choice(TOKENS.explore, "探索客栈", "explore")],
      npcs: [{ name: "老板", role: "路人", talkChoice: choice(TOKENS.dialogueOne, "与老板交谈", "dialogue") }],
      town: null,
    },
    obtainableItems: [{ name: "铜钥匙", description: "旧钥匙", choice: choice(TOKENS.item, "拾取铜钥匙", "item") }],
    inventory: [],
    story: { currentAct: 1, targetActs: 3, tension: 30, pacingNeed: "reveal", storyProgress: 5, currentObjectiveLabel: null, currentObjectiveChoiceToken: null },
    narrative: {
      mode: "offline", hasScene: true, narration: "老板压低声音。", choices: [], npcLine: null,
      npcDialogues: [{
        npcId: "npc_1", name: "老板", role: "路人", speechPages: ["此事不可声张。"],
        choices: [
          choice(TOKENS.dialogueOne, "追问线索", "dialogue"),
          choice(TOKENS.dialogueTwo, "表示理解", "dialogue"),
        ],
        freeInputEnabled: true,
        giveChoices: [],
      }],
    },
    narrativeGeneration: { status: "idle" },
    battle: {
      enemyName: "灰狼", playerHp: 90, enemyHp: 12, round: 2,
      controls: [choice(TOKENS.battle, "攻击", "battle")],
    },
    quests: [{ name: "查明真相", description: "追寻线索", kind: "main", status: "active", objectives: [{ label: "发现秘密", completed: false }] }],
    prologueShown: true,
    prologueText: "",
    ending: null,
  };
}

function renderShell(): void {
  render(<AdventureGameShell
    view={buildView()}
    onViewChange={vi.fn()}
    onStaleRevision={vi.fn()}
    onClearDevelopmentSave={vi.fn(async () => {})}
  />);
}

/** 进入当前地点场景（地图视图点击"进入客栈"）。 */
async function enterScene(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "进入客栈" }));
}

afterEach(() => {
  cleanup();
  vi.mocked(postAction).mockClear();
});

describe("AdventureGameShell canonical opaque choices", () => {
  it("requires an in-game second confirmation before clearing the development save", async () => {
    const clearSave = vi.fn(async () => {});
    render(<AdventureGameShell
      view={buildView()}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={clearSave}
    />);

    await userEvent.click(screen.getByRole("button", { name: "开发工具" }));
    await userEvent.click(screen.getByRole("button", { name: "清除本地试玩存档" }));

    expect(clearSave).not.toHaveBeenCalled();
    expect(screen.getByText("此操作会结束当前试玩并返回新游戏创建界面。")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "确认清除并重新开局" }));
    await waitFor(() => expect(clearSave).toHaveBeenCalledOnce());
  });

  it("keeps the save and offers retry feedback when development clearing fails", async () => {
    const clearSave = vi.fn(async () => { throw new Error("delete failed"); });
    render(<AdventureGameShell
      view={buildView()}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={clearSave}
    />);

    await userEvent.click(screen.getByRole("button", { name: "开发工具" }));
    await userEvent.click(screen.getByRole("button", { name: "清除本地试玩存档" }));
    await userEvent.click(screen.getByRole("button", { name: "确认清除并重新开局" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("清除失败，存档仍然保留。请稍后重试。");
    expect(screen.getByRole("button", { name: "确认清除并重新开局" })).toBeEnabled();
  });

  it("starts on the world map with current and travel nodes", () => {
    renderShell();
    expect(screen.getByRole("button", { name: "进入客栈" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往街道" })).toBeInTheDocument();
  });

  it("forwards the server token for 前往街道 from the map", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "前往街道" }));
    expect(postAction).toHaveBeenCalledWith({
      interaction: { kind: "fixed_choice", choiceToken: TOKENS.travel },
      revision: 9,
    });
  });

  for (const [label, token] of [
    ["追问线索", TOKENS.dialogueOne],
    ["表示理解", TOKENS.dialogueTwo],
    ["探索客栈", TOKENS.explore],
    ["拾取铜钥匙", TOKENS.item],
    ["攻击", TOKENS.battle],
  ] as const) {
    it(`forwards the server token for ${label}`, async () => {
      const user = userEvent.setup();
      renderShell();
      await enterScene(user);
      await user.click(screen.getByRole("button", { name: label }));
      expect(postAction).toHaveBeenCalledWith({
        interaction: { kind: "fixed_choice", choiceToken: token },
        revision: 9,
      });
    });
  }

  it("forwards custom dialogue input without constructing a semantic token", async () => {
    const user = userEvent.setup();
    renderShell();
    await enterScene(user);
    await user.type(screen.getByRole("textbox", { name: "自定义回应" }), "  我相信你  ");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(postAction).toHaveBeenCalledWith({
      interaction: { kind: "free_text", text: "我相信你", targetNpcId: "npc_1" },
      revision: 9,
    });
  });

  it("sets the common busy state for NPC fixed choices until the request settles", async () => {
    let resolveRequest!: (outcome: ActionOutcome) => void;
    vi.mocked(postAction).mockImplementationOnce(() => new Promise<ActionOutcome>((resolve) => {
      resolveRequest = resolve;
    }));
    const user = userEvent.setup();
    renderShell();
    await enterScene(user);

    await user.click(screen.getByRole("button", { name: "追问线索" }));

    expect(screen.queryByRole("dialog", { name: "与老板对话" })).not.toBeInTheDocument();
    expect((screen.getByRole("button", { name: "探索客栈" }) as HTMLButtonElement).disabled).toBe(true);

    resolveRequest({ kind: "rejected", message: "stop" });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "探索客栈" }) as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(screen.getByRole("button", { name: /老板路人/ }));
    expect(screen.getByRole("button", { name: "表示理解" })).toBeEnabled();
  });

  it("closes the old NPC dialog as soon as a formal dialogue choice is submitted", async () => {
    const base = buildView();
    const onSubmit = vi.fn();
    render(<LocationSceneScreen
      view={base}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);

    expect(screen.getByRole("dialog", { name: "与老板对话" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "追问线索" }));

    expect(onSubmit).toHaveBeenCalledWith({
      kind: "fixed_choice",
      choiceToken: TOKENS.dialogueOne,
    });
    expect(screen.queryByRole("dialog", { name: "与老板对话" })).not.toBeInTheDocument();
  });

  it("does not auto-open an NPC dialog when pending completes and a new NPC appears", async () => {
    const base = buildView();
    const onSubmit = vi.fn();
    const { rerender } = render(<LocationSceneScreen
      view={base}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);

    await userEvent.click(screen.getByRole("button", { name: "关闭对话" }));
    rerender(<LocationSceneScreen
      view={{ ...base, narrativeGeneration: { status: "pending" } }}
      busy={true}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);

    const messengerView: GameSessionView = {
      ...base,
      revision: base.revision + 1,
      currentLocation: {
        ...base.currentLocation,
        npcs: [
          ...base.currentLocation.npcs,
          { name: "传讯人", role: "信使", talkChoice: choice("c_messenger_talk", "与传讯人交谈", "dialogue") },
        ],
      },
      narrative: {
        ...base.narrative,
        eventKind: "observe",
        npcDialogues: [
          ...base.narrative.npcDialogues,
          {
            npcId: "npc_2",
            name: "传讯人",
            role: "信使",
            speechPages: ["我带来了一封信。"],
            choices: [choice("c_messenger_talk", "与传讯人交谈", "dialogue")],
            freeInputEnabled: false,
            giveChoices: [],
          },
        ],
      },
      narrativeGeneration: { status: "idle" },
    };
    rerender(<LocationSceneScreen
      view={messengerView}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("announces the authoritative next task after the generated handoff becomes ready", async () => {
    const initial = {
      ...buildView(),
      story: { ...buildView().story, currentObjectiveLabel: "与邵叔交谈" },
    };
    const { rerender } = render(<AdventureGameShell
      view={initial}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);

    rerender(<AdventureGameShell
      view={{
        ...initial,
        revision: initial.revision + 1,
        story: { ...initial.story, currentObjectiveLabel: null },
        narrativeGeneration: { status: "pending" },
      }}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);
    rerender(<AdventureGameShell
      view={{
        ...initial,
        revision: initial.revision + 2,
        story: { ...initial.story, currentObjectiveLabel: "与传讯人交谈" },
        narrativeGeneration: { status: "idle" },
      }}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);

    expect(await screen.findByRole("status")).toHaveTextContent("下一步：与传讯人交谈");
  });

  it("sets the same busy state for NPC free text until the request settles", async () => {
    let resolveRequest!: (outcome: ActionOutcome) => void;
    vi.mocked(postAction).mockImplementationOnce(() => new Promise<ActionOutcome>((resolve) => {
      resolveRequest = resolve;
    }));
    const user = userEvent.setup();
    renderShell();
    await enterScene(user);
    await user.type(screen.getByRole("textbox", { name: "自定义回应" }), "我有一个主意");

    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(screen.queryByRole("dialog", { name: "与老板对话" })).not.toBeInTheDocument();
    expect((screen.getByRole("button", { name: "探索客栈" }) as HTMLButtonElement).disabled).toBe(true);

    resolveRequest({ kind: "rejected", message: "stop" });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "探索客栈" }) as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(screen.getByRole("button", { name: /老板路人/ }));
    expect(screen.getByRole("textbox", { name: "自定义回应" })).toBeEnabled();
  });

  it("provides a close button that collapses the NPC dialogue panel", async () => {
    const user = userEvent.setup();
    renderShell();
    await enterScene(user);

    expect(screen.getByRole("heading", { name: "老板" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭对话" }));
    expect(screen.queryByRole("heading", { name: "老板" })).not.toBeInTheDocument();
  });

  it("auto-switches to the scene view when the player moves to a new location", () => {
    const initialView = buildView();
    const { rerender } = render(<AdventureGameShell
      view={initialView}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);

    // 初始仍在地图视图，等待玩家手动进入
    expect(screen.getByRole("button", { name: "进入客栈" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "地点场景：客栈" })).not.toBeInTheDocument();

    // 玩家移动到新地点：performTurn 返回 currentLocation 变化、revision+1
    const movedView: GameSessionView = {
      ...initialView,
      revision: initialView.revision + 1,
      worldMap: {
        locations: [
          { name: "客栈", current: false, visited: true, scale: "town", travelChoice: choice(TOKENS.travel, "前往客栈", "travel") },
          { name: "街道", current: true, visited: true, scale: "scene", travelChoice: null },
        ],
      },
      currentLocation: {
        name: "街道",
        description: "夜市灯火通明",
        scale: "scene",
        actions: [choice(TOKENS.explore, "探索街道", "explore")],
        npcs: [],
        town: null,
      },
      narrative: {
        ...initialView.narrative,
        narration: "夜市灯火通明，行人摩肩接踵。",
        npcDialogues: [],
        choices: [],
      },
    };
    rerender(<AdventureGameShell
      view={movedView}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);

    // 移动到新地点后应自动进入场景视图，显示新地点的探索/活动行动栏
    expect(screen.getByRole("region", { name: "地点场景：街道" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "探索街道" })).toBeInTheDocument();
  });

  it("hides NPC dialogue panels while narrative generation is pending instead of showing empty choices", async () => {
    const view = {
      ...buildView(),
      narrativeGeneration: { status: "pending" as const },
    };
    render(<LocationSceneScreen
      view={view}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    // 叙事生成中：对话面板不渲染（避免出现无选项的空面板），仅显示编排提示
    expect(screen.queryByRole("heading", { name: "老板" })).not.toBeInTheDocument();
    expect(screen.getByText("正在编排下一幕……")).toBeInTheDocument();
  });

  it("does not repeat a location description when it matches the scene narration", () => {
    const view = {
      ...buildView(),
      currentLocation: { ...buildView().currentLocation, description: "夜市灯火通明。。" },
      narrative: { ...buildView().narrative, narration: "夜市灯火通明。" },
    };
    render(<LocationSceneScreen
      view={view}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    expect(screen.getAllByText("夜市灯火通明。")).toHaveLength(1);
  });

  it("explains when the scene has no available actions", () => {
    const base = buildView();
    render(<LocationSceneScreen
      view={{
        ...base,
        battle: null,
        currentLocation: { ...base.currentLocation, actions: [] },
        narrative: { ...base.narrative, npcDialogues: [] },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    expect(screen.getByRole("alert")).toHaveTextContent("当前场景没有可执行行动，请返回地图或重新载入存档。");
  });

  it("shows only the current objective action in the scene action rail", () => {
    const base = buildView();
    render(<LocationSceneScreen
      view={{
        ...base,
        battle: null,
        story: { ...base.story, currentObjectiveLabel: "与老板交谈", currentObjectiveChoiceToken: TOKENS.dialogueOne },
        currentLocation: {
          ...base.currentLocation,
          actions: [
            choice(TOKENS.explore, "探索客栈", "explore"),
            choice(TOKENS.dialogueOne, "与老板交谈", "dialogue"),
            choice(TOKENS.battle, "挑战灰狼", "battle"),
          ],
        },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: "与老板交谈" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "探索客栈" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "挑战灰狼" })).not.toBeInTheDocument();
  });

  it("labels the single NPC talk choice as a dialogue preparation state", () => {
    const base = buildView();
    render(<LocationSceneScreen
      view={{
        ...base,
        narrative: {
          ...base.narrative,
          npcDialogues: [{ ...base.narrative.npcDialogues[0]!, choices: [choice(TOKENS.dialogueOne, "与老板交谈", "dialogue")], freeInputEnabled: false }],
        },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    expect(screen.getByText("正在准备对话……")).toBeInTheDocument();
  });

  it("opens prepared NPC dialogue first and submits only after choosing a response", async () => {
    const base = buildView();
    const onSubmit = vi.fn();
    render(<LocationSceneScreen
      view={{
        ...base,
        battle: null,
        currentLocation: {
          ...base.currentLocation,
          actions: [choice(TOKENS.dialogueOne, "与老板交谈", "dialogue")],
        },
        narrative: {
          ...base.narrative,
          npcDialogues: [{
            ...base.narrative.npcDialogues[0]!,
            choices: [
              choice(TOKENS.dialogueOne, "追问线索", "dialogue"),
              choice(TOKENS.dialogueTwo, "表示理解", "dialogue"),
            ],
            freeInputEnabled: true,
          }],
        },
      }}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
      initialFocusNpcId="npc_1"
    />);

    await userEvent.click(screen.getByRole("button", { name: "与老板交谈" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "与老板对话" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "追问线索" }));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "fixed_choice",
      choiceToken: TOKENS.dialogueOne,
    });
  });

  it("keeps battle sides explicit and shows the attack feedback before the next snapshot", async () => {
    const base = buildView();
    const onSubmit = vi.fn();
    const { rerender } = render(<LocationSceneScreen
      view={base}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);

    expect(screen.getByRole("group", { name: "己方：侠客" })).toHaveAttribute("data-side", "player");
    expect(screen.getByRole("group", { name: "敌方：灰狼" })).toHaveAttribute("data-side", "enemy");
    await userEvent.click(screen.getByRole("button", { name: "攻击" }));
    expect(screen.getByText("你攻击！")).toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledWith({ kind: "fixed_choice", choiceToken: TOKENS.battle });

    rerender(<LocationSceneScreen
      view={{
        ...base,
        battle: {
          ...base.battle!,
          enemyHp: 5,
          round: 3,
          lastAdvance: [{
            sequence: 0,
            round: 2,
            actorSlot: "player-0",
            actorName: "侠客",
            targetSlot: "enemy-0",
            targetName: "灰狼",
            kind: "attack",
            damage: 7,
            targetHpAfter: 5,
          }],
        },
      }}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);
    expect(await screen.findByText("侠客攻击 灰狼 -7 HP")).toBeInTheDocument();
  });

  it("offers non-focus NPC small talk without submitting a game action", async () => {
    const base = buildView();
    const onSubmit = vi.fn();
    const view: GameSessionView = {
      ...base,
      currentLocation: {
        ...base.currentLocation,
        npcs: [
          ...base.currentLocation.npcs,
          { name: "猎人", role: "游侠", talkChoice: choice("c_hunter_talk", "与猎人交谈", "dialogue") },
        ],
      },
      narrative: {
        ...base.narrative,
        npcDialogues: [
          ...base.narrative.npcDialogues,
          {
            npcId: "npc_2",
            name: "猎人",
            role: "游侠",
            speechPages: ["猎人靠在门边观察雨幕。"],
            choices: [choice("c_hunter_talk", "与猎人交谈", "dialogue")],
            freeInputEnabled: false,
            giveChoices: [],
            smallTalk: { prompt: "向猎人打听附近动静", response: "猎人说：林子里今天很安静。" },
          },
        ],
      },
    };
    render(<LocationSceneScreen
      view={view}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);

    await userEvent.click(screen.getByRole("button", { name: /猎人游侠/ }));
    await userEvent.click(screen.getByRole("button", { name: /向猎人打听附近动静/ }));
    expect(screen.getByText("猎人说：林子里今天很安静。")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("AdventureGameShell three-layer navigation", () => {
  const townFixture = townViewFixture();
  const interactive = townFixture.interactiveBuildings[0]!;

  function buildTownView(): GameSessionView {
    return {
      ...buildView(),
      worldMap: {
        locations: [
          { name: "客栈", current: true, visited: true, scale: "town", travelChoice: null },
          { name: "街道", current: false, visited: false, scale: "scene", travelChoice: choice(TOKENS.travel, "前往街道", "travel") },
        ],
      },
      currentLocation: {
        name: "客栈", description: "一间客栈", scale: "town",
        actions: [choice(TOKENS.explore, "探索客栈", "explore")],
        npcs: [{ name: "老板", role: "路人", talkChoice: choice(TOKENS.dialogueOne, "与老板交谈", "dialogue") }],
        town: townFixture,
      },
    };
  }

  it("entering a town-scale location from the map renders TownLayerScreen", async () => {
    const user = userEvent.setup();
    render(<AdventureGameShell
      view={buildTownView()}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);
    await user.click(screen.getByRole("button", { name: "进入客栈" }));
    expect(screen.getByRole("region", { name: `小镇：客栈` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回地图" })).toBeInTheDocument();
  });

  it("selecting a bound story building renders LocationSceneScreen and focuses its NPC", async () => {
    const user = userEvent.setup();
    render(<AdventureGameShell
      view={buildTownView()}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);
    await user.click(screen.getByRole("button", { name: "进入客栈" }));
    await user.click(screen.getByRole("button", { name: interactive.displayName }));
    await user.click(screen.getByRole("button", { name: `进入${interactive.displayName}` }));
    expect(screen.getByRole("region", { name: `地点场景：${interactive.displayName}` })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: interactive.displayName })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(`${interactive.npcName}.*`) })).toBeInTheDocument();
    // 场景返回按钮从小镇进入时显示“返回小镇”
    expect(screen.getByRole("button", { name: "返回小镇" })).toBeInTheDocument();
  });

  it("entering a building only opens the scene and does not start a talk action", async () => {
    const user = userEvent.setup();
    const view = buildTownView();
    const notDialogueReady: GameSessionView = {
      ...view,
      narrative: {
        ...view.narrative,
        npcDialogues: [{
          npcId: "npc_1",
          name: "老板",
          role: "路人",
          speechPages: ["老板说道：我知道了。"],
          choices: [],
          freeInputEnabled: false,
          giveChoices: [],
        }],
      },
    };
    render(<AdventureGameShell
      view={notDialogueReady}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);

    await user.click(screen.getByRole("button", { name: "进入客栈" }));
    await user.click(screen.getByRole("button", { name: interactive.displayName }));
    await user.click(screen.getByRole("button", { name: `进入${interactive.displayName}` }));

    expect(screen.getByRole("region", { name: `地点场景：${interactive.displayName}` })).toBeInTheDocument();
    expect(postAction).not.toHaveBeenCalled();
  });

  it("uses the NPC bound to the clicked building instead of the current objective NPC", async () => {
    const user = userEvent.setup();
    const view = buildTownView();
    const clickedBuilding = view.currentLocation.town!.interactiveBuildings[0]!;
    const secondBuilding = view.currentLocation.town!.snapshot.buildings.find((entry) =>
      entry.storyRequired && entry.buildingId !== clickedBuilding.buildingId,
    )!;
    const twoNpcView: GameSessionView = {
      ...view,
      story: { ...view.story, currentObjectiveLabel: "与目标人交谈" },
      currentLocation: {
        ...view.currentLocation,
        npcs: [
          { name: clickedBuilding.npcName, role: "掌柜", talkChoice: choice(TOKENS.dialogueOne, `与${clickedBuilding.npcName}交谈`, "dialogue") },
          { name: "目标人", role: "信使", talkChoice: choice(TOKENS.dialogueTwo, "与目标人交谈", "dialogue") },
        ],
        town: {
          ...view.currentLocation.town!,
          interactiveBuildings: [
            clickedBuilding,
            {
              buildingId: secondBuilding.buildingId,
              displayName: secondBuilding.displayName,
              buildingType: "house",
              npcId: "npc_2",
              npcName: "目标人",
            },
          ],
        },
      },
      narrative: { ...view.narrative, npcDialogues: [] },
    };
    render(<AdventureGameShell
      view={twoNpcView}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);

    await user.click(screen.getByRole("button", { name: "进入客栈" }));
    await user.click(screen.getByRole("button", { name: clickedBuilding.displayName }));
    await user.click(screen.getByRole("button", { name: `进入${clickedBuilding.displayName}` }));

    expect(screen.getByRole("region", { name: `地点场景：${clickedBuilding.displayName}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(`${clickedBuilding.npcName}.*`) })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /目标人.*信使/ })).not.toBeInTheDocument();
    expect(postAction).not.toHaveBeenCalled();
  });

  it("returning from scene goes to town, and returning from town goes to the world map", async () => {
    const user = userEvent.setup();
    render(<AdventureGameShell
      view={buildTownView()}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);
    await user.click(screen.getByRole("button", { name: "进入客栈" }));
    await user.click(screen.getByRole("button", { name: interactive.displayName }));
    await user.click(screen.getByRole("button", { name: `进入${interactive.displayName}` }));
    // 场景 → 小镇
    await user.click(screen.getByRole("button", { name: "返回小镇" }));
    expect(screen.getByRole("region", { name: `小镇：客栈` })).toBeInTheDocument();
    // 小镇 → 世界地图
    await user.click(screen.getByRole("button", { name: "返回地图" }));
    expect(screen.getByRole("button", { name: "进入客栈" })).toBeInTheDocument();
  });

  it("a scene-scale location continues map → scene directly", async () => {
    const user = userEvent.setup();
    render(<AdventureGameShell
      view={buildView()}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);
    await user.click(screen.getByRole("button", { name: "进入客栈" }));
    expect(screen.getByRole("region", { name: "地点场景：客栈" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回地图" })).toBeInTheDocument();
  });
});
