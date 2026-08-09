import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EndingPanel } from "./EndingPanel";
import type { CompatibilityGameSessionView } from "@/game/application";

// ---------------------------------------------------------------------------
// Phase 6 Task 4：结局面板测试。
// 只在 view.ending 非 null 时渲染；显示结局名称、描述与 outcome；
// 成功结局与失败结局有不同视觉标识；结局后无任何可操作按钮。
// ---------------------------------------------------------------------------

function buildEndingViewFixture(outcome: "success" | "failure"): CompatibilityGameSessionView {
  return {
    gameId: "game-ending-001",
    world: { name: "武侠", summary: "镖局一夜覆灭。", gameType: "wuxia" },
    player: { name: "沈青崖", identity: "落魄镖师" },
    currentLocation: { name: "密林深处", description: "树影摇曳，杀气森森。" },
    visibleNpcs: [],
    initialItems: [],
    openingNarration: "你踏入了密林深处。",
    suggestedActions: [],
    generation: { generationId: "gen-001", templateVersion: "fallback-1" },
    revision: 5,
    availableActions: [],
    knownFacts: [],
    presentNpcs: [],
    activeQuests: [],
    obtainableItems: [],
    inventoryItems: [],
    battle: null,
    ending:
      outcome === "success"
        ? {
            name: "真相大白",
            description: "刺客伏诛，灭门真相终于大白于天下。",
            outcome: "success",
          }
        : {
            name: "功亏一篑",
            description: "撤退后线索断裂，真相终被掩埋。",
            outcome: "failure",
          },
  } as unknown as CompatibilityGameSessionView;
}

function buildNoEndingViewFixture(): CompatibilityGameSessionView {
  const base = buildEndingViewFixture("success");
  return { ...base, ending: null } as unknown as CompatibilityGameSessionView;
}

describe("EndingPanel：渲染条件", () => {
  it("view.ending 非 null 时渲染结局面板", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<EndingPanel view={buildEndingViewFixture("success")} />);

    expect(screen.getByRole("region", { name: "结局" })).toBeInTheDocument();
  });

  it("view.ending 为 null 时不渲染结局面板", () => {
    vi.stubGlobal("fetch", vi.fn());
    const { container } = render(<EndingPanel view={buildNoEndingViewFixture()} />);

    expect(container.querySelector("[data-ending-panel]")).toBeNull();
  });
});

describe("EndingPanel：成功结局展示", () => {
  it("显示结局名称、描述与成功标识", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<EndingPanel view={buildEndingViewFixture("success")} />);

    expect(screen.getByText("真相大白")).toBeInTheDocument();
    expect(screen.getByText("刺客伏诛，灭门真相终于大白于天下。")).toBeInTheDocument();
    expect(screen.getByText(/成功/)).toBeInTheDocument();
  });
});

describe("EndingPanel：失败结局展示", () => {
  it("显示结局名称、描述与失败标识", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<EndingPanel view={buildEndingViewFixture("failure")} />);

    expect(screen.getByText("功亏一篑")).toBeInTheDocument();
    expect(screen.getByText("撤退后线索断裂，真相终被掩埋。")).toBeInTheDocument();
    expect(screen.getByText(/失败/)).toBeInTheDocument();
  });
});

describe("EndingPanel：结局后无可操作元素", () => {
  it("结局面板不渲染任何按钮", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<EndingPanel view={buildEndingViewFixture("success")} />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("结局面板不渲染任何表单输入", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<EndingPanel view={buildEndingViewFixture("failure")} />);

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("input")).toBeNull();
  });
});
