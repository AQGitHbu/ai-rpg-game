import { describe, expect, it, vi } from "vitest";
import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import {
  createRpgAiClient,
  createServerRpgAiClient,
  RPG_AI_DEFAULT_POLICIES,
  resolveRpgAiThinkingRoles,
} from "./rpgAiClient";
import type { AiTextAuditRecorder, AiTextAuditPayload } from "./textAuditTypes";

const config: AiTransportConfig = { baseUrl: "http://provider.test/v1", apiKey: "secret", model: "model" };
const messages = [{ role: "user" as const, content: "返回 JSON" }];

function transportFor(complete: AiTransport["complete"]): AiTransport {
  return {
    complete,
    stream: async () => ({ ok: false as const, code: "network_error" as const, retryable: true, latencyMs: 1 }),
  };
}

function fakeRecorder(): AiTextAuditRecorder & { records: AiTextAuditPayload[] } {
  const records: AiTextAuditPayload[] = [];
  return {
    enabled: true,
    records,
    record: vi.fn(async (payload: AiTextAuditPayload) => { records.push(payload); }),
    close: vi.fn(async () => {}),
  } as unknown as AiTextAuditRecorder & { records: AiTextAuditPayload[] };
}

describe("createRpgAiClient", () => {
  it("has explicit off thinking policies and role-specific budgets", () => {
    expect(RPG_AI_DEFAULT_POLICIES.intent).toMatchObject({ thinking: "off", maxTokens: 320, maxAttempts: 1 });
    expect(RPG_AI_DEFAULT_POLICIES.scene).toMatchObject({ thinking: "off", maxTokens: 3_000, maxAttempts: 2 });
    expect(RPG_AI_DEFAULT_POLICIES.world).toMatchObject({ thinking: "off", maxTokens: 3_200, maxAttempts: 3 });
    expect(RPG_AI_DEFAULT_POLICIES.opening).toMatchObject({ thinking: "off", maxTokens: 5_000 });
  });

  it("builds DeepSeek thinking and JSON options from the selected role policy", async () => {
    const complete = vi.fn(async (_config, _messages, options) => {
      expect(options).toEqual({
        timeoutMs: 45_000,
        temperature: 0.2,
        extraBody: {
          thinking: { type: "enabled" },
          max_tokens: 3_000,
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
  it("defaults to no thinking roles and ignores unknown/duplicate values", () => {
    expect(resolveRpgAiThinkingRoles({})).toEqual([]);
    expect(resolveRpgAiThinkingRoles({ AI_RUNTIME_THINKING_ROLES: "world,unknown,scene,world" })).toEqual([
      "scene",
      "world",
    ]);
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
