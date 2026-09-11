import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewGameSetupForm } from "./NewGameSetupForm";

const INITIALIZATION_MARKER_KEY = "ai-rpg-game:initialization";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function isInitializationUrl(url: string): boolean {
  return url.startsWith("/api/game/initialization");
}

/** 只取创建开局的 POST 调用，避免把挂载时的初始化查询算进来。 */
function createCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => String(url) === "/api/game");
}

function mockCreateSuccess() {
  const fetchMock = vi.fn(async (url: string) => {
    if (isInitializationUrl(String(url))) return json({ ok: true, status: "none" });
    return json({ ok: true, requestId: "req-created", status: "published", revision: 0 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("NewGameSetupForm canonical contract", () => {
  it("忽略没有本次请求标记的历史已发布开局", async () => {
    const onCreated = vi.fn();
    const fetchMock = vi.fn(async () => json({ ok: true, requestId: "historical", status: "published", revision: 0 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<NewGameSetupForm onCreated={onCreated} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("textbox", { name: "角色名字" })).toBeEnabled());
    expect(onCreated).not.toHaveBeenCalled();
  });
  it("keeps player-edited fields when switching the genre preset", async () => {
    mockCreateSuccess();
    render(<NewGameSetupForm onCreated={vi.fn()} />);
    const premise = screen.getByRole("textbox", { name: "世界观背景" });
    await userEvent.clear(premise);
    await userEvent.type(premise, "这是玩家亲自写下、切换题材后也必须保留的世界。" );

    await userEvent.click(screen.getByRole("radio", { name: /奇幻/ }));

    expect(premise).toHaveValue("这是玩家亲自写下、切换题材后也必须保留的世界。");
    expect(screen.getByRole("textbox", { name: "角色名字" })).toHaveValue("凯尔");
  });

  it("posts to the fixed game endpoint and invokes the one completion callback", async () => {
    const onCreated = vi.fn();
    const fetchMock = mockCreateSuccess();
    render(<NewGameSetupForm onCreated={onCreated} />);

    await userEvent.click(screen.getByRole("button", { name: "踏上旅程" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/game", expect.objectContaining({ method: "POST" }));
    expect(createCalls(fetchMock)).toHaveLength(1);
  });

  it("includes the opaque ended-session identity and revision when creating a replacement game", async () => {
    const fetchMock = mockCreateSuccess();
    render(<NewGameSetupForm onCreated={vi.fn()} restart={{ identity: "opaque-ended-session", expectedRevision: 9 }} />);

    await userEvent.click(screen.getByRole("button", { name: "踏上旅程" }));
    await waitFor(() => expect(createCalls(fetchMock)).toHaveLength(1));
    const init = createCalls(fetchMock)[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      gameType: "wuxia",
      gameLength: "short",
      characterName: expect.any(String),
      characterIdentity: expect.any(String),
      characterProfile: expect.any(String),
      worldPremise: expect.any(String),
      storyOpening: expect.any(String),
      narrativeStyle: "novel",
      contentIntensity: "normal",
      restart: { identity: "opaque-ended-session", expectedRevision: 9 },
    });
  });
  it("uses the original seven cover URLs and survives an image load failure", async () => {
    mockCreateSuccess();
    const { container } = render(<NewGameSetupForm onCreated={vi.fn()} />);
    const cards = [...container.querySelectorAll(".game-type-card")];
    expect(cards).toHaveLength(7);
    for (const card of cards) {
      const input = card.querySelector("input")!;
      const image = card.querySelector("img")!;
      const src = new URL(image.getAttribute("src")!, "http://localhost");
      expect(src.searchParams.get("url") ?? src.pathname).toBe(`/assets/genres/${input.value}.jpg`);
    }
    const first = cards[0]!;
    fireEvent.error(first.querySelector("img")!);
    expect(first.querySelector("img")).toBeNull();
    expect(first.querySelector(".game-type-card--visual")).toBeInTheDocument();
    await userEvent.click(first.querySelector("input")!);
    expect(first.querySelector("input")).toBeChecked();
    expect(screen.getByRole("button", { name: "踏上旅程" })).toBeEnabled();
  });
});

describe("NewGameSetupForm personality and intensity preferences", () => {
  it("exposes six controlled personality tags and two content-intensity choices", () => {
    mockCreateSuccess();
    render(<NewGameSetupForm onCreated={vi.fn()} />);
    for (const tag of ["冷静", "冲动", "善良", "多疑", "幽默", "寡言"]) {
      expect(screen.getByRole("checkbox", { name: new RegExp(tag) })).toBeInTheDocument();
    }
    expect(screen.getByRole("radio", { name: /普通/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /黑暗/ })).toBeInTheDocument();
  });

  it("selected personality tags and dark intensity reach POST /api/game exactly", async () => {
    const fetchMock = mockCreateSuccess();
    render(<NewGameSetupForm onCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /冷静/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /多疑/ }));
    await userEvent.click(screen.getByRole("radio", { name: /黑暗/ }));
    await userEvent.click(screen.getByRole("button", { name: "踏上旅程" }));
    await waitFor(() => expect(createCalls(fetchMock)).toHaveLength(1));
    const init = createCalls(fetchMock)[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      personalityTags: ["冷静", "多疑"],
      contentIntensity: "dark",
    });
  });

  it("caps personality tags at three: selecting a fourth is ignored", async () => {
    const fetchMock = mockCreateSuccess();
    render(<NewGameSetupForm onCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /冷静/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /冲动/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /善良/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /多疑/ }));
    await userEvent.click(screen.getByRole("button", { name: "踏上旅程" }));
    await waitFor(() => expect(createCalls(fetchMock)).toHaveLength(1));
    const init = createCalls(fetchMock)[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      personalityTags: ["冷静", "冲动", "善良"],
    });
  });
});

// ---------------------------------------------------------------------------
// Task 11：开局分阶段生成期间，客户端只显示笼统进度与显式重试，
// 且整个恢复链必须绑定同一个 requestId —— 重复创建会产生第二个任务并重复计费。
// ---------------------------------------------------------------------------

describe("NewGameSetupForm initialization recovery", () => {
  it("202 后显示笼统生成进度，失败用同一 requestId 重试，published 才回调 onCreated", async () => {
    const onCreated = vi.fn();
    let status: "pending" | "failed" | "published" = "pending";
    let createdRequestId = "";
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/game") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        createdRequestId = String(body.requestId);
        return json({ ok: true, requestId: createdRequestId, status: "pending" }, 202);
      }
      if (target.startsWith("/api/game/initialization")) {
        if (init?.method === "POST") {
          requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          status = "pending";
          return json({ ok: true, requestId: createdRequestId, status });
        }
        // 无 query 的挂载查询看服务器当前槽；有 query 才读指定任务。
        if (!target.includes("requestId=")) return json({ ok: true, status: "none" });
        return json({ ok: true, requestId: createdRequestId, status });
      }
      return json({ ok: false, code: "UNEXPECTED" }, 500);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<NewGameSetupForm onCreated={onCreated} />);
    await userEvent.click(await screen.findByRole("button", { name: "踏上旅程" }));

    // 202：进入生成中；不能回调 onCreated，也不能冒出第二个创建请求。
    expect(await screen.findByRole("dialog", { name: /正在生成世界/ })).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    await waitFor(() => expect(createCalls(fetchMock)).toHaveLength(1));
    const createBody = JSON.parse(String((createCalls(fetchMock)[0]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(typeof createBody.requestId).toBe("string");
    expect(String(createBody.requestId).length).toBeGreaterThan(0);

    // 失败：同一 requestId 只做控制操作，不新建任务。
    status = "failed";
    await waitFor(() => expect(screen.getByRole("button", { name: "重试生成" })).toBeInTheDocument(), { timeout: 3000 });
    await userEvent.click(screen.getByRole("button", { name: "重试生成" }));
    await waitFor(() => expect(requestBodies).toHaveLength(1));
    expect(requestBodies[0]).toEqual({ requestId: createBody.requestId, operation: "retry" });
    expect(createCalls(fetchMock)).toHaveLength(1);

    // published：只在这时进入正式游戏。
    status = "published";
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce(), { timeout: 3000 });
    expect(createCalls(fetchMock)).toHaveLength(1);
  });

  it("sessionStorage 只保存 requestId 标记，不保存表单输入或任务产物", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (!isInitializationUrl(String(url))) {
        return json({ ok: true, requestId: "req-marker", status: "pending" }, 202);
      }
      return String(url).includes("requestId=")
        ? json({ ok: true, requestId: "req-marker", status: "pending" })
        : json({ ok: true, status: "none" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<NewGameSetupForm onCreated={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "踏上旅程" }));
    await waitFor(() => expect(createCalls(fetchMock)).toHaveLength(1));

    const stored = window.sessionStorage.getItem(INITIALIZATION_MARKER_KEY);
    expect(stored).not.toBeNull();
    expect(stored).toBe("req-marker");
    // 玩家输入与任务产物绝不进 sessionStorage。
    expect(stored).not.toContain("sk-");
    expect(stored).not.toContain("世界");
  });

  it("刷新时按服务器初始化槽恢复进度，服务器没有任务才回到表单", async () => {
    window.sessionStorage.setItem(INITIALIZATION_MARKER_KEY, "req-resume");
    const fetchMock = vi.fn(async (url: string) => {
      if (isInitializationUrl(String(url))) {
        return json({ ok: true, requestId: "req-resume", status: "pending" });
      }
      return json({ ok: true, status: "none" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<NewGameSetupForm onCreated={vi.fn()} />);

    expect(await screen.findByRole("dialog", { name: /正在生成世界/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "踏上旅程" })).toBeNull();
  });

  it("storage 不可用时仍按服务器初始化槽恢复", async () => {
    const getItem = vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (isInitializationUrl(String(url))) {
        return json({ ok: true, requestId: "req-server", status: "pending" });
      }
      return json({ ok: true, status: "none" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<NewGameSetupForm onCreated={vi.fn()} />);

    expect(await screen.findByRole("dialog", { name: /正在生成世界/ })).toBeInTheDocument();
    getItem.mockRestore();
  });

  it("取消后清除标记并允许用新 requestId 重新提交", async () => {
    let status: "pending" | "failed" | "published" | "cancelled" = "pending";
    const createdRequestIds: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/game") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        createdRequestIds.push(String(body.requestId));
        return json({ ok: true, requestId: String(body.requestId), status: "pending" }, 202);
      }
      if (isInitializationUrl(target)) {
        if (init?.method === "POST") {
          status = "cancelled";
          return json({ ok: true, requestId: "req-abc", status });
        }
        if (!target.includes("requestId=")) return json({ ok: true, status: "none" });
        return json({ ok: true, requestId: "req-abc", status });
      }
      return json({ ok: false, code: "UNEXPECTED" }, 500);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<NewGameSetupForm onCreated={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "踏上旅程" }));
    await waitFor(() => expect(createCalls(fetchMock)).toHaveLength(1));

    status = "failed";
    await waitFor(() => expect(screen.getByRole("button", { name: "放弃本次生成" })).toBeInTheDocument(), { timeout: 3000 });
    await userEvent.click(screen.getByRole("button", { name: "放弃本次生成" }));

    expect(await screen.findByRole("button", { name: "踏上旅程" })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(INITIALIZATION_MARKER_KEY)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "踏上旅程" }));
    await waitFor(() => expect(createCalls(fetchMock)).toHaveLength(2));
    expect(createdRequestIds[0]).not.toBe(createdRequestIds[1]);
  });
});
