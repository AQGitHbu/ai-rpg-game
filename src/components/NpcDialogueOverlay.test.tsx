import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { NpcDialogueOverlay, reduceDialogueUiState } from "./NpcDialogueOverlay";
import type { DialogueUiState } from "./NpcDialogueOverlay";
import type { NpcDialogueView } from "@/game/application";

export function makeDialogue(overrides?: Partial<NpcDialogueView>): NpcDialogueView {
  return {
    npcId: "npc_1",
    name: "薇拉",
    role: "酒馆老板的女儿",
    speechPages: ["那天夜里井边传来很奇怪的声音。", "我去看了一眼，但什么都没看清。"],
    choices: [
      { choiceToken: "token_a", label: "后来那口井里到底出了什么事？", presentation: "dialogue" },
      { choiceToken: "token_b", label: "我想帮你查清楚。", presentation: "dialogue" },
    ],
    freeInputEnabled: true,
    giveChoices: [],
    ...overrides,
  };
}

function renderOverlay(overrides?: Partial<ComponentProps<typeof NpcDialogueOverlay>>) {
  const props = {
    dialogue: makeDialogue(),
    gameType: "wuxia" as const,
    busy: false,
    phase: "choice" as const,
    pendingPlayerResponse: null,
    pendingChoiceToken: null,
    resetInputNonce: 0,
    handoffAcknowledgement: null,
    relationshipTier: "friendly" as const,
    onSubmit: vi.fn(),
    onAcknowledge: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<NpcDialogueOverlay {...props} />), props };
}

describe("NpcDialogueOverlay 骨架", () => {
  it("渲染名字横幅、当前页台词、关闭按钮与占位头像首字", () => {
    renderOverlay();
    expect(screen.getByRole("dialog", { name: "与薇拉对话" })).toBeTruthy();
    expect(screen.getByText("薇拉")).toBeTruthy();
    expect(screen.getByText("那天夜里井边传来很奇怪的声音。")).toBeTruthy();
    expect(screen.getByLabelText("关闭对话")).toBeTruthy();
    expect(screen.getByText("薇", { selector: ".npc-dialogue-overlay-avatar" })).toBeTruthy();
  });

  it("右上角徽标显示档位文案，不显示数值", () => {
    renderOverlay();
    const badge = screen.getByText(/薇拉 · 友善/);
    expect(badge).toBeTruthy();
    expect(badge.textContent).not.toMatch(/\d/);
  });

  it("relationshipTier 为 null 时隐藏徽标", () => {
    renderOverlay({ relationshipTier: null });
    expect(screen.queryByText(/· 友善/)).toBeNull();
  });

  it("点击关闭调用 onClose", async () => {
    const user = userEvent.setup();
    const { props } = renderOverlay();
    await user.click(screen.getByLabelText("关闭对话"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("打开时对话框获得焦点；关闭（卸载）后焦点回到原元素", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    const { unmount } = renderOverlay();
    // 覆盖层挂载即把焦点移入对话框，键盘翻页可用。
    expect(screen.getByRole("dialog", { name: "与薇拉对话" }).contains(document.activeElement)).toBe(true);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe("NpcDialogueOverlay 翻页", () => {
  it("首页隐藏选项面板并显示翻页箭头", () => {
    renderOverlay();
    expect(screen.queryByLabelText("对话选项")).toBeNull();
    expect(screen.getByText("▶")).toBeTruthy();
  });

  it("点击对话框翻到末页并隐藏箭头", async () => {
    const user = userEvent.setup();
    renderOverlay();
    await user.click(screen.getByText("那天夜里井边传来很奇怪的声音。"));
    expect(screen.getByText("我去看了一眼，但什么都没看清。")).toBeTruthy();
    expect(screen.queryByText("▶")).toBeNull();
  });

  it("点击对话框内的关闭按钮只关闭、不翻页", async () => {
    const user = userEvent.setup();
    const { props } = renderOverlay();
    await user.click(screen.getByLabelText("关闭对话"));
    expect(screen.getByText("那天夜里井边传来很奇怪的声音。")).toBeTruthy();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("键盘 Enter 翻页", () => {
    renderOverlay();
    const box = screen.getByRole("dialog", { name: "与薇拉对话" }).querySelector(".npc-dialogue-overlay-box")!;
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByText("我去看了一眼，但什么都没看清。")).toBeTruthy();
  });

  it("台词内容变化时页码重置回首页", () => {
    const { rerender, props } = renderOverlay();
    const box = screen.getByRole("dialog", { name: "与薇拉对话" }).querySelector(".npc-dialogue-overlay-box")!;
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByText("我去看了一眼，但什么都没看清。")).toBeTruthy();
    rerender(
      <NpcDialogueOverlay
        {...props}
        dialogue={makeDialogue({ speechPages: ["全新的第一页。", "全新的第二页。"] })}
      />,
    );
    expect(screen.getByText("全新的第一页。")).toBeTruthy();
    expect(screen.queryByText("全新的第二页。")).toBeNull();
    // 重置确实发生：新内容从首页起可再翻一页（未重置时会被钳在末页）。
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByText("全新的第二页。")).toBeTruthy();
  });

  it("内容相同的新数组引用不重置页码", () => {
    const { rerender, props } = renderOverlay();
    const box = screen.getByRole("dialog", { name: "与薇拉对话" }).querySelector(".npc-dialogue-overlay-box")!;
    fireEvent.keyDown(box, { key: "Enter" });
    rerender(<NpcDialogueOverlay {...props} dialogue={makeDialogue()} />);
    expect(screen.getByText("我去看了一眼，但什么都没看清。")).toBeTruthy();
  });

  it("等待态时点击不翻页", () => {
    renderOverlay({ phase: "waiting", pendingPlayerResponse: "我想帮你。", pendingChoiceToken: "token_b" });
    fireEvent.click(screen.getByText("那天夜里井边传来很奇怪的声音。"));
    expect(screen.queryByText("我去看了一眼，但什么都没看清。")).toBeNull();
  });

  it("speechPages 为空时显示空态文案", () => {
    renderOverlay({ dialogue: makeDialogue({ speechPages: [] }) });
    expect(screen.getByText("还没有开始对话。")).toBeTruthy();
  });
});

// reduceDialogueUiState 与四个类型自 LocationSceneScreen.tsx 原样迁移，是 Task 5 消费的跨任务契约
// （Task 5 才删除原件）。这里用纯函数单测钉住真实迁移行为，使 Tasks 3-4 期间两份副本的任何漂移立即可见。
describe("reduceDialogueUiState 等待快照契约", () => {
  const baseState: DialogueUiState = {
    npcId: null,
    revision: 0,
    pendingPlayerResponse: null,
    pendingChoiceToken: null,
    pendingDialogue: null,
  };

  const submitted: DialogueUiState = {
    npcId: "npc_1",
    revision: 4,
    pendingPlayerResponse: "我想帮你查清楚。",
    pendingChoiceToken: "token_b",
    pendingDialogue: makeDialogue(),
  };

  it("set 写入 npcId 并清空三个 pending 字段", () => {
    const next = reduceDialogueUiState(submitted, { kind: "set", npcId: "npc_2" });
    expect(next).toEqual({
      npcId: "npc_2",
      revision: 4,
      pendingPlayerResponse: null,
      pendingChoiceToken: null,
      pendingDialogue: null,
    });
  });

  it("set 传 null 时关闭对话并清空 pending", () => {
    const next = reduceDialogueUiState(submitted, { kind: "set", npcId: null });
    expect(next.npcId).toBeNull();
    expect(next.pendingPlayerResponse).toBeNull();
    expect(next.pendingChoiceToken).toBeNull();
    expect(next.pendingDialogue).toBeNull();
    expect(next.revision).toBe(4);
  });

  it("submit 记录 playerResponse、choiceToken 与捕获的对白，不动 npcId/revision", () => {
    const dialogue = makeDialogue({ npcId: "npc_1", name: "沈观" });
    const next = reduceDialogueUiState(
      { ...baseState, npcId: "npc_1", revision: 7 },
      { kind: "submit", playerResponse: "后来那口井里到底出了什么事？", choiceToken: "token_a", dialogue }
    );
    expect(next).toEqual({
      npcId: "npc_1",
      revision: 7,
      pendingPlayerResponse: "后来那口井里到底出了什么事？",
      pendingChoiceToken: "token_a",
      pendingDialogue: dialogue,
    });
    // 捕获的对白按引用保存，供等待态展示已选回应。
    expect(next.pendingDialogue).toBe(dialogue);
  });

  it("submit 允许 choiceToken 为 null（自由输入）", () => {
    const next = reduceDialogueUiState(
      { ...baseState, npcId: "npc_1" },
      { kind: "submit", playerResponse: "我自己问", choiceToken: null, dialogue: makeDialogue() }
    );
    expect(next.pendingChoiceToken).toBeNull();
    expect(next.pendingPlayerResponse).toBe("我自己问");
    expect(next.pendingDialogue?.name).toBe("薇拉");
  });

  it("clear_pending 只清三个 pending 字段，保留 npcId 与 revision", () => {
    const next = reduceDialogueUiState(submitted, { kind: "clear_pending" });
    expect(next).toEqual({
      npcId: "npc_1",
      revision: 4,
      pendingPlayerResponse: null,
      pendingChoiceToken: null,
      pendingDialogue: null,
    });
  });

  it("sync_revision 在 close:false 时更新 revision 并保留 npcId 与 pending", () => {
    const next = reduceDialogueUiState(submitted, { kind: "sync_revision", revision: 9, close: false });
    expect(next).toEqual({ ...submitted, revision: 9 });
    expect(next.npcId).toBe("npc_1");
    expect(next.pendingPlayerResponse).toBe("我想帮你查清楚。");
    expect(next.pendingChoiceToken).toBe("token_b");
    expect(next.pendingDialogue).toBe(submitted.pendingDialogue);
  });

  it("sync_revision 在 close:true 时清空 npcId、pending 字段与 pending 对白", () => {
    const next = reduceDialogueUiState(submitted, { kind: "sync_revision", revision: 11, close: true });
    expect(next).toEqual({
      npcId: null,
      revision: 11,
      pendingPlayerResponse: null,
      pendingChoiceToken: null,
      pendingDialogue: null,
    });
  });
});
