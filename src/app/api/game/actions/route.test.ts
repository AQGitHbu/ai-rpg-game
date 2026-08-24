import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  performTurn: vi.fn(),
  executeHttpRequest: vi.fn(async (_method: string, _route: string, handler: (context: unknown) => Promise<Response>) => handler({})),
}));

vi.mock("@/game/application/server/compositionRoot", () => ({
  getServerGameEntryPoints: () => mocks,
}));

import { POST } from "./route";

const ACTION_ID = "11111111-1111-4111-8111-111111111111";

function request(body: unknown): Request {
  return new Request("http://localhost/api/game/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.performTurn.mockResolvedValue({ ok: true, revision: 8, feedback: "Action performed", view: { revision: 8 } });
});

describe("POST /api/game/actions", () => {
  it("fixed_choice 也进入同一个 performTurn 入口", async () => {
    const response = await POST(request({
      actionId: ACTION_ID,
      interaction: { kind: "fixed_choice", choiceToken: "opaque-token" },
      expectedRevision: 7,
    }));

    expect(response.status).toBe(200);
    expect(mocks.performTurn).toHaveBeenCalledWith({
      actionId: ACTION_ID,
      interaction: { kind: "fixed_choice", choiceToken: "opaque-token" },
      expectedRevision: 7,
    });
  });

  it("free_text 直接进入 composition root 的 performTurn 并返回统一 view", async () => {
    const response = await POST(request({
      actionId: ACTION_ID,
      interaction: { kind: "free_text", text: "我相信你", targetNpcId: "npc_1" },
      expectedRevision: 7,
    }));

    expect(response.status).toBe(200);
    expect(mocks.performTurn).toHaveBeenCalledWith({
      actionId: ACTION_ID,
      interaction: { kind: "free_text", text: "我相信你", targetNpcId: "npc_1" },
      expectedRevision: 7,
    });
    expect(await response.json()).toMatchObject({ ok: true, revision: 8, view: { revision: 8 } });
  });

  it.each([
    { code: "NARRATIVE_CONTINUATION_MISSING", status: 409 },
    { code: "NARRATIVE_CONTINUATION_INVALID", status: 500 },
  ])("maps $code to its stable HTTP status", async ({ code, status }) => {
    mocks.performTurn.mockResolvedValue({ ok: false, code, feedback: "stable failure" });

    const response = await POST(request({
      actionId: ACTION_ID,
      interaction: { kind: "fixed_choice", choiceToken: "opaque-token" },
      expectedRevision: 7,
    }));

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, code });
  });

  it.each([
    { actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "unknown" } },
    { actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "free_text", text: "你好" } },
    { actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "free_text", text: "", targetNpcId: "npc_1" } },
    { actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "free_text", text: "你好", targetNpcId: "npc_1", extra: true } },
    { actionId: ACTION_ID, expectedRevision: -1, interaction: { kind: "fixed_choice", choiceToken: "tok" } },
    { actionId: ACTION_ID, expectedRevision: 1.5, interaction: { kind: "fixed_choice", choiceToken: "tok" } },
    { actionId: ACTION_ID, expectedRevision: 0, interaction: { kind: "fixed_choice", choiceToken: "tok" }, extra: true },
    { actionId: "not-a-uuid", expectedRevision: 0, interaction: { kind: "fixed_choice", choiceToken: "tok" } },
  ])("拒绝非法或含未知字段的请求 %#", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(mocks.performTurn).not.toHaveBeenCalled();
  });
});
