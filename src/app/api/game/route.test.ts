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
  mocks.createGame.mockResolvedValue({ ok: true, revision: 0 });
});

describe("POST /api/game", () => {
  it("forwards an explicit ending revision through the canonical restart contract", async () => {
    const response = await POST(request({
      gameType: "science_fiction",
      gameLength: "medium",
      restart: { expectedRevision: 12 },
    }));

    expect(response.status).toBe(200);
    expect(mocks.createGame).toHaveBeenCalledWith({
      gameType: "science_fiction",
      gameLength: "medium",
      restart: { expectedRevision: 12 },
    });
  });

  it.each([
    { gameType: "unknown", gameLength: "short" },
    { gameType: "wuxia", gameLength: "long" },
    { gameType: "wuxia", gameLength: "short", restart: {} },
    { gameType: "wuxia", gameLength: "short", restart: { expectedRevision: -1 } },
    { gameType: "wuxia", gameLength: "short", restart: { expectedRevision: 1, extra: true } },
    { gameType: "wuxia", gameLength: "short", extra: true },
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
      restart: { expectedRevision: 3 },
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, code: "STALE_GAME_REVISION" });
  });
});
