import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OpeningGameView } from "./OpeningGameView";
import { buildOpeningViewFixture } from "./openingViewFixture.testutil";

// ---------------------------------------------------------------------------
// Task 4：开场视图为纯展示组件——只呈现 read model 允许的信息，
// 不出现任何可执行交互（按钮/输入框），建议行动仅为文本。
// ---------------------------------------------------------------------------

describe("OpeningGameView", () => {
  const view = buildOpeningViewFixture();

  it("展示世界、角色、当前地点、开场叙事、NPC、物品与建议行动", () => {
    render(<OpeningGameView view={view} />);

    expect(screen.getByText("武侠")).toBeInTheDocument();
    expect(screen.getByText("镖局一夜覆灭，江湖各派暗流涌动。")).toBeInTheDocument();
    // Phase 3：knownFacts 中也包含「沈青崖」，需用 getAllByText。
    expect(screen.getAllByText(/沈青崖/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/落魄镖师/).length).toBeGreaterThan(0);
    expect(screen.getByText("青石镇")).toBeInTheDocument();
    expect(screen.getByText("镇口贴着一张字迹潦草的缉凶告示。")).toBeInTheDocument();
    expect(screen.getByText("暮色四合，你背着旧刀走进青石镇。")).toBeInTheDocument();
    expect(screen.getByText(/陆掌柜/)).toBeInTheDocument();
    expect(screen.getByText(/捕头赵五/)).toBeInTheDocument();
    // 「旧刀」同时出现在物品与叙事文本中，用 getAllByText 断言至少一次。
    expect(screen.getAllByText(/旧刀/).length).toBeGreaterThan(0);
    expect(screen.getByText("去客栈打听消息")).toBeInTheDocument();
    expect(screen.getByText("查看缉凶告示")).toBeInTheDocument();
  });

  it("没有任何可执行交互：无按钮、无输入框，建议行动是列表文本", () => {
    render(<OpeningGameView view={view} />);

    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    // 建议行动渲染为 listitem 文本，不是可点击元素。
    expect(screen.getByText("去客栈打听消息").closest("li")).not.toBeNull();
  });

  it("展示已发现线索和行动灵感提示", () => {
    render(<OpeningGameView view={view} />);
    // Phase 3：不再显示「交互将在下一阶段开放」，而是提示可在行动面板操作。
    expect(screen.getByText(/可在下方行动面板中选择具体操作/)).toBeInTheDocument();
  });
});
