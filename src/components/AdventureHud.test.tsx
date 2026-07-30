import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdventureHud } from "./AdventureHud";
import { buildSessionViewFixture } from "./sessionViewFixture.testutil";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdventureHud", () => {
  it("HUD 显示玩家姓名 HP 并保留四个信息入口", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const onOpen = vi.fn();
    const view = buildSessionViewFixture();
    render(<AdventureHud view={view} screen="map" onOpen={onOpen} />);

    await userEvent.click(screen.getByRole("button", { name: "背包" }));
    expect(onOpen).toHaveBeenCalledWith("inventory");

    expect(screen.getByText("沈青崖")).toBeVisible();
  });

  it("HUD 玩家卡片显示姓名和 HP", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = buildSessionViewFixture();
    render(<AdventureHud view={view} screen="map" onOpen={vi.fn()} />);

    expect(screen.getByText("沈青崖")).toBeVisible();
    expect(screen.getByText(/30/)).toBeVisible();
  });

  it("主线摘要取第一个未完成 objective", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = buildSessionViewFixture();
    render(<AdventureHud view={view} screen="map" onOpen={vi.fn()} />);

    expect(screen.getByText("到访城外官道")).toBeVisible();
  });

  it("没有主线任务时显示暂无线索", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = { ...buildSessionViewFixture(), activeQuests: [] };
    render(<AdventureHud view={view} screen="map" onOpen={vi.fn()} />);

    expect(screen.getByText("暂无线索")).toBeVisible();
  });

  it("四个入口均可键盘访问", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const onOpen = vi.fn();
    render(<AdventureHud view={buildSessionViewFixture()} screen="map" onOpen={onOpen} />);

    await userEvent.click(screen.getByRole("button", { name: "角色" }));
    expect(onOpen).toHaveBeenCalledWith("character");
    await userEvent.click(screen.getByRole("button", { name: "任务" }));
    expect(onOpen).toHaveBeenCalledWith("quests");
    await userEvent.click(screen.getByRole("button", { name: "日志" }));
    expect(onOpen).toHaveBeenCalledWith("journal");
  });

  it("developmentTools=true：右上角在\u201c日志\u201d之后显示\u201c开发工具\u201d入口并触发回调", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const onOpen = vi.fn();
    const onOpenDevTools = vi.fn();
    render(
      <AdventureHud
        view={buildSessionViewFixture()}
        screen="map"
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

  it("developmentTools 缺省/假：不显示\u201c开发工具\u201d入口", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<AdventureHud view={buildSessionViewFixture()} screen="map" onOpen={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "开发工具" })).toBeNull();
  });

  it("地图模式显示角色、当前目标和右下入口，但不显示中央地点名", () => {
    render(<AdventureHud view={buildSessionViewFixture()} screen="map" onOpen={vi.fn()} />);
    const hud = screen.getByLabelText("游戏 HUD");
    expect(hud.querySelector(".adventure-hud-player-card")).toHaveTextContent("沈青崖");
    expect(hud.querySelector(".adventure-hud-avatar svg")).toHaveAttribute("aria-hidden", "true");
    expect(hud.querySelector(".adventure-hud-objective")).toHaveTextContent("到访城外官道");
    expect(hud.querySelector(".adventure-hud-location-title")).toBeNull();
    expect(hud.querySelector(".adventure-hud-actions")).toHaveTextContent("角色背包任务日志");
  });

  it("地点模式在 HUD 顶部中央显示当前场景名", () => {
    render(<AdventureHud view={buildSessionViewFixture()} screen="scene" onOpen={vi.fn()} />);
    expect(screen.getByText("青石镇")).toHaveClass("adventure-hud-location-title");
  });
});
