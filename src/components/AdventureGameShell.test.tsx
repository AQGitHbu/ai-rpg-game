import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompatibilityGameSessionView } from "@/game/application/gameSessionView";
import { AdventureGameShell } from "./AdventureGameShell";
import { postAction } from "./gameActionRequest";

vi.mock("./gameActionRequest", () => ({
  postAction: vi.fn(),
}));

const view: CompatibilityGameSessionView = {
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

describe("AdventureGameShell unified NPC input", () => {
  it("自定义输入与固定选择共用 postAction，且从不调用 standalone dialogue helper", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(postAction).mockResolvedValue({
      kind: "success",
      view: { ...view, revision: 8 },
      message: "Action performed",
    });
    const user = userEvent.setup();
    render(
      <AdventureGameShell
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

    await waitFor(() => expect(postAction).toHaveBeenCalledWith({
      interaction: { kind: "free_text", text: "我相信你", targetNpcId: "npc_1" },
      revision: 7,
    }));
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/game/npc/dialogue",
      expect.anything(),
    );
  });
});
