import { describe, it, expect, afterEach } from "vitest";
import {
  getActionIdGenerator, setActionIdGenerator, postAction, ensureNarrative, retryNarrative,
  fetchInitialization, retryInitialization, cancelInitialization, type ActionPayload,
} from "./gameActionRequest";

// ---------------------------------------------------------------------------
// Task 10：客户端 actionId 改用 UUID，提供测试环境可注入 fallback；
// 禁止用 Date.now() 作为唯一 actionId。
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_GENERATOR = getActionIdGenerator();

afterEach(() => {
  // 还原默认生成器，避免测试间串扰。
  setActionIdGenerator(DEFAULT_GENERATOR);
});

describe("actionId 生成器", () => {
  it("默认生成器产生非空、非纯时间戳 actionId，且两次调用不同", () => {
    const gen = getActionIdGenerator();
    const a = gen();
    const b = gen();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
    // 不可能是裸 Date.now() 数字串
    expect(a).not.toMatch(/^\d+$/);
  });

  it("crypto.randomUUID 可用时产生 UUID 格式", () => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      const gen = getActionIdGenerator();
      expect(gen()).toMatch(UUID_RE);
    }
  });

  it("测试环境可注入确定性生成器", () => {
    setActionIdGenerator(() => "fixed-action-id");
    expect(getActionIdGenerator()()).toBe("fixed-action-id");
  });
});

describe("narrative 轮询与手动重试的请求体分流", () => {
  it("ensureNarrative() 只发送空对象 {}，不携带 retry", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(
        JSON.stringify({ ok: true, result: "not_pending" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const outcome = await ensureNarrative();
    expect(outcome).toEqual({ ok: true, result: "not_pending" });
    expect(bodies).toEqual(["{}"]);
  });

  it("retryNarrative() 发送 { retry: true }，不发送普通空对象", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(
        JSON.stringify({ ok: true, result: "queued" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const outcome = await retryNarrative();
    expect(outcome).toEqual({ ok: true, result: "queued" });
    expect(bodies).toEqual(['{"retry":true}']);
  });

  it("普通轮询与手动重试都打到同一 ensure 端点，但请求体语义不同", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: String(init?.body) });
      return new Response(
        JSON.stringify({ ok: true, result: "not_pending" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await ensureNarrative();
    await retryNarrative();
    await ensureNarrative();

    expect(seen).toEqual([
      { url: "/api/game/narrative/ensure", body: "{}" },
      { url: "/api/game/narrative/ensure", body: '{"retry":true}' },
      { url: "/api/game/narrative/ensure", body: "{}" },
    ]);
  });
});

describe("postAction 使用注入的 actionId", () => {
  it("请求体 actionId 来自注入生成器，而非 Date.now()", async () => {
    const captured: string[] = [];
    setActionIdGenerator(() => "injected-uuid-1");
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body));
      captured.push(parsed.actionId);
      return new Response(
        JSON.stringify({ ok: false, code: "NO_ACTIVE_GAME" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const payload: ActionPayload = {
      interaction: { kind: "fixed_choice", choiceToken: "tok_1" },
      revision: 0,
    };
    await postAction(payload);
    expect(captured).toEqual(["injected-uuid-1"]);
  });

  it("NO_ACTIVE_GAME 映射为 rejected 且不是 stale", async () => {
    setActionIdGenerator(() => "uuid-2");
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ ok: false, code: "NO_ACTIVE_GAME" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await postAction({
      interaction: { kind: "fixed_choice", choiceToken: "tok_1" },
      revision: 0,
    });
    expect(result.kind).toBe("rejected");
  });

  it("STALE_GAME_REVISION 映射为 stale", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ ok: false, code: "STALE_GAME_REVISION" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await postAction({
      interaction: { kind: "free_text", text: "我相信你", targetNpcId: "npc_1" },
      revision: 0,
    });
    expect(result.kind).toBe("stale");
  });

  it("同一 NPC 的两次自定义输入都向 actions endpoint 发送不同 actionId", async () => {
    const requests: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];
    const ids = ["uuid-1", "uuid-2"];
    setActionIdGenerator(() => ids.shift() ?? "unexpected-id");
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(
        JSON.stringify({ ok: false, code: "NO_ACTIVE_GAME" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await postAction({
      interaction: { kind: "free_text", text: "我相信你", targetNpcId: "npc_1" },
      revision: 4,
    });
    await postAction({
      interaction: { kind: "free_text", text: "你在撒谎", targetNpcId: "npc_1" },
      revision: 6,
    });

    expect(requests.map((request) => request.url)).toEqual([
      "/api/game/actions",
      "/api/game/actions",
    ]);
    expect(requests.map((request) => request.body.actionId)).toEqual(["uuid-1", "uuid-2"]);
    expect(requests.map((request) => request.body.interaction)).toEqual([
      { kind: "free_text", text: "我相信你", targetNpcId: "npc_1" },
      { kind: "free_text", text: "你在撒谎", targetNpcId: "npc_1" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Task 11：初始化任务恢复。服务器 slot 是权威，客户端只做安全状态读取与控制；
// 网络失败必须与「服务器没有任务」区分，否则 UI 会把无法恢复误报成可重新开局。
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("初始化任务恢复请求", () => {
  it("fetchInitialization() 读取当前初始化槽，不携带 requestId query", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return json({ ok: true, requestId: "req_current", status: "pending" });
    }) as unknown as typeof fetch;

    const outcome = await fetchInitialization();
    expect(seen).toEqual(["/api/game/initialization"]);
    expect(outcome).toEqual({ ok: true, view: { requestId: "req_current", status: "pending" } });
  });

  it("fetchInitialization(requestId) 只读指定任务并做 URL 编码", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return json({ ok: true, status: "none" });
    }) as unknown as typeof fetch;

    const outcome = await fetchInitialization("req with space");
    expect(seen).toEqual(["/api/game/initialization?requestId=req%20with%20space"]);
    expect(outcome).toEqual({ ok: true, view: { status: "none" } });
  });

  it("网络失败不当作 none，而是可展示的错误", async () => {
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

    const outcome = await fetchInitialization();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("本地服务");
  });

  it("retry/cancel 只发送 requestId 与 operation 两个字段", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return json({ ok: true, requestId: "req-1", status: "pending" });
    }) as unknown as typeof fetch;

    await retryInitialization("req-1");
    await cancelInitialization("req-1");

    expect(bodies).toEqual([
      '{"requestId":"req-1","operation":"retry"}',
      '{"requestId":"req-1","operation":"cancel"}',
    ]);
  });

  it("retry 的服务端失败码转成可展示文案，不伪装成已恢复", async () => {
    globalThis.fetch = (async () => json({ ok: false, code: "JOB_CONFLICT" }, 409)) as unknown as typeof fetch;

    const outcome = await retryInitialization("req-1");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("状态已变化");
  });
});
