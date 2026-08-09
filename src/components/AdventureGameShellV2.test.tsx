import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameSessionViewV2 } from "@/game/application/gameSessionViewV2";
import { AdventureGameShellV2 } from "./AdventureGameShellV2";
import { postV2Action } from "./gameActionRequestV2";

vi.mock("./gameActionRequestV2", () => ({
  postV2Action: vi.fn(),
}));

const view: GameSessionViewV2 = {
  revision: 7,
  gameType: "wuxia",
  player: { name: "侠客", identity: "剑客", hp: 100, attack: 10, defense: 5 },
  currentLocation: { id: "loc_1" as never, name: "客栈", description: "一间客栈" },
  availableNpcs: [{ id: "npc_1" as never, name: "老板", role: "掌柜", met: true }],
  availableMoves: [],
  inventory: [],
  story: { currentAct: 1, targetActs: 3, tension: 30, pacingNeed: "reveal", storyProgress: 10 },
  narrative: {
    mode: "ai",
    hasScene: true,
    eventKind: "dialogue",
    narration: "老板等着你的问题。",
    choices: [],
    npcLine: { npcId: "npc_1", text: "请讲。", emotion: "neutral" },
    npcDialogues: [{
      npcId: "npc_1",
      npcName: "老板",
      npcRole: "掌柜",
      speechPages: ["请讲。"],
      choices: [
        { choiceToken: "tok_1", label: "询问近况" },
        { choiceToken: "tok_2", label: "质疑说法" },
      ],
      freeInputEnabled: true,
    }],
  },
  battle: null,
  quests: [],
  prologueShown: true,
  ending: null,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("AdventureGameShellV2 unified NPC input", () => {
  it("自定义输入与固定选择共用 postV2Action，且从不调用 standalone dialogue helper", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(postV2Action).mockResolvedValue({
      kind: "success",
      view: { ...view, revision: 8 },
      message: "Action performed",
    });
    const user = userEvent.setup();
    render(
      <AdventureGameShellV2
        view={view}
        onViewChange={vi.fn()}
        onStaleRevision={vi.fn()}
        onClearDevelopmentSave={vi.fn(async () => undefined)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "进入客栈" }));
    await user.click(screen.getByRole("button", { name: "老板，掌柜" }));
    await user.type(screen.getByRole("textbox", { name: "自由输入" }), "我相信你");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(postV2Action).toHaveBeenCalledWith({
      interaction: { kind: "free_text", text: "我相信你", targetNpcId: "npc_1" },
      revision: 7,
    }));
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/v2/game/npc/dialogue",
      expect.anything(),
    );
  });
});
