import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGame: vi.fn(),
  executeHttpRequest: vi.fn(async (_method: string, _route: string, handler: () => Promise<Response>) => handler()),
}));

vi.mock("@/game/application/server/compositionRoot", () => ({
  getServerGameEntryPoints: () => mocks,
}));

import { POST } from "./route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/game", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createGame.mockResolvedValue({
    ok: true,
    httpStatus: 202,
    view: { requestId: "req-1", status: "pending" },
  });
});

describe("POST /api/game", () => {
  it("forwards an opaque ending identity and revision through the canonical restart contract", async () => {
    const response = await POST(request({
      gameType: "science_fiction",
      gameLength: "medium",
      requestId: "req-1",
      restart: { identity: "opaque-ended-session", expectedRevision: 12 },
    }));

    expect(response.status).toBe(202);
    expect(mocks.createGame).toHaveBeenCalledWith({
      requestId: "req-1",
      gameType: "science_fiction",
      gameLength: "medium",
      restart: { identity: "opaque-ended-session", expectedRevision: 12 },
    });
    expect(await response.json()).toEqual({
      ok: true,
      requestId: "req-1",
      status: "pending",
    });
  });

  it("returns 200 when the initialization job is already published", async () => {
    mocks.createGame.mockResolvedValue({
      ok: true,
      httpStatus: 200,
      view: { requestId: "req-1", status: "published" },
    });
    const response = await POST(request({
      gameType: "wuxia",
      gameLength: "short",
      requestId: "req-1",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, requestId: "req-1", status: "published" });
  });

  it.each([
    { gameType: "unknown", gameLength: "short", requestId: "req-1" },
    { gameType: "wuxia", gameLength: "long", requestId: "req-1" },
    // requestId 缺失 / 空 / 非字符串一律 400（它承载幂等键语义）。
    { gameType: "wuxia", gameLength: "short" },
    { gameType: "wuxia", gameLength: "short", requestId: "" },
    { gameType: "wuxia", gameLength: "short", requestId: 7 },
    { gameType: "wuxia", gameLength: "short", requestId: "  padded  " },
    { gameType: "wuxia", gameLength: "short", requestId: "req-1", restart: {} },
    { gameType: "wuxia", gameLength: "short", requestId: "req-1", restart: { expectedRevision: 1 } },
    { gameType: "wuxia", gameLength: "short", requestId: "req-1", restart: { identity: "", expectedRevision: 1 } },
    { gameType: "wuxia", gameLength: "short", requestId: "req-1", restart: { expectedRevision: -1 } },
    { gameType: "wuxia", gameLength: "short", requestId: "req-1", restart: { expectedRevision: 1, extra: true } },
    { gameType: "wuxia", gameLength: "short", requestId: "req-1", extra: true },
  ])("rejects invalid create/restart input %#", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(mocks.createGame).not.toHaveBeenCalled();
  });

  it("maps stale restart to conflict without hiding the failure", async () => {
    mocks.createGame.mockResolvedValue({ ok: false, code: "STALE_GAME_REVISION" });
    const response = await POST(request({
      gameType: "wuxia",
      gameLength: "short",
      requestId: "req-1",
      restart: { identity: "stale-ended-session", expectedRevision: 3 },
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, code: "STALE_GAME_REVISION" });
  });
});
