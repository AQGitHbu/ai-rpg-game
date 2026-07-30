import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BuildingProfilePanel } from "./BuildingProfilePanel";
import type { TownBuilding } from "@/game/application";

// ---------------------------------------------------------------------------
// Town demo Task 8：建筑档案面板测试。
// Panel 内展示名称/类型/区域/命名状态/占地/入口方位 + SVG 占位外观图；
// 必须用 warning Tag 明示「AI 生图未接入（预留接口）」（用户硬约束）；
// 关闭按钮触发 onClose。
// ---------------------------------------------------------------------------

function buildBuildingFixture(overrides?: Partial<TownBuilding>): TownBuilding {
  return {
    buildingId: "b-tavern",
    plotId: "plot-1",
    definitionState: "named",
    buildingType: "tavern",
    displayName: "金穗酒馆",
    district: "market",
    footprint: { x: 2, y: 2, width: 3, height: 2 },
    entrance: { x: 3, y: 4, direction: "south" },
    storyRequired: true,
    ...overrides
  };
}

describe("BuildingProfilePanel：档案内容", () => {
  it("显示建筑名称与档案要素（类型/区域/命名状态/占地/入口方位）", () => {
    render(<BuildingProfilePanel building={buildBuildingFixture()} onClose={vi.fn()} />);

    expect(screen.getByText("金穗酒馆")).toBeInTheDocument();
    expect(screen.getByText("酒馆")).toBeInTheDocument();
    expect(screen.getByText("集市区")).toBeInTheDocument();
    expect(screen.getByText("已命名")).toBeInTheDocument();
    expect(screen.getByText("3 × 2 格")).toBeInTheDocument();
    expect(screen.getByText(/南/)).toBeInTheDocument();
  });

  it("剧情必需建筑显示剧情标识，普通建筑不显示", () => {
    const { rerender } = render(
      <BuildingProfilePanel building={buildBuildingFixture()} onClose={vi.fn()} />
    );
    expect(screen.getByText("剧情建筑")).toBeInTheDocument();

    rerender(
      <BuildingProfilePanel
        building={buildBuildingFixture({ storyRequired: false })}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByText("剧情建筑")).toBeNull();
  });
});

describe("BuildingProfilePanel：占位插图与生图预留提示", () => {
  it("渲染程序生成的 SVG 占位外观图（无网络图片）", () => {
    const { container } = render(
      <BuildingProfilePanel building={buildBuildingFixture()} onClose={vi.fn()} />
    );

    expect(screen.getByRole("img", { name: /酒馆/ })).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("用 warning Tag 明示「AI 生图未接入（预留接口）」", () => {
    render(<BuildingProfilePanel building={buildBuildingFixture()} onClose={vi.fn()} />);

    const notice = screen.getByText("AI 生图未接入（预留接口）");
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveClass("tag--warning");
  });

  it("占位图由 buildingId 确定性驱动：同一建筑两次渲染 SVG 内容一致", () => {
    const building = buildBuildingFixture();
    const first = render(<BuildingProfilePanel building={building} onClose={vi.fn()} />);
    const firstArt = first.container.querySelector("[data-building-art]")?.outerHTML;
    first.unmount();

    const second = render(<BuildingProfilePanel building={building} onClose={vi.fn()} />);
    const secondArt = second.container.querySelector("[data-building-art]")?.outerHTML;

    expect(firstArt).toBeDefined();
    expect(firstArt).toBe(secondArt);
  });
});

describe("BuildingProfilePanel：关闭", () => {
  it("点击关闭按钮触发 onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<BuildingProfilePanel building={buildBuildingFixture()} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "关闭档案" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
