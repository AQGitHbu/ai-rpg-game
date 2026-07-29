import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldMapScreen } from "./WorldMapScreen";
import { buildSessionViewFixture } from "./sessionViewFixture.testutil";

// ---------------------------------------------------------------------------
// Phase 7 Task 5：世界地图旅行层测试。地图只呈现 worldMap 节点：
//   current    → 进入{名称}，纯本地回调，零 fetch；
//   travelable → 前往{名称}，回调携带 locationId；
//   known      → 禁用按钮，可访问名称含「需从相邻地点前往」；
//   locked     → 禁用按钮，可访问名称固定「探寻未知之地：尚未解锁」。
// 所有可点击节点必须是 <button>；busy 时行动按钮全部禁用。fetch 全程打桩。
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorldMapScreen", () => {
  it("当前节点点击只触发 onEnterCurrent，纯本地导航零 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const enter = vi.fn();
    const move = vi.fn();
    const user = userEvent.setup();

    render(
      <WorldMapScreen
        view={buildSessionViewFixture()}
        onEnterCurrent={enter}
        onMove={move}
        busy={false}
      />
    );

    await user.click(screen.getByRole("button", { name: "进入青石镇" }));

    expect(enter).toHaveBeenCalledOnce();
    expect(move).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("可前往节点点击触发 onMove(locationId)，自身不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const enter = vi.fn();
    const move = vi.fn();
    const user = userEvent.setup();

    render(
      <WorldMapScreen
        view={buildSessionViewFixture()}
        onEnterCurrent={enter}
        onMove={move}
        busy={false}
      />
    );

    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    expect(move).toHaveBeenCalledWith("loc_guandao");
    expect(enter).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("known 节点是禁用按钮：真实名称 + 需从相邻地点前往", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <WorldMapScreen
        view={buildSessionViewFixture()}
        onEnterCurrent={vi.fn()}
        onMove={vi.fn()}
        busy={false}
      />
    );

    expect(
      screen.getByRole("button", { name: "密林深处：需从相邻地点前往" })
    ).toBeDisabled();
  });

  it("locked 节点是禁用按钮：探寻未知之地：尚未解锁，不泄漏真实地点", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <WorldMapScreen
        view={buildSessionViewFixture()}
        onEnterCurrent={vi.fn()}
        onMove={vi.fn()}
        busy={false}
      />
    );

    expect(
      screen.getByRole("button", { name: "探寻未知之地：尚未解锁" })
    ).toBeDisabled();
  });

  it("busy 时全部行动按钮禁用，避免并发写入", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <WorldMapScreen
        view={buildSessionViewFixture()}
        onEnterCurrent={vi.fn()}
        onMove={vi.fn()}
        busy
      />
    );

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("每个地图节点都是 button（不使用 div onClick），数量与 worldMap 节点一致", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = buildSessionViewFixture();
    render(
      <WorldMapScreen view={view} onEnterCurrent={vi.fn()} onMove={vi.fn()} busy={false} />
    );

    expect(screen.getAllByRole("button")).toHaveLength(view.worldMap.nodes.length);
  });

  it("用装饰性地图底图覆盖安全节点，并只让真实节点操作", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = buildSessionViewFixture();
    render(
      <WorldMapScreen view={view} onEnterCurrent={vi.fn()} onMove={vi.fn()} busy={false} />
    );

    expect(screen.getByTestId("world-map-viewport")).toHaveTextContent("当前目标");
    expect(screen.getByTestId("world-map-backdrop")).toHaveAttribute("aria-hidden", "true");
    const moveButtons = screen.getAllByRole("button", { name: /前往/ });
    expect(moveButtons.length).toBeGreaterThan(0);
    for (const btn of moveButtons) {
      expect(btn).toHaveAttribute("data-map-position");
    }
    expect(screen.getByRole("button", { name: /探寻未知之地/ })).toBeDisabled();
  });
});
