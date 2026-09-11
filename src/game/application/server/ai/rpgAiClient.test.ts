import { describe, expect, it, vi } from "vitest";
import type { AiCompletionResult, AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import {
  createRpgAiClient,
  createServerRpgAiClient,
  RPG_AI_DEFAULT_POLICIES,
  RPG_AI_ROLES,
  STAGED_NARRATIVE_ROLES,
  resolveRpgAiThinkingRoles,
} from "./rpgAiClient";
import type { AiTextAuditRecorder, AiTextAuditPayload } from "./textAuditTypes";

const config: AiTransportConfig = { baseUrl: "http://provider.test/v1", apiKey: "secret", model: "model" };
const messages = [{ role: "user" as const, content: "返回 JSON" }];

type TestCompletion = (...args: Parameters<AiTransport["complete"]>) => Promise<unknown>;

function transportFor(complete: TestCompletion): AiTransport {
  return {
    complete: async (...args) => (await complete(...args)) as AiCompletionResult,
    stream: async () => ({ ok: false as const, code: "network_error" as const, retryable: true, latencyMs: 1 }),
  };
}

function fakeRecorder(): AiTextAuditRecorder & { records: AiTextAuditPayload[] } {
  const records: AiTextAuditPayload[] = [];
  return {
    enabled: true,
    gameApiMode: "compact",
    records,
    record: vi.fn(async (payload: AiTextAuditPayload) => { records.push(payload); }),
    close: vi.fn(async () => {}),
  } as unknown as AiTextAuditRecorder & { records: AiTextAuditPayload[] };
}

describe("staged narrative roles", () => {
  it("传输重试共用调用截止时间，不重置剩余预算", async () => {
    let time = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
    const timeouts: number[] = [];
    try {
      const client = createRpgAiClient({ config, transport: transportFor(async (_c, _m, opts) => {
        timeouts.push(opts!.timeoutMs!);
        time += 700;
        return { ok: false, code: "network_error", retryable: true, latencyMs: 700 };
      }) });
      await client.complete("choices", messages, undefined, { timeoutMs: 1000 });
      expect(timeouts).toEqual([1000, 300]);
    } finally { clock.mockRestore(); }
  });
  it("defines fixed decision-table budgets for the four staged roles", () => {
    expect(RPG_AI_DEFAULT_POLICIES.planning).toMatchObject({ thinking: "on", timeoutMs: 90_000, maxAttempts: 2 });
    expect(RPG_AI_DEFAULT_POLICIES.planning.maxTokens).toBeUndefined();
    expect(RPG_AI_DEFAULT_POLICIES.narration).toMatchObject({ thinking: "off", timeoutMs: 45_000, maxTokens: 2_000, maxAttempts: 2 });
    expect(RPG_AI_DEFAULT_POLICIES.character).toMatchObject({ thinking: "off", timeoutMs: 45_000, maxTokens: 2_000, maxAttempts: 2 });
    expect(RPG_AI_DEFAULT_POLICIES.choices).toMatchObject({ thinking: "off", timeoutMs: 30_000, maxTokens: 600, maxAttempts: 2 });
    for (const role of STAGED_NARRATIVE_ROLES) {
      expect(RPG_AI_ROLES).toContain(role);
    }
  });

  it("passes the staged AbortSignal and remaining timeoutMs through to the transport", async () => {
    const controller = new AbortController();
    const complete = vi.fn(async (_config: unknown, _messages: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }) => {
      expect(options?.signal).toBe(controller.signal);
      expect(options?.timeoutMs).toBe(1234);
      return { ok: true as const, content: "{}", latencyMs: 1 };
    });
    const client = createRpgAiClient({ transport: transportFor(complete), config });
    const result = await client.complete("choices", messages, undefined, {
      signal: controller.signal,
      timeoutMs: 1234,
    });
    expect(result.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not retry an aborted staged call", async () => {
    const complete = vi.fn(async () => ({
      ok: false as const,
      code: "aborted" as const,
      retryable: false,
      latencyMs: 1,
    }));
    const client = createRpgAiClient({ transport: transportFor(complete), config });
    const controller = new AbortController();
    const result = await client.complete("narration", messages, undefined, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, code: "aborted" });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("createRpgAiClient", () => {
  it.each(RPG_AI_ROLES)("records the previous transport cause for %s without altering messages", async (role) => {
    const audit = fakeRecorder();
    const complete = vi.fn().mockResolvedValueOnce({ ok: false, code: "rate_limited", retryable: true, latencyMs: 1 }).mockResolvedValueOnce({ ok: true, content: "{}", latencyMs: 1 });
    const client = createRpgAiClient({ transport: transportFor(complete), config, auditRecorder: audit });
    await client.complete(role, messages);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]?.[1]).toEqual(messages);
    expect(complete.mock.calls[1]?.[1]).toEqual(messages);
    expect(audit.records[1]).toMatchObject({ context: { retry: { mechanism: "transport", attempt: 2, reason: "rate_limited" } } });
  });
  it("has explicit off thinking policies and role-specific budgets", () => {
    expect(RPG_AI_DEFAULT_POLICIES.intent).toMatchObject({ thinking: "off", maxTokens: 320, maxAttempts: 2 });
    expect(RPG_AI_DEFAULT_POLICIES.scene).toMatchObject({ thinking: "off", maxTokens: 3_000, maxAttempts: 2 });
    expect(RPG_AI_DEFAULT_POLICIES.world).toMatchObject({ thinking: "off", maxTokens: 3_200, maxAttempts: 3 });
    expect(RPG_AI_DEFAULT_POLICIES.opening).toMatchObject({ thinking: "off", maxTokens: 5_000 });
    expect(RPG_AI_DEFAULT_POLICIES.narrative_bundle).toMatchObject({ thinking: "off", timeoutMs: 45_000, maxTokens: 8_000, maxAttempts: 2 });

    const client = createRpgAiClient({
      transport: transportFor(async () => ({ ok: true as const, content: "{}", latencyMs: 1 })),
      config,
    });
    expect(client.policy("narrative_bundle")).toMatchObject({ timeoutMs: 45_000, maxAttempts: 2, maxTokens: 8_000 });
  });

  it("omits the output cap when the selected role enables DeepSeek thinking", async () => {
    const complete = vi.fn(async (_config, _messages, options) => {
      expect(options).toEqual({
        timeoutMs: 45_000,
        temperature: 0.2,
        extraBody: {
          thinking: { type: "enabled" },
          response_format: { type: "json_object" },
        },
      });
      return { ok: true as const, content: "{}", latencyMs: 1 };
    });
    const client = createRpgAiClient({
      transport: transportFor(complete),
      config,
      policies: { scene: { thinking: "on", jsonMode: "json_object" } },
    });

    await client.complete("scene", messages);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not repeat an empty final channel with the same request", async () => {
    const complete = vi.fn(async () => ({
      ok: false as const,
      code: "empty_response" as const,
      retryable: false,
      latencyMs: 1,
    }));
    const warn = vi.fn();
    const client = createRpgAiClient({
      transport: transportFor(complete),
      config,
      logger: { warn },
    });

    const result = await client.complete("scene", messages);

    expect(result).toMatchObject({ ok: false, code: "empty_response" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("rpg_ai_provider_empty_final_content", {
      role: "scene",
      code: "empty_response",
      latencyMs: 1,
    });
  });

  it("records safe evidence when the provider reasons despite thinking being off", async () => {
    const warn = vi.fn();
    const client = createRpgAiClient({
      transport: transportFor(async () => ({
        ok: false as const,
        code: "empty_response" as const,
        retryable: false,
        latencyMs: 12,
        finishReason: "length",
        reasoningTokens: 1_800,
        hasReasoningContent: true,
      })),
      config,
      logger: { warn },
    });

    await client.complete("scene", messages);

    expect(warn).toHaveBeenCalledWith("rpg_ai_provider_reasoning_observed", {
      role: "scene",
      requestedThinking: "off",
      finishReason: "length",
      reasoningTokens: 1_800,
      hasReasoningContent: true,
    });
    expect(warn).toHaveBeenCalledWith("rpg_ai_provider_empty_final_content", {
      role: "scene",
      code: "empty_response",
      latencyMs: 12,
      finishReason: "length",
      reasoningTokens: 1_800,
      hasReasoningContent: true,
    });
  });

  it("observes reasoning tokens carried in successful transport usage", async () => {
    const warn = vi.fn();
    const client = createRpgAiClient({
      transport: transportFor(async () => ({
        ok: true as const,
        content: "{}",
        latencyMs: 12,
        finishReason: "stop",
        usage: { reasoningTokens: 9 },
      })),
      config,
      logger: { warn },
    });

    await client.complete("scene", messages);

    expect(warn).toHaveBeenCalledWith("rpg_ai_provider_reasoning_observed", {
      role: "scene",
      requestedThinking: "off",
      finishReason: "stop",
      reasoningTokens: 9,
    });
  });

  it("retries only transient transport failures according to the role policy", async () => {
    let calls = 0;
    const complete = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: false as const, code: "service_error" as const, retryable: true, latencyMs: 1 };
      return { ok: true as const, content: "{}", latencyMs: 1 };
    });
    const client = createRpgAiClient({ transport: transportFor(complete), config });

    const result = await client.complete("scene", messages);

    expect(result).toMatchObject({ ok: true, content: "{}" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("applies production thinking overrides by role without changing evaluation settings", () => {
    const client = createServerRpgAiClient({
      AI_API_BASE_URL: "http://provider.test/v1",
      AI_API_KEY: "secret",
      AI_MODEL: "model",
      AI_RUNTIME_THINKING_ROLES: "world",
    });

    expect(client?.policy("scene").thinking).toBe("off");
    expect(client?.policy("world").thinking).toBe("on");
  });
});

describe("resolveRpgAiThinkingRoles", () => {
  it("默认仅规划思考，显式空值可关闭，仍忽略未知和重复角色", () => {
    expect(resolveRpgAiThinkingRoles({})).toEqual(["planning"]);
    expect(resolveRpgAiThinkingRoles({ AI_RUNTIME_THINKING_ROLES: "" })).toEqual([]);
    expect(resolveRpgAiThinkingRoles({ AI_RUNTIME_THINKING_ROLES: "world,unknown,scene,world" })).toEqual([
      "scene",
      "world",
    ]);
  });
  it("生产装配使用规划默认值，三个润色角色保持关闭", () => {
    const client = createServerRpgAiClient({ AI_API_BASE_URL: "http://provider.test/v1", AI_API_KEY: "secret", AI_MODEL: "model" });
    expect(client?.policy("planning").thinking).toBe("on");
    for (const role of ["narration", "character", "choices"] as const) expect(client?.policy(role).thinking).toBe("off");
    const disabled = createServerRpgAiClient({ AI_API_BASE_URL: "http://provider.test/v1", AI_API_KEY: "secret", AI_MODEL: "model", AI_RUNTIME_THINKING_ROLES: "" });
    expect(disabled?.policy("planning").thinking).toBe("off");
  });
});

describe("audit recorder integration", () => {
  it("records successful ai_call with messages and model content", async () => {
    const audit = fakeRecorder();
    const client = createRpgAiClient({
      transport: transportFor(async () => ({ ok: true as const, content: "模型正文", latencyMs: 1 })),
      config,
      auditRecorder: audit,
    });

    await client.complete("scene", messages, {
      purpose: "scene_performance",
      trigger: "talk_choice",
      gameId: "game-1",
      action: { kind: "talk", npcId: "npc-1" },
    });

    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      kind: "ai_call",
      role: "scene",
      attempt: 1,
      context: expect.objectContaining({
        purpose: "scene_performance",
        trigger: "talk_choice",
        gameId: "game-1",
      }),
      input: { messages },
      output: expect.objectContaining({ ok: true, content: "模型正文" }),
    });
  });

  it("records failed calls with stable failure code", async () => {
    const audit = fakeRecorder();
    const client = createRpgAiClient({
      transport: transportFor(async () => ({
        ok: false as const,
        code: "service_error" as const,
        retryable: true,
        latencyMs: 42,
      })),
      config,
      auditRecorder: audit,
      policies: { scene: { maxAttempts: 1 } },
    });

    await client.complete("scene", messages, {
      purpose: "scene_performance",
      trigger: "explore_action",
    });

    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      kind: "ai_call",
      role: "scene",
      attempt: 1,
      output: expect.objectContaining({ ok: false, code: "service_error", latencyMs: 42 }),
    });
  });

  it("records each retry attempt as separate ai_call entries", async () => {
    const audit = fakeRecorder();
    let calls = 0;
    const client = createRpgAiClient({
      transport: transportFor(async () => {
        calls += 1;
        if (calls < 3) return { ok: false as const, code: "service_error" as const, retryable: true, latencyMs: 1 };
        return { ok: true as const, content: "ok", latencyMs: 1 };
      }),
      config,
      auditRecorder: audit,
    });

    await client.complete("world", messages, {
      purpose: "world_evolution",
      trigger: "scene_evolution",
    });

    expect(audit.records).toHaveLength(3);
    expect(audit.records[0]).toMatchObject({ attempt: 1, output: { ok: false } });
    expect(audit.records[1]).toMatchObject({ attempt: 2, output: { ok: false } });
    expect(audit.records[2]).toMatchObject({ attempt: 3, output: { ok: true } });
  });

  it("does not record when no auditRecorder is provided", async () => {
    const client = createRpgAiClient({
      transport: transportFor(async () => ({ ok: true as const, content: "{}", latencyMs: 1 })),
      config,
    });

    // Should not throw
    await expect(client.complete("scene", messages)).resolves.toBeDefined();
  });

  it("marks provider transport retry as mechanism=transport keeping origin", async () => {
    const audit = fakeRecorder();
    let calls = 0;
    const client = createRpgAiClient({
      transport: transportFor(async () => {
        calls += 1;
        if (calls === 1) return { ok: false as const, code: "network_error" as const, retryable: true, latencyMs: 1 };
        return { ok: true as const, content: "ok", latencyMs: 1 };
      }),
      config,
      auditRecorder: audit,
    });

    await client.complete("scene", messages, {
      purpose: "scene_performance",
      trigger: "talk_choice",
    });

    const events = audit.records.filter((r) => r.kind === "ai_call");
    expect(events.map((event) => event.context.retry)).toEqual([
      { origin: "normal", mechanism: "initial", attempt: 0 },
      { origin: "normal", mechanism: "transport", attempt: 2, reason: "network_error" },
    ]);
  });

  it("content repair callback uses a new callId, shares link fields and marks content_repair", async () => {
    const audit = fakeRecorder();
    const client = createRpgAiClient({
      transport: transportFor(async () => ({ ok: true as const, content: "ok", latencyMs: 1 })),
      config,
      auditRecorder: audit,
    });
    const link = { gameId: "game-1", jobId: "job-1", traceId: "trace-1" };

    await client.complete("intent", messages, {
      ...link,
      purpose: "intent_parsing",
      trigger: "free_text_action",
      retry: { origin: "normal", mechanism: "initial", attempt: 0 },
    });
    await client.complete("intent", messages, {
      ...link,
      purpose: "intent_parsing",
      trigger: "free_text_action",
      retry: { origin: "normal", mechanism: "content_repair", attempt: 1, reason: "invalid_json" },
    });

    const events = audit.records.filter((r) => r.kind === "ai_call");
    expect(events).toHaveLength(2);
    expect(events[0].callId).not.toBe(events[1].callId);
    expect(events[0].context).toMatchObject(link);
    expect(events[1].context).toMatchObject(link);
    expect(events[0].context.retry).toEqual({ origin: "normal", mechanism: "initial", attempt: 0 });
    expect(events[1].context.retry).toEqual({
      origin: "normal",
      mechanism: "content_repair",
      attempt: 1,
      reason: "invalid_json",
    });
  });

  it("does not include apiKey, authorization or baseUrl in the record", async () => {
    const audit = fakeRecorder();
    const client = createRpgAiClient({
      transport: transportFor(async () => ({ ok: true as const, content: "{}", latencyMs: 1 })),
      config,
      auditRecorder: audit,
    });

    await client.complete("scene", messages, {
      purpose: "scene_performance",
      trigger: "talk_choice",
    });

    const record = JSON.stringify(audit.records[0]);
    expect(record).not.toContain("apiKey");
    expect(record).not.toContain("authorization");
    expect(record).not.toContain("baseUrl");
    expect(record).not.toContain("secret");
  });

  it("audit write failure does not change the return result", async () => {
    const failingAudit: AiTextAuditRecorder = {
      enabled: true,
      gameApiMode: "compact",
      record: vi.fn(async () => { throw new Error("write failed"); }),
      close: vi.fn(async () => {}),
    };
    const client = createRpgAiClient({
      transport: transportFor(async () => ({ ok: true as const, content: "result", latencyMs: 1 })),
      config,
      auditRecorder: failingAudit,
    });

    const result = await client.complete("scene", messages, {
      purpose: "scene_performance",
      trigger: "talk_choice",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("result");
    }
  });
});
