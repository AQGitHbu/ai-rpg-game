// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createServerGameEntryPoints, type ServerGameEntryPoints } from "./compositionRoot";
import type { AiTextAuditPayload, AiTextAuditRecorder } from "./ai/textAuditTypes";

function fakeRecorder(): AiTextAuditRecorder & { records: AiTextAuditPayload[] } {
  const records: AiTextAuditPayload[] = [];
  return {
    enabled: true,
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
      // No AI config so deterministic sources are used
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
