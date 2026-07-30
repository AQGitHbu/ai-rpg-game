import { describe, expect, it } from "vitest";
import type {
  AiCompletionResult,
  AiMessage,
  AiTransport,
  AiTransportConfig
} from "@ai-game/ai-transport";
import { TOWN_PLAN_CONTRACT_VERSION, type TownPlanRequest } from "../../townPlanGeneration";
import {
  createLiveTownPlanSource,
  createUnavailableTownPlanSource
} from "./liveTownPlanSource";
import { buildTownPlanFixtureCandidate, createTownPlanFixtureSource } from "./townPlanFixtureSource";
import { buildTownPlanPromptMessages } from "./townPlanPrompt";

// ---------------------------------------------------------------------------
// Town 层：town plan source 契约测试。
// - live：完整 JSON / ```json fence 解析；provider 失败映射稳定类别；
//   candidate 保持未信任（origin=live）；诊断与遥测绝不含 prompt/密钥/URL。
// - fixture：确定性候选，剧情 NPC 全覆盖。
// - prompt：封闭词汇表写入 system；上下文不含 seed/traceId。
// ---------------------------------------------------------------------------

const CONFIG: AiTransportConfig = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-should-never-leak",
  model: "town-test-model"
};

const REQUEST: TownPlanRequest = {
  locationId: "loc_2",
  locationName: "大石镇",
  locationDescription: "群山环抱的边陲聚落。",
  locationTags: ["聚落", "边陲"],
  npcs: [
    { id: "npc_tie", name: "铁牛", role: "铁匠" },
    { id: "npc_lu", name: "陆掌柜", role: "客栈掌柜" }
  ],
  worldTone: "苍凉",
  worldThemes: ["复仇", "江湖"],
  seed: "seed#town#loc_2",
  traceId: "town-trace-secret"
};

function fakeTransport(results: readonly AiCompletionResult[]): {
  transport: AiTransport;
  calls: { messages: readonly AiMessage[] }[];
} {
  const calls: { messages: readonly AiMessage[] }[] = [];
  let index = 0;
  return {
    calls,
    transport: {
      async complete(_config, messages) {
        calls.push({ messages });
        const result = results[Math.min(index, results.length - 1)];
        index += 1;
        return result;
      },
      async stream() {
        throw new Error("live town plan source 不使用 stream");
      }
    }
  };
}

function okResult(content: string): AiCompletionResult {
  return { ok: true, content, latencyMs: 88, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
}

function makeLive(results: readonly AiCompletionResult[]) {
  const { transport, calls } = fakeTransport(results);
  const logs: string[] = [];
  const source = createLiveTownPlanSource({ transport, config: CONFIG, log: (line) => logs.push(line) });
  return { source, calls, logs };
}

describe("createLiveTownPlanSource", () => {
  it("完整 JSON 响应 ⇒ ok，candidate 原样透传（未信任），origin=live", async () => {
    const candidate = { theme: "大石镇", requiredBuildings: [] };
    const { source } = makeLive([okResult(JSON.stringify(candidate))]);

    const attempt = await source.generate(REQUEST);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.origin).toBe("live");
    expect(attempt.contractVersion).toBe(TOWN_PLAN_CONTRACT_VERSION);
    expect(attempt.candidate).toEqual(candidate);
  });

  it("```json fence 包裹的响应也能解析", async () => {
    const candidate = { theme: "围栏镇" };
    const { source } = makeLive([okResult("```json\n" + JSON.stringify(candidate) + "\n```")]);

    const attempt = await source.generate(REQUEST);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.candidate).toEqual(candidate);
  });

  it("空响应 ⇒ empty_response；非 JSON ⇒ invalid_json", async () => {
    const empty = await makeLive([okResult("   ")]).source.generate(REQUEST);
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.category).toBe("empty_response");

    const garbage = await makeLive([okResult("not json at all")]).source.generate(REQUEST);
    expect(garbage.ok).toBe(false);
    if (garbage.ok) return;
    expect(garbage.category).toBe("invalid_json");
  });

  it("provider 失败码映射稳定类别（rate_limited / timeout / http_error→service_error）", async () => {
    const rate = await makeLive([{ ok: false, code: "rate_limited", retryable: true, latencyMs: 5 }]).source.generate(REQUEST);
    expect(rate.ok === false && rate.category).toBe("rate_limited");
    const timeout = await makeLive([{ ok: false, code: "timeout", retryable: true, latencyMs: 5 }]).source.generate(REQUEST);
    expect(timeout.ok === false && timeout.category).toBe("timeout");
    const http = await makeLive([{ ok: false, code: "http_error", retryable: false, latencyMs: 5 }]).source.generate(REQUEST);
    expect(http.ok === false && http.category).toBe("service_error");
  });

  it("遥测与诊断绝不泄漏 prompt / 密钥 / URL / 模型输出", async () => {
    const { source, logs } = makeLive([okResult(JSON.stringify({ theme: "泄漏检测", secretEcho: "sk-should-never-leak" }))]);
    await source.generate(REQUEST);
    const blob = logs.join("\n");
    expect(blob).not.toContain("sk-should-never-leak");
    expect(blob).not.toContain(CONFIG.baseUrl);
    expect(blob).not.toContain(REQUEST.traceId);
    expect(blob).toContain("town_plan");
  });
});

describe("createUnavailableTownPlanSource", () => {
  it("永远失败，携带注入的诊断，origin=unavailable", async () => {
    const source = createUnavailableTownPlanSource(["AI_CONFIG_KEY_MISSING"]);
    const attempt = await source.generate(REQUEST);
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.origin).toBe("unavailable");
    expect(attempt.diagnostics).toEqual(["AI_CONFIG_KEY_MISSING"]);
  });
});

describe("createTownPlanFixtureSource", () => {
  it("确定性候选：同请求深度相等，剧情 NPC 全覆盖（key=story_npc_<id>）", async () => {
    const source = createTownPlanFixtureSource();
    const a = await source.generate(REQUEST);
    const b = await source.generate(REQUEST);
    expect(a.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.origin).toBe("fixture");
    expect(a.candidate).toEqual(b.candidate);
    expect(a.candidate).toEqual(buildTownPlanFixtureCandidate(REQUEST));
    const keys = (a.candidate as { requiredBuildings: { key: string }[] }).requiredBuildings.map((b2) => b2.key);
    expect(keys).toEqual(["story_npc_npc_tie", "story_npc_npc_lu"]);
  });
});

describe("buildTownPlanPromptMessages", () => {
  it("system 指令含封闭词汇表；user 上下文不含 seed / traceId", () => {
    const messages = buildTownPlanPromptMessages(REQUEST);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(TOWN_PLAN_CONTRACT_VERSION);
    expect(messages[0].content).toContain("story_npc_");
    expect(messages[0].content).toContain("blacksmith");
    const userContent = messages[1].content;
    expect(userContent).not.toContain(REQUEST.seed);
    expect(userContent).not.toContain(REQUEST.traceId);
    expect(userContent).toContain("大石镇");
  });
});
