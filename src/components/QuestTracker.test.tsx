import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuestTracker } from "./QuestTracker";
import { buildSessionViewFixture } from "./sessionViewFixture.testutil";

// ---------------------------------------------------------------------------
// Phase 4 Task 4：任务面板为纯展示组件——只呈现 active quest 摘要允许的信息。
// 已完成/进行中 objective 用状态标签区分；未支持 objective 标注「后续阶段能力」
// 并附说明，绝不出现任何按钮或输入框（不给出假的可完成入口）。
// ---------------------------------------------------------------------------

describe("QuestTracker", () => {
  const quests = buildSessionViewFixture().activeQuests;

  it("展示任务名称、类型、描述与 objective 进度", () => {
    render(<QuestTracker quests={quests} />);

    expect(screen.getByText("查明灭门真相")).toBeInTheDocument();
    expect(screen.getByText("主线")).toBeInTheDocument();
    expect(screen.getByText("追查镖局灭门案背后的真凶。")).toBeInTheDocument();
    expect(screen.getByText("与陆掌柜交谈")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("到访城外官道")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
  });

  it("未支持 objective 标注后续阶段能力并附说明，不显示为可完成", () => {
    render(<QuestTracker quests={quests} />);

    expect(screen.getByText("取得关键物品")).toBeInTheDocument();
    expect(screen.getByText("后续阶段能力")).toBeInTheDocument();
    expect(screen.getByText(/后续版本开放对应玩法后才能推进/)).toBeInTheDocument();
  });

  it("没有任何可执行交互：无按钮、无输入框", () => {
    render(<QuestTracker quests={quests} />);

    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
  });

  it("没有 active 任务时显示中性提示", () => {
    render(<QuestTracker quests={[]} />);

    expect(screen.getByText("当前没有进行中的任务。")).toBeInTheDocument();
  });
});
