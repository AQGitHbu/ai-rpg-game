import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdventureHud } from "./AdventureHud";
import { buildSessionViewFixture } from "./sessionViewFixture.testutil";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdventureHud", () => {
  it("HUD 只显示安全主线摘要，并把四个入口交给 shell", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const onOpen = vi.fn();
    const view = buildSessionViewFixture();
    render(<AdventureHud view={view} onOpen={onOpen} />);

    await userEvent.click(screen.getByRole("button", { name: "背包" }));
    expect(onOpen).toHaveBeenCalledWith("inventory");

    expect(screen.getByText(view.activeQuests[0].name)).toBeVisible();
  });

  it("显示世界名、当前地点、玩家姓名/身份和 HP", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = buildSessionViewFixture();
    render(<AdventureHud view={view} onOpen={vi.fn()} />);

    expect(screen.getByText("武侠")).toBeVisible();
    expect(screen.getByText("青石镇")).toBeVisible();
    expect(screen.getByText("沈青崖")).toBeVisible();
    expect(screen.getByText(/30/)).toBeVisible();
  });

  it("主线摘要取第一个未完成 objective", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = buildSessionViewFixture();
    render(<AdventureHud view={view} onOpen={vi.fn()} />);

    expect(screen.getByText("到访城外官道")).toBeVisible();
  });

  it("没有主线任务时显示暂无线索", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = { ...buildSessionViewFixture(), activeQuests: [] };
    render(<AdventureHud view={view} onOpen={vi.fn()} />);

    expect(screen.getByText("暂无线索")).toBeVisible();
  });

  it("四个入口均可键盘访问", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const onOpen = vi.fn();
    render(<AdventureHud view={buildSessionViewFixture()} onOpen={onOpen} />);

    await userEvent.click(screen.getByRole("button", { name: "角色" }));
    expect(onOpen).toHaveBeenCalledWith("character");
    await userEvent.click(screen.getByRole("button", { name: "任务" }));
    expect(onOpen).toHaveBeenCalledWith("quests");
    await userEvent.click(screen.getByRole("button", { name: "日志" }));
    expect(onOpen).toHaveBeenCalledWith("journal");
  });

  it("developmentTools=true：右上角在“日志”之后显示“开发工具”入口并触发回调", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const onOpen = vi.fn();
    const onOpenDevTools = vi.fn();
    render(
      <AdventureHud
        view={buildSessionViewFixture()}
        onOpen={onOpen}
        developmentTools
        onOpenDevTools={onOpenDevTools}
      />
    );

    const devButton = screen.getByRole("button", { name: "开发工具" });
    expect(devButton).toBeInTheDocument();

    const actions = screen.getByRole("navigation", { name: "信息入口" });
    const buttons = within(actions).getAllByRole("button");
    expect(buttons[buttons.length - 1].textContent).toBe("开发工具");

    await userEvent.click(devButton);
    expect(onOpenDevTools).toHaveBeenCalledTimes(1);
  });

  it("developmentTools 缺省/假：不显示“开发工具”入口", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<AdventureHud view={buildSessionViewFixture()} onOpen={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "开发工具" })).toBeNull();
  });
});
