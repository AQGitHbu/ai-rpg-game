import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SceneActionPanel } from "./SceneActionPanel";
import { buildOpeningViewFixture } from "./openingViewFixture.testutil";

type FakeResponse = { json: () => Promise<unknown> };

function jsonResponse(body: unknown): FakeResponse {
  return { json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SceneActionPanel", () => {
  it("提交固定行动时带上 read model revision，并用成功响应替换开场视图", async () => {
    const view = buildOpeningViewFixture();
    const updatedView = { ...view, revision: 1, availableActions: [] };
    let submittedRequest: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      submittedRequest = init;
      return jsonResponse({ view: updatedView, feedback: { ok: true, message: "观察完成。" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onActionSuccess = vi.fn();
    const user = userEvent.setup();

    render(
      <SceneActionPanel
        view={view}
        onActionSuccess={onActionSuccess}
        onStaleRevision={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "观察青石镇" }));

    await waitFor(() => expect(onActionSuccess).toHaveBeenCalledWith(updatedView));
    expect(screen.getByRole("status")).toHaveTextContent("观察完成。");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/game/actions",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.parse(String(submittedRequest?.body))).toEqual({
      intent: { type: "observe", locationId: "loc_qingshi" },
      revision: 0
    });
  });

  it("提交期间禁用全部固定行动，避免重复写入", async () => {
    let resolveResponse: ((response: FakeResponse) => void) | undefined;
    const fetchMock = vi.fn(
      () => new Promise<FakeResponse>((resolve) => { resolveResponse = resolve; })
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const view = buildOpeningViewFixture();

    render(<SceneActionPanel view={view} onActionSuccess={vi.fn()} onStaleRevision={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "观察青石镇" }));

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveResponse?.(jsonResponse({ view, feedback: { ok: true, message: "完成" } }));
    await screen.findByText("完成");
  });

  it("规则拒绝显示反馈但不伪造成功", async () => {
    const view = buildOpeningViewFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          code: "ACTION_REJECTED",
          view,
          feedback: { ok: false, message: "你已经观察过这里了。" }
        })
      )
    );
    const onActionSuccess = vi.fn();
    const user = userEvent.setup();

    render(<SceneActionPanel view={view} onActionSuccess={onActionSuccess} onStaleRevision={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "观察青石镇" }));

    expect(await screen.findByRole("status")).toHaveTextContent("你已经观察过这里了。");
    expect(onActionSuccess).not.toHaveBeenCalled();
  });

  it("revision 冲突请求重新读取当前存档", async () => {
    const onStaleRevision = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "STALE_GAME_REVISION" })));
    const user = userEvent.setup();

    render(
      <SceneActionPanel
        view={buildOpeningViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={onStaleRevision}
      />
    );
    await user.click(screen.getByRole("button", { name: "观察青石镇" }));

    expect(await screen.findByRole("status")).toHaveTextContent("状态已更新，请重试。");
    expect(onStaleRevision).toHaveBeenCalledTimes(1);
  });

  it("非对象响应显示可恢复错误，不在客户端抛出 TypeError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(true)));
    const user = userEvent.setup();

    render(
      <SceneActionPanel
        view={buildOpeningViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "观察青石镇" }));

    expect(await screen.findByRole("status")).toHaveTextContent("服务器返回了无法解析的响应");
  });
});
