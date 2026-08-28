import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GameSessionView, NpcDialogueView } from "@/game/application";
import { LocationSceneScreen } from "./LocationSceneScreen";

/** 回归夹具：历史 view 仍可能带 investigate presentation，但地点页不再渲染它。 */
function viewWithInvestigationApproaches(): GameSessionView {
  return {
    revision: 9,
    turnNumber: 8,
    gameType: "wuxia",
    setup: { storyOpening: null, worldPremise: null, characterProfile: null, narrativeStyle: null },
    player: { name: "侠客", identity: "剑客", hp: 90, attack: 10, defense: 5 },
    worldMap: {
      locations: [
        { name: "客栈", current: true, visited: true, scale: "scene", travelChoice: null },
      ],
    },
    currentLocation: {
      name: "客栈", description: "一间客栈", scale: "scene",
      actions: [
        { choiceToken: "c_follow", label: "沿痕迹追查", presentation: "investigate" },
        { choiceToken: "c_search", label: "翻查附近杂物", presentation: "investigate" },
      ],
      npcs: [],
      town: null,
    },
    obtainableItems: [],
    inventory: [],
    story: {
      currentAct: 1, targetActs: 3, tension: 30, pacingNeed: "reveal", storyProgress: 5,
      currentObjectiveLabel: "调查酒楼后巷的车轮印",
      currentObjectiveChoiceToken: "c_follow",
      currentObjectiveChoiceTokens: ["c_follow", "c_search"],
    },
    narrative: {
      mode: "offline", hasScene: true, narration: "车轮印断续向北延伸。", choices: [], npcLine: null, npcDialogues: [],
    },
    narrativeGeneration: { status: "idle" },
    battle: null,
    quests: [{ name: "追查车轮印", description: "查明去向", kind: "main", status: "active", objectives: [{ label: "调查酒楼后巷的车轮印", completed: false }] }],
    prologueShown: true,
    prologueText: "",
    ending: null,
  };
}

describe("LocationSceneScreen：调查和底部行动栏已移除", () => {
  it("does not render investigation buttons or the bottom action rail", () => {
    render(<LocationSceneScreen view={viewWithInvestigationApproaches()} busy={false} onSubmit={vi.fn()} onReturnMap={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "沿痕迹追查" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "翻查附近杂物" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
  });

  it("renders the sole AI boundary-preparation action so a completed act cannot dead-end", () => {
    const onSubmit = vi.fn();
    const view: GameSessionView = {
      ...viewWithInvestigationApproaches(),
      currentLocation: {
        ...viewWithInvestigationApproaches().currentLocation,
        actions: [{ choiceToken: "c_boundary", label: "继续追查下一幕线索", presentation: "explore" }],
      },
      story: {
        ...viewWithInvestigationApproaches().story,
        currentObjectiveLabel: null,
        currentObjectiveChoiceToken: null,
        currentObjectiveChoiceTokens: [],
      },
      narrative: {
        ...viewWithInvestigationApproaches().narrative,
        mode: "ai",
      },
    };

    render(<LocationSceneScreen view={view} busy={false} onSubmit={onSubmit} onReturnMap={vi.fn()} />);

    const button = screen.getByRole("button", { name: "继续追查下一幕线索" });
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledWith({ kind: "fixed_choice", choiceToken: "c_boundary" });
  });
});

const veraAmbient: NpcDialogueView = {
  npcId: "npc_1",
  name: "薇拉",
  role: "酒保女儿",
  speechPages: ["最近来问井的事的人不少。"],
  choices: [],
  freeInputEnabled: false,
  giveChoices: [],
};

function viewWithVeraDialogue(dialogue: NpcDialogueView = veraAmbient): GameSessionView {
  const base = viewWithInvestigationApproaches();
  return {
    ...base,
    currentLocation: {
      ...base.currentLocation,
      actions: [{ choiceToken: "c_boundary", label: "继续追查下一幕线索", presentation: "explore" }],
      npcs: [{ npcId: "npc_1", name: "薇拉", role: "酒保女儿", talkChoice: null, relationshipTier: "friendly" }],
    },
    story: {
      ...base.story,
      currentObjectiveLabel: null,
      currentObjectiveChoiceToken: null,
      currentObjectiveChoiceTokens: [],
    },
    narrative: { ...base.narrative, mode: "ai", npcDialogues: [dialogue] },
  };
}

/**
 * ready 焦点对话（审查 Finding B）：`gameSessionView.ts:776-787` 在 formalDialogueReady 时
 * 把整只背包映射成 giveChoices，所以真实数据里这一行恒为非空。全部既有夹具都写
 * `giveChoices: []`，赠物行从未被任何集成用例渲染过。这里按投影形状补一份焦点对白。
 */
const veraFocus: NpcDialogueView = {
  ...veraAmbient,
  speechPages: ["井边那晚我也听见了动静。", "之后灯就灭了，没人肯说看见什么。"],
  choices: [
    { choiceToken: "token_a", label: "你看见谁了？", presentation: "dialogue" },
    { choiceToken: "token_b", label: "我想帮你查清楚。", presentation: "dialogue" },
  ],
  freeInputEnabled: true,
  giveChoices: [
    { itemName: "药草", choice: { choiceToken: "token_give", label: "把药草交给薇拉", presentation: "item" } },
  ],
};

describe("LocationSceneScreen：对话覆盖层集成", () => {
  it("对话打开时隐藏侧栏与行动栏，徽标按显示 NPC 匹配档位文案", () => {
    render(<LocationSceneScreen view={viewWithVeraDialogue()} busy={false} onSubmit={vi.fn()} onReturnMap={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "与薇拉对话" })).toBeInTheDocument();
    expect(screen.queryByLabelText("场景人物")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "行动栏" })).toBeNull();
    expect(screen.getByText(/薇拉 · 友善/)).toBeInTheDocument();
  });

  it("显示对话的 npcId 不在 currentLocation.npcs 时隐藏徽标", () => {
    const base = viewWithVeraDialogue();
    const view: GameSessionView = {
      ...base,
      currentLocation: { ...base.currentLocation, npcs: [] },
    };
    render(<LocationSceneScreen view={view} busy={false} onSubmit={vi.fn()} onReturnMap={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "与薇拉对话" })).toBeInTheDocument();
    expect(screen.queryByText(/友善/)).toBeNull();
  });

  // 审查 Finding B：giveChoices 在真实 ready 焦点对话里恒为非空（整只背包映射），
  // 但既有夹具全是 []，赠物行从未走过整条链路。这里用投影形态的夹具补一次。
  it("ready 焦点对话的赠物行与固定回应在读模型链路上可区分，点击仍只提交 opaque choiceToken", () => {
    const onSubmit = vi.fn();
    render(
      <LocationSceneScreen
        view={viewWithVeraDialogue(veraFocus)}
        busy={false}
        onSubmit={onSubmit}
        onReturnMap={vi.fn()}
      />,
    );
    const dialogue = screen.getByRole("dialog", { name: "与薇拉对话" });
    // 审查 Finding A：对话期间侧栏被卸载，身份行必须在覆盖层内可见。
    expect(within(dialogue).getByText("酒保女儿")).toBeInTheDocument();

    // 翻到末页才出现选项面板。
    fireEvent.click(within(dialogue).getByText("井边那晚我也听见了动静。"));
    const panel = within(dialogue).getByRole("group", { name: "对话选项" });
    const giveGroup = within(panel).getByRole("group", { name: "给予道具" });
    expect(within(giveGroup).getByRole("button", { name: "把药草交给薇拉" })).toBeInTheDocument();
    // 赠物不是"另一句回话"：固定回应留在外层面板、不在赠物分组内。
    expect(within(giveGroup).queryByRole("button", { name: "你看见谁了？" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "你看见谁了？" })).toBeInTheDocument();
    expect(
      within(panel).getByText("自定义输入仅用于对白；交付道具请点击上方选项。"),
    ).toBeInTheDocument();

    fireEvent.click(within(giveGroup).getByRole("button", { name: "把药草交给薇拉" }));
    // 提交链路不变：只消费服务端 opaque choiceToken，经地点页唯一 onSubmit 出口。
    expect(onSubmit).toHaveBeenCalledWith({ kind: "fixed_choice", choiceToken: "token_give" }, "npc-dialogue");
  });
});
