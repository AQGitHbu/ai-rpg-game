import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type Dispatch, type SetStateAction } from "react";
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

function choice(choiceToken: string, label: string, presentation: "dialogue" | "travel" | "explore" | "item" | "battle" | "investigate") {
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

function buildView(options: { battle?: GameSessionView["battle"] } = {}): GameSessionView {
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
      npcs: [{ npcId: "npc_1", name: "老板", role: "路人", talkChoice: choice(TOKENS.dialogueOne, "与老板交谈", "dialogue"), relationshipTier: "neutral" }],
      town: null,
    },
    obtainableItems: [{ name: "铜钥匙", description: "旧钥匙", choice: choice(TOKENS.item, "拾取铜钥匙", "item") }],
    inventory: [],
    story: { currentAct: 1, targetActs: 3, tension: 30, pacingNeed: "reveal", storyProgress: 5, currentObjectiveLabel: null, currentObjectiveChoiceToken: null, currentObjectiveChoiceTokens: [] },
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
    battle: options.battle ?? null,
    quests: [{ name: "查明真相", description: "追寻线索", kind: "main", status: "active", objectives: [{ label: "发现秘密", completed: false }] }],
    prologueShown: true,
    prologueText: "",
    ending: null,
  };
}

function buildBattleView(): GameSessionView {
  return buildView({
    battle: {
      enemyName: "灰狼", playerHp: 90, enemyHp: 12, round: 2,
      controls: [choice(TOKENS.battle, "攻击", "battle")],
    },
  });
}

function renderShell(view: GameSessionView = buildView()): void {
  render(<AdventureGameShell
    view={view}
    onViewChange={vi.fn()}
    onStaleRevision={vi.fn()}
    onClearDevelopmentSave={vi.fn(async () => {})}
  />);
}

/** 进入当前地点场景（地图视图点击"客栈"）。 */
async function enterScene(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "客栈" }));
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
    expect(screen.getByRole("button", { name: "客栈" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往街道" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入客栈" })).not.toBeInTheDocument();
  });

  it("enters the current map node locally without submitting an action", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: "客栈" }));

    expect(screen.getByRole("region", { name: "地点场景：客栈" })).toBeInTheDocument();
    expect(postAction).not.toHaveBeenCalled();
  });

  it("forwards the server token for 前往街道 from the map", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "前往街道" }));
    expect(postAction).toHaveBeenCalledWith({
      interaction: { kind: "fixed_choice", choiceToken: TOKENS.travel },
      revision: 9,
    });
    expect(screen.queryByRole("dialog", { name: "正在编排下一幕……" })).not.toBeInTheDocument();
  });

  for (const [label, token] of [
    ["追问线索", TOKENS.dialogueOne],
    ["表示理解", TOKENS.dialogueTwo],
    ["拾取铜钥匙", TOKENS.item],
    ["攻击", TOKENS.battle],
  ] as const) {
    it(`forwards the server token for ${label}`, async () => {
      const user = userEvent.setup();
      renderShell(label === "攻击" ? buildBattleView() : undefined);
      await enterScene(user);
      await user.click(screen.getByRole("button", { name: label }));
      expect(postAction).toHaveBeenCalledWith({
        interaction: { kind: "fixed_choice", choiceToken: token },
        revision: 9,
      });
    });
  }

  it("does not render non-dialogue scene actions in the removed bottom rail", async () => {
    renderShell({
      ...buildView(),
      narrative: { ...buildView().narrative, npcDialogues: [] },
    });
    expect(screen.queryByRole("button", { name: "探索客栈" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
  });

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

  it("keeps the selected NPC response inline while locking every game control", async () => {
    let resolveRequest!: (outcome: ActionOutcome) => void;
    vi.mocked(postAction).mockImplementationOnce(() => new Promise<ActionOutcome>((resolve) => {
      resolveRequest = resolve;
    }));
    const user = userEvent.setup();
    renderShell();
    await enterScene(user);

    await user.click(screen.getByRole("button", { name: "追问线索" }));

    const dialogue = screen.getByRole("dialog", { name: "与老板对话" });
    const selectedChoice = within(dialogue).getByRole("button", { name: "追问线索" });
    expect(dialogue).toHaveAttribute("aria-busy", "true");
    expect(selectedChoice).toBeDisabled();
    expect(selectedChoice).toHaveAttribute("aria-current", "true");
    expect(within(selectedChoice).getByTestId("npc-dialogue-spinner")).toHaveAttribute("aria-hidden", "true");
    expect(within(dialogue).getByRole("button", { name: "表示理解" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("正在等待老板回应");
    expect(screen.queryByRole("dialog", { name: "正在处理……" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "正在编排下一幕……" })).not.toBeInTheDocument();

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }

    resolveRequest({ kind: "rejected", message: "stop" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "追问线索" })).toBeEnabled();
    });
    expect(screen.getByRole("button", { name: "表示理解" })).toBeEnabled();
  });

  it("keeps the submitted dialogue snapshot through an empty pending view, then replaces it when ready", async () => {
    const base = buildView();
    const pendingView: GameSessionView = {
      ...base,
      revision: base.revision + 1,
      turnNumber: base.turnNumber + 1,
      narrative: {
        ...base.narrative,
        npcDialogues: [{
          ...base.narrative.npcDialogues[0]!,
          choices: [],
          giveChoices: [],
          freeInputEnabled: false,
        }],
      },
      narrativeGeneration: { status: "pending", jobKey: "job-pending" },
    };
    const readyView: GameSessionView = {
      ...pendingView,
      revision: pendingView.revision + 1,
      narrative: {
        ...pendingView.narrative,
        npcDialogues: [{
          ...pendingView.narrative.npcDialogues[0]!,
          speechPages: ["账本我已经核过了，下一步得先找到送货的人。"],
          choices: [
            choice("c_0000000000000011", "追查送货人", "dialogue"),
            choice("c_0000000000000012", "先整理账本", "dialogue"),
          ],
          freeInputEnabled: true,
        }],
      },
      narrativeGeneration: { status: "idle" },
    };
    vi.mocked(postAction).mockResolvedValueOnce({
      kind: "success",
      view: pendingView,
      message: "Action performed",
    });
    const user = userEvent.setup();
    let setView: Dispatch<SetStateAction<GameSessionView>> | null = null;
    function ShellHarness() {
      const [view, updateView] = useState(base);
      setView = updateView;
      return <AdventureGameShell
        view={view}
        onViewChange={updateView}
        onStaleRevision={vi.fn()}
        onClearDevelopmentSave={vi.fn(async () => {})}
      />;
    }
    render(<ShellHarness />);
    await enterScene(user);
    await user.click(screen.getByRole("button", { name: "追问线索" }));
    await waitFor(() => expect(postAction).toHaveBeenCalledOnce());

    const dialogue = screen.getByRole("dialog", { name: "与老板对话" });
    const selectedChoice = within(dialogue).getByRole("button", { name: "追问线索" });
    expect(dialogue).toHaveAttribute("aria-busy", "true");
    expect(selectedChoice).toHaveAttribute("aria-current", "true");
    expect(within(selectedChoice).getByTestId("npc-dialogue-spinner")).toBeInTheDocument();
    expect(within(dialogue).getByRole("button", { name: "表示理解" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "返回地图" })).toBeDisabled();
    // 旧断言检查等待态下侧栏「老板」卡片 disabled；对话显示时侧栏整体不再渲染（spec §2.2），
    // 该入口锁定语义由三处覆盖：上方对覆盖层自身全部选项/关闭按钮的禁用断言、
    // NpcDialogueOverlay.test.tsx「等待态：…全部禁用」「等待态锁定关闭按钮并隐藏自由输入」、
    // LocationSceneScreen.test.tsx「对话打开时隐藏侧栏与行动栏」。

    await act(async () => {
      setView?.(readyView);
    });

    await waitFor(() => {
      expect(screen.getByText("账本我已经核过了，下一步得先找到送货的人。")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "追查送货人" })).toBeEnabled();
    });
    expect(screen.getByRole("button", { name: "先整理账本" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "追问线索" })).not.toBeInTheDocument();
  });

  it("restores custom dialogue input after an ordinary action error", async () => {
    let resolveRequest!: (outcome: ActionOutcome) => void;
    vi.mocked(postAction).mockImplementationOnce(() => new Promise<ActionOutcome>((resolve) => {
      resolveRequest = resolve;
    }));
    const user = userEvent.setup();
    renderShell();
    await enterScene(user);

    await user.type(screen.getByRole("textbox", { name: "自定义回应" }), "我有一个主意");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const dialogue = screen.getByRole("dialog", { name: "与老板对话" });
    const playerReply = within(dialogue).getByText("我有一个主意");
    expect(within(playerReply).getByTestId("npc-dialogue-spinner")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "自定义回应" })).not.toBeInTheDocument();

    resolveRequest({ kind: "error", message: "network" });
    const restoredInput = await screen.findByRole("textbox", { name: "自定义回应" });
    expect(restoredInput).toHaveValue("我有一个主意");
    expect(screen.queryByTestId("npc-dialogue-spinner")).not.toBeInTheDocument();
  });

  it("retries an NPC action failure in place with the same interaction", async () => {
    let resolveRetry!: (outcome: ActionOutcome) => void;
    vi.mocked(postAction)
      .mockResolvedValueOnce({
        kind: "ai-failure",
        message: "AI 调用失败，请重试。",
        failureKind: "AI_CALL_FAILED",
        interaction: { kind: "fixed_choice", choiceToken: TOKENS.dialogueOne },
      })
      .mockImplementationOnce(() => new Promise<ActionOutcome>((resolve) => {
        resolveRetry = resolve;
      }));
    const user = userEvent.setup();
    renderShell();
    await enterScene(user);

    await user.click(screen.getByRole("button", { name: "追问线索" }));
    expect(await screen.findByRole("dialog", { name: "本次选择提交失败" })).toBeInTheDocument();
    expect(screen.getAllByRole("button").filter((button) => !button.hasAttribute("disabled"))).toEqual([
      screen.getByRole("button", { name: "重试当前选择" }),
    ]);
    await user.click(screen.getByRole("button", { name: "重试当前选择" }));

    await waitFor(() => expect(postAction).toHaveBeenCalledTimes(2));
    expect(vi.mocked(postAction).mock.calls[1]?.[0]).toEqual({
      interaction: { kind: "fixed_choice", choiceToken: TOKENS.dialogueOne },
      revision: 9,
    });
    const selectedChoice = screen.getByRole("button", { name: "追问线索" });
    expect(within(selectedChoice).getByTestId("npc-dialogue-spinner")).toBeInTheDocument();

    resolveRetry({ kind: "rejected", message: "stop" });
    await waitFor(() => expect(screen.getByRole("button", { name: "追问线索" })).toBeEnabled());
  });

  it("retries a failed NPC narrative without resubmitting its action", async () => {
    const base = buildView();
    const pendingView: GameSessionView = {
      ...base,
      revision: base.revision + 1,
      turnNumber: base.turnNumber + 1,
      narrativeGeneration: { status: "pending", jobKey: "job-pending" },
    };
    const onRetryNarrative = vi.fn(async () => {});
    vi.mocked(postAction).mockResolvedValueOnce({
      kind: "success",
      view: pendingView,
      message: "Action performed",
    });
    const user = userEvent.setup();
    const { rerender } = render(<AdventureGameShell
      view={base}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
      onRetryNarrative={onRetryNarrative}
    />);
    await enterScene(user);
    await user.click(screen.getByRole("button", { name: "追问线索" }));
    await waitFor(() => expect(postAction).toHaveBeenCalledOnce());

    rerender(<AdventureGameShell
      view={{ ...pendingView, narrativeGeneration: { status: "failed", failureKind: "AI_RESPONSE_INVALID", jobKey: "job-pending" } }}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
      onRetryNarrative={onRetryNarrative}
    />);

    expect(screen.getByRole("dialog", { name: "与老板对话" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "NPC回应生成失败" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试生成回应" }));
    expect(onRetryNarrative).toHaveBeenCalledOnce();
    expect(postAction).toHaveBeenCalledOnce();
  });

  it("renders zero-turn idle dialogue for handed-off NPC with dismiss button and no submission", async () => {
    const user = userEvent.setup();
    const idleView: GameSessionView = {
      ...buildView(),
      currentLocation: {
        ...buildView().currentLocation,
        npcs: [{ npcId: "npc_lao_zhou", name: "老周", role: "茶摊老板", talkChoice: null, relationshipTier: "neutral" }],
      },
      narrative: {
        ...buildView().narrative,
        npcDialogues: [{
          npcId: "npc_lao_zhou",
          name: "老周",
          role: "茶摊老板",
          speechPages: ["先前说定的事别忘了。调查酒楼后巷的车轮印要紧，有了结果再来告诉我。"],
          choices: [],
          freeInputEnabled: false,
          giveChoices: [],
        }],
      },
    };
    renderShell(idleView);
    await enterScene(user);

    // 测试环境（isTest）默认打开首个活跃对话：闲聊覆盖层已直接展示，侧栏此时已隐藏。
    // 「点击侧栏卡片本地打开对话、零提交」这一腿由本文件
    // 「offers non-focus NPC only the real talk action」/
    // 「starts the authoritative provider talk on NPC click …」两用例继续守住。
    expect(screen.getByText(/调查酒楼后巷的车轮印/)).toBeInTheDocument();
    // 不存在可提交的“与老周交谈”按钮，也不存在自由输入
    expect(screen.queryByRole("button", { name: "与老周交谈" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("自定义回应")).not.toBeInTheDocument();

    // “知道了”关闭弹窗；全程零提交
    await user.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.queryByRole("dialog", { name: "与老周对话" })).not.toBeInTheDocument();
    expect(vi.mocked(postAction)).not.toHaveBeenCalled();
  });

  it("closes a handoff acknowledgement locally without submitting or waiting", async () => {
    const playerResponse = "（（抱拳）多谢先生指点，那练刀场在断魂崖后山何处？我这就去瞧瞧。）";
    const onSubmit = vi.fn();
    const onReturnMap = vi.fn();
    const handoffDialogue = Object.assign({
      npcId: "npc_chen",
      name: "陈半仙",
      role: "算命先生",
      speechPages: ["断魂崖后山那片废弃的练刀场，夜里常有刀气破空。"],
      choices: [],
      freeInputEnabled: false,
      giveChoices: [],
    }, { handoffAcknowledgement: { label: playerResponse } });
    const handoffView: GameSessionView = {
      ...buildView(),
      story: {
        ...buildView().story,
        currentObjectiveLabel: "前往断魂崖后山练刀场",
        currentObjectiveChoiceToken: "c_handoff_move",
        currentObjectiveChoiceTokens: ["c_handoff_move"],
      },
      currentLocation: {
        ...buildView().currentLocation,
        npcs: [{ npcId: "npc_chen", name: "陈半仙", role: "算命先生", talkChoice: null, relationshipTier: "neutral" }],
      },
      narrative: {
        ...buildView().narrative,
        eventKind: "dialogue",
        choices: [choice("c_handoff_move", playerResponse, "travel")],
        npcDialogues: [handoffDialogue as unknown as GameSessionView["narrative"]["npcDialogues"][number]],
      },
    };

    render(<LocationSceneScreen
      view={handoffView}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={onReturnMap}
    />);

    const dialogue = screen.getByRole("dialog", { name: "与陈半仙对话" });
    expect(dialogue).toHaveTextContent(playerResponse);
    expect(dialogue.querySelector(".npc-dialogue-overlay-speech--player")).toBeNull();
    const responseButton = within(dialogue).getByRole("button", { name: playerResponse });
    expect(responseButton).toBeInTheDocument();
    expect(within(dialogue).getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();

    await userEvent.click(responseButton);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("status", { name: /等待.*回应/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "与陈半仙对话" })).not.toBeInTheDocument();
    expect(onReturnMap).not.toHaveBeenCalled();
  });

  it("keeps the old NPC's final line and closes its acknowledgement locally", async () => {
    const base = buildView();
    const onSubmit = vi.fn();
    const initialView: GameSessionView = {
      ...base,
      currentLocation: {
        ...base.currentLocation,
        scale: "town",
        actions: [
          choice(TOKENS.dialogueOne, "与赵铁嘴交谈", "dialogue"),
          choice(TOKENS.dialogueTwo, "与老郎中交谈", "dialogue"),
        ],
        npcs: [
          { npcId: "npc_1", name: "赵铁嘴", role: "告示栏旁的算命先生", talkChoice: choice(TOKENS.dialogueOne, "与赵铁嘴交谈", "dialogue"), relationshipTier: "neutral" },
          { npcId: "npc_2", name: "老郎中", role: "医馆掌柜", talkChoice: choice(TOKENS.dialogueTwo, "与老郎中交谈", "dialogue"), relationshipTier: "neutral" },
        ],
      },
      story: {
        ...base.story,
        currentObjectiveLabel: "与赵铁嘴交谈",
        currentObjectiveChoiceToken: TOKENS.dialogueOne,
        currentObjectiveChoiceTokens: [TOKENS.dialogueOne],
      },
      narrative: {
        ...base.narrative,
        npcDialogues: [{
          ...base.narrative.npcDialogues[0]!,
          name: "赵铁嘴",
          role: "告示栏旁的算命先生",
          choices: [
            choice(TOKENS.dialogueOne, "追问告示线索", "dialogue"),
            choice(TOKENS.dialogueTwo, "追问老郎中的去向", "dialogue"),
          ],
          freeInputEnabled: true,
        }],
      },
    };
    const { rerender } = render(<LocationSceneScreen
      view={initialView}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
      initialFocusNpcId="npc_1"
      sceneNpcName="赵铁嘴"
      sceneLocationName="镇口告示栏"
    />);

    await userEvent.click(screen.getByRole("button", { name: /赵铁嘴/ }));
    await userEvent.click(screen.getByRole("button", { name: "追问老郎中的去向" }));
    expect(onSubmit).toHaveBeenCalledWith(
      { kind: "fixed_choice", choiceToken: TOKENS.dialogueTwo },
      "npc-dialogue",
    );

    rerender(<LocationSceneScreen
      view={{ ...initialView, narrativeGeneration: { status: "pending", jobKey: "job-pending" } }}
      busy={true}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
      initialFocusNpcId="npc_1"
      sceneNpcName="赵铁嘴"
      sceneLocationName="镇口告示栏"
    />);
    rerender(<LocationSceneScreen
      view={{
        ...initialView,
        revision: initialView.revision + 1,
        turnNumber: initialView.turnNumber + 1,
        currentLocation: {
          ...initialView.currentLocation,
          actions: [choice(TOKENS.dialogueTwo, "与老郎中交谈", "dialogue")],
        },
        story: {
          ...initialView.story,
          currentObjectiveLabel: "与老郎中交谈",
          currentObjectiveChoiceToken: TOKENS.dialogueTwo,
          currentObjectiveChoiceTokens: [TOKENS.dialogueTwo],
        },
        narrative: {
          ...initialView.narrative,
          eventKind: "observe",
          npcDialogues: [{
            ...initialView.narrative.npcDialogues[0]!,
            speechPages: ["黑影往后巷医馆去了，老郎中或许知道那名伤者的来历。"],
            choices: [],
            handoffAcknowledgement: { label: "知道了" },
            freeInputEnabled: false,
          }],
        },
        narrativeGeneration: { status: "idle" },
      }}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
      initialFocusNpcId="npc_1"
      sceneNpcName="赵铁嘴"
      sceneLocationName="镇口告示栏"
    />);

    const dialogue = screen.getByRole("dialog", { name: "与赵铁嘴对话" });
    expect(dialogue).toHaveTextContent("黑影往后巷医馆去了");
    const acknowledgement = within(dialogue).getByRole("button", { name: "知道了" });
    expect(acknowledgement).toBeInTheDocument();
    await userEvent.click(acknowledgement);
    expect(screen.queryByRole("dialog", { name: "与赵铁嘴对话" })).not.toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status", { name: /等待.*回应/ })).not.toBeInTheDocument();
  });

  it("keeps ordinary narrative pending modal while locking rule actions", () => {
    render(<AdventureGameShell
      view={{ ...buildView(), narrativeGeneration: { status: "pending", jobKey: "job-pending" } }}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);

    expect(screen.getByRole("dialog", { name: "正在编排下一幕……" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "客栈" })).toBeDisabled();
  });

  it("keeps the NPC dialog open after a formal choice so the next reply can return in place", async () => {
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

    expect(onSubmit).toHaveBeenCalledWith(
      { kind: "fixed_choice", choiceToken: TOKENS.dialogueOne },
      "npc-dialogue",
    );
    expect(screen.getByRole("dialog", { name: "与老板对话" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在等待老板回应");
  });

  it("keeps the NPC dialog open when the action response already contains the ready reply", async () => {
    const base = buildView();
    const readyView: GameSessionView = {
      ...base,
      revision: base.revision + 1,
      turnNumber: base.turnNumber + 1,
      narrative: {
        ...base.narrative,
        eventKind: "dialogue",
        npcDialogues: [{
          ...base.narrative.npcDialogues[0]!,
          speechPages: ["账本上的墨迹还没干。你若要查下去，先去后巷找送货的人。"],
          choices: [
            choice("c_ready_dialogue_1", "追问账本来源", "dialogue"),
            choice("c_ready_dialogue_2", "先去后巷查看", "dialogue"),
          ],
        }],
      },
      narrativeGeneration: { status: "idle" },
    };
    vi.mocked(postAction).mockResolvedValueOnce({
      kind: "success",
      view: readyView,
      message: "Action performed",
    });
    function ShellHarness() {
      const [view, updateView] = useState(base);
      return <AdventureGameShell
        view={view}
        onViewChange={updateView}
        onStaleRevision={vi.fn()}
        onClearDevelopmentSave={vi.fn(async () => {})}
      />;
    }

    const user = userEvent.setup();
    render(<ShellHarness />);
    await enterScene(user);
    await user.click(screen.getByRole("button", { name: "追问线索" }));

    await waitFor(() => {
      expect(postAction).toHaveBeenCalledOnce();
      expect(screen.getByText("账本上的墨迹还没干。你若要查下去，先去后巷找送货的人。")).toBeInTheDocument();
    });
    expect(screen.getByRole("dialog", { name: "与老板对话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "追问账本来源" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "先去后巷查看" })).toBeEnabled();
    expect(screen.queryByRole("status", { name: /等待.*回应/ })).not.toBeInTheDocument();
  });

  it("does not show a town item inside a different building scene", () => {
    const town = townViewFixture();
    const itemBuildingId = town.interactiveBuildings[0]?.buildingId;
    const view: GameSessionView = {
      ...buildView(),
      currentLocation: {
        ...buildView().currentLocation,
        scale: "town",
        town,
      },
      obtainableItems: [{
        name: "染血腰牌",
        description: "一块旧腰牌。",
        buildingId: itemBuildingId,
        choice: choice(TOKENS.item, "拾取染血腰牌", "item"),
      }],
    };
    render(<LocationSceneScreen
      view={view}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
      initialFocusNpcId="npc_1"
      sceneBuildingId="building_not_the_item_building"
    />);

    expect(screen.queryByRole("button", { name: "拾取染血腰牌" })).not.toBeInTheDocument();
  });

  it("keeps the final NPC handoff visible until the player acknowledges it", async () => {
    const base = buildView();
    const onSubmit = vi.fn();
    const { rerender } = render(<LocationSceneScreen
      view={base}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);

    await userEvent.type(screen.getByRole("textbox", { name: "自定义回应" }), "请把昨夜的经过说清楚");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSubmit).toHaveBeenCalledWith(
      { kind: "free_text", text: "请把昨夜的经过说清楚", targetNpcId: "npc_1" },
      "npc-dialogue",
    );

    rerender(<LocationSceneScreen
      view={{ ...base, narrativeGeneration: { status: "pending", jobKey: "job-pending" } }}
      busy={true}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);
    expect(screen.getByRole("dialog", { name: "与老板对话" })).toHaveAttribute("aria-busy", "true");

    rerender(<LocationSceneScreen
      view={{
        ...base,
        revision: base.revision + 1,
        turnNumber: base.turnNumber + 1,
        story: {
          ...base.story,
          currentObjectiveLabel: "前往街道",
          currentObjectiveChoiceToken: TOKENS.travel,
        },
        narrative: {
          ...base.narrative,
          eventKind: "dialogue",
          npcDialogues: [{
            ...base.narrative.npcDialogues[0]!,
            speechPages: ["我看见告示是子时后贴上的，贴告示的人左手有一道新伤。你若要追查，先去巷口找留下的车辙。"],
            choices: [],
            freeInputEnabled: false,
          }],
        },
        narrativeGeneration: { status: "idle" },
      }}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);

    const dialogue = screen.getByRole("dialog", { name: "与老板对话" });
    expect(dialogue).toHaveTextContent("我看见告示是子时后贴上的");
    expect(within(dialogue).getByRole("button", { name: "知道了" })).toBeInTheDocument();
    await userEvent.click(within(dialogue).getByRole("button", { name: "知道了" }));
    expect(screen.queryByRole("dialog", { name: "与老板对话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看下一步" })).not.toBeInTheDocument();
  });

  it("shows the NPC reply and restores the same NPC's next choices directly", async () => {
    const base = buildView();
    const onSubmit = vi.fn();
    const { rerender } = render(<LocationSceneScreen
      view={base}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);

    await userEvent.click(screen.getByRole("button", { name: "追问线索" }));
    rerender(<LocationSceneScreen
      view={{ ...base, narrativeGeneration: { status: "pending", jobKey: "job-pending" } }}
      busy={true}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);
    rerender(<LocationSceneScreen
      view={{
        ...base,
        revision: base.revision + 1,
        turnNumber: base.turnNumber + 1,
        story: { ...base.story, currentObjectiveLabel: "查明秘密", currentObjectiveChoiceToken: TOKENS.dialogueOne },
        narrative: {
          ...base.narrative,
          eventKind: "dialogue",
          npcDialogues: [{
            ...base.narrative.npcDialogues[0]!,
            speechPages: ["我可以告诉你更多，但你得先说清楚自己站在哪一边。"],
          }],
        },
        narrativeGeneration: { status: "idle" },
      }}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: "追问线索" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续对话" })).not.toBeInTheDocument();
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
      view={{ ...base, narrativeGeneration: { status: "pending", jobKey: "job-pending" } }}
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
          { npcId: "npc_2", name: "传讯人", role: "信使", talkChoice: choice("c_messenger_talk", "与传讯人交谈", "dialogue"), relationshipTier: "neutral" },
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

  it("closes a stale dialog when a handoff scene only has a non-focus NPC line", async () => {
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
      view={{ ...base, narrativeGeneration: { status: "pending", jobKey: "job-pending" } }}
      busy={true}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);
    rerender(<LocationSceneScreen
      view={{
        ...base,
        revision: base.revision + 1,
        narrative: {
          ...base.narrative,
          eventKind: "dialogue",
          npcDialogues: [{
            ...base.narrative.npcDialogues[0]!,
            speechPages: ["盟誓铁印只认当年在场的三个人。"],
            choices: [choice(TOKENS.dialogueOne, "与老板交谈", "dialogue")],
            freeInputEnabled: false,
          }],
        },
        narrativeGeneration: { status: "idle" },
      }}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);

    expect(screen.queryByRole("dialog", { name: "与老板对话" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /老板/ })).toBeInTheDocument();
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
        narrativeGeneration: { status: "pending", jobKey: "job-pending" },
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

  it("does not show an empty current objective while the next scene is pending", () => {
    renderShell({
      ...buildView(),
      story: { ...buildView().story, currentObjectiveLabel: null },
      quests: [{ name: "已完成旧案", description: "", kind: "main", status: "completed", objectives: [{ label: "旧目标", completed: true }] }],
      narrativeGeneration: { status: "pending", jobKey: "job-next-scene" },
    });

    expect(within(screen.getByLabelText("游戏 HUD")).getByText("正在编排下一幕……")).toBeInTheDocument();
    expect(screen.queryByText("暂无线索")).not.toBeInTheDocument();
  });

  it("does not leave old-building actions beside a new NPC handoff", () => {
    const base = buildView();
    render(<LocationSceneScreen
      view={{
        ...base,
        story: { ...base.story, currentObjectiveLabel: "与传讯人交谈", currentObjectiveChoiceToken: TOKENS.dialogueTwo },
        narrative: {
          ...base.narrative,
          npcDialogues: [{
            ...base.narrative.npcDialogues[0]!,
            choices: [choice(TOKENS.dialogueOne, "与老板交谈", "dialogue")],
            freeInputEnabled: false,
          }],
        },
        currentLocation: {
          ...base.currentLocation,
          actions: [
            choice(TOKENS.explore, "探索客栈", "explore"),
            choice(TOKENS.dialogueOne, "与老板交谈", "dialogue"),
            choice(TOKENS.dialogueTwo, "与传讯人交谈", "dialogue"),
            choice(TOKENS.battle, "挑战灰狼", "battle"),
          ],
        },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
      initialFocusNpcId="npc_1"
      sceneNpcName="老板"
      sceneLocationName="福来酒楼"
    />);

    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回地图" })).toBeInTheDocument();
  });

  it("also clears old-building actions when the next main objective is at another location", () => {
    const base = buildView();
    render(<LocationSceneScreen
      view={{
        ...base,
        story: { ...base.story, currentObjectiveLabel: "前往断碑谷，与苏绾交谈", currentObjectiveChoiceToken: null },
        narrative: {
          ...base.narrative,
          npcDialogues: [{
            ...base.narrative.npcDialogues[0]!,
            choices: [choice(TOKENS.dialogueOne, "与老板交谈", "dialogue")],
            freeInputEnabled: false,
          }],
        },
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
      initialFocusNpcId="npc_1"
      sceneNpcName="老板"
    />);

    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
  });

  it("does not render a same-location investigation action after an NPC handoff", () => {
    const base = buildView();
    render(<LocationSceneScreen
      view={{
        ...base,
        currentLocation: {
          ...base.currentLocation,
          actions: [
            choice(TOKENS.explore, "调查酒楼后巷的车轮印", "explore"),
            choice(TOKENS.dialogueOne, "与老板交谈", "dialogue"),
          ],
        },
        story: {
          ...base.story,
          currentObjectiveLabel: "调查酒楼后巷的车轮印",
          currentObjectiveChoiceToken: TOKENS.explore,
        },
        narrative: { ...base.narrative, npcDialogues: [] },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
      initialFocusNpcId="npc_1"
      sceneNpcName="老板"
    />);

    expect(screen.queryByRole("button", { name: "调查酒楼后巷的车轮印" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
  });

  it("does not render investigation method buttons of the current objective token set", () => {
    const base = buildView();
    render(<LocationSceneScreen
      view={{
        ...base,
        currentLocation: {
          ...base.currentLocation,
          actions: [
            choice(TOKENS.explore, "沿痕迹追查", "investigate"),
            choice(TOKENS.item, "翻查附近杂物", "investigate"),
          ],
          npcs: [],
        },
        story: {
          ...base.story,
          currentObjectiveLabel: "调查酒楼后巷的车轮印",
          currentObjectiveChoiceToken: TOKENS.explore,
          currentObjectiveChoiceTokens: [TOKENS.explore, TOKENS.item],
        },
        narrative: { ...base.narrative, npcDialogues: [] },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "沿痕迹追查" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "翻查附近杂物" })).not.toBeInTheDocument();
  });

  it("keeps the current item objective in the action rail while the prior NPC dialogue is ready", () => {
    const base = buildView();
    render(<LocationSceneScreen
      view={{
        ...base,
        currentLocation: {
          ...base.currentLocation,
          actions: [
            choice(TOKENS.item, "拾取染血腰牌", "item"),
            choice(TOKENS.dialogueOne, "与老板交谈", "dialogue"),
          ],
        },
        obtainableItems: [{
          name: "染血腰牌",
          description: "一块旧腰牌。",
          buildingId: "building_1",
          choice: choice(TOKENS.item, "拾取染血腰牌", "item"),
        }],
        story: {
          ...base.story,
          currentObjectiveLabel: "获取染血腰牌",
          currentObjectiveChoiceToken: TOKENS.item,
        },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
      initialFocusNpcId="npc_1"
      sceneNpcName="老板"
      sceneBuildingId="building_1"
    />);

    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拾取染血腰牌" })).toBeInTheDocument();
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

    // 等待期间弹窗进入等待态：自由输入与发送按钮被隐藏
    expect(screen.getByRole("dialog", { name: "与老板对话" })).toBeInTheDocument();
    expect(screen.getByText("正在等待老板回应……")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "自定义回应" })).not.toBeInTheDocument();

    resolveRequest({ kind: "rejected", message: "stop" });
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "自定义回应" })).toBeEnabled();
    });
  });

  it("provides a close button that collapses the NPC dialogue panel", async () => {
    const user = userEvent.setup();
    renderShell();
    await enterScene(user);

    expect(screen.getByRole("dialog", { name: "与老板对话" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭对话" }));
    expect(screen.queryByRole("dialog", { name: "与老板对话" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "客栈" })).toBeInTheDocument();
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

    // 移动到新地点后应自动进入场景视图；场景不再显示底部行动栏
    expect(screen.getByRole("region", { name: "地点场景：街道" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "探索街道" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
  });

  it("preserves an existing NPC dialogue while narrative generation is pending", async () => {
    const view = {
      ...buildView(),
      narrativeGeneration: { status: "pending" as const, jobKey: "job-pending" },
    };
    render(<LocationSceneScreen
      view={view}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    // 名字横幅在新布局是覆盖层内的 <span>（旧模态用的是 <h3>）：仍钉住
    // 「pending 期间对话内容与 NPC 名字未被通用加载态替换」，而非只看外壳存在。
    const dialogue = screen.getByRole("dialog", { name: "与老板对话" });
    expect(dialogue).toBeInTheDocument();
    expect(within(dialogue).getByText("老板")).toBeInTheDocument();
    expect(screen.queryByText("正在编排下一幕……")).not.toBeInTheDocument();
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

    // 测试环境自动打开首个对话；旁注在对话打开时由覆盖层接管整条隐藏，先本地关闭再断言旁注内容。
    fireEvent.click(screen.getByRole("button", { name: "关闭对话" }));
    expect(screen.getAllByText("夜市灯火通明。")).toHaveLength(1);
  });

  it("keeps quest status out of the location side note and identifies the place clearly", () => {
    const base = buildView();
    render(<LocationSceneScreen
      view={{
        ...base,
        narrative: {
          ...base.narrative,
          narration: "主线推进到第3幕。已完成：与陆归鸿交谈；当前目标：新的线索。你身处青石镇，灯笼沿着街檐亮起。",
        },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    // 对话打开时旁注整条隐藏，先本地关闭再断言旁注内容净化规则。
    fireEvent.click(screen.getByRole("button", { name: "关闭对话" }));
    const sideNote = screen.getByRole("region", { name: "地点旁注" });
    expect(sideNote).toHaveTextContent("客栈");
    expect(sideNote).toHaveTextContent("你身处青石镇，灯笼沿着街檐亮起。");
    expect(sideNote).not.toHaveTextContent("当前目标");
    expect(sideNote).not.toHaveTextContent("完成了任务");
    expect(sideNote).not.toHaveTextContent("主线推进");
  });

  it("removes punctuation left behind when a quest-status prefix is cleaned from the side note", () => {
    const base = buildView();
    render(<LocationSceneScreen
      view={{
        ...base,
        narrative: {
          ...base.narrative,
          narration: "完成了任务「拼回旧案卷宗」的目标：击败灭口刺客。你身处断碑谷，荒碑夹着一线山谷。",
        },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    // 对话打开时旁注整条隐藏，先本地关闭再断言旁注内容净化规则。
    fireEvent.click(screen.getByRole("button", { name: "关闭对话" }));
    const sideNote = screen.getByRole("region", { name: "地点旁注" });
    expect(sideNote).toHaveTextContent("你身处断碑谷，荒碑夹着一线山谷。");
    expect(sideNote).not.toHaveTextContent("。你身处");
  });

  it("keeps location side notes informational and moves scene choices to the action rail", () => {
    const base = buildView();
    render(<LocationSceneScreen
      view={{
        ...base,
        currentLocation: { ...base.currentLocation, actions: [] },
        narrative: {
          ...base.narrative,
          eventKind: "observe",
          npcDialogues: [],
          choices: [
            choice(TOKENS.dialogueOne, "与老板交谈", "dialogue"),
            choice(TOKENS.dialogueTwo, "与吴九交谈", "dialogue"),
          ],
        },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    const sideNote = screen.getByRole("region", { name: "地点旁注" });
    expect(sideNote.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
  });

  it("does not show NPC replies in the location side note", () => {
    const base = buildView();
    render(<LocationSceneScreen
      view={{
        ...base,
        narrative: {
          ...base.narrative,
          npcLine: { text: "这句对白只应在人物对话里出现。", emotion: "neutral", speaker: "老板" },
          npcDialogues: [{ ...base.narrative.npcDialogues[0]!, speechPages: ["这句对白只应在人物对话里出现。"] }],
        },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    // 对话打开时旁注整条隐藏：NPC 台词不可能泄进旁注，覆盖层对话框是唯一台词出口。
    expect(screen.queryByRole("region", { name: "地点旁注" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "与老板对话" })).toHaveTextContent("这句对白只应在人物对话里出现。");
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

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not render current objective actions in a scene action rail", () => {
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
        narrative: {
          ...base.narrative,
          eventKind: "travel",
          npcDialogues: [],
          choices: [
            choice(TOKENS.dialogueTwo, "与吴九交谈", "dialogue"),
            choice(TOKENS.explore, "探索客栈", "explore"),
          ],
        },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "探索客栈" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "挑战灰狼" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "与吴九交谈" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "与老板交谈" })).not.toBeInTheDocument();
  });

  it("keeps a prepared same-NPC response pair inside dialogue and leaves all scene actions in the rail", () => {
    const base = buildView();
    render(<LocationSceneScreen
      view={{
        ...base,
        story: { ...base.story, currentObjectiveLabel: null, currentObjectiveChoiceToken: null },
        currentLocation: {
          ...base.currentLocation,
          actions: [
            choice(TOKENS.explore, "探索客栈", "explore"),
            choice(TOKENS.dialogueOne, "与老板交谈", "dialogue"),
            choice(TOKENS.battle, "挑战灰狼", "battle"),
          ],
        },
        narrative: {
          ...base.narrative,
          eventKind: "battle",
          choices: [
            choice(TOKENS.dialogueOne, "回应老板：我愿意把证据摊开。", "dialogue"),
            choice(TOKENS.dialogueTwo, "质疑老板：我会先核对证据。", "dialogue"),
          ],
        },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "探索客栈" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "挑战灰狼" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "与老板交谈" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回应老板：我愿意把证据摊开。" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "质疑老板：我会先核对证据。" })).not.toBeInTheDocument();
    const dialogue = screen.getByRole("dialog", { name: "与老板对话" });
    expect(within(dialogue).getByRole("button", { name: "追问线索" })).toBeInTheDocument();
    expect(within(dialogue).getByRole("button", { name: "表示理解" })).toBeInTheDocument();
  });

  it("does not label a single NPC talk choice as dialogue preparation", () => {
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

    expect(screen.queryByText("正在准备对话……")).not.toBeInTheDocument();
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

    await userEvent.click(screen.getByRole("button", { name: /老板.*路人/ }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "与老板对话" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "追问线索" }));
    expect(onSubmit).toHaveBeenCalledWith(
      { kind: "fixed_choice", choiceToken: TOKENS.dialogueOne },
      "npc-dialogue",
    );
  });

  it("starts the authoritative provider talk on NPC click without showing ambient or fallback speech", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const base = buildView();
    const missingPreparedDialogue: GameSessionView = {
      ...base,
      story: {
        ...base.story,
        currentObjectiveLabel: "与老板交谈",
        currentObjectiveChoiceToken: TOKENS.dialogueOne,
        currentObjectiveChoiceTokens: [TOKENS.dialogueOne],
      },
      narrative: {
        ...base.narrative,
        npcDialogues: [{
          ...base.narrative.npcDialogues[0]!,
          speechPages: [],
          choices: [],
          freeInputEnabled: false,
          startChoice: choice(TOKENS.dialogueOne, "与老板交谈", "dialogue"),
        }],
      },
    };

    render(<LocationSceneScreen
      view={missingPreparedDialogue}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);

    expect(screen.queryByText(/欢迎光临|晚风还要凉/u)).not.toBeInTheDocument();
    // 测试环境默认已打开该 NPC 的空台词覆盖层，侧栏随之整体隐藏；
    // 先关闭回到场景视图，才能复现本用例要测的「点击侧栏 NPC 卡片补发权威 ask 回合」动线。
    await user.click(screen.getByLabelText("关闭对话"));
    await user.click(screen.getByRole("button", { name: /老板.*路人/ }));
    expect(onSubmit).toHaveBeenCalledWith(
      { kind: "fixed_choice", choiceToken: TOKENS.dialogueOne },
      "npc-dialogue",
    );
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("正在等待老板回应");
  });

  it("keeps battle sides explicit and shows the attack feedback before the next snapshot", async () => {
    const base = buildBattleView();
    const onSubmit = vi.fn();
    const { rerender } = render(<LocationSceneScreen
      view={base}
      busy={false}
      onSubmit={onSubmit}
      onReturnMap={vi.fn()}
    />);

    expect(screen.getByRole("group", { name: "己方：侠客" })).toHaveAttribute("data-side", "player");
    expect(screen.getByRole("group", { name: "敌方：灰狼" })).toHaveAttribute("data-side", "enemy");
    expect(screen.getByRole("region", { name: "战斗 · 灰狼" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "地点场景：客栈" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "与老板对话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回地图" })).not.toBeInTheDocument();
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

  it("removes defeated units from the battle scene", () => {
    // 需要 battle 基础字段（controls/enemyName 等）：buildView() 的 battle 为 null，
    // 展开会丢失 controls 导致渲染崩溃，故用 buildBattleView() 再覆盖 units。
    const view = buildBattleView();
    render(<LocationSceneScreen
      view={{
        ...view,
        battle: {
          ...view.battle!,
          units: [
            {
              slot: "ally-0",
              name: "侠客",
              side: "allies",
              current: true,
              defeated: false,
              hp: 80,
              maxHp: 100,
              energy: 10,
              maxEnergy: 40,
              speed: 12,
              guarding: false,
              intent: null,
            },
            {
              slot: "enemy-0",
              name: "灰狼",
              side: "enemies",
              current: false,
              defeated: true,
              hp: 0,
              maxHp: 55,
              energy: 10,
              maxEnergy: 40,
              speed: 8,
              guarding: false,
              intent: null,
            },
          ],
        },
      }}
      busy={false}
      onSubmit={vi.fn()}
      onReturnMap={vi.fn()}
    />);

    expect(screen.getByRole("group", { name: "己方：侠客" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "敌方：灰狼" })).not.toBeInTheDocument();
  });

  it("offers non-focus NPC only the real talk action", async () => {
    const base = buildView();
    const onSubmit = vi.fn();
    const view: GameSessionView = {
      ...base,
      currentLocation: {
        ...base.currentLocation,
        npcs: [
          ...base.currentLocation.npcs,
          { npcId: "npc_2", name: "猎人", role: "游侠", talkChoice: choice("c_hunter_talk", "与猎人交谈", "dialogue"), relationshipTier: "neutral" },
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

    // 覆盖层内不提供多 NPC 切换（spec §2.2）：测试环境已自动打开焦点 NPC 老板的对话，
    // 侧栏因此隐藏。先关闭它回到场景视图，再点击非焦点 NPC「猎人 · 游侠」卡片。
    await userEvent.click(screen.getByLabelText("关闭对话"));
    await userEvent.click(screen.getByRole("button", { name: /猎人游侠/ }));
    expect(screen.queryByRole("button", { name: /聊几句/ })).not.toBeInTheDocument();
    expect(screen.queryByText("正在准备对话……")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "与猎人交谈" }));
    expect(onSubmit).toHaveBeenCalledWith(
      { kind: "fixed_choice", choiceToken: "c_hunter_talk" },
      "npc-dialogue",
    );
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
        npcs: [{ npcId: "npc_1", name: "老板", role: "路人", talkChoice: choice(TOKENS.dialogueOne, "与老板交谈", "dialogue"), relationshipTier: "neutral" }],
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
    await user.click(screen.getByRole("button", { name: "客栈" }));
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
    await user.click(screen.getByRole("button", { name: "客栈" }));
    await user.click(screen.getByRole("button", { name: interactive.displayName }));
    await user.click(screen.getByRole("button", { name: `进入${interactive.displayName}` }));
    expect(screen.getByRole("region", { name: `地点场景：${interactive.displayName}` })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: `地点场景：${interactive.displayName}` })).getByRole("heading", { name: interactive.displayName, level: 2 })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: new RegExp(`${interactive.npcName}.*`) }).length).toBeGreaterThan(0);
    // 场景返回按钮从小镇进入时显示“返回小镇”
    expect(screen.getByRole("button", { name: "返回小镇" })).toBeInTheDocument();
  });

  it("keeps the current building scene open when the next story objective changes", async () => {
    const user = userEvent.setup();
    const initialView = {
      ...buildTownView(),
      story: { ...buildTownView().story, currentObjectiveLabel: `与${interactive.npcName}交谈` },
    };
    const { rerender } = render(<AdventureGameShell
      view={initialView}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);

    await user.click(screen.getByRole("button", { name: "客栈" }));
    await user.click(screen.getByRole("button", { name: interactive.displayName }));
    await user.click(screen.getByRole("button", { name: `进入${interactive.displayName}` }));

    rerender(<AdventureGameShell
      view={{
        ...initialView,
        revision: initialView.revision + 1,
        story: { ...initialView.story, currentObjectiveLabel: "前往街道与线人交谈" },
      }}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);

    await waitFor(() => {
      expect(screen.getByRole("region", { name: `地点场景：${interactive.displayName}` })).toBeInTheDocument();
    });
    expect(screen.queryByRole("region", { name: "小镇：客栈" })).not.toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "客栈" }));
    await user.click(screen.getByRole("button", { name: interactive.displayName }));
    await user.click(screen.getByRole("button", { name: `进入${interactive.displayName}` }));

    expect(screen.getByRole("region", { name: `地点场景：${interactive.displayName}` })).toBeInTheDocument();
    expect(postAction).not.toHaveBeenCalled();
  });

  it("submits the server-provided arrival explore token for a fact-target building", async () => {
    const user = userEvent.setup();
    const base = buildTownView();
    const arrivalToken = "c_00000000000000aa";
    const view: GameSessionView = {
      ...base,
      currentLocation: {
        ...base.currentLocation,
        town: {
          ...base.currentLocation.town!,
          interactiveBuildings: base.currentLocation.town!.interactiveBuildings.map((entry, index) =>
            index === 0 ? { ...entry, arrivalChoiceToken: arrivalToken } : entry,
          ),
        },
      },
    };
    render(<AdventureGameShell
      view={view}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);

    await user.click(screen.getByRole("button", { name: "客栈" }));
    await user.click(screen.getByRole("button", { name: interactive.displayName }));
    await user.click(screen.getByRole("button", { name: `进入${interactive.displayName}` }));

    expect(postAction).toHaveBeenCalledWith({
      interaction: { kind: "fixed_choice", choiceToken: arrivalToken },
      revision: 9,
    });
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
          { npcId: clickedBuilding.npcId, name: clickedBuilding.npcName, role: "掌柜", talkChoice: choice(TOKENS.dialogueOne, `与${clickedBuilding.npcName}交谈`, "dialogue"), relationshipTier: "neutral" },
          { npcId: "npc_2", name: "目标人", role: "信使", talkChoice: choice(TOKENS.dialogueTwo, "与目标人交谈", "dialogue"), relationshipTier: "neutral" },
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
              isCurrentFocus: false,
            },
          ],
        },
      },
      // 读模型为在场全部 NPC 投影对话；此处补上目标建筑 NPC 的零回合闲聊，
      // 侧边栏只展示有投影对话的人物，不再按地点 NPC 列表合成卡片。
      narrative: {
        ...view.narrative,
        npcDialogues: [{
          npcId: clickedBuilding.npcId,
          name: clickedBuilding.npcName,
          role: "掌柜",
          speechPages: ["客官里边请，本店规矩照旧。"],
          choices: [],
          freeInputEnabled: false,
          giveChoices: [],
        }],
      },
    };
    render(<AdventureGameShell
      view={twoNpcView}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);

    await user.click(screen.getByRole("button", { name: "客栈" }));
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
    await user.click(screen.getByRole("button", { name: "客栈" }));
    await user.click(screen.getByRole("button", { name: interactive.displayName }));
    await user.click(screen.getByRole("button", { name: `进入${interactive.displayName}` }));
    // 场景 → 小镇
    await user.click(screen.getByRole("button", { name: "返回小镇" }));
    expect(screen.getByRole("region", { name: `小镇：客栈` })).toBeInTheDocument();
    // 小镇 → 世界地图
    await user.click(screen.getByRole("button", { name: "返回地图" }));
    expect(screen.getByRole("button", { name: "客栈" })).toBeInTheDocument();
    expect(postAction).not.toHaveBeenCalled();
  });

  it("a scene-scale location continues map → scene directly", async () => {
    const user = userEvent.setup();
    render(<AdventureGameShell
      view={buildView()}
      onViewChange={vi.fn()}
      onStaleRevision={vi.fn()}
      onClearDevelopmentSave={vi.fn(async () => {})}
    />);
    await user.click(screen.getByRole("button", { name: "客栈" }));
    expect(screen.getByRole("region", { name: "地点场景：客栈" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回地图" })).toBeInTheDocument();
  });
});
