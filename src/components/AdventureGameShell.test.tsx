import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameSessionView } from "@/game/application";
import { AdventureGameShell } from "./AdventureGameShell";
import { postAction } from "./gameActionRequest";

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
        { id: "loc_1", name: "客栈", current: true, visited: true, travelChoice: null },
        { id: "loc_2", name: "街道", current: false, visited: false, travelChoice: choice(TOKENS.travel, "前往街道", "travel") },
      ],
    },
    currentLocation: {
      id: "loc_1", name: "客栈", description: "一间客栈",
      actions: [choice(TOKENS.explore, "探索客栈", "explore")],
    },
    obtainableItems: [{ itemId: "item_key", name: "铜钥匙", description: "旧钥匙", choice: choice(TOKENS.item, "拾取铜钥匙", "item") }],
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
    quests: [{ id: "q1", name: "查明真相", description: "追寻线索", kind: "main", status: "active", objectives: [{ label: "发现秘密", completed: false }] }],
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

afterEach(() => {
  cleanup();
  vi.mocked(postAction).mockClear();
});

describe("AdventureGameShell canonical opaque choices", () => {
  for (const [label, token] of [
    ["追问线索", TOKENS.dialogueOne],
    ["表示理解", TOKENS.dialogueTwo],
    ["前往街道", TOKENS.travel],
    ["探索客栈", TOKENS.explore],
    ["拾取铜钥匙", TOKENS.item],
    ["攻击", TOKENS.battle],
  ] as const) {
    it(`forwards the server token for ${label}`, async () => {
      renderShell();
      await userEvent.click(screen.getByRole("button", { name: label }));
      expect(postAction).toHaveBeenCalledWith({
        interaction: { kind: "fixed_choice", choiceToken: token },
        revision: 9,
      });
    });
  }

  it("forwards custom dialogue input without constructing a semantic token", async () => {
    renderShell();
    await userEvent.type(screen.getByRole("textbox", { name: "自定义回应" }), "  我相信你  ");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(postAction).toHaveBeenCalledWith({
      interaction: { kind: "free_text", text: "我相信你", targetNpcId: "npc_1" },
      revision: 9,
    });
  });
});
