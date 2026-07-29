import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdventureDetailsPanel } from "./AdventureDetailsPanel";
import { buildSessionViewFixture } from "./sessionViewFixture.testutil";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdventureDetailsPanel", () => {
  it("panel=character 显示角色信息", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<AdventureDetailsPanel view={buildSessionViewFixture()} panel="character" />);

    expect(screen.getByText("沈青崖")).toBeInTheDocument();
    expect(screen.getByText("落魄镖师")).toBeInTheDocument();
  });

  it("panel=inventory 显示物品列表", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<AdventureDetailsPanel view={buildSessionViewFixture()} panel="inventory" />);

    expect(screen.getByText("旧刀")).toBeInTheDocument();
  });

  it("panel=inventory 空背包显示空态", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = { ...buildSessionViewFixture(), inventoryItems: [] };
    render(<AdventureDetailsPanel view={view} panel="inventory" />);

    expect(screen.getByText("背包空空如也。")).toBeInTheDocument();
  });

  it("panel=quests 显示 active 任务和目标", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<AdventureDetailsPanel view={buildSessionViewFixture()} panel="quests" />);

    expect(screen.getByText("查明灭门真相")).toBeInTheDocument();
    expect(screen.getByText(/与陆掌柜交谈/)).toBeInTheDocument();
  });

  it("panel=journal 显示开场叙事和故事事件", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<AdventureDetailsPanel view={buildSessionViewFixture()} panel="journal" />);

    expect(screen.getByText("旅程开端")).toBeInTheDocument();
    expect(screen.getByText("暮色四合，你背着旧刀走进青石镇。")).toBeInTheDocument();
    expect(
      screen.getByText("你与陆掌柜交谈。对方以自己的身份和立场回应了你。")
    ).toBeInTheDocument();
  });
});
