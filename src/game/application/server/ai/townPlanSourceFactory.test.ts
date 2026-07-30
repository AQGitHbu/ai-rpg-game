import { describe, expect, it, vi } from "vitest";
import type { AiTransport } from "@ai-game/ai-transport";
import type { TownPlanRequest } from "../../townPlanGeneration";
import { createTownPlanSource } from "./townPlanSourceFactory";

// ---------------------------------------------------------------------------
// createTownPlanSource 装配契约：
// - env 无效 ⇒ unavailable source（origin=unavailable，携带 AI_CONFIG_* 诊断），
//   不创建 transport；
// - env 有效 ⇒ live source，把请求经注入的 fake transport 送达。
// 全部离线：transport 由测试注入 fake，绝不真实 fetch。
// ---------------------------------------------------------------------------

const VALID_ENV = {
  AI_API_BASE_URL: "https://api.example.com/v1",
  AI_MODEL: "some-model",
  AI_API_KEY: "sk-secret-value-123"
};

const REQUEST: TownPlanRequest = {
  locationId: "loc_2",
  locationName: "大石镇",
  locationDescription: "边陲聚落。",
  locationTags: [],
  npcs: [],
  worldTone: "苍凉",
  worldThemes: [],
  seed: "seed#town#loc_2",
  traceId: "trace-factory"
};

describe("createTownPlanSource：无效配置", () => {
  it("缺少密钥 ⇒ unavailable + 稳定诊断，且不创建 transport", async () => {
    const transportFactory = vi.fn();
    const source = createTownPlanSource(
      { AI_API_BASE_URL: VALID_ENV.AI_API_BASE_URL, AI_MODEL: VALID_ENV.AI_MODEL },
      { transportFactory }
    );
    const attempt = await source.generate(REQUEST);
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.origin).toBe("unavailable");
    expect(attempt.diagnostics).toContain("AI_CONFIG_KEY_MISSING");
    expect(transportFactory).not.toHaveBeenCalled();
  });
});

describe("createTownPlanSource：有效配置", () => {
  it("装配 live source：请求经注入 transport 送达，失败映射稳定类别", async () => {
    const calls: unknown[][] = [];
    const transport: AiTransport = {
      async complete(...args: unknown[]) {
        calls.push(args);
        return { ok: false as const, code: "timeout" as const, retryable: true, latencyMs: 1 };
      },
      async stream() { throw new Error("not used"); }
    } as unknown as AiTransport;
    const source = createTownPlanSource(VALID_ENV, { transportFactory: () => transport });

    const attempt = await source.generate(REQUEST);
    expect(calls).toHaveLength(1);
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.origin).toBe("live");
    expect(attempt.category).toBe("timeout");
  });
});
