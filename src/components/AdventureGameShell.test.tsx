import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameSessionView } from "@/game/application";
import { AdventureGameShell } from "./AdventureGameShell";
import { LocationSceneScreen } from "./LocationSceneScreen";
import { postAction, type ActionOutcome } from "./gameActionRequest";

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

function choice(choiceToken: string, label: string, presentation: "dialogue" | "travel" | "explore" | "item" | "battle" | "rest") {
  return { choiceToken, label, presentation } as const;
}

function buildView(): GameSessionView {
  return {
    revision: 9,
    gameType: "wuxia",
    player: { name: "侠客", identity: "剑客", hp: 90, attack: 10, defense: 5 },
    worldMap: {
      locations: [
        { name: "客栈", current: true, visited: true, travelChoice: null },
        { name: "街道", current: false, visited: false, travelChoice: choice(TOKENS.travel, "前往街道", "travel") },
      ],
    },
    currentLocation: {
      name: "客栈", description: "一间客栈",
      actions: [choice(TOKENS.explore, "探索客栈", "explore")],
    },
    obtainableItems: [{ name: "铜钥匙", description: "旧钥匙", choice: choice(TOKENS.item, "拾取铜钥匙", "item") }],
    inventory: [],
    story: { currentAct: 1, targetActs: 3, tension: 30, pacingNeed: "reveal", storyProgress: 5 },
    narrative: {
      mode: "offline", hasScene: true, narration: "老板压低声音。", choices: [], npcLine: null,
      npcDialogues: [{
        npcId: "npc_1", name: "老板", role: "路人", speechPages: ["此事不可声张。"],
        choices: [
          choice(TOKENS.dialogueOne, "追问线索", "dialogue"),
          choice(TOKENS.dialogueTwo, "表示理解", "dialogue"),
        ],
        freeInputEnabled: true,
      }],
    },
    narrativeGeneration: { status: "idle" },
    battle: {
      enemyName: "灰狼", playerHp: 90, enemyHp: 12, round: 2,
      controls: [choice(TOKENS.battle, "攻击", "battle")],
    },
    quests: [{ name: "查明真相", description: "追寻线索", kind: "main", status: "active", objectives: [{ label: "发现秘密", completed: false }] }],
    prologueShown: true,
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

    expect((screen.getByRole("button", { name: "表示理解" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "自定义回应" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "探索客栈" }) as HTMLButtonElement).disabled).toBe(true);

    resolveRequest({ kind: "rejected", message: "stop" });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "表示理解" }) as HTMLButtonElement).disabled).toBe(false);
    });
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

    expect((screen.getByRole("textbox", { name: "自定义回应" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "追问线索" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "探索客栈" }) as HTMLButtonElement).disabled).toBe(true);

    resolveRequest({ kind: "rejected", message: "stop" });
    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "自定义回应" }) as HTMLInputElement).disabled).toBe(false);
    });
  });

  it("provides a close button that collapses the NPC dialogue panel", async () => {
    const user = userEvent.setup();
    renderShell();
    await enterScene(user);

    expect(screen.getByRole("heading", { name: "老板" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭对话" }));
    expect(screen.queryByRole("heading", { name: "老板" })).not.toBeInTheDocument();
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
});
