import { afterEach, describe, expect, it, vi } from "vitest";
import { validateNewGameInput, type NewGameInput } from "@/game/domain";
import wuxiaFixture from "../../../../../data/fixtures/phase1/wuxia.json";
import { TEST_TRACE_ID } from "../../applicationFixture.testutil";
import { createScenarioCandidateSource } from "./scenarioCandidateSourceFactory";

// ---------------------------------------------------------------------------
// factory 装配契约（Phase 4C）：
// - env 无效（含 AI_OUTPUT_FORMAT 非法）⇒ unavailable source，不创建 transport；
// - env 有效 ⇒ 按 outputFormat 把 response_format extraBody 传进 transport.complete。
// 全部离线：transport 由测试注入 fake，绝不真实 fetch。
// ---------------------------------------------------------------------------

const VALID_ENV = {
  AI_API_BASE_URL: "https://api.example.com/v1",
  AI_MODEL: "some-model",
  AI_API_KEY: "sk-secret-value-123"
};

const REQUEST = {
  input: validatedFixtureInput(),
  seed: "seed-factory-test",
  traceId: TEST_TRACE_ID
};

/** request.input 是 branded ValidatedNewGameInput：沿用域校验而非强转。 */
function validatedFixtureInput() {
  const validated = validateNewGameInput(
    (wuxiaFixture as unknown as { input: NewGameInput }).input
  );
  if (!validated.ok) throw new Error("fixture 输入必须合法");
  return validated.value;
}

function fakeTransport() {
  const calls: unknown[][] = [];
  return {
    calls,
    transport: {
      complete: async (...args: unknown[]) => {
        calls.push(args);
        return { ok: false as const, code: "timeout" as const, latencyMs: 1 };
      }
    }
  };
}

afterEach(() => vi.restoreAllMocks());

describe("createScenarioCandidateSource：无效配置", () => {
  it("AI_OUTPUT_FORMAT 非法 ⇒ unavailable + 稳定诊断，且不创建 transport", async () => {
    const transportFactory = vi.fn();
    const source = createScenarioCandidateSource(
      { ...VALID_ENV, AI_OUTPUT_FORMAT: "bogus" },
      { transportFactory }
    );
    const attempt = await source.generate(REQUEST);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.origin).toBe("unavailable");
      expect(attempt.diagnostics).toEqual(["AI_CONFIG_OUTPUT_FORMAT_INVALID"]);
    }
    expect(transportFactory).not.toHaveBeenCalled();
  });
});

describe("createScenarioCandidateSource：extraBody 按格式装配", () => {
  it.each([
    [undefined, undefined],
    ["prompt_only", undefined],
    ["json_object", { response_format: { type: "json_object" } }]
  ] as const)("AI_OUTPUT_FORMAT=%s ⇒ extraBody 并入 nested thinking + 低温 + 长超时", async (format, expected) => {
    const { calls, transport } = fakeTransport();
    const source = createScenarioCandidateSource(
      { ...VALID_ENV, AI_OUTPUT_FORMAT: format },
      { transportFactory: () => transport as never }
    );
    await source.generate(REQUEST);
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual({
      extraBody: { chat_template_kwargs: { enable_thinking: false }, ...(expected ?? {}) },
      temperature: 0.2,
      timeoutMs: 120_000
    });
  });

  it("json_schema ⇒ strict 命名 schema 进入 extraBody", async () => {
    const { calls, transport } = fakeTransport();
    const source = createScenarioCandidateSource(
      { ...VALID_ENV, AI_OUTPUT_FORMAT: "json_schema" },
      { transportFactory: () => transport as never }
    );
    await source.generate(REQUEST);
    const options = calls[0][2] as {
      extraBody: {
        response_format: {
          type: string;
          json_schema: { name: string; strict: boolean };
        };
      };
    };
    expect(options.extraBody.response_format.type).toBe("json_schema");
    expect(options.extraBody.response_format.json_schema.name).toBe("scenario_blueprint_candidate");
    expect(options.extraBody.response_format.json_schema.strict).toBe(true);
  });

  it("AI_THINKING_ROLES=scenario ⇒ 只为开局蓝图开启思考", async () => {
    const { calls, transport } = fakeTransport();
    const source = createScenarioCandidateSource(
      { ...VALID_ENV, AI_THINKING_ROLES: "scenario" },
      { transportFactory: () => transport as never }
    );
    await source.generate(REQUEST);
    expect((calls[0][2] as { extraBody: { chat_template_kwargs: { enable_thinking: boolean } } }).extraBody.chat_template_kwargs.enable_thinking).toBe(true);
  });
});
