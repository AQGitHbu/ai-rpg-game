import type { AiTransportConfig } from "@ai-game/ai-transport";

// ---------------------------------------------------------------------------
// Phase 4B/4C server-only runtime config（spec §2）。
//
// 唯一职责：把注入的 env 记录解析为脱敏的 AiTransportConfig，或给出稳定诊断。
// 约束：
// - 只接收 Record<string, string | undefined>；绝不读取 process.env、绝不读 .env.local。
//   （生产唯一注入点是 compositionRoot.ts，测试显式注入 env。）
// - 复用 scripts/aiEnv.mjs 的三键规则：AI_API_BASE_URL 必须 http(s)、model/key trim 非空、
//   拒绝占位值；语义与部署前 `npm run env:check` 保持一致。
// - Phase 4C 新增第四个非敏感键 AI_OUTPUT_FORMAT（三值严格、缺省 prompt_only）。
// - 诊断码稳定（AI_CONFIG_*），绝不回显任何值，绝不抛出。
// ---------------------------------------------------------------------------

/** Phase 4C：显式输出格式（spec §1）。缺省 prompt_only，绝不隐式探测 provider 能力。 */
export const AI_OUTPUT_FORMATS = ["json_schema", "json_object", "prompt_only"] as const;
export type AiOutputFormat = (typeof AI_OUTPUT_FORMATS)[number];

/** 解析结果：available 携带脱敏 config；unavailable 只含稳定诊断码。 */
export type AiRuntimeConfigResult =
  | Readonly<{ status: "available"; config: AiTransportConfig; outputFormat: AiOutputFormat }>
  | Readonly<{ status: "unavailable"; diagnostics: readonly string[] }>;

type FieldSpec = Readonly<{
  envKey: string;
  configKey: keyof AiTransportConfig;
  missingCode: string;
  placeholderCode: string;
}>;

// 与 aiEnv.mjs 相同的键顺序，保证诊断码顺序稳定、可断言。
const FIELDS: readonly FieldSpec[] = [
  {
    envKey: "AI_API_BASE_URL",
    configKey: "baseUrl",
    missingCode: "AI_CONFIG_BASE_URL_MISSING",
    placeholderCode: "AI_CONFIG_BASE_URL_PLACEHOLDER"
  },
  {
    envKey: "AI_MODEL",
    configKey: "model",
    missingCode: "AI_CONFIG_MODEL_MISSING",
    placeholderCode: "AI_CONFIG_MODEL_PLACEHOLDER"
  },
  {
    envKey: "AI_API_KEY",
    configKey: "apiKey",
    missingCode: "AI_CONFIG_KEY_MISSING",
    placeholderCode: "AI_CONFIG_KEY_PLACEHOLDER"
  }
];

/** 与 aiEnv.mjs validateAiEnv 相同的占位值判定（大小写不敏感）。 */
const PLACEHOLDER_PATTERN = /^(change-me|replace-me|todo|<.+>)$/i;

export function parseAiRuntimeConfig(
  env: Record<string, string | undefined>
): AiRuntimeConfigResult {
  const diagnostics: string[] = [];
  const values: Partial<Record<keyof AiTransportConfig, string>> = {};

  for (const field of FIELDS) {
    const trimmed = (env[field.envKey] ?? "").trim();
    if (trimmed === "") {
      diagnostics.push(field.missingCode);
      continue;
    }
    if (PLACEHOLDER_PATTERN.test(trimmed)) {
      diagnostics.push(field.placeholderCode);
      continue;
    }
    values[field.configKey] = trimmed;
  }

  // base URL 存在且非占位时再校验协议：必须是合法 http(s) URL。
  const baseUrl = values.baseUrl;
  if (baseUrl !== undefined && !isHttpUrl(baseUrl)) {
    diagnostics.push("AI_CONFIG_BASE_URL_INVALID");
    delete values.baseUrl;
  }

  // Phase 4C：AI_OUTPUT_FORMAT 严格三值（大小写敏感）；缺失/空白默认 prompt_only，
  // 无效值给稳定诊断码（绝不回显），生产最终走 unavailable → fallback。
  const rawFormat = (env.AI_OUTPUT_FORMAT ?? "").trim();
  let outputFormat: AiOutputFormat = "prompt_only";
  if (rawFormat !== "") {
    if ((AI_OUTPUT_FORMATS as readonly string[]).includes(rawFormat)) {
      outputFormat = rawFormat as AiOutputFormat;
    } else {
      diagnostics.push("AI_CONFIG_OUTPUT_FORMAT_INVALID");
    }
  }

  if (diagnostics.length > 0 || values.baseUrl === undefined || values.model === undefined || values.apiKey === undefined) {
    return { status: "unavailable", diagnostics };
  }
  return {
    status: "available",
    config: { baseUrl: values.baseUrl, model: values.model, apiKey: values.apiKey },
    outputFormat
  };
}

/** 合法 http(s) URL 判定：非法值一律不外泄，只映射稳定诊断码。 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
