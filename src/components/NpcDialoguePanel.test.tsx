import { render, screen, within } from "@testing-library/react";
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

// fixture 契约：npc_lu 单页对白（无翻页），npc_zhao 两页对白（有翻页）。
const LU = () => getNpcDialogue("npc_lu");
const ZHAO = () => getNpcDialogue("npc_zhao");

describe("NpcDialoguePanel：左侧立绘与名字", () => {
  it("左侧立绘区渲染 NPC 名字与身份", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <NpcDialoguePanel dialogue={LU()} gameType="wuxia" onChoice={vi.fn()} busy={false} />
    );

    const figure = screen.getByTestId("npc-dialogue-figure");
    expect(within(figure).getByText("陆掌柜")).toBeInTheDocument();
    expect(within(figure).getByText("客栈掌柜")).toBeInTheDocument();
  });
});

describe("NpcDialoguePanel：右侧对白分页", () => {
  it("显示第一页对白；单页时不渲染翻页按钮与页码", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <NpcDialoguePanel dialogue={LU()} gameType="wuxia" onChoice={vi.fn()} busy={false} />
    );

    expect(
      screen.getByText("陆掌柜擦着酒碗抬起头。又见面了，若有新的发现，随时可以来找我。")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上一页" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下一页" })).not.toBeInTheDocument();
  });

  it("多页时渲染翻页按钮：首页上一页禁用，下一页翻到第二页后下一页禁用", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    const zhao = ZHAO();
    render(
      <NpcDialoguePanel dialogue={zhao} gameType="wuxia" onChoice={vi.fn()} busy={false} />
    );

    // 第一页可见，第二页不可见；页码 1 / 2。
    expect(screen.getByText(zhao.speechPages[0])).toBeInTheDocument();
    expect(screen.queryByText(zhao.speechPages[1])).not.toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    const prev = screen.getByRole("button", { name: "上一页" });
    const next = screen.getByRole("button", { name: "下一页" });
    expect(prev).toBeDisabled();
    expect(next).toBeEnabled();

    await user.click(next);
    expect(screen.getByText(zhao.speechPages[1])).toBeInTheDocument();
    expect(screen.queryByText(zhao.speechPages[0])).not.toBeInTheDocument();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(prev).toBeEnabled();
    expect(next).toBeDisabled();

    await user.click(prev);
    expect(screen.getByText(zhao.speechPages[0])).toBeInTheDocument();
  });

  it("翻页按钮使用装饰性 SVG 图标（aria-hidden），翻页零 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <NpcDialoguePanel dialogue={ZHAO()} gameType="wuxia" onChoice={vi.fn()} busy={false} />
    );

    const next = screen.getByRole("button", { name: "下一页" });
    expect(next.querySelector("svg")).not.toBeNull();
    expect(next.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    await user.click(next);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("NpcDialoguePanel：底部选项", () => {
  it("选项按编号渲染，greet 选择提交精确的 dialogue_choice payload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onChoice = vi.fn();
    const user = userEvent.setup();

    render(
      <NpcDialoguePanel dialogue={ZHAO()} gameType="wuxia" onChoice={onChoice} busy={false} />
    );

    await user.click(screen.getByRole("button", { name: "1. 与捕头赵五初次交谈" }));

    expect(onChoice).toHaveBeenCalledWith("npc_zhao", "npc_zhao:greet");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("review_clue 点击只展开线索文本，零 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onChoice = vi.fn();
    const user = userEvent.setup();

    render(
      <NpcDialoguePanel dialogue={LU()} gameType="wuxia" onChoice={onChoice} busy={false} />
    );

    await user.click(screen.getByRole("button", { name: "1. 回顾已知线索" }));

    expect(screen.getByText("【玩家输入】沈青崖自述身份：落魄镖师")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onChoice).not.toHaveBeenCalled();
  });

  it("busy 时写状态 choice 禁用，review_clue 仍可用", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <NpcDialoguePanel dialogue={ZHAO()} gameType="wuxia" onChoice={vi.fn()} busy />
    );

    expect(screen.getByRole("button", { name: "1. 与捕头赵五初次交谈" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "2. 回顾已知线索" })).not.toBeDisabled();
  });
});

describe("NpcDialoguePanel：自由输入", () => {
  it("输入框与发送按钮存在；发送后显示本地确定性回应、清空输入、零 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onChoice = vi.fn();
    const user = userEvent.setup();

    render(
      <NpcDialoguePanel dialogue={ZHAO()} gameType="wuxia" onChoice={onChoice} busy={false} />
    );

    const input = screen.getByPlaceholderText("请输入你的话...");
    await user.type(input, "你见过刺客吗？");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(
      screen.getByText("捕头赵五沉吟片刻，没有接你的话。（自由对话尚未开放）")
    ).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onChoice).not.toHaveBeenCalled();
  });

  it("空输入发送不产生回应", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();

    render(
      <NpcDialoguePanel dialogue={ZHAO()} gameType="wuxia" onChoice={vi.fn()} busy={false} />
    );

    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(screen.queryByText(/自由对话尚未开放/)).not.toBeInTheDocument();
  });
});
