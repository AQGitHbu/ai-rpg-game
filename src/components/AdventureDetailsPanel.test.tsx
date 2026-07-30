import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdventureDetailsPanel } from "./AdventureDetailsPanel";
import { buildSessionViewFixture } from "./sessionViewFixture.testutil";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdventureDetailsPanel", () => {
  it("panel=character 渲染横屏角色面板，包含头像、身份与扩展属性卡片", () => {
    vi.stubGlobal("fetch", vi.fn());
    const { container } = render(
      <AdventureDetailsPanel view={buildSessionViewFixture()} panel="character" />
    );

    expect(screen.getByText("沈青崖")).toBeInTheDocument();
    expect(screen.getByText("落魄镖师")).toBeInTheDocument();
    expect(screen.getByText("等级 1")).toBeInTheDocument();
    expect(screen.getByText("生命 (HP)")).toBeInTheDocument();
    expect(screen.getByText("基础属性")).toBeInTheDocument();
    expect(screen.getByText("拓展属性")).toBeInTheDocument();

    // 验证带有 .details-character-landscape 容器与 SVG 头像
    expect(container.querySelector(".details-character-landscape")).not.toBeNull();
    expect(container.querySelector(".character-avatar-frame svg")).not.toBeNull();
  });

  it("panel=character 渲染 HP 血条与基础/拓展属性数值", () => {
    vi.stubGlobal("fetch", vi.fn());
    const fixture = buildSessionViewFixture();
    const { container } = render(<AdventureDetailsPanel view={fixture} panel="character" />);

    const hp = fixture.player.stats.hp;
    expect(screen.getByText(`${hp} / ${hp}`)).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");

    expect(screen.getByText("攻击")).toBeInTheDocument();
    expect(screen.getByText(String(fixture.player.stats.attack))).toBeInTheDocument();
    expect(screen.getByText("防御")).toBeInTheDocument();
    expect(screen.getByText(String(fixture.player.stats.defense))).toBeInTheDocument();

    // 扩展属性插槽：速度 / 暴击率 / 闪避率
    expect(screen.getByText("速度")).toBeInTheDocument();
    expect(screen.getByText("暴击率")).toBeInTheDocument();
    expect(screen.getByText("闪避率")).toBeInTheDocument();
    expect(container.querySelectorAll(".stat-card-extended")).toHaveLength(3);
  });

  it("panel=inventory 显示物品列表", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<AdventureDetailsPanel view={buildSessionViewFixture()} panel="inventory" />);

    expect(screen.getByText("旧刀")).toBeInTheDocument();
  });

  it("panel=inventory 渲染四分类背包界面（装备/道具/材料/任务）", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<AdventureDetailsPanel view={buildSessionViewFixture()} panel="inventory" />);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "装备",
      "道具",
      "材料",
      "任务"
    ]);
    // 默认选中装备页签：旧刀的详情（稀有度/描述）可见。
    expect(screen.getByText("精良")).toBeInTheDocument();
    expect(screen.getByText("父亲留下的佩刀，刀鞘磨损严重。")).toBeInTheDocument();
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
