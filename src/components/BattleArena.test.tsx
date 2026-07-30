import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BattleArena } from "./BattleArena";

// ---------------------------------------------------------------------------
// Phase 9 Task 1：BattleArena 纯呈现组件测试。
// BattleArena 只接收 gameType、playerName、playerHp、enemyName、enemyHp、
// round 和 children，以只读方式投影为战斗主视窗。不持有 state、不发请求、
// 不调用 action callback、不 import gameplay 模块、不计算数值。
// 装饰性 SVG 由 AdventureVisual 提供，敌我可访问名称由相邻文本提供。
// ---------------------------------------------------------------------------

describe("BattleArena", () => {
  it("只显示传入的敌我 HP、回合和装饰性 SVG", () => {
    render(
      <BattleArena gameType="wuxia" playerName="沈青崖" playerHp={28} enemyName="暗影刺客" enemyHp={15} round={2}>
        <span>行动</span>
      </BattleArena>
    );

    const region = screen.getByRole("region", { name: "战斗" });
    expect(region).toHaveTextContent("沈青崖");
    expect(region).toHaveTextContent("28");
    expect(region).toHaveTextContent("暗影刺客");
    expect(region).toHaveTextContent("15");
    expect(screen.getByText("回合 2")).toBeVisible();
    expect(screen.getAllByTestId("battle-combatant-visual")).toHaveLength(2);
  });

  it("渲染 children 内容", () => {
    render(
      <BattleArena gameType="wuxia" playerName="沈青崖" playerHp={28} enemyName="暗影刺客" enemyHp={15} round={2}>
        <div data-testid="child-content">行动栏</div>
      </BattleArena>
    );

    expect(screen.getByTestId("child-content")).toBeInTheDocument();
  });

  it("玩家与敌人分列两侧，各自显示肖像与生命值", () => {
    render(
      <BattleArena gameType="xianxia" playerName="云游子" playerHp={30} enemyName="魔修" enemyHp={20} round={1}>
        <span>children</span>
      </BattleArena>
    );

    const combatants = screen.getAllByTestId("battle-combatant-visual");
    expect(combatants).toHaveLength(2);

    const playerHeading = screen.getByRole("heading", { level: 3, name: "云游子" });
    expect(playerHeading.closest(".battle-combatant")).toHaveClass("battle-combatant--player");
    expect(playerHeading.closest(".battle-combatant")).toHaveTextContent("生命 30");

    const enemyHeading = screen.getByRole("heading", { level: 3, name: "魔修" });
    expect(enemyHeading.closest(".battle-combatant")).toHaveClass("battle-combatant--enemy");
    expect(enemyHeading.closest(".battle-combatant")).toHaveTextContent("生命 20");
  });
});
