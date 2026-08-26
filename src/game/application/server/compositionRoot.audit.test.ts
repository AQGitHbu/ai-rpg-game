// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createServerGameEntryPoints } from "./compositionRoot";
import type { AiTextAuditPayload, AiTextAuditRecorder, GameApiAuditMode } from "./ai/textAuditTypes";

function fakeRecorder(gameApiMode: GameApiAuditMode = "full"): AiTextAuditRecorder & { records: AiTextAuditPayload[] } {
  const records: AiTextAuditPayload[] = [];
  return {
    enabled: true,
    gameApiMode,
    records,
    record: vi.fn(async (payload: AiTextAuditPayload) => { records.push(payload); }),
    close: vi.fn(async () => {}),
  } as unknown as AiTextAuditRecorder & { records: AiTextAuditPayload[] };
}

describe("compositionRoot audit recording", () => {
  it("creates an audit recorder and injects it into the AI client", async () => {
    // We can't directly verify the internal recorder, but we can verify
    // that createServerGameEntryPoints still works with audit env vars
    const env = {
      AI_TEXT_AUDIT: "full",
      AI_TEXT_AUDIT_RUN_ID: "test-run",
      NODE_ENV: "test",
    };
    const entryPoints = createServerGameEntryPoints(env);
    expect(entryPoints).toBeDefined();
    // close should not throw
    await expect(entryPoints.close()).resolves.toBeUndefined();
  });

  it("executeHttpRequest records game_api events for create_game", async () => {
    const audit = fakeRecorder();
    const env = {
      AI_TEXT_AUDIT: "full",
      AI_TEXT_AUDIT_RUN_ID: "test-create",
      NODE_ENV: "test",
      // No AI config: production sources remain unavailable and never become deterministic.
    };
    const entryPoints = createServerGameEntryPoints(env, audit);

    // We can't easily test a full create game without SQLite, but we can
    // verify the executeHttpRequest path records game_api events
    const response = await entryPoints.executeHttpRequest(
      "POST",
      "/api/game",
      async () => new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), { status: 400 }),
      "trace-test",
    );

    expect(response.status).toBe(400);
    // Check that a game_api record was written
    const apiRecords = audit.records.filter((r) => r.kind === "game_api");
    expect(apiRecords.length).toBeGreaterThanOrEqual(1);

    await entryPoints.close();
  });

  it("executeHttpRequest records game_api with request/response bodies", async () => {
    const audit = fakeRecorder();
    const env = {
      AI_TEXT_AUDIT: "full",
      AI_TEXT_AUDIT_RUN_ID: "test-bodies",
      NODE_ENV: "test",
    };
    const entryPoints = createServerGameEntryPoints(env, audit);

    const requestBody = JSON.stringify({ gameType: "wuxia" });
    const responseBody = JSON.stringify({ ok: true });

    // Create a mock Request object
    const request = new Request("http://localhost/api/game", {
      method: "POST",
      body: requestBody,
      headers: { "Content-Type": "application/json" },
    });

    await entryPoints.executeHttpRequest(
      "POST",
      "/api/game",
      async () => new Response(responseBody, { status: 200, headers: { "Content-Type": "application/json" } }),
      "trace-bodies",
      request,
    );

    const apiRecords = audit.records.filter((r) => r.kind === "game_api") as Extract<AiTextAuditPayload, { kind: "game_api" }>[];
    expect(apiRecords.length).toBeGreaterThanOrEqual(1);
    expect(apiRecords[0].route).toBe("/api/game");
    expect(apiRecords[0].method).toBe("POST");
    expect(apiRecords[0].httpStatus).toBe(200);
    expect(apiRecords[0].context.trigger).toBe("create_game");
    expect(apiRecords[0].context.traceId).toBe("trace-bodies");

    await entryPoints.close();
  });

  it("records polling APIs compactly by default while keeping action APIs full", async () => {
    const audit = fakeRecorder("compact");
    const entryPoints = createServerGameEntryPoints({ NODE_ENV: "test" }, audit);

    await entryPoints.executeHttpRequest(
      "GET",
      "/api/game/current",
      async () => new Response(JSON.stringify({ ok: true, story: "poll output" }), { status: 200 }),
      "trace-poll",
    );
    await entryPoints.executeHttpRequest(
      "POST",
      "/api/game/actions",
      async () => new Response(JSON.stringify({ ok: true, story: "action output" }), { status: 200 }),
      "trace-action",
      new Request("http://localhost/api/game/actions", {
        method: "POST",
        body: JSON.stringify({ text: "玩家行动" }),
      }),
    );

    const records = audit.records.filter((entry) => entry.kind === "game_api");
    const poll = records.find((entry) => entry.context.traceId === "trace-poll") as Extract<AiTextAuditPayload, { kind: "game_api"; detail: "compact" }> | undefined;
    const action = records.find((entry) => entry.context.traceId === "trace-action") as Extract<AiTextAuditPayload, { kind: "game_api"; detail: "full" }> | undefined;
    expect(poll).toMatchObject({ detail: "compact", route: "/api/game/current", durationMs: expect.any(Number) });
    expect(poll?.request.hasBody).toBe(false);
    expect(poll?.response.hasBody).toBe(true);
    expect(poll && "rawBody" in poll.request).toBe(false);
    expect(poll && "json" in poll.response).toBe(false);
    expect(action).toMatchObject({ detail: "full", route: "/api/game/actions" });
    expect(action?.request.rawBody).toContain("玩家行动");
    expect(action && "rawBody" in action.request).toBe(true);
    expect(JSON.stringify(action)).toContain("玩家行动");

    await entryPoints.close();
  });

  it("records manual/poll retry origin for the ensure route in compact audit context", async () => {
    const audit = fakeRecorder("compact");
    const entryPoints = createServerGameEntryPoints({ NODE_ENV: "test" }, audit);

    // 普通轮询：不传 retry，context.retry.origin=normal
    await entryPoints.executeHttpRequest(
      "POST",
      "/api/game/narrative/ensure",
      async () => new Response(JSON.stringify({ ok: true, result: "queued" }), { status: 200 }),
      "trace-poll",
      new Request("http://localhost/api/game/narrative/ensure", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    // 手动失败 job 重试：body 携带 { retry: true }
    await entryPoints.executeHttpRequest(
      "POST",
      "/api/game/narrative/ensure",
      async () => new Response(JSON.stringify({ ok: true, result: "queued" }), { status: 200 }),
      "trace-retry",
      new Request("http://localhost/api/game/narrative/ensure", {
        method: "POST",
        body: JSON.stringify({ retry: true }),
      }),
    );

    const records = audit.records.filter((entry) => entry.kind === "game_api");
    const poll = records.find((entry) => entry.context.traceId === "trace-poll") as Extract<AiTextAuditPayload, { kind: "game_api"; detail: "compact" }> | undefined;
    const retry = records.find((entry) => entry.context.traceId === "trace-retry") as Extract<AiTextAuditPayload, { kind: "game_api"; detail: "compact" }> | undefined;

    expect(poll).toBeDefined();
    expect(poll?.detail).toBe("compact");
    expect(poll?.context.retry).toEqual({ origin: "normal", mechanism: "initial", attempt: 0 });
    // compact 模式不保存原始 body
    expect(poll && "rawBody" in poll.request).toBe(false);

    expect(retry).toBeDefined();
    expect(retry?.detail).toBe("compact");
    expect(retry?.context.retry).toEqual({ origin: "manual_failed_job", mechanism: "initial", attempt: 0 });
    expect(retry && "rawBody" in retry.request).toBe(false);

    await entryPoints.close();
  });

  it("records origin=normal for a no-body / request-undefined ensure poll", async () => {
    const audit = fakeRecorder("compact");
    const entryPoints = createServerGameEntryPoints({ NODE_ENV: "test" }, audit);

    // 无 body 的普通 ensure 轮询：request 为 undefined 时也应收敛为 origin=normal。
    await entryPoints.executeHttpRequest(
      "POST",
      "/api/game/narrative/ensure",
      async () => new Response(JSON.stringify({ ok: true, result: "queued" }), { status: 200 }),
      "trace-poll-nobody",
    );

    const records = audit.records.filter((entry) => entry.kind === "game_api");
    const poll = records.find((entry) => entry.context.traceId === "trace-poll-nobody") as Extract<AiTextAuditPayload, { kind: "game_api"; detail: "compact" }> | undefined;
    expect(poll).toBeDefined();
    expect(poll?.context.retry).toEqual({ origin: "normal", mechanism: "initial", attempt: 0 });

    await entryPoints.close();
  });

  it("captures polling bodies in full mode and omits game_api events in off mode", async () => {
    const fullAudit = fakeRecorder("full");
    const fullEntryPoints = createServerGameEntryPoints({ NODE_ENV: "test" }, fullAudit);
    await fullEntryPoints.executeHttpRequest(
      "GET",
      "/api/game/current",
      async () => new Response(JSON.stringify({ story: "full poll output" }), { status: 200 }),
      "trace-full-poll",
    );
    const fullRecord = fullAudit.records.find((entry) => entry.kind === "game_api");
    expect(fullRecord).toMatchObject({ detail: "full", route: "/api/game/current" });
    expect(JSON.stringify(fullRecord)).toContain("full poll output");
    await fullEntryPoints.close();

    const offAudit = fakeRecorder("off");
    const offEntryPoints = createServerGameEntryPoints({ NODE_ENV: "test" }, offAudit);
    await offEntryPoints.executeHttpRequest(
      "GET",
      "/api/game/current",
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      "trace-off",
    );
    expect(offAudit.records.filter((entry) => entry.kind === "game_api")).toHaveLength(0);
    await offEntryPoints.close();
  });

  it("executeHttpRequest records handler exceptions with errorName only", async () => {
    const audit = fakeRecorder();
    const env = {
      AI_TEXT_AUDIT: "full",
      AI_TEXT_AUDIT_RUN_ID: "test-error",
      NODE_ENV: "test",
    };
    const entryPoints = createServerGameEntryPoints(env, audit);

    const error = new TypeError("something went wrong");

    await expect(
      entryPoints.executeHttpRequest(
        "POST",
        "/api/game/actions",
        async () => { throw error; },
        "trace-error",
      ),
    ).rejects.toThrow(TypeError);

    const apiRecords = audit.records.filter((r) => r.kind === "game_api") as Extract<AiTextAuditPayload, { kind: "game_api" }>[];
    expect(apiRecords.length).toBeGreaterThanOrEqual(1);
    expect(apiRecords[0].response.errorName).toBe("TypeError");
    // Must not contain exception message
    const recordJson = JSON.stringify(apiRecords[0]);
    expect(recordJson).not.toContain("something went wrong");

    await entryPoints.close();
  });

  it("redacts sensitive HTTP body fields while preserving game text", async () => {
    const audit = fakeRecorder();
    const entryPoints = createServerGameEntryPoints({ NODE_ENV: "test" }, audit);
    const request = new Request("http://localhost/api/game", {
      method: "POST",
      body: JSON.stringify({
        apiKey: "should-not-log",
        nested: { authorization: "Bearer should-not-log" },
        characterProfile: "保留这段游戏文本",
        callbackUrl: "https://secret.example.test/callback",
      }),
      headers: { "Content-Type": "application/json" },
    });

    await entryPoints.executeHttpRequest(
      "POST",
      "/api/game",
      async () => new Response(JSON.stringify({ ok: true, story: "保留输出文本" }), { status: 200 }),
      "trace-redaction",
      request,
    );

    const record = JSON.stringify(audit.records.find((entry) => entry.kind === "game_api"));
    expect(record).not.toContain("should-not-log");
    expect(record).not.toContain("Bearer");
    expect(record).not.toContain("https://secret.example.test");
    expect(record).toContain("保留这段游戏文本");
    expect(record).toContain("保留输出文本");
    await entryPoints.close();
  });
});
