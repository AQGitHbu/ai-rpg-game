import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureNarrativeScene: vi.fn(),
  executeHttpRequest: vi.fn(async (_method: string, _route: string, handler: () => Promise<Response>) => handler()),
}));

vi.mock("@/game/application/server/compositionRoot", () => ({
  getServerGameEntryPoints: () => mocks,
}));

import { POST } from "./route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/game/narrative/ensure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureNarrativeScene.mockResolvedValue({ ok: true, result: "queued" });
});

describe("POST /api/game/narrative/ensure", () => {
  it("polls with an explicit empty body and retries only when requested", async () => {
    const normal = await POST(request({}));
    expect(normal.status).toBe(200);
    expect(mocks.ensureNarrativeScene).toHaveBeenLastCalledWith({}, undefined);

    const retry = await POST(request({ retry: true }));
    expect(retry.status).toBe(200);
    expect(mocks.ensureNarrativeScene).toHaveBeenLastCalledWith({ retry: true }, undefined);
  });

  it.each([null, [], { retry: false }, { retry: true, extra: true }, { unknown: true }])(
    "rejects non-canonical body %#",
    async (body) => {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(mocks.ensureNarrativeScene).not.toHaveBeenCalled();
    },
  );

  it("maps failed AI response to 502 without provider details", async () => {
    mocks.ensureNarrativeScene.mockResolvedValue({ ok: false, code: "AI_GENERATION_FAILED", failureKind: "AI_RESPONSE_INVALID" });
    const response = await POST(request({}));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, code: "AI_GENERATION_FAILED", failureKind: "AI_RESPONSE_INVALID" });
  });
});
