import { render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewGameSetupForm } from "./NewGameSetupForm";
import { buildSessionViewFixture } from "./sessionViewFixture.testutil";

// ---------------------------------------------------------------------------
// Task 4：表单真实提交测试。fetch 一律以 vi.stubGlobal 打桩——jsdom 测试
// 不接触 SQLite/scenario，也不允许任何未预期的网络调用（无 AI 请求）。
// ---------------------------------------------------------------------------

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function jsonResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function stubFetch(implementation: (input: unknown, init?: RequestInit) => Promise<FakeResponse>) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fillValidForm(user: UserEvent) {
  await user.click(screen.getByRole("radio", { name: /科幻/ }));
  await user.type(screen.getByLabelText("角色名字"), "林渡");
  await user.type(screen.getByLabelText("身份 / 职业"), "失踪航站的维修员");
  await user.click(screen.getByLabelText("世界观背景"));
  await user.paste("人类城市依靠一座不断删除居民记忆的轨道电梯维持能源。");
  await user.click(screen.getByLabelText("故事开端"));
  await user.paste("我在停运十年的站台收到了一张写着自己名字的返程票。");
}

describe("NewGameSetupForm", () => {
  it("offers all configured MVP game types", () => {
    stubFetch(async () => jsonResponse(200, {}));
    render(<NewGameSetupForm />);
    for (const label of ["武侠", "仙侠", "奇幻", "科幻", "都市", "历史架空", "末日"]) {
      expect(screen.getByRole("radio", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
  });

  it("渲染本身不发起任何网络请求", () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, {}));
    render(<NewGameSetupForm />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("有效表单 → loading → 只向 /api/game 提交允许字段 → onCreated 收到 view 与安全来源", async () => {
    const view = buildSessionViewFixture();
    const pending = deferred<FakeResponse>();
    const fetchMock = stubFetch(() => pending.promise);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewGameSetupForm onCreated={onCreated} />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "确认开局资料" }));

    // loading：aria-live 等待态 + 提交按钮与类型 fieldset 禁用。
    expect(screen.getByRole("status")).toHaveTextContent("正在生成世界，请稍候……");
    expect(screen.getByRole("button", { name: "确认开局资料" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /科幻/ })).toBeDisabled();

    pending.resolve(jsonResponse(201, { view, generationSource: "generated" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(view, "generated"));

    // 只调用一次，且只打向本地 API（无 AI 网络请求）。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/game");
    expect(init?.method).toBe("POST");
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "characterIdentity",
      "characterName",
      "characterProfile",
      "contentIntensity",
      "gameType",
      "narrativeStyle",
      "personalityTags",
      "storyOpening",
      "worldPremise"
    ]);
    // 浏览器绝不提交 seed/gameId/生成来源等内部字段。
    expect(payload).not.toHaveProperty("seed");
    expect(payload).not.toHaveProperty("gameId");
    expect(payload.gameType).toBe("science_fiction");
    expect(payload.personalityTags).toEqual([]);
    expect(payload.contentIntensity).toBe("normal");
  });

  it("loading 期间重复点击不会重复提交", async () => {
    const pending = deferred<FakeResponse>();
    const fetchMock = stubFetch(() => pending.promise);
    const user = userEvent.setup();
    render(<NewGameSetupForm onCreated={vi.fn()} />);

    await fillValidForm(user);
    const submit = screen.getByRole("button", { name: "确认开局资料" });
    await user.click(submit);
    await user.click(submit);
    await user.click(submit);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    pending.resolve(jsonResponse(201, { view: buildSessionViewFixture(), generationSource: "generated" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认开局资料" })).toBeEnabled()
    );
  });

  it("fallback 来源：onCreated 收到 (view, 'fallback')", async () => {
    const view = buildSessionViewFixture();
    stubFetch(async () => jsonResponse(201, { view, generationSource: "fallback" }));
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewGameSetupForm onCreated={onCreated} />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "确认开局资料" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(view, "fallback"));
  });

  it("201 但缺失 generationSource：视为失败，不调用 onCreated", async () => {
    stubFetch(async () => jsonResponse(201, { view: buildSessionViewFixture() }));
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewGameSetupForm onCreated={onCreated} />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "确认开局资料" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("创建开局失败")
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "确认开局资料" })).toBeEnabled();
  });

  it("201 但 generationSource 未知：同样失败，绝不默认按 generated 处理", async () => {
    stubFetch(async () =>
      jsonResponse(201, { view: buildSessionViewFixture(), generationSource: "ai_live" })
    );
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewGameSetupForm onCreated={onCreated} />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "确认开局资料" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("创建开局失败")
    );
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("客户端校验失败：不发请求，逐字段提示并标记 aria-invalid", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, {}));
    const user = userEvent.setup();
    render(<NewGameSetupForm />);

    // 只填其余字段，角色名字留空。
    await user.type(screen.getByLabelText("身份 / 职业"), "失踪航站的维修员");
    await user.click(screen.getByLabelText("世界观背景"));
    await user.paste("人类城市依靠一座不断删除居民记忆的轨道电梯维持能源。");
    await user.click(screen.getByLabelText("故事开端"));
    await user.paste("我在停运十年的站台收到了一张写着自己名字的返程票。");
    await user.click(screen.getByRole("button", { name: "确认开局资料" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("请修正表单中标出的问题");
    expect(screen.getByLabelText("角色名字")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("此项为必填内容。")).toBeInTheDocument();
  });

  it("服务器 INVALID_INPUT：按 fieldErrors 显示服务器字段错误", async () => {
    stubFetch(async () =>
      jsonResponse(400, {
        code: "INVALID_INPUT",
        fieldErrors: [
          { field: "worldPremise", code: "TOO_LONG", params: { max: 500, actual: 600 } }
        ]
      })
    );
    const user = userEvent.setup();
    render(<NewGameSetupForm />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "确认开局资料" }));

    await waitFor(() =>
      expect(screen.getByText("最多允许 500 个字符（当前 600 个）。")).toBeInTheDocument()
    );
    expect(screen.getByLabelText("世界观背景")).toHaveAttribute("aria-invalid", "true");
  });

  it("ACTIVE_GAME_EXISTS 冲突：提示已有存档且刷新可恢复", async () => {
    stubFetch(async () => jsonResponse(409, { code: "ACTIVE_GAME_EXISTS" }));
    const user = userEvent.setup();
    render(<NewGameSetupForm />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "确认开局资料" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("已存在进行中的存档")
    );
    // 失败后允许再次提交。
    expect(screen.getByRole("button", { name: "确认开局资料" })).toBeEnabled();
  });

  it("INFRASTRUCTURE_FAILURE：提示数据库暂不可用", async () => {
    stubFetch(async () => jsonResponse(503, { code: "INFRASTRUCTURE_FAILURE" }));
    const user = userEvent.setup();
    render(<NewGameSetupForm />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "确认开局资料" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("本地存档数据库暂时不可用")
    );
  });

  it("网络异常：fetch 抛错时给出稳定提示且不吞掉表单", async () => {
    stubFetch(async () => {
      throw new TypeError("failed to fetch");
    });
    const user = userEvent.setup();
    render(<NewGameSetupForm />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "确认开局资料" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("网络异常"));
    expect(screen.getByRole("button", { name: "确认开局资料" })).toBeEnabled();
  });
});
