import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

  // 审查 Finding A：旧模态在立绘下渲染 dialogue.role，覆盖层重建时漏掉；
  // 而同样显示 role 的人物侧栏在对话显示期间被卸载 —— 对话中玩家看不到 NPC 身份。
  it("名字横幅第二行显示 NPC 身份（role），且不并入名字文本节点", () => {
    renderOverlay();
    const dialogue = screen.getByRole("dialog", { name: "与薇拉对话" });
    const nameElement = within(dialogue).getByText("薇拉");
    expect(nameElement.className).toContain("npc-dialogue-overlay-name");
    // 名字文本节点保持稳定：壳层用例按 exact 文本查询名字横幅（AdventureGameShell.test.tsx:1274）。
    expect(nameElement.textContent).toBe("薇拉");
    const roleElement = within(dialogue).getByText("酒馆老板的女儿");
    expect(roleElement).toBeTruthy();
    // 身份行属于底部对话框（名字横幅区域），不是被卸载的侧栏残留。
    const box = dialogue.querySelector(".npc-dialogue-overlay-box")!;
    expect(box.contains(roleElement)).toBe(true);
  });

  it("role 与其它对白文本同样经 normalizeDisplayText 清洗", () => {
    renderOverlay({ dialogue: makeDialogue({ role: "酒馆老板的女儿。。" }) });
    expect(screen.getByText("酒馆老板的女儿。")).toBeTruthy();
  });

  it("role 为纯空白时不渲染身份行", () => {
    const { container } = renderOverlay({ dialogue: makeDialogue({ role: "   " }) });
    expect(container.querySelector(".npc-dialogue-overlay-role")).toBeNull();
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

  // spec §4.1：键盘翻页必须排除持有焦点的交互控件。
  // 关闭按钮是唯一渲染在 `<section onKeyDown>` 内部的交互控件（选项面板/自由输入 form 都是它的兄弟），
  // 所以它是唯一能真正走到共享守卫 isInteractiveTarget 的焦点目标——守卫用例只能建在它上面。
  async function focusCloseButtonViaTab() {
    const user = userEvent.setup();
    const box = screen.getByRole("dialog", { name: "与薇拉对话" }).querySelector(".npc-dialogue-overlay-box")!;
    const close = screen.getByLabelText("关闭对话");
    // 前提成立才谈得上"守卫被调用"：keydown 会从按钮冒泡到持有 onKeyDown 的对话框。
    expect(box.contains(close)).toBe(true);
    // 挂载时焦点已在对话框上（spec §6），Tab 前移到框内唯一可聚焦控件。
    await user.tab();
    expect(document.activeElement).toBe(close);
    return user;
  }

  it("关闭按钮持有焦点时 Enter 不翻页，且未吞掉按钮自身激活语义（键盘守卫）", async () => {
    const { props } = renderOverlay();
    const user = await focusCloseButtonViaTab();
    // user-event 只在 keydown 未被 preventDefault 时才补发 Enter 的默认 click 激活，
    // 故"onClose 被调用一次"同时钉住守卫放行（未误翻页）与未误吞按钮默认行为两半。
    await user.keyboard("{Enter}");
    expect(screen.getByText("那天夜里井边传来很奇怪的声音。")).toBeTruthy();
    expect(screen.queryByText("我去看了一眼，但什么都没看清。")).toBeNull();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("关闭按钮持有焦点时 Space 不翻页，且未吞掉按钮自身激活语义（键盘守卫）", async () => {
    const { props } = renderOverlay();
    const user = await focusCloseButtonViaTab();
    // `[Space]` 按物理码取键（keyMap 里它的 key 是 " "）；Space 的默认激活发生在 keyup，
    // 而 keydown 被 preventDefault 时 user-event 会抑制该默认行为。
    await user.keyboard("[Space]");
    expect(screen.getByText("那天夜里井边传来很奇怪的声音。")).toBeTruthy();
    expect(screen.queryByText("我去看了一眼，但什么都没看清。")).toBeNull();
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

describe("NpcDialogueOverlay 选项面板", () => {
  // 投影形态复用件：与 gameSessionView.ts:776-787 的 giveChoices 形状/label 文案一致。
  const veraGiveChoice: NpcDialogueView["giveChoices"][number] = {
    itemName: "药草",
    choice: { choiceToken: "token_give", label: "把药草交给薇拉", presentation: "item" },
  };

  async function turnToLastPage() {
    const user = userEvent.setup();
    await user.click(screen.getByText("那天夜里井边传来很奇怪的声音。"));
    return user;
  }

  it("末页显示选项面板；固定选项经 onSubmit 提交对应 token", async () => {
    const { props } = renderOverlay();
    const user = await turnToLastPage();
    expect(screen.getByLabelText("对话选项")).toBeTruthy();
    expect(screen.getAllByTestId("npc-dialogue-choice")).toHaveLength(2);
    // 可访问名不含装饰性 ">" 前缀（aria-hidden），按语义 label 查询。
    await user.click(screen.getByRole("button", { name: "我想帮你查清楚。" }));
    expect(props.onSubmit).toHaveBeenCalledWith(
      { kind: "fixed_choice", choiceToken: "token_b" },
      "我想帮你查清楚。",
    );
  });

  it("单页台词直接显示选项面板，无翻页箭头", () => {
    renderOverlay({ dialogue: makeDialogue({ speechPages: ["只有一句。"] }) });
    expect(screen.queryByText("▶")).toBeNull();
    expect(screen.getByLabelText("对话选项")).toBeTruthy();
  });

  it("赠物选项并入面板并走 fixed_choice 提交", async () => {
    const { props } = renderOverlay({
      dialogue: makeDialogue({
        giveChoices: [
          // 与投影一致的赠物 label 文案（gameSessionView.ts:781 `把${itemName}交给${npc.name}`）。
          { itemName: "药草", choice: { choiceToken: "token_give", label: "把药草交给薇拉", presentation: "item" } },
        ],
      }),
    });
    const user = await turnToLastPage();
    await user.click(screen.getByTestId("npc-dialogue-overlay-give-token_give"));
    expect(props.onSubmit).toHaveBeenCalledWith(
      { kind: "fixed_choice", choiceToken: "token_give" },
      "把药草交给薇拉",
    );
  });

  // 审查 Finding B：旧模态的赠物区自带 role="group" aria-label="给予道具"、可见标签
  // 和自由输入提示行；覆盖层重建时三者全丢，赠物项混进「对话选项」里，
  // 屏幕阅读器用户无法区分"送礼"和"回话"。
  it("赠物项在独立「给予道具」分组内：嵌套于对话选项面板且与固定回应可区分", async () => {
    renderOverlay({ dialogue: makeDialogue({ giveChoices: [veraGiveChoice] }) });
    await turnToLastPage();
    const panel = screen.getByRole("group", { name: "对话选项" });
    const giveGroup = within(panel).getByRole("group", { name: "给予道具" });
    // 分组既有可访问名也有可见标签文案（沿用旧模态措辞）。
    expect(within(giveGroup).getByText("给予道具")).toBeTruthy();
    expect(within(giveGroup).getByRole("button", { name: "把药草交给薇拉" })).toBeTruthy();
    // 固定回应属于外层面板但不属于赠物分组——这就是"可区分"的含义。
    expect(within(giveGroup).queryByRole("button", { name: "我想帮你查清楚。" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "我想帮你查清楚。" })).toBeTruthy();
    // 提示行只在赠物项与自由输入并存时出现，且不在赠物分组内（它说的是下方的输入行）。
    expect(within(giveGroup).queryByLabelText("自定义回应")).toBeNull();
    expect(
      within(panel).getByText("自定义输入仅用于对白；交付道具请点击上方选项。"),
    ).toBeTruthy();
  });

  it("无赠物项时不渲染空分组，也不显示交付道具提示行", async () => {
    renderOverlay();
    await turnToLastPage();
    expect(screen.queryByRole("group", { name: "给予道具" })).toBeNull();
    expect(screen.queryByText("自定义输入仅用于对白；交付道具请点击上方选项。")).toBeNull();
  });

  it("等待态快照同样把赠物项放进「给予道具」分组（与 ready 一致）", () => {
    renderOverlay({
      phase: "waiting",
      busy: true,
      pendingPlayerResponse: "我想帮你查清楚。",
      pendingChoiceToken: "token_b",
      dialogue: makeDialogue({ giveChoices: [veraGiveChoice] }),
    });
    const giveGroup = screen.getByRole("group", { name: "给予道具" });
    const giveButton = within(giveGroup).getByRole("button", { name: "把药草交给薇拉" }) as HTMLButtonElement;
    expect(giveButton.disabled).toBe(true);
    // 等待态不渲染自由输入（既有行为），因此也不出现只对自由输入有意义的提示行。
    expect(screen.queryByText("自定义输入仅用于对白；交付道具请点击上方选项。")).toBeNull();
    // 固定回应仍在外层面板、不在赠物分组内。
    expect(within(giveGroup).queryByRole("button", { name: "后来那口井里到底出了什么事？" })).toBeNull();
  });

  it("自由输入以 free_text + targetNpcId 提交；草稿保留至父级 resetInputNonce", async () => {
    const { props } = renderOverlay();
    const user = await turnToLastPage();
    const input = screen.getByLabelText("自定义回应");
    await user.type(input, "我还有别的问题。");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(props.onSubmit).toHaveBeenCalledWith(
      { kind: "free_text", text: "我还有别的问题。", targetNpcId: "npc_1" },
      "我还有别的问题。",
    );
    expect((input as HTMLInputElement).value).toBe("我还有别的问题。"); // 草稿保留，由父级经 resetInputNonce 清空
  });

  it("自由输入行在对话框之外：键入含空格文本不丢字符（面板位置不截获按键，非键盘守卫证据）", async () => {
    const { container } = renderOverlay(); // 覆盖层必须先挂载，turnToLastPage 才有可点的台词
    const user = await turnToLastPage();
    const input = screen.getByLabelText("自定义回应") as HTMLInputElement;
    // 本用例只钉住"输入不被吞"：form 所在面板是 <section onKeyDown> 的兄弟节点，
    // 输入框内的按键根本不会冒泡进 handleBoxKeyDown，因此它不构成键盘守卫的证据
    // （守卫用例见 describe("NpcDialogueOverlay 翻页") 内关闭按钮两例）。
    const box = container.querySelector(".npc-dialogue-overlay-box")!;
    expect(box.contains(input)).toBe(false);
    await user.type(input, "好。 继续说");
    expect(input.value).toBe("好。 继续说");
  });

  it("输入框内按 Enter 保持提交语义（free_text），未被翻页截获", async () => {
    const { props } = renderOverlay();
    const user = await turnToLastPage();
    const input = screen.getByLabelText("自定义回应");
    await user.type(input, "我还有别的问题。");
    // user-event 只有在 keydown 未被 preventDefault 时才执行 Enter 的表单提交默认行为，
    // 故本断言钉住"输入框内的 Enter 仍然是提交"（spec §4.1 后半句）。
    await user.keyboard("{Enter}");
    expect(props.onSubmit).toHaveBeenCalledWith(
      { kind: "free_text", text: "我还有别的问题。", targetNpcId: "npc_1" },
      "我还有别的问题。",
    );
  });

  it("等待态：快照台词、固定选项与赠物可见且全部禁用，已选项带标记与 spinner", () => {
    renderOverlay({
      phase: "waiting",
      busy: true,
      pendingPlayerResponse: "我想帮你查清楚。",
      pendingChoiceToken: "token_b",
      dialogue: makeDialogue({
        giveChoices: [
          { itemName: "药草", choice: { choiceToken: "token_give", label: "把药草交给薇拉", presentation: "item" } },
        ],
      }),
    });
    expect(screen.getByText("那天夜里井边传来很奇怪的声音。")).toBeTruthy();
    const options = screen.getAllByTestId("npc-dialogue-choice");
    expect(options).toHaveLength(3); // 两个固定选项 + 一个赠物项（快照渲染，不依赖 pending view）
    expect(options.every((el) => (el as HTMLButtonElement).disabled)).toBe(true);
    expect(options[1].getAttribute("aria-current")).toBe("true");
    expect(options.some((el) => el.textContent?.includes("把药草交给薇拉"))).toBe(true);
    expect(screen.getAllByTestId("npc-dialogue-spinner").length).toBeGreaterThan(0);
    // 固定选项提交时玩家回应由已选态承载：文案只出现在已选按钮内，不另渲染玩家回应行。
    expect(screen.getAllByText("我想帮你查清楚。")).toHaveLength(1);
    expect(screen.getByText("正在等待薇拉回应……")).toBeTruthy();
  });

  it("自由输入提交后的等待态临时展示玩家回应行与 spinner", () => {
    renderOverlay({ phase: "waiting", busy: true, pendingPlayerResponse: "我还有别的问题。", pendingChoiceToken: null });
    const playerLine = screen.getByText("我还有别的问题。");
    expect(playerLine.closest(".npc-dialogue-overlay-speech--player")).toBeTruthy();
    expect(screen.getAllByTestId("npc-dialogue-spinner").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("自定义回应")).toBeNull();
  });

  it("等待态锁定关闭按钮并隐藏自由输入（逐条保留现有行为）", () => {
    renderOverlay({ phase: "waiting", busy: true, pendingPlayerResponse: "我想帮你查清楚。", pendingChoiceToken: "token_a" });
    expect((screen.getByLabelText("关闭对话") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("自定义回应")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });

  it("startChoice 空态只显示单一开始交谈入口", async () => {
    const { props } = renderOverlay({
      dialogue: makeDialogue({
        speechPages: [],
        choices: [],
        freeInputEnabled: false,
        startChoice: { choiceToken: "token_ask", label: "与薇拉交谈", presentation: "dialogue" },
      }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "与薇拉交谈" }));
    expect(props.onSubmit).toHaveBeenCalledWith(
      { kind: "fixed_choice", choiceToken: "token_ask" },
      "与薇拉交谈",
    );
    expect(screen.queryByLabelText("自定义回应")).toBeNull();
  });

  it("handoff 收尾只显示单一交接确认，点击走 onAcknowledge", async () => {
    const { props } = renderOverlay({
      dialogue: makeDialogue({ speechPages: ["旧 NPC 的最后一句。"], choices: [], freeInputEnabled: false }),
      handoffAcknowledgement: { label: "与下一位 NPC 交谈" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "与下一位 NPC 交谈" }));
    expect(props.onAcknowledge).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("非焦点闲聊只有\"知道了\"，点击走 onClose，描边降级为灰色调", async () => {
    const { props } = renderOverlay({
      dialogue: makeDialogue({ speechPages: ["最近来问井的事的人不少。"], choices: [], freeInputEnabled: false }),
    });
    expect(
      screen.getByRole("dialog", { name: "与薇拉对话" }).querySelector(".npc-dialogue-overlay-box--ambient"),
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "知道了" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
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
