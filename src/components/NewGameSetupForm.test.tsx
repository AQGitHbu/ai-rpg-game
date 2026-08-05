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
  // 选择类型会整体预填示例内容，此处先清空再输入，模拟玩家按自己意图编辑。
  await user.clear(screen.getByLabelText("角色名字"));
  await user.type(screen.getByLabelText("角色名字"), "林渡");
  await user.clear(screen.getByLabelText("身份 / 职业"));
  await user.type(screen.getByLabelText("身份 / 职业"), "失踪航站的维修员");
  await user.clear(screen.getByLabelText("世界观背景"));
  await user.type(screen.getByLabelText("世界观背景"), "人类城市依靠一座不断删除居民记忆的轨道电梯维持能源。");
  await user.clear(screen.getByLabelText("故事开端"));
  await user.type(screen.getByLabelText("故事开端"), "我在停运十年的站台收到了一张写着自己名字的返程票。");
}

describe("NewGameSetupForm", () => {
  it("offers all configured MVP game types", () => {
    stubFetch(async () => jsonResponse(200, {}));
    render(<NewGameSetupForm />);
    for (const label of ["武侠", "仙侠", "奇幻", "科幻", "都市", "历史架空", "末日"]) {
      expect(screen.getByRole("radio", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
  });

  it("初始默认预填武侠示例，叙事风格为小说化、游戏时长为短篇", () => {
    stubFetch(async () => jsonResponse(200, {}));
    render(<NewGameSetupForm />);

    expect(screen.getByRole("radio", { name: /^武侠/ })).toBeChecked();
    expect(screen.getByLabelText("角色名字")).toHaveValue("沈青崖");
    expect(screen.getByLabelText("身份 / 职业")).toHaveValue("落魄镖师");
    expect(screen.getByLabelText("角色基础信息")).toHaveValue(
      "青崖镖局独子，镖局一夜覆灭后流落江湖，靠押送散货为生。"
    );
    expect(screen.getByLabelText("世界观背景")).toHaveValue(
      "镖局一夜覆灭，江湖各派暗流涌动，真凶身份成谜，官府与门派各怀心思。"
    );
    expect(screen.getByLabelText("故事开端")).toHaveValue(
      "暮色四合，主角背着旧刀走进青石镇，镇口贴着一张字迹潦草的缉凶告示。"
    );
    expect(screen.getByRole("radio", { name: /小说化/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /短篇/ })).toBeChecked();
  });

  it("切换叙事风格与游戏时长分段选项后选中态更新，且提交携带所选值", async () => {
    const view = buildSessionViewFixture();
    const pending = deferred<FakeResponse>();
    const fetchMock = stubFetch(() => pending.promise);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewGameSetupForm onCreated={onCreated} />);

    expect(screen.getByRole("radio", { name: /小说化/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /电影化/ }));
    expect(screen.getByRole("radio", { name: /电影化/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /小说化/ })).not.toBeChecked();

    await user.click(screen.getByRole("radio", { name: /长篇/ }));
    expect(screen.getByRole("radio", { name: /长篇/ })).toBeChecked();

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "踏上旅程" }));

    pending.resolve(jsonResponse(201, { view, generationSource: "generated" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(view, "generated"));
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(payload.narrativeStyle).toBe("cinematic");
    expect(payload.gameLength).toBe("long");
  });

  it("所选游戏类型向表单注入对应题材的主题色 CSS 变量", async () => {
    stubFetch(async () => jsonResponse(200, {}));
    const user = userEvent.setup();
    const { container } = render(<NewGameSetupForm />);

    const form = container.querySelector("form.new-game-form") as HTMLFormElement;
    // 默认武侠主题：#c4675f。
    expect(form.style.getPropertyValue("--stage-accent")).toBe("#c4675f");

    await user.click(screen.getByRole("radio", { name: /科幻/ }));
    expect(form.style.getPropertyValue("--stage-accent")).toBe("#ff8a5c");
  });

  it("切换游戏类型后，主角与世界开端字段整体替换为对应示例", async () => {
    stubFetch(async () => jsonResponse(200, {}));
    const user = userEvent.setup();
    render(<NewGameSetupForm />);

    await user.click(screen.getByRole("radio", { name: /科幻/ }));

    expect(screen.getByRole("radio", { name: /科幻/ })).toBeChecked();
    expect(screen.getByLabelText("角色名字")).toHaveValue("林渡");
    expect(screen.getByLabelText("身份 / 职业")).toHaveValue("失踪航站的维修员");
    expect(screen.getByLabelText("角色基础信息")).toHaveValue(
      "曾是环带航站的高级维修员，事故后身份记录被清除，熟悉每一段走私航道的暗门。"
    );
    expect(screen.getByLabelText("世界观背景")).toHaveValue(
      "人类城市依靠一座不断删除居民记忆的轨道电梯维持能源。"
    );
    expect(screen.getByLabelText("故事开端")).toHaveValue(
      "我在停运十年的站台收到了一张写着自己名字的返程票。"
    );
  });

  it("切换游戏类型会覆盖玩家已手动编辑的字段", async () => {
    stubFetch(async () => jsonResponse(200, {}));
    const user = userEvent.setup();
    render(<NewGameSetupForm />);

    await user.clear(screen.getByLabelText("角色名字"));
    await user.type(screen.getByLabelText("角色名字"), "自改名字");
    await user.clear(screen.getByLabelText("世界观背景"));
    await user.type(screen.getByLabelText("世界观背景"), "玩家自编的世界观背景示例内容。");
    await user.click(screen.getByRole("radio", { name: /末日/ }));

    expect(screen.getByLabelText("角色名字")).toHaveValue("周临");
    expect(screen.getByLabelText("身份 / 职业")).toHaveValue("废土补给车队司机");
    expect(screen.getByLabelText("世界观背景")).toHaveValue(
      "大灾变后地表被灰烬与辐射覆盖，幸存者聚居于破败城邦，净水与燃料成为硬通货。"
    );
    expect(screen.getByLabelText("故事开端")).toHaveValue(
      "主角开车驶入空荡的旧城寻找燃料，电台里突然传来一段重复了三十年的求救信号。"
    );
  });

  it("渲染本身不发起任何网络请求", () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, {}));
    render(<NewGameSetupForm />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("开发环境可使用已有离线旅程数据开始，且请求不含玩家输入", async () => {
    const view = buildSessionViewFixture();
    const fetchMock = stubFetch(async () => jsonResponse(201, { view, generationSource: "fallback" }));
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewGameSetupForm developmentTools onCreated={onCreated} />);

    await user.click(screen.getByRole("button", { name: "使用已有数据开始" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(view, "fallback"));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      developmentPreset: "phase10-journey-v1",
      caseId: "wuxia-a",
    });
  });

  it("开发环境渲染 7 题材下拉，默认武侠；选择后提交携带所选 caseId", async () => {
    const view = buildSessionViewFixture();
    const fetchMock = stubFetch(async () => jsonResponse(201, { view, generationSource: "fallback" }));
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewGameSetupForm developmentTools onCreated={onCreated} />);

    const select = screen.getByLabelText("离线题材");
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue("wuxia-a");
    for (const label of ["武侠", "仙侠", "奇幻", "科幻", "都市", "架空历史", "末日"]) {
      expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
    }

    await user.selectOptions(select, "post-apocalypse-a");
    await user.click(screen.getByRole("button", { name: "使用已有数据开始" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(view, "fallback"));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      developmentPreset: "phase10-journey-v1",
      caseId: "post-apocalypse-a",
    });
  });

  it("非开发环境不显示已有数据开局入口", () => {
    stubFetch(async () => jsonResponse(200, {}));
    render(<NewGameSetupForm />);
    expect(screen.queryByRole("button", { name: "使用已有数据开始" })).toBeNull();
  });

  it("有效表单 → loading → 只向 /api/game 提交允许字段 → onCreated 收到 view 与安全来源", async () => {
    const view = buildSessionViewFixture();
    const pending = deferred<FakeResponse>();
    const fetchMock = stubFetch(() => pending.promise);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewGameSetupForm onCreated={onCreated} />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "踏上旅程" }));

    // loading：aria-live 等待态 + 提交按钮与类型 fieldset 禁用。
    expect(screen.getByRole("status")).toHaveTextContent("正在生成世界，请稍候……");
    expect(screen.getByRole("button", { name: "踏上旅程" })).toBeDisabled();
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
      "gameLength",
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
    const submit = screen.getByRole("button", { name: "踏上旅程" });
    await user.click(submit);
    await user.click(submit);
    await user.click(submit);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    pending.resolve(jsonResponse(201, { view: buildSessionViewFixture(), generationSource: "generated" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "踏上旅程" })).toBeEnabled()
    );
  });

  it("fallback 来源：onCreated 收到 (view, 'fallback')", async () => {
    const view = buildSessionViewFixture();
    stubFetch(async () => jsonResponse(201, { view, generationSource: "fallback" }));
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewGameSetupForm onCreated={onCreated} />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "踏上旅程" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(view, "fallback"));
  });

  it("201 但缺失 generationSource：视为失败，不调用 onCreated", async () => {
    stubFetch(async () => jsonResponse(201, { view: buildSessionViewFixture() }));
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewGameSetupForm onCreated={onCreated} />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "踏上旅程" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("创建开局失败")
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "踏上旅程" })).toBeEnabled();
  });

  it("201 但 generationSource 未知：同样失败，绝不默认按 generated 处理", async () => {
    stubFetch(async () =>
      jsonResponse(201, { view: buildSessionViewFixture(), generationSource: "ai_live" })
    );
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewGameSetupForm onCreated={onCreated} />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "踏上旅程" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("创建开局失败")
    );
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("客户端校验失败：不发请求，逐字段提示并标记 aria-invalid", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, {}));
    const user = userEvent.setup();
    render(<NewGameSetupForm />);

    // 默认示例已填好其余字段，清空角色名字以触发必填错误。
    await user.clear(screen.getByLabelText("角色名字"));
    await user.click(screen.getByRole("button", { name: "踏上旅程" }));

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
    await user.click(screen.getByRole("button", { name: "踏上旅程" }));

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
    await user.click(screen.getByRole("button", { name: "踏上旅程" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("已存在进行中的存档")
    );
    // 失败后允许再次提交。
    expect(screen.getByRole("button", { name: "踏上旅程" })).toBeEnabled();
  });

  it("INFRASTRUCTURE_FAILURE：提示数据库暂不可用", async () => {
    stubFetch(async () => jsonResponse(503, { code: "INFRASTRUCTURE_FAILURE" }));
    const user = userEvent.setup();
    render(<NewGameSetupForm />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "踏上旅程" }));

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
    await user.click(screen.getByRole("button", { name: "踏上旅程" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("网络异常"));
    expect(screen.getByRole("button", { name: "踏上旅程" })).toBeEnabled();
  });
});
