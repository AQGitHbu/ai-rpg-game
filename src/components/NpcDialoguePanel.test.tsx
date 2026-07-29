import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NpcDialoguePanel } from "./NpcDialoguePanel";
import { buildSessionViewFixture } from "./sessionViewFixture.testutil";
import type { NpcDialogueView } from "@/game/application";

afterEach(() => {
  vi.unstubAllGlobals();
});

function getNpcDialogue(npcId: string): NpcDialogueView {
  const view = buildSessionViewFixture();
  const dialogue = view.dialogues.find((d) => d.npcId === npcId);
  if (dialogue === undefined) throw new Error(`NPC ${npcId} not found in fixture`);
  return dialogue;
}

describe("NpcDialoguePanel", () => {
  it("渲染 NPC 肖像、名称和身份", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <NpcDialoguePanel
        dialogue={getNpcDialogue("npc_lu")}
        gameType="wuxia"
        onChoice={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByText("陆掌柜")).toBeInTheDocument();
    expect(screen.getByText("客栈掌柜")).toBeInTheDocument();
  });

  it("显示中性开场语", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <NpcDialoguePanel
        dialogue={getNpcDialogue("npc_lu")}
        gameType="wuxia"
        onChoice={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByText("陆掌柜向你点了点头。")).toBeInTheDocument();
  });

  it("review_clue 点击只展开线索文本，零 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onChoice = vi.fn();
    const user = userEvent.setup();

    render(
      <NpcDialoguePanel
        dialogue={getNpcDialogue("npc_lu")}
        gameType="wuxia"
        onChoice={onChoice}
        busy={false}
      />
    );

    await user.click(screen.getByRole("button", { name: "回顾已知线索" }));

    expect(screen.getByText("【玩家输入】沈青崖自述身份：落魄镖师")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onChoice).not.toHaveBeenCalled();
  });

  it("greet 选择提交精确的 dialogue_choice payload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onChoice = vi.fn();
    const user = userEvent.setup();

    render(
      <NpcDialoguePanel
        dialogue={getNpcDialogue("npc_zhao")}
        gameType="wuxia"
        onChoice={onChoice}
        busy={false}
      />
    );

    await user.click(screen.getByRole("button", { name: "与捕头赵五初次交谈" }));

    expect(onChoice).toHaveBeenCalledWith("npc_zhao", "npc_zhao:greet");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("busy 时写状态 choice 禁用，review_clue 仍可用", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <NpcDialoguePanel
        dialogue={getNpcDialogue("npc_zhao")}
        gameType="wuxia"
        onChoice={vi.fn()}
        busy
      />
    );

    expect(screen.getByRole("button", { name: "与捕头赵五初次交谈" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "回顾已知线索" })).not.toBeDisabled();
  });
});
