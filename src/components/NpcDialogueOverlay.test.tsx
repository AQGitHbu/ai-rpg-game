import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { NpcDialogueOverlay } from "./NpcDialogueOverlay";
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
