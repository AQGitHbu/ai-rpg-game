import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemPanel } from "./ItemPanel";
import { buildItemTakenSessionViewFixture, buildSessionViewFixture } from "./sessionViewFixture.testutil";

// ---------------------------------------------------------------------------
// Phase 5 Task 4：物品面板测试（"可取得物品" + "背包" 两个业务区域）。
// 名称/描述只来自 GameSessionView（obtainableItems / inventoryItems），
// 拾取按钮提交带 revision 的 take_item payload，提交期间禁用、拒绝/陈旧
// revision 反馈与 SceneActionPanel/TravelPanel 同一套模式（aria-live），
// fetch 全程打桩。绝不出现 use/give/trade 等未来阶段按钮。
// ---------------------------------------------------------------------------

type FakeResponse = { json: () => Promise<unknown> };

function jsonResponse(body: unknown): FakeResponse {
  return { json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ItemPanel", () => {
  it("渲染可取得物品（名称/描述 + 拾取按钮）与背包物品，别无其他按钮", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <ItemPanel
        view={buildSessionViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );

    const obtainable = screen.getByRole("region", { name: "可取得物品" });
    expect(within(obtainable).getByText("锈铁钥匙")).toBeInTheDocument();
    expect(within(obtainable).getByText(/钥匙柄上刻着镖局的徽记/)).toBeInTheDocument();
    expect(within(obtainable).getByRole("button", { name: "拾取锈铁钥匙" })).toBeInTheDocument();

    const inventory = screen.getByRole("region", { name: "背包" });
    expect(within(inventory).getByText(/旧刀/)).toBeInTheDocument();
    expect(within(inventory).getByText(/父亲留下的佩刀/)).toBeInTheDocument();
    expect(within(inventory).queryAllByRole("button")).toEqual([]);

    // 未来阶段能力不出现：全面板只有拾取按钮，无使用/赠送/交易入口。
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /使用|赠送|交易/ })).toBeNull();
  });

  it("提交 take_item 时带上 read model revision，并用成功响应替换会话视图", async () => {
    const view = buildSessionViewFixture();
    const takenView = buildItemTakenSessionViewFixture();
    let submittedRequest: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      submittedRequest = init;
      return jsonResponse({ view: takenView, feedback: { ok: true, message: "你拾起了锈铁钥匙。" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onActionSuccess = vi.fn();
    const user = userEvent.setup();

    render(<ItemPanel view={view} onActionSuccess={onActionSuccess} onStaleRevision={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "拾取锈铁钥匙" }));

    await waitFor(() => expect(onActionSuccess).toHaveBeenCalledWith(takenView));
    expect(screen.getByRole("status")).toHaveTextContent("你拾起了锈铁钥匙。");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/game/actions",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.parse(String(submittedRequest?.body))).toEqual({
      intent: { type: "take_item", itemId: "item_key" },
      revision: 0
    });
  });

  it("提交期间禁用全部拾取按钮，重复点击不产生第二次请求", async () => {
    let resolveResponse: ((response: FakeResponse) => void) | undefined;
    const fetchMock = vi.fn(
      () => new Promise<FakeResponse>((resolve) => { resolveResponse = resolve; })
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ItemPanel
        view={buildSessionViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );
    const takeButton = screen.getByRole("button", { name: "拾取锈铁钥匙" });
    await user.click(takeButton);

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
    // 禁用期间再点一次：不得触发第二次写入。
    await user.click(takeButton);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveResponse?.(jsonResponse({
      view: buildItemTakenSessionViewFixture(),
      feedback: { ok: true, message: "完成" }
    }));
    await screen.findByText("完成");
  });

  it("外部 busy 时禁用拾取按钮（其他面板正在提交）", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <ItemPanel
        view={buildSessionViewFixture()}
        busy
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "拾取锈铁钥匙" })).toBeDisabled();
  });

  it("规则拒绝经 aria-live 显示反馈但不伪造成功", async () => {
    const view = buildSessionViewFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          code: "ACTION_REJECTED",
          view,
          feedback: { ok: false, message: "这件物品不在此处。" }
        })
      )
    );
    const onActionSuccess = vi.fn();
    const user = userEvent.setup();

    render(<ItemPanel view={view} onActionSuccess={onActionSuccess} onStaleRevision={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "拾取锈铁钥匙" }));

    expect(await screen.findByRole("status")).toHaveTextContent("这件物品不在此处。");
    expect(onActionSuccess).not.toHaveBeenCalled();
  });

  it("revision 冲突请求重新读取当前存档", async () => {
    const onStaleRevision = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "STALE_GAME_REVISION" })));
    const user = userEvent.setup();

    render(
      <ItemPanel
        view={buildSessionViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={onStaleRevision}
      />
    );
    await user.click(screen.getByRole("button", { name: "拾取锈铁钥匙" }));

    expect(await screen.findByRole("status")).toHaveTextContent("状态已更新，请重试。");
    expect(onStaleRevision).toHaveBeenCalledTimes(1);
  });

  it("键盘可操作：Tab 聚焦拾取按钮后按 Enter 触发提交", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        view: buildItemTakenSessionViewFixture(),
        feedback: { ok: true, message: "你拾起了锈铁钥匙。" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ItemPanel
        view={buildSessionViewFixture()}
        onActionSuccess={vi.fn()}
        onStaleRevision={vi.fn()}
      />
    );

    await user.tab();
    expect(screen.getByRole("button", { name: "拾取锈铁钥匙" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("status")).toHaveTextContent("你拾起了锈铁钥匙。");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("没有可取得物品且背包为空时显示中性空态，无任何按钮", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = buildSessionViewFixture();
    const emptyView = {
      ...view,
      availableActions: view.availableActions.filter((action) => action.type !== "take_item"),
      obtainableItems: [],
      inventoryItems: []
    };

    render(<ItemPanel view={emptyView} onActionSuccess={vi.fn()} onStaleRevision={vi.fn()} />);

    expect(screen.getByText("当前地点没有可取得的物品。")).toBeInTheDocument();
    expect(screen.getByText("背包目前是空的。")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
