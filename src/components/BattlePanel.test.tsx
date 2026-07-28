import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BattlePanel } from "./BattlePanel";
import type { GameSessionView } from "@/game/application";

// ---------------------------------------------------------------------------
// Phase 6 Task 4：战斗面板测试。
// 只在 view.battle 非 null 时渲染；显示敌人名称/血量/回合；
// 只渲染 battle_action 按钮（attack/guard/withdraw）；提交带 revision 的
// battle_action payload；提交期间禁用全部按钮；aria-live 报告反馈；
// 规则拒绝/陈旧 revision 与其他面板同一模式。
// 不用前端逻辑自行减少 HP 或判断胜负。
// ---------------------------------------------------------------------------

type FakeResponse = { json: () => Promise<unknown> };

function jsonResponse(body: unknown): FakeResponse {
  return { json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 构造 active battle 的会话视图 fixture。 */
function buildBattleViewFixture(): GameSessionView {
  return {
    gameId: "game-battle-001",
    world: { name: "武侠", summary: "镖局一夜覆灭。", gameType: "wuxia" },
    player: { name: "沈青崖", identity: "落魄镖师" },
    currentLocation: { name: "密林深处", description: "树影摇曳，杀气森森。" },
    visibleNpcs: [],
    initialItems: [{ name: "旧刀", description: "父亲留下的佩刀。" }],
    openingNarration: "你踏入了密林深处。",
    suggestedActions: [],
    generation: { generationId: "gen-001", templateVersion: "fallback-1" },
    revision: 3,
    availableActions: [
      { type: "battle_action", action: "attack", label: "攻击" },
      { type: "battle_action", action: "guard", label: "防御" },
      { type: "battle_action", action: "withdraw", label: "撤退" },
    ],
    knownFacts: [],
    presentNpcs: [],
    activeQuests: [
      {
        name: "讨伐暗影刺客",
        description: "击败潜伏在密林中的刺客。",
        kind: "main",
        objectives: [{ label: "击败暗影刺客", completed: false, supported: true }],
      },
    ],
    obtainableItems: [],
    inventoryItems: [{ name: "旧刀", description: "父亲留下的佩刀。" }],
    battle: {
      enemyName: "暗影刺客",
      playerHp: 28,
      enemyHp: 15,
      round: 2,
    },
    ending: null,
  } as unknown as GameSessionView;
}

/** 构造无战斗的会话视图 fixture。 */
function buildNoBattleViewFixture(): GameSessionView {
  const base = buildBattleViewFixture();
  return {
    ...base,
    battle: null,
    availableActions: [
      { type: "observe", locationId: "loc_forest", label: "观察密林" },
    ],
  } as unknown as GameSessionView;
}

describe("BattlePanel：渲染条件", () => {
  it("view.battle 非 null 时渲染战斗面板", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <BattlePanel
        view={buildBattleViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );

    expect(screen.getByRole("region", { name: "战斗" })).toBeInTheDocument();
    expect(screen.getByText("暗影刺客")).toBeInTheDocument();
  });

  it("view.battle 为 null 时不渲染战斗面板", () => {
    vi.stubGlobal("fetch", vi.fn());
    const { container } = render(
      <BattlePanel
        view={buildNoBattleViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );

    expect(container.querySelector("[data-battle-panel]")).toBeNull();
  });
});

describe("BattlePanel：服务器 read model 展示", () => {
  it("显示敌人名称、玩家血量、敌方血量与回合数", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <BattlePanel
        view={buildBattleViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );

    expect(screen.getByText("暗影刺客")).toBeInTheDocument();
    // 使用 dd 元素精确匹配 HP/回合数值
    const stats = screen.getAllByText((content, element) =>
      element?.tagName === "DD" && (content === "28" || content === "15" || content === "2")
    );
    expect(stats).toHaveLength(3);
  });

  it("只渲染 battle_action 按钮，不渲染 observe/talk 等普通行动", () => {
    vi.stubGlobal("fetch", vi.fn());
    const baseView = buildBattleViewFixture();
    // 添加一些非 battle_action 行动，确保它们不被渲染
    const view: GameSessionView = {
      ...baseView,
      availableActions: [
        ...baseView.availableActions,
        { type: "observe", locationId: "loc_forest", label: "观察密林" } as never,
      ],
    };
    render(
      <BattlePanel
        view={view}
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "攻击" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "防御" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤退" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "观察密林" })).toBeNull();
  });
});

describe("BattlePanel：提交 battle_action", () => {
  it("提交 attack 时带上 read model revision，并用成功响应替换会话视图", async () => {
    const view = buildBattleViewFixture();
    const updatedView = { ...view, revision: 4, battle: { ...view.battle!, enemyHp: 11, round: 3 } };
    let submittedRequest: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      submittedRequest = init;
      return jsonResponse({
        view: updatedView,
        feedback: { ok: true, message: "你挥刀斩中敌人，造成4点伤害！" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onActionSuccess = vi.fn();
    const user = userEvent.setup();

    render(
      <BattlePanel view={view} onActionSuccess={onActionSuccess} onStaleRevision={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "攻击" }));

    await waitFor(() => expect(onActionSuccess).toHaveBeenCalledWith(updatedView));
    expect(screen.getByRole("status")).toHaveTextContent("你挥刀斩中敌人");
    expect(JSON.parse(String(submittedRequest?.body))).toEqual({
      intent: { type: "battle_action", action: "attack" },
      revision: 3,
    });
  });

  it("提交 guard 时带上正确的 action 值", async () => {
    const view = buildBattleViewFixture();
    let submittedRequest: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      submittedRequest = init;
      return jsonResponse({
        view,
        feedback: { ok: true, message: "你举刀防御，减轻了伤害。" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <BattlePanel view={view} onActionSuccess={vi.fn()} onStaleRevision={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "防御" }));

    await waitFor(() =>
      expect(JSON.parse(String(submittedRequest?.body))).toEqual({
        intent: { type: "battle_action", action: "guard" },
        revision: 3,
      })
    );
  });

  it("提交 withdraw 时带上正确的 action 值", async () => {
    const view = buildBattleViewFixture();
    let submittedRequest: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      submittedRequest = init;
      return jsonResponse({
        view,
        feedback: { ok: true, message: "你果断撤退。" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <BattlePanel view={view} onActionSuccess={vi.fn()} onStaleRevision={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "撤退" }));

    await waitFor(() =>
      expect(JSON.parse(String(submittedRequest?.body))).toEqual({
        intent: { type: "battle_action", action: "withdraw" },
        revision: 3,
      })
    );
  });
});

describe("BattlePanel：提交期间禁用", () => {
  it("提交期间禁用全部战斗按钮，避免重复写入", async () => {
    let resolveResponse: ((response: FakeResponse) => void) | undefined;
    const fetchMock = vi.fn(
      () => new Promise<FakeResponse>((resolve) => { resolveResponse = resolve; })
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <BattlePanel
        view={buildBattleViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "攻击" }));

    // 提交期间：全部战斗按钮都禁用
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }

    resolveResponse?.(
      jsonResponse({
        view: buildBattleViewFixture(),
        feedback: { ok: true, message: "攻击成功。" },
      })
    );
    await screen.findByText("攻击成功。");
  });

  it("外部 busy 为 true 时禁用全部按钮", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <BattlePanel
        view={buildBattleViewFixture()}
        busy={true}
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });
});

describe("BattlePanel：反馈与错误处理", () => {
  it("规则拒绝时显示拒绝消息，不替换会话视图", async () => {
    const view = buildBattleViewFixture();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        code: "ACTION_REJECTED",
        view,
        feedback: { ok: false, message: "战斗已结束，无法继续行动。" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const onActionSuccess = vi.fn();
    const user = userEvent.setup();

    render(
      <BattlePanel view={view} onActionSuccess={onActionSuccess} onStaleRevision={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "攻击" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("战斗已结束"));
    expect(onActionSuccess).not.toHaveBeenCalled();
  });

  it("陈旧 revision 触发 onStaleRevision 回调", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: "STALE_GAME_REVISION", view: buildBattleViewFixture() })
    );
    vi.stubGlobal("fetch", fetchMock);
    const onStaleRevision = vi.fn();
    const user = userEvent.setup();

    render(
      <BattlePanel
        view={buildBattleViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={onStaleRevision}
      />
    );

    await user.click(screen.getByRole("button", { name: "攻击" }));

    await waitFor(() => expect(onStaleRevision).toHaveBeenCalled());
    expect(screen.getByRole("status")).toHaveTextContent("状态已更新");
  });

  it("网络错误显示友好错误消息", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network error");
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <BattlePanel
        view={buildBattleViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "攻击" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("网络异常"));
  });
});

describe("BattlePanel：不自行减少 HP", () => {
  it("不用前端逻辑判断胜负——HP 完全来自服务器 read model", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = buildBattleViewFixture();
    render(
      <BattlePanel view={view} onActionSuccess={vi.fn()} onStaleRevision={vi.fn()} />
    );

    // 确认显示的 HP 来自 view.battle，不是前端计算
    const battleRegion = screen.getByRole("region", { name: "战斗" });
    expect(battleRegion).toHaveTextContent("28");
    expect(battleRegion).toHaveTextContent("15");
    expect(battleRegion).toHaveTextContent("2");
  });
});
