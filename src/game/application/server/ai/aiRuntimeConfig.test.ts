import { describe, expect, it } from "vitest";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";

// ---------------------------------------------------------------------------
// server-only runtime config 契约测试：只接收注入的 env 记录，绝不读 process.env、
// 绝不读 .env.local，绝不回显任何值，绝不抛出。诊断码是稳定的 AI_CONFIG_*，
// 与 scripts/aiEnv.mjs 的三键规则语义一致（base URL 必须 http(s)、model/key trim 非空）。
// ---------------------------------------------------------------------------

const VALID_ENV: Record<string, string | undefined> = {
  AI_API_BASE_URL: "https://api.example.com/v1",
  AI_MODEL: "some-model",
  AI_API_KEY: "sk-secret-value-123"
};

describe("parseAiRuntimeConfig：有效配置", () => {
  it("三键齐备且合法 ⇒ available，config 为 trim 后的值", () => {
    const result = parseAiRuntimeConfig(VALID_ENV);
    expect(result).toEqual({
      status: "available",
      config: {
        baseUrl: "https://api.example.com/v1",
        model: "some-model",
        apiKey: "sk-secret-value-123"
      }
    });
  });

  it("包裹空白的值会被 trim 后接受", () => {
    const result = parseAiRuntimeConfig({
      AI_API_BASE_URL: "  http://localhost:1234/v1  ",
      AI_MODEL: "  m  ",
      AI_API_KEY: "  k  "
    });
    expect(result).toEqual({
      status: "available",
      config: { baseUrl: "http://localhost:1234/v1", model: "m", apiKey: "k" }
    });
  });
});

describe("parseAiRuntimeConfig：缺失/占位诊断", () => {
  it("全部缺失 ⇒ unavailable，三条稳定诊断码", () => {
    const result = parseAiRuntimeConfig({});
    expect(result).toEqual({
      status: "unavailable",
      diagnostics: ["AI_CONFIG_BASE_URL_MISSING", "AI_CONFIG_MODEL_MISSING", "AI_CONFIG_KEY_MISSING"]
    });
  });

  it("单键缺失分别映射对应诊断码", () => {
    expect(parseAiRuntimeConfig({ ...VALID_ENV, AI_API_BASE_URL: "   " })).toEqual({
      status: "unavailable",
      diagnostics: ["AI_CONFIG_BASE_URL_MISSING"]
    });
    expect(parseAiRuntimeConfig({ ...VALID_ENV, AI_MODEL: undefined })).toEqual({
      status: "unavailable",
      diagnostics: ["AI_CONFIG_MODEL_MISSING"]
    });
    expect(parseAiRuntimeConfig({ ...VALID_ENV, AI_API_KEY: "" })).toEqual({
      status: "unavailable",
      diagnostics: ["AI_CONFIG_KEY_MISSING"]
    });
  });

  it("占位值（replace-me / <...> 等）映射 PLACEHOLDER 诊断码", () => {
    const result = parseAiRuntimeConfig({
      AI_API_BASE_URL: "https://ok.example/v1",
      AI_MODEL: "replace-me",
      AI_API_KEY: "<your-key>"
    });
    expect(result).toEqual({
      status: "unavailable",
      diagnostics: ["AI_CONFIG_MODEL_PLACEHOLDER", "AI_CONFIG_KEY_PLACEHOLDER"]
    });
  });
});

describe("parseAiRuntimeConfig：base URL 协议校验", () => {
  it("非 http(s) 协议 ⇒ AI_CONFIG_BASE_URL_INVALID", () => {
    expect(parseAiRuntimeConfig({ ...VALID_ENV, AI_API_BASE_URL: "ftp://x/v1" })).toEqual({
      status: "unavailable",
      diagnostics: ["AI_CONFIG_BASE_URL_INVALID"]
    });
  });

  it("不是合法 URL ⇒ AI_CONFIG_BASE_URL_INVALID", () => {
    expect(parseAiRuntimeConfig({ ...VALID_ENV, AI_API_BASE_URL: "not a url" })).toEqual({
      status: "unavailable",
      diagnostics: ["AI_CONFIG_BASE_URL_INVALID"]
    });
  });
});

describe("parseAiRuntimeConfig：脱敏与健壮性", () => {
  it("诊断绝不包含任何输入值", () => {
    const secretKey = "sk-super-secret-should-never-leak";
    const result = parseAiRuntimeConfig({
      AI_API_BASE_URL: "ftp://leaky.example/v1",
      AI_MODEL: "leaky-model-name",
      AI_API_KEY: secretKey
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain("leaky-model-name");
    expect(serialized).not.toContain("leaky.example");
  });

  it("面对全 undefined 输入不抛出", () => {
    expect(() =>
      parseAiRuntimeConfig({ AI_API_BASE_URL: undefined, AI_MODEL: undefined, AI_API_KEY: undefined })
    ).not.toThrow();
  });
});
