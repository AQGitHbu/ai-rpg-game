import { describe, expect, it, vi } from "vitest";
import { createServerIntentParserSource } from "./intentParserSourceFactory";
import type { RpgAiClient } from "./rpgAiClient";
import type { IntentContext } from "@/game/gameplay/rpg/intentParser";

const VALID_ENV = {
  AI_API_BASE_URL: "https://api.example.com/v1",
  AI_API_KEY: "test-key",
  AI_MODEL: "test-model",
} as const;

const context: IntentContext = {
  currentLocationName: "客栈",
  connectedLocations: [],
  presentNpcs: [],
  availableItems: [],
  undiscoveredFacts: [],
  activeQuests: [],
  topicRefs: [],
};

describe("createServerIntentParserSource", () => {
  it("AI 配置缺失时返回不可用源，并映射为稳定 AI_CALL_FAILED", async () => {
    const source = createServerIntentParserSource({});

    expect(source.sourceVersion).toBe("unavailable-intent");
    await expect(source.parseIntent("探索", context)).resolves.toEqual({
      ok: false,
      reason: "service_error",
      failureKind: "AI_CALL_FAILED",
    });
  });

  it("AI 配置有效时使用注入的 live client，不切换到规则源", async () => {
    const client: RpgAiClient = {
      complete: vi.fn(async () => ({
        ok: true as const,
        content: JSON.stringify({ type: "explore" }),
        latencyMs: 1,
      })),
      policy: vi.fn(() => ({
        thinking: "off" as const,
        timeoutMs: 1_000,
        jsonMode: "prompt_only" as const,
        maxAttempts: 1,
      })),
    };

    const source = createServerIntentParserSource(VALID_ENV, client);
    expect(source.sourceVersion).toBe("live-intent");

    const result = await source.parseIntent("探索", context);
    expect(result).toEqual({ ok: true, action: { type: "explore" } });
    expect(client.complete).toHaveBeenCalledTimes(1);
  });
});
