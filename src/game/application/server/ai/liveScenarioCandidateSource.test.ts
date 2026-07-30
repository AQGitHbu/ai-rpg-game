import { describe, expect, it } from "vitest";
import type {
  AiCompletionResult,
  AiMessage,
  AiTransport,
  AiTransportConfig
} from "@ai-game/ai-transport";
import { validateNewGameInput } from "@/game/domain";
import type { ScenarioGenerationRequest } from "../../scenarioGeneration";
import type { ScenarioAuditEvent, ScenarioGenerationAudit } from "./scenarioGenerationAudit";
import {
  createLiveScenarioCandidateSource,
  createUnavailableScenarioCandidateSource
} from "./liveScenarioCandidateSource";

// ---------------------------------------------------------------------------
// liveScenarioCandidateSource 契约测试：注入 shared transport、config、prompt builder
// 与 audit。只接受完整 JSON 或单一 ```json fence；root-shape 检查与 fixture source
// 同级；provider 失败映射到既有 11 个失败类别（不新增）；诊断绝不含模型原文或输入；
// 成功/失败都写 audit（脱敏）。source 不 import repository/persistence（边界守卫另测）。
// ---------------------------------------------------------------------------

const CONFIG: AiTransportConfig = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-should-never-leak",
  model: "test-model"
};

/** 最小合法结构候选：live source 只做结构存在性检查，不做完整业务校验。 */
const MINIMAL_CANDIDATE = {
  schemaVersion: 1,
  generationId: "gen-live",
  seed: "phase4b-seed-001",
  templateVersion: "live-1",
  gameType: "wuxia",
  inputDigest: "digest-live",
  world: { summary: "s", tone: "t", themes: [], facts: [], tags: [] },
  player: {
    name: "沈青崖",
    identity: "落魄镖师",
    backgroundSummary: "b",
    startingLocationId: "loc_1",
    startingItemIds: [],
    baseStats: { hp: 30, attack: 6, defense: 4 }
  },
  locations: [],
  npcs: [],
  quests: [],
  enemies: [],
  items: [],
  endings: [],
  openingScene: {
    id: "scene_opening",
    locationId: "loc_1",
    narration: "n",
    presentNpcIds: [],
    suggestedActions: [],
    investigableFactIds: []
  },
  contentBudget: {
    mainLocations: 4,
    hiddenLocationsMax: 1,
    coreNpcsMin: 4,
    coreNpcsMax: 6,
    companionsMax: 1,
    sideQuestsMax: 2,
    endings: 2
  }
};

const REQUEST: ScenarioGenerationRequest = buildRequest();

function buildRequest(): ScenarioGenerationRequest {
  const validated = validateNewGameInput({
    gameType: "wuxia",
    characterName: "沈青崖",
    characterIdentity: "落魄镖师",
    personalityTags: [],
    worldPremise: "镖局一夜覆灭，江湖各派暗流涌动，真凶身份成谜。",
    storyOpening: "暮色四合，主角背着旧刀走进青石镇，镇口贴着一张缉凶告示。",
    narrativeStyle: "novel",
    contentIntensity: "normal"
  });
  if (!validated.ok) throw new Error("测试输入必须合法");
  return { input: validated.value, seed: "phase4b-seed-001", traceId: "trace-live-0001" };
}

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
        throw new Error("live source 不使用 stream");
      }
    }
  };
}

function spyAudit(): { events: ScenarioAuditEvent[]; audit: ScenarioGenerationAudit } {
  const events: ScenarioAuditEvent[] = [];
  return { events, audit: { record: (event) => events.push(event) } };
}

function okResult(content: string): AiCompletionResult {
  return {
    ok: true,
    content,
    latencyMs: 111,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }
  };
}

function makeSource(
  results: readonly AiCompletionResult[],
  buildMessages: (request: ScenarioGenerationRequest) => readonly AiMessage[] = () => [
    { role: "user", content: "x" }
  ]
) {
  const { transport, calls } = fakeTransport(results);
  const { events, audit } = spyAudit();
  const source = createLiveScenarioCandidateSource({ transport, config: CONFIG, buildMessages, audit });
  return { source, calls, events };
}

describe("createLiveScenarioCandidateSource：成功路径", () => {
  it("完整 JSON 内容 ⇒ ok/live，携带候选与 audit(ok, usage)", async () => {
    const { source, events } = makeSource([okResult(JSON.stringify(MINIMAL_CANDIDATE))]);
    const attempt = await source.generate(REQUEST);
    expect(attempt).toMatchObject({ ok: true, origin: "live", contractVersion: "phase4b-v1" });
    if (attempt.ok) expect(attempt.candidate.generationId).toBe("gen-live");
    expect(events[0]).toMatchObject({
      outcome: "ok",
      traceId: "trace-live-0001",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }
    });
  });

  it("单一 ```json fence ⇒ ok/live", async () => {
    const fenced = "```json\n" + JSON.stringify(MINIMAL_CANDIDATE) + "\n```";
    const { source } = makeSource([okResult(fenced)]);
    const attempt = await source.generate(REQUEST);
    expect(attempt).toMatchObject({ ok: true, origin: "live" });
  });

  it("透传 prompt builder 产出的 messages 给 transport", async () => {
    const built: AiMessage[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "payload" }
    ];
    const { source, calls } = makeSource([okResult(JSON.stringify(MINIMAL_CANDIDATE))], () => built);
    await source.generate(REQUEST);
    expect(calls[0].messages).toEqual(built);
  });
});

describe("createLiveScenarioCandidateSource：内容解析失败", () => {
  it("空内容 ⇒ empty_response", async () => {
    const { source } = makeSource([okResult("   ")]);
    expect(await source.generate(REQUEST)).toMatchObject({
      ok: false,
      origin: "live",
      category: "empty_response"
    });
  });

  it("不可解析 JSON ⇒ invalid_json，诊断不含模型原文", async () => {
    const { source } = makeSource([okResult('{"secret":"LEAK_ME_RAW", broken')]);
    const attempt = await source.generate(REQUEST);
    expect(attempt).toMatchObject({ ok: false, origin: "live", category: "invalid_json" });
    if (!attempt.ok) expect(attempt.diagnostics.join(" ")).not.toContain("LEAK_ME_RAW");
  });

  it("多个 ```json fence ⇒ invalid_json（不满足单一 fence 契约）", async () => {
    const multi = '```json\n{"a":1}\n```\n再补充一份：\n```json\n{"b":2}\n```';
    const { source } = makeSource([okResult(multi)]);
    const attempt = await source.generate(REQUEST);
    expect(attempt).toMatchObject({ ok: false, origin: "live", category: "invalid_json" });
    if (!attempt.ok) expect(attempt.diagnostics).toEqual(["LIVE_INVALID_JSON"]);
  });

  it("root 结构错误 ⇒ schema_violation", async () => {
    const broken = { ...MINIMAL_CANDIDATE, npcs: "oops" };
    const { source } = makeSource([okResult(JSON.stringify(broken))]);
    expect(await source.generate(REQUEST)).toMatchObject({
      ok: false,
      origin: "live",
      category: "schema_violation"
    });
  });
});

describe("createLiveScenarioCandidateSource：transport 失败映射到既有 11 类别", () => {
  const cases: readonly { code: AiCompletionResult; expected: string }[] = [
    { code: { ok: false, code: "timeout", retryable: true, latencyMs: 5 }, expected: "timeout" },
    { code: { ok: false, code: "rate_limited", retryable: true, latencyMs: 5 }, expected: "rate_limited" },
    { code: { ok: false, code: "service_error", retryable: true, latencyMs: 5 }, expected: "service_error" },
    { code: { ok: false, code: "network_error", retryable: true, latencyMs: 5 }, expected: "service_error" },
    { code: { ok: false, code: "http_error", retryable: false, latencyMs: 5 }, expected: "service_error" },
    { code: { ok: false, code: "invalid_response", retryable: false, latencyMs: 5 }, expected: "service_error" },
    { code: { ok: false, code: "empty_response", retryable: false, latencyMs: 5 }, expected: "empty_response" }
  ];

  for (const { code, expected } of cases) {
    if (code.ok) continue;
    it(`${code.code} ⇒ ${expected}`, async () => {
      const { source, events } = makeSource([code]);
      const attempt = await source.generate(REQUEST);
      expect(attempt).toMatchObject({ ok: false, origin: "live", category: expected });
      expect(events[0]).toMatchObject({ outcome: "failure", transportCode: code.code });
    });
  }
});

describe("createLiveScenarioCandidateSource：脱敏与稳定性", () => {
  it("诊断与结果绝不包含 api key 或输入原文", async () => {
    const { source } = makeSource([{ ok: false, code: "service_error", retryable: true, latencyMs: 5 }]);
    const attempt = await source.generate(REQUEST);
    const serialized = JSON.stringify(attempt);
    expect(serialized).not.toContain("sk-should-never-leak");
    expect(serialized).not.toContain("镖局一夜覆灭");
  });

  it("每次 generate 递增 audit attempt 序号", async () => {
    const { source, events } = makeSource([
      { ok: false, code: "timeout", retryable: true, latencyMs: 5 },
      { ok: false, code: "timeout", retryable: true, latencyMs: 5 }
    ]);
    await source.generate(REQUEST);
    await source.generate(REQUEST);
    expect(events.map((event) => event.attempt)).toEqual([1, 2]);
  });

  it("transport 意外抛错 ⇒ 映射 service_error，不外泄", async () => {
    const audit = spyAudit();
    const source = createLiveScenarioCandidateSource({
      config: CONFIG,
      buildMessages: () => [{ role: "user", content: "x" }],
      audit: audit.audit,
      transport: {
        async complete() {
          throw new Error("驱动崩溃 secret at https://api.example.com");
        },
        async stream() {
          throw new Error("unused");
        }
      }
    });
    const attempt = await source.generate(REQUEST);
    expect(attempt).toMatchObject({ ok: false, origin: "live", category: "service_error" });
    expect(JSON.stringify(attempt)).not.toContain("驱动崩溃");
  });
});

describe("Phase 4C：extraBody 透传", () => {
  /** 记录 complete 三个入参的 fake transport（沿用既有 fakeTransport 风格）。 */
  function recordingTransport(): { transport: AiTransport; calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
      calls,
      transport: {
        async complete(config, messages, requestOptions) {
          calls.push([config, messages, requestOptions]);
          return { ok: false, code: "timeout", retryable: true, latencyMs: 5 };
        },
        async stream() {
          throw new Error("live source 不使用 stream");
        }
      }
    };
  }

  it("提供 extraBody 时并入 enable_thinking + 低温 + 长超时传给 transport.complete", async () => {
    const { transport, calls } = recordingTransport();
    const { audit } = spyAudit();
    const extraBody = { response_format: { type: "json_object" } };
    const source = createLiveScenarioCandidateSource({
      transport,
      config: CONFIG,
      buildMessages: () => [{ role: "user", content: "x" }],
      audit,
      extraBody
    });
    await source.generate(REQUEST);
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual({
      extraBody: { enable_thinking: false, response_format: { type: "json_object" } },
      temperature: 0.2,
      timeoutMs: 120_000
    });
  });

  it("未提供 extraBody 时仍发送 enable_thinking + 低温 + 长超时（与兄弟 source 对齐）", async () => {
    const { transport, calls } = recordingTransport();
    const { audit } = spyAudit();
    const source = createLiveScenarioCandidateSource({
      transport,
      config: CONFIG,
      buildMessages: () => [{ role: "user", content: "x" }],
      audit
    });
    await source.generate(REQUEST);
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual({
      extraBody: { enable_thinking: false },
      temperature: 0.2,
      timeoutMs: 120_000
    });
  });
});

describe("createUnavailableScenarioCandidateSource", () => {
  it("恒返回 origin=unavailable service_error，携带注入的稳定诊断", async () => {
    const source = createUnavailableScenarioCandidateSource(["AI_CONFIG_MODEL_MISSING"]);
    expect(await source.generate(REQUEST)).toEqual({
      ok: false,
      contractVersion: "phase4b-v1",
      origin: "unavailable",
      category: "service_error",
      diagnostics: ["AI_CONFIG_MODEL_MISSING"]
    });
  });
});
