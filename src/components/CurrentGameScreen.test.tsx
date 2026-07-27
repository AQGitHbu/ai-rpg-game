import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentGameScreen } from "./CurrentGameScreen";
import {
  buildItemTakenSessionViewFixture,
  buildMovedSessionViewFixture,
  buildSessionViewFixture
} from "./sessionViewFixture.testutil";

// ---------------------------------------------------------------------------
// Task 4（Phase 3）+ Phase 4 Task 4：根页面客户端协调器测试。
// 挂载时读取 /api/game/current：none → 创建表单；active → 会话视图
//（场景 + 行动面板 + 移动面板 + 任务面板）；corrupt → 按 reason 分支的
// 可恢复提示（真实数据损坏 ≠ 数据库不可用）。fetch 全程打桩。
// ---------------------------------------------------------------------------

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function jsonResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function stubFetch(implementation: (input: unknown, init?: RequestInit) => Promise<FakeResponse>) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CurrentGameScreen", () => {
  it("加载中先显示读取状态（aria-live）", () => {
    stubFetch(() => new Promise<FakeResponse>(() => {}));
    render(<CurrentGameScreen />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取当前存档");
  });

  it("current=none：显示创建表单，且只请求过 /api/game/current", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { status: "none" }));
    render(<CurrentGameScreen />);

    expect(await screen.findByText("选择游戏类型")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/game/current");
  });

  it("current=active：恢复会话视图含任务与移动面板，不显示表单", async () => {
    const view = buildSessionViewFixture();
    stubFetch(async () => jsonResponse(200, { status: "active", view }));
    render(<CurrentGameScreen />);

    expect(await screen.findByText("暮色四合，你背着旧刀走进青石镇。")).toBeInTheDocument();
    // 刷新恢复：GET /api/game/current 还原任务面板与移动面板。
    expect(screen.getByText("查明灭门真相")).toBeInTheDocument();
    expect(screen.getByText("后续阶段能力")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往城外官道" })).toBeInTheDocument();
    // 刷新恢复（Phase 5）：物品面板的可取得区与背包一并还原。
    expect(screen.getByRole("button", { name: "拾取锈铁钥匙" })).toBeInTheDocument();
    const obtainable = screen.getByRole("region", { name: "可取得物品" });
    expect(within(obtainable).getByText("锈铁钥匙")).toBeInTheDocument();
    const inventory = screen.getByRole("region", { name: "背包" });
    expect(within(inventory).getByText("旧刀")).toBeInTheDocument();
    expect(screen.queryByText("选择游戏类型")).toBeNull();
  });

  it("corrupt=UNPARSEABLE_RECORD：显示数据损坏提示，而非数据库不可用", async () => {
    stubFetch(async () =>
      jsonResponse(200, { status: "corrupt", reason: "UNPARSEABLE_RECORD" })
    );
    render(<CurrentGameScreen />);

    expect(await screen.findByText(/存档记录无法解析/)).toBeInTheDocument();
    expect(screen.getByText(/存档数据已损坏/)).toBeInTheDocument();
    expect(screen.queryByText(/暂时不可用/)).toBeNull();
  });

  it("corrupt=INFRASTRUCTURE_FAILURE：显示数据库暂不可用，而非数据损坏", async () => {
    stubFetch(async () =>
      jsonResponse(503, { status: "corrupt", reason: "INFRASTRUCTURE_FAILURE" })
    );
    render(<CurrentGameScreen />);

    expect(await screen.findByText(/本地存档数据库暂时不可用/)).toBeInTheDocument();
    expect(screen.queryByText(/已损坏/)).toBeNull();
  });

  it("current API 网络异常：提示刷新重试，不显示表单", async () => {
    stubFetch(async () => {
      throw new TypeError("failed to fetch");
    });
    render(<CurrentGameScreen />);

    expect(await screen.findByText(/未能读取当前存档/)).toBeInTheDocument();
    expect(screen.queryByText("选择游戏类型")).toBeNull();
  });

  it("完整闭环：none → 填表创建成功 → 无需刷新直接看到开场视图，只访问本地 API", async () => {
    const view = buildSessionViewFixture();
    const fetchMock = stubFetch(async (input) => {
      if (input === "/api/game/current") return jsonResponse(200, { status: "none" });
      if (input === "/api/game") return jsonResponse(201, { view });
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await screen.findByText("选择游戏类型");
    await user.type(screen.getByLabelText("角色名字"), "沈青崖");
    await user.type(screen.getByLabelText("身份 / 职业"), "落魄镖师");
    await user.click(screen.getByLabelText("世界观背景"));
    await user.paste("镖局一夜覆灭，江湖各派暗流涌动，真凶身份成谜。");
    await user.click(screen.getByLabelText("故事开端"));
    await user.paste("暮色四合，主角背着旧刀走进青石镇，镇口贴着缉凶告示。");
    await user.click(screen.getByRole("button", { name: "确认开局资料" }));

    expect(await screen.findByText("暮色四合，你背着旧刀走进青石镇。")).toBeInTheDocument();
    expect(screen.queryByText("选择游戏类型")).toBeNull();
    // 无 AI 网络请求：全部调用都指向本地 /api/game*。
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toMatch(/^\/api\/game(\/current)?$/);
    }
  });

  it("移动闭环：发送 move payload 与 revision，成功后新地点/NPC/任务更新", async () => {
    const view = buildSessionViewFixture();
    const movedView = buildMovedSessionViewFixture();
    let submittedRequest: RequestInit | undefined;
    const fetchMock = stubFetch(async (input, init) => {
      if (input === "/api/game/current") return jsonResponse(200, { status: "active", view });
      if (input === "/api/game/actions") {
        submittedRequest = init;
        return jsonResponse(200, {
          view: movedView,
          feedback: { ok: true, message: "你来到了城外官道。" }
        });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "前往城外官道" }));

    // 新地点描述与运行时在场 NPC。
    expect(
      await screen.findByText("黄土道上车辙纵横，隐约可见几处暗色血迹。")
    ).toBeInTheDocument();
    expect(screen.getByText(/巡道老兵/)).toBeInTheDocument();
    // 任务面板同步更新：旧主线完成后只展示新解锁的 active 任务。
    expect(screen.getByText("追查马帮下落")).toBeInTheDocument();
    expect(screen.queryByText("查明灭门真相")).toBeNull();
    // 开场快照 NPC 不泄漏到新地点（在场名单来自运行时 presentNpcs）。
    expect(screen.queryByText(/陆掌柜/)).toBeNull();
    // 请求 payload 只含 intent + revision。
    expect(JSON.parse(String(submittedRequest?.body))).toEqual({
      intent: { type: "move", locationId: "loc_guandao" },
      revision: 0
    });
    // 无 AI 网络请求：全部调用都指向本地 /api/game*。
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toMatch(/^\/api\/game\/(current|actions)$/);
    }
  });

  it("行动请求进行中：场景与移动面板的全部按钮一律禁用", async () => {
    const view = buildSessionViewFixture();
    let resolvePost: ((response: FakeResponse) => void) | undefined;
    stubFetch(async (input) => {
      if (input === "/api/game/current") return jsonResponse(200, { status: "active", view });
      return new Promise<FakeResponse>((resolve) => { resolvePost = resolve; });
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "前往城外官道" }));

    // 提交期间：行动面板 + 移动面板的所有按钮都禁用，避免并发写入。
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }

    resolvePost?.(
      jsonResponse(200, {
        view: buildMovedSessionViewFixture(),
        feedback: { ok: true, message: "你来到了城外官道。" }
      })
    );
    await screen.findByText("你来到了城外官道。");
  });

  it("拾取闭环：发送 take_item payload 与 revision，成功后物品从可取得区消失并进入背包", async () => {
    const view = buildSessionViewFixture();
    const takenView = buildItemTakenSessionViewFixture();
    let submittedRequest: RequestInit | undefined;
    const fetchMock = stubFetch(async (input, init) => {
      if (input === "/api/game/current") return jsonResponse(200, { status: "active", view });
      if (input === "/api/game/actions") {
        submittedRequest = init;
        return jsonResponse(200, {
          view: takenView,
          feedback: { ok: true, message: "你拾起了锈铁钥匙。" }
        });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "拾取锈铁钥匙" }));

    // 成功后整页替换为服务端 read model：可取得区清空、背包收录新物品。
    const obtainable = screen.getByRole("region", { name: "可取得物品" });
    expect(
      await within(obtainable).findByText("当前地点没有可取得的物品。")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拾取锈铁钥匙" })).toBeNull();
    const inventory = screen.getByRole("region", { name: "背包" });
    expect(within(inventory).getByText("锈铁钥匙")).toBeInTheDocument();
    // 任务目标同步到完成态（服务端视图驱动，UI 不自行推断）。
    expect(screen.queryByText("后续阶段能力")).toBeNull();
    // 请求 payload 只含 intent + revision。
    expect(JSON.parse(String(submittedRequest?.body))).toEqual({
      intent: { type: "take_item", itemId: "item_key" },
      revision: 0
    });
    // 无 AI 网络请求：全部调用都指向本地 /api/game*。
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toMatch(/^\/api\/game\/(current|actions)$/);
    }
  });

  it("拾取遇到陈旧 revision：重新读取当前存档并渲染最新视图", async () => {
    const view = buildSessionViewFixture();
    const refreshedView = { ...buildItemTakenSessionViewFixture(), revision: 2 };
    let currentCalls = 0;
    stubFetch(async (input) => {
      if (input === "/api/game/current") {
        currentCalls += 1;
        return jsonResponse(200, {
          status: "active",
          view: currentCalls === 1 ? view : refreshedView
        });
      }
      if (input === "/api/game/actions") {
        return jsonResponse(409, { code: "STALE_GAME_REVISION" });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "拾取锈铁钥匙" }));

    // 冲突后重新请求 current-game：最新视图里钥匙已在背包、拾取按钮消失。
    const obtainable = screen.getByRole("region", { name: "可取得物品" });
    expect(
      await within(obtainable).findByText("当前地点没有可取得的物品。")
    ).toBeInTheDocument();
    expect(currentCalls).toBe(2);
  });

  it("移动遇到陈旧 revision：重新读取当前存档并渲染最新视图", async () => {
    const view = buildSessionViewFixture();
    const refreshedView = { ...buildMovedSessionViewFixture(), revision: 2 };
    let currentCalls = 0;
    stubFetch(async (input) => {
      if (input === "/api/game/current") {
        currentCalls += 1;
        return jsonResponse(200, {
          status: "active",
          view: currentCalls === 1 ? view : refreshedView
        });
      }
      if (input === "/api/game/actions") {
        return jsonResponse(409, { code: "STALE_GAME_REVISION" });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "前往城外官道" }));

    // 冲突后重新请求 current-game，渲染服务器最新视图。
    expect(
      await screen.findByText("黄土道上车辙纵横，隐约可见几处暗色血迹。")
    ).toBeInTheDocument();
    expect(currentCalls).toBe(2);
  });
});
