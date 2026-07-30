import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import TownDemoPage from "./page";

// ---------------------------------------------------------------------------
// Town demo Task 8：/town-demo 页面测试。
// 初始只有 seed 输入与生成按钮；点击「生成」调用 application 门面
// generateTownDemoView（真实确定性生成器，无网络/mock）后出现统计行与
// SVG 地图；点击建筑出现档案面板；空 seed 显示 aria-live 错误文案；
// 「随机种子」只改输入框文本（生成仍由 seed 确定）。
// ---------------------------------------------------------------------------

describe("TownDemoPage：初始状态", () => {
  it("渲染 seed 输入框（初始 demo-1）与生成按钮，尚无地图", () => {
    const { container } = render(<TownDemoPage />);

    expect(screen.getByLabelText("种子")).toHaveValue("demo-1");
    expect(screen.getByRole("button", { name: "生成" })).toBeInTheDocument();
    expect(container.querySelector("[data-town-map]")).toBeNull();
  });
});

describe("TownDemoPage：生成小镇", () => {
  it("点击生成后出现统计行与 SVG 地图", async () => {
    const user = userEvent.setup();
    const { container } = render(<TownDemoPage />);

    await user.click(screen.getByRole("button", { name: "生成" }));

    expect(screen.getByText(/^建筑 \d+$/)).toBeInTheDocument();
    expect(screen.getByText(/^地块 \d+$/)).toBeInTheDocument();
    expect(container.querySelector("[data-town-map]")).not.toBeNull();
  });

  it("点击地图上的建筑出现档案面板（含生图预留提示），关闭后消失", async () => {
    const user = userEvent.setup();
    const { container } = render(<TownDemoPage />);

    await user.click(screen.getByRole("button", { name: "生成" }));
    const map = container.querySelector("[data-town-map]") as HTMLElement;
    const buildingButtons = within(map).getAllByRole("button");
    expect(buildingButtons.length).toBeGreaterThan(0);

    await user.click(buildingButtons[0]);
    expect(screen.getByText("AI 生图未接入（预留接口）")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "关闭档案" }));
    expect(screen.queryByText("AI 生图未接入（预留接口）")).toBeNull();
  });

  it("随机种子按钮把输入框换成 8 位随机文本", async () => {
    const user = userEvent.setup();
    render(<TownDemoPage />);

    await user.click(screen.getByRole("button", { name: "随机种子" }));

    const input = screen.getByLabelText("种子") as HTMLInputElement;
    expect(input.value).not.toBe("demo-1");
    expect(input.value).toHaveLength(8);
  });
});

describe("TownDemoPage：错误处理", () => {
  it("空 seed 点生成显示 aria-live 错误文案且不渲染地图", async () => {
    const user = userEvent.setup();
    const { container } = render(<TownDemoPage />);

    const input = screen.getByLabelText("种子");
    await user.clear(input);
    await user.type(input, "   ");
    await user.click(screen.getByRole("button", { name: "生成" }));

    expect(screen.getByRole("alert")).toHaveTextContent("种子无效");
    expect(container.querySelector("[data-town-map]")).toBeNull();
  });
});

describe("TownDemoPage：调试开关", () => {
  it("勾选开关后渲染地块边界与路网节点覆盖层", async () => {
    const user = userEvent.setup();
    const { container } = render(<TownDemoPage />);

    await user.click(screen.getByRole("button", { name: "生成" }));
    expect(container.querySelector("[data-plot-borders]")).toBeNull();
    expect(container.querySelector("[data-road-nodes]")).toBeNull();

    await user.click(screen.getByLabelText("显示地块边界"));
    await user.click(screen.getByLabelText("显示路网节点"));

    expect(container.querySelector("[data-plot-borders]")).not.toBeNull();
    expect(container.querySelector("[data-road-nodes]")).not.toBeNull();
  });
});
