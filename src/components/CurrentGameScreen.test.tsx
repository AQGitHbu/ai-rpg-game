import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentGameScreen } from "./CurrentGameScreen";
import { buildOpeningViewFixture } from "./openingViewFixture.testutil";

// ---------------------------------------------------------------------------
// Task 4：根页面客户端协调器测试。挂载时读取 /api/game/current：
// none → 创建表单；active → OpeningGameView；corrupt → 按 reason 分支的
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

  it("current=active：直接恢复开场视图，不显示表单", async () => {
    const view = buildOpeningViewFixture();
    stubFetch(async () => jsonResponse(200, { status: "active", view }));
    render(<CurrentGameScreen />);

    expect(await screen.findByText("暮色四合，你背着旧刀走进青石镇。")).toBeInTheDocument();
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
    const view = buildOpeningViewFixture();
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
});
