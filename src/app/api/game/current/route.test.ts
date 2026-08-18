import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentGame: vi.fn(),
  executeHttpRequest: vi.fn(async (_method: string, _route: string, handler: () => Promise<Response>) => handler()),
}));

vi.mock("@/game/application/server/compositionRoot", () => ({
  getServerGameEntryPoints: () => mocks,
}));

import { dynamic, GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentGame.mockResolvedValue({ ok: true, status: "active", revision: 7, view: { revision: 7 } });
});

describe("GET /api/game/current", () => {
  it("is always dynamic because the current slot can change after a turn or restart", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("returns the latest current-game view through the canonical entry point", async () => {
    const response = await GET(new Request("http://localhost/api/game/current"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "active", revision: 7, view: { revision: 7 } });
    expect(mocks.getCurrentGame).toHaveBeenCalledOnce();
  });
});
