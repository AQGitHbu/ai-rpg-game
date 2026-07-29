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
  it("渲染 NPC 名称、身份和 role=dialog", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <NpcDialoguePanel
        dialogue={getNpcDialogue("npc_lu")}
        onChoice={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("陆掌柜")).toBeInTheDocument();
    expect(screen.getByText("客栈掌柜")).toBeInTheDocument();
  });

  it("review_clue 点击只展开线索文本，零 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onChoice = vi.fn();
    const user = userEvent.setup();

    render(
      <NpcDialoguePanel
        dialogue={getNpcDialogue("npc_lu")}
        onChoice={onChoice}
        onClose={vi.fn()}
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
        onChoice={onChoice}
        onClose={vi.fn()}
        busy={false}
      />
    );

    await user.click(screen.getByRole("button", { name: "与捕头赵五初次交谈" }));

    expect(onChoice).toHaveBeenCalledWith("npc_zhao", "npc_zhao:greet");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("关闭对话触发 onClose，零 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <NpcDialoguePanel
        dialogue={getNpcDialogue("npc_lu")}
        onChoice={vi.fn()}
        onClose={onClose}
        busy={false}
      />
    );

    await user.click(screen.getByRole("button", { name: "关闭对话" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("busy 时写状态 choice 禁用，review_clue 和关闭仍可用", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <NpcDialoguePanel
        dialogue={getNpcDialogue("npc_zhao")}
        onChoice={vi.fn()}
        onClose={vi.fn()}
        busy
      />
    );

    expect(screen.getByRole("button", { name: "与捕头赵五初次交谈" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "回顾已知线索" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭对话" })).not.toBeDisabled();
  });

  it("关闭按钮键盘可达（Escape 关闭）", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <NpcDialoguePanel
        dialogue={getNpcDialogue("npc_lu")}
        onChoice={vi.fn()}
        onClose={onClose}
        busy={false}
      />
    );

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
