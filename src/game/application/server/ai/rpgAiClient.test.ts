import { describe, expect, it, vi } from "vitest";
import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import {
  createRpgAiClient,
  createServerRpgAiClient,
  RPG_AI_DEFAULT_POLICIES,
  resolveRpgAiThinkingRoles,
} from "./rpgAiClient";

const config: AiTransportConfig = { baseUrl: "http://provider.test/v1", apiKey: "secret", model: "model" };
const messages = [{ role: "user" as const, content: "返回 JSON" }];

function transportFor(complete: AiTransport["complete"]): AiTransport {
  return {
    complete,
    stream: async () => ({ ok: false as const, code: "network_error" as const, retryable: true, latencyMs: 1 }),
  };
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
