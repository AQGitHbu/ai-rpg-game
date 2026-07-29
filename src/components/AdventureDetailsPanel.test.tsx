import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdventureDetailsPanel } from "./AdventureDetailsPanel";
import { buildSessionViewFixture } from "./sessionViewFixture.testutil";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdventureDetailsPanel", () => {
  it("渲染四个子视图切换按钮", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<AdventureDetailsPanel view={buildSessionViewFixture()} />);

    expect(screen.getByRole("button", { name: "角色" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "背包" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "任务" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "日志" })).toBeInTheDocument();
  });

  it("默认显示角色信息", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<AdventureDetailsPanel view={buildSessionViewFixture()} />);

    expect(screen.getByText("沈青崖")).toBeInTheDocument();
    expect(screen.getByText("落魄镖师")).toBeInTheDocument();
  });

  it("切换到背包显示物品列表", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    render(<AdventureDetailsPanel view={buildSessionViewFixture()} />);

    await user.click(screen.getByRole("button", { name: "背包" }));

    expect(screen.getByText("旧刀")).toBeInTheDocument();
  });

  it("切换到任务显示 active 任务和目标", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    render(<AdventureDetailsPanel view={buildSessionViewFixture()} />);

    await user.click(screen.getByRole("button", { name: "任务" }));

    expect(screen.getByText("查明灭门真相")).toBeInTheDocument();
    expect(screen.getByText(/与陆掌柜交谈/)).toBeInTheDocument();
  });

  it("切换到日志显示故事事件", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    render(<AdventureDetailsPanel view={buildSessionViewFixture()} />);

    await user.click(screen.getByRole("button", { name: "日志" }));

    expect(
      screen.getByText("你与陆掌柜交谈。对方以自己的身份和立场回应了你。")
    ).toBeInTheDocument();
  });

  it("切换子视图零 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdventureDetailsPanel view={buildSessionViewFixture()} />);

    await user.click(screen.getByRole("button", { name: "背包" }));
    await user.click(screen.getByRole("button", { name: "任务" }));
    await user.click(screen.getByRole("button", { name: "日志" }));
    await user.click(screen.getByRole("button", { name: "角色" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
