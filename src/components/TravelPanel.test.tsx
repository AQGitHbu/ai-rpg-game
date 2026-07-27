import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TravelPanel } from "./TravelPanel";
import { buildMovedSessionViewFixture, buildSessionViewFixture } from "./sessionViewFixture.testutil";

// ---------------------------------------------------------------------------
// Phase 4 Task 4：地点移动面板测试。只渲染会话视图中的 move 行动按钮；
// 提交带 revision 的 move payload、提交期间禁用、拒绝/陈旧 revision 反馈
// 与 SceneActionPanel 同一套模式（aria-live），fetch 全程打桩。
// ---------------------------------------------------------------------------

type FakeResponse = { json: () => Promise<unknown> };

function jsonResponse(body: unknown): FakeResponse {
  return { json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TravelPanel", () => {
  it("只渲染 move 行动按钮，不渲染 observe/talk/investigate", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <TravelPanel
        view={buildSessionViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "前往城外官道" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "观察青石镇" })).toBeNull();
    expect(screen.queryByRole("button", { name: "与陆掌柜交谈" })).toBeNull();
  });

  it("提交 move 时带上 read model revision，并用成功响应替换会话视图", async () => {
    const view = buildSessionViewFixture();
    const movedView = buildMovedSessionViewFixture();
    let submittedRequest: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      submittedRequest = init;
      return jsonResponse({ view: movedView, feedback: { ok: true, message: "你来到了城外官道。" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onActionSuccess = vi.fn();
    const user = userEvent.setup();

    render(
      <TravelPanel view={view} onActionSuccess={onActionSuccess} onStaleRevision={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    await waitFor(() => expect(onActionSuccess).toHaveBeenCalledWith(movedView));
    expect(screen.getByRole("status")).toHaveTextContent("你来到了城外官道。");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/game/actions",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.parse(String(submittedRequest?.body))).toEqual({
      intent: { type: "move", locationId: "loc_guandao" },
      revision: 0
    });
  });

  it("提交期间禁用全部移动按钮，避免重复写入", async () => {
    let resolveResponse: ((response: FakeResponse) => void) | undefined;
    const fetchMock = vi.fn(
      () => new Promise<FakeResponse>((resolve) => { resolveResponse = resolve; })
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <TravelPanel
        view={buildSessionViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveResponse?.(jsonResponse({
      view: buildMovedSessionViewFixture(),
      feedback: { ok: true, message: "完成" }
    }));
    await screen.findByText("完成");
  });

  it("外部 busy 时禁用移动按钮（其他面板正在提交）", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <TravelPanel
        view={buildSessionViewFixture()}
        busy
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "前往城外官道" })).toBeDisabled();
  });

  it("规则拒绝显示反馈但不伪造成功", async () => {
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
    const onActionSuccess = vi.fn();
    const user = userEvent.setup();

    render(<TravelPanel view={view} onActionSuccess={onActionSuccess} onStaleRevision={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    expect(await screen.findByRole("status")).toHaveTextContent("那条路尚未打通。");
    expect(onActionSuccess).not.toHaveBeenCalled();
  });

  it("revision 冲突请求重新读取当前存档", async () => {
    const onStaleRevision = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "STALE_GAME_REVISION" })));
    const user = userEvent.setup();

    render(
      <TravelPanel
        view={buildSessionViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={onStaleRevision}
      />
    );
    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    expect(await screen.findByRole("status")).toHaveTextContent("状态已更新，请重试。");
    expect(onStaleRevision).toHaveBeenCalledTimes(1);
  });

  it("没有可前往的地点时显示中性提示", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = buildSessionViewFixture();
    const noMoveView = {
      ...view,
      availableActions: view.availableActions.filter((action) => action.type !== "move")
    };

    render(
      <TravelPanel view={noMoveView} onActionSuccess={vi.fn()} onStaleRevision={vi.fn()} />
    );

    expect(screen.getByText("当前没有可前往的相邻地点。")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
