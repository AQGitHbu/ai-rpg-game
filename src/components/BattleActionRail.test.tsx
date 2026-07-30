import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BattleActionRail } from "./BattleActionRail";
import type { SessionActionView } from "@/game/application";

// ---------------------------------------------------------------------------
// Phase 9 Task 2：BattleActionRail 固定战斗行动栏测试。
// 只渲染服务端给出的 battle_action（attack/guard/withdraw），不显示技能、
// 物品等未来操作。busy 时禁用全部按钮。onSelect 转发原始 action entry，
// BattlePanel 无需重建 payload。
// ---------------------------------------------------------------------------

type BattleActionView = Extract<SessionActionView, { type: "battle_action" }>;

const attack: BattleActionView = { type: "battle_action", action: "attack", label: "攻击" };
const guard: BattleActionView = { type: "battle_action", action: "guard", label: "防御" };
const withdraw: BattleActionView = { type: "battle_action", action: "withdraw", label: "撤退" };

describe("BattleActionRail", () => {
  it("只渲染服务端给出的 battle_action，并转发精确 action", async () => {
    const onSelect = vi.fn();
    render(<BattleActionRail actions={[attack, guard, withdraw]} busy={false} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole("button", { name: "攻击" }));
    expect(onSelect).toHaveBeenCalledWith(attack);

    expect(screen.queryByRole("button", { name: "技能" })).toBeNull();
    expect(screen.queryByRole("button", { name: "物品" })).toBeNull();
  });

  it("busy 时禁用所有已有战斗行动", () => {
    render(<BattleActionRail actions={[attack, guard]} busy onSelect={vi.fn()} />);

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("点击防御按钮转发 guard action entry", async () => {
    const onSelect = vi.fn();
    render(<BattleActionRail actions={[attack, guard, withdraw]} busy={false} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole("button", { name: "防御" }));
    expect(onSelect).toHaveBeenCalledWith(guard);
  });

  it("点击撤退按钮转发 withdraw action entry", async () => {
    const onSelect = vi.fn();
    render(<BattleActionRail actions={[attack, guard, withdraw]} busy={false} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole("button", { name: "撤退" }));
    expect(onSelect).toHaveBeenCalledWith(withdraw);
  });

  it("actions 为空时不渲染任何按钮", () => {
    render(<BattleActionRail actions={[]} busy={false} onSelect={vi.fn()} />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("行动栏使用 group 语义且可访问标签为战斗行动", () => {
    render(<BattleActionRail actions={[attack]} busy={false} onSelect={vi.fn()} />);

    expect(screen.getByRole("group", { name: "战斗行动" })).toBeInTheDocument();
  });
});
