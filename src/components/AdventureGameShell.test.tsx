import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdventureGameShell } from "./AdventureGameShell";
import {
  buildMovedSessionViewFixture,
  buildSessionViewFixture
} from "./sessionViewFixture.testutil";

// ---------------------------------------------------------------------------
// Phase 7 Task 5：地图优先游戏壳测试。壳只维护本地 screen: map | scene 状态机：
//   - 首次 active view 显示地图；
//   - 进入当前地点 = 纯本地 map → scene 切换，零请求、revision 不变；
//   - move 走 postGameAction 协议：success 上报最新 view 并自动切到 scene，
//     rejected 留在地图显示反馈，stale 只触发 onStaleRevision，error 不伪造成功。
// fetch 全程打桩，绝不发真实请求。
// ---------------------------------------------------------------------------

type FakeResponse = { json: () => Promise<unknown> };

function jsonResponse(body: unknown): FakeResponse {
  return { json: async () => body };
}

function renderShell(overrides?: {
  view?: ReturnType<typeof buildSessionViewFixture>;
  onBusyChange?: ReturnType<typeof vi.fn>;
  onViewChange?: ReturnType<typeof vi.fn>;
  onStaleRevision?: ReturnType<typeof vi.fn>;
}) {
  const props = {
    view: overrides?.view ?? buildSessionViewFixture(),
    busy: false,
    onBusyChange: overrides?.onBusyChange ?? vi.fn(),
    onViewChange: overrides?.onViewChange ?? vi.fn(),
    onStaleRevision: overrides?.onStaleRevision ?? vi.fn()
  };
  return { ...render(<AdventureGameShell {...props} />), props };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdventureGameShell", () => {
  it("首次 active view 显示世界地图，不显示地点场景", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderShell();

    expect(screen.getByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回地图" })).toBeNull();
  });

  it("进入当前地点只做本地 map → scene 切换：零请求、view 不变", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onViewChange = vi.fn();
    const user = userEvent.setup();
    renderShell({ onViewChange });

    await user.click(screen.getByRole("button", { name: "进入青石镇" }));

    expect(screen.getByRole("heading", { name: "青石镇" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回地图" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("返回地图同样是本地切换，零请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "进入青石镇" }));
    await user.click(screen.getByRole("button", { name: "返回地图" }));

    expect(screen.getByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("移动成功：提交精确 move payload、上报最新 view 并自动切换到地点场景", async () => {
    const movedView = buildMovedSessionViewFixture();
    let submittedRequest: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      submittedRequest = init;
      return jsonResponse({ view: movedView, feedback: { ok: true, message: "你来到了城外官道。" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onViewChange = vi.fn();
    const onBusyChange = vi.fn();
    const user = userEvent.setup();
    const { rerender, props } = renderShell({ onViewChange, onBusyChange });

    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    await waitFor(() => expect(onViewChange).toHaveBeenCalledWith(movedView));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/game/actions",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.parse(String(submittedRequest?.body))).toEqual({
      intent: { type: "move", locationId: "loc_guandao" },
      revision: 0
    });
    expect(onBusyChange).toHaveBeenNthCalledWith(1, true);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);

    // 父级用最新 view 重渲染后，壳已自动处于目标地点场景。
    rerender(<AdventureGameShell {...props} view={movedView} />);
    expect(screen.getByRole("heading", { name: "城外官道" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回地图" })).toBeInTheDocument();
  });

  it("移动被规则拒绝：留在地图并显示反馈，不上报新 view", async () => {
    const view = buildSessionViewFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          code: "ACTION_REJECTED",
          view,
          feedback: { ok: false, message: "那条路尚未打通。" }
        })
      )
    );
    const onViewChange = vi.fn();
    const user = userEvent.setup();
    renderShell({ view, onViewChange });

    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    expect(await screen.findByRole("status")).toHaveTextContent("那条路尚未打通。");
    expect(screen.getByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回地图" })).toBeNull();
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("revision 冲突：只触发 onStaleRevision，不上报新 view、不切换场景", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "STALE_GAME_REVISION" })));
    const onViewChange = vi.fn();
    const onStaleRevision = vi.fn();
    const user = userEvent.setup();
    renderShell({ onViewChange, onStaleRevision });

    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    await waitFor(() => expect(onStaleRevision).toHaveBeenCalledTimes(1));
    expect(onViewChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回地图" })).toBeNull();
  });

  it("网络异常：显示错误、留在地图，绝不伪造移动成功", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const onViewChange = vi.fn();
    const onStaleRevision = vi.fn();
    const user = userEvent.setup();
    renderShell({ onViewChange, onStaleRevision });

    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "网络异常，请检查连接后重试。"
    );
    expect(screen.getByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回地图" })).toBeNull();
    expect(onViewChange).not.toHaveBeenCalled();
    expect(onStaleRevision).not.toHaveBeenCalled();
  });

  it("次级面板入口是本地开关：切换 aria-expanded，零请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderShell();

    const toggle = screen.getByRole("button", { name: "冒险详情" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
