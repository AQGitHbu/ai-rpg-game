import type { AiMessage, AiTransport, AiTransportConfig, AiTransportFailureCode } from "@ai-game/ai-transport";
import type { ScenarioBlueprintCandidate } from "@/game/domain";
import {
  SCENARIO_CANDIDATE_CONTRACT_VERSION,
  type ScenarioCandidateAttempt,
  type ScenarioCandidateFailureCategory,
  type ScenarioCandidateSource,
  type ScenarioGenerationRequest
} from "../../scenarioGeneration";
import type { ScenarioGenerationAudit } from "./scenarioGenerationAudit";

// ---------------------------------------------------------------------------
// liveScenarioCandidateSource：真实 AI 候选来源（spec §3）。
//
// 注入 shared transport、有效 config、prompt builder 与脱敏 audit：
// - 只接受完整 JSON 或单一 ```json code fence；不用贪婪正则从任意 prose 抽取；
// - 先做与 fixture source 同级的 root-shape 检查，再返回 live attempt；
// - transport 失败映射到既有 11 个 ScenarioCandidateFailureCategory（不新增）；
// - 诊断只含稳定代码，绝不含 prompt、玩家原文、模型原始响应或密钥；
// - 成功/失败都写 audit（脱敏），每次 generate 递增 attempt 序号。
// 本文件不 import repository/persistence（由目录边界守卫保证）。
// ---------------------------------------------------------------------------

export type LiveScenarioCandidateSourceOptions = Readonly<{
  transport: AiTransport;
  config: AiTransportConfig;
  buildMessages: (request: ScenarioGenerationRequest) => readonly AiMessage[];
  audit: ScenarioGenerationAudit;
}>;

const CANDIDATE_ARRAY_FIELDS = [
  "locations",
  "npcs",
  "quests",
  "items",
  "enemies",
  "endings"
] as const;

const CANDIDATE_OBJECT_FIELDS = ["world", "openingScene", "player"] as const;

/** transport 失败码 → 既有失败类别的稳定映射（不新增类别）。 */
const TRANSPORT_CATEGORY: Readonly<Record<AiTransportFailureCode, ScenarioCandidateFailureCategory>> = {
  timeout: "timeout",
  rate_limited: "rate_limited",
  empty_response: "empty_response",
  service_error: "service_error",
  network_error: "service_error",
  http_error: "service_error",
  invalid_response: "service_error",
  aborted: "service_error",
  invalid_config: "service_error"
};

export function createLiveScenarioCandidateSource(
  options: LiveScenarioCandidateSourceOptions
): ScenarioCandidateSource {
  const { transport, config, buildMessages, audit } = options;
  let attempts = 0;

  return {
    async generate(request) {
      attempts += 1;
      const attempt = attempts;
      const messages = buildMessages(request);

      let result;
      try {
        result = await transport.complete(config, messages);
      } catch {
        // transport 意外抛错：不泄漏 message，映射稳定 service_error。
        audit.record({
          traceId: request.traceId,
          attempt,
          outcome: "failure",
          category: "service_error",
          latencyMs: 0
        });
        return liveFailure("service_error", ["LIVE_TRANSPORT_THROW"]);
      }

      if (!result.ok) {
        const category = TRANSPORT_CATEGORY[result.code];
        audit.record({
          traceId: request.traceId,
          attempt,
          outcome: "failure",
          category,
          transportCode: result.code,
          latencyMs: result.latencyMs
        });
        return liveFailure(category, [`LIVE_TRANSPORT_${result.code.toUpperCase()}`]);
      }

      const parsed = parseCandidate(result.content);
      if (!parsed.ok) {
        audit.record({
          traceId: request.traceId,
          attempt,
          outcome: "failure",
          category: parsed.category,
          latencyMs: result.latencyMs,
          usage: result.usage
        });
        return liveFailure(parsed.category, parsed.diagnostics);
      }

      audit.record({
        traceId: request.traceId,
        attempt,
        outcome: "ok",
        latencyMs: result.latencyMs,
        usage: result.usage
      });
      return {
        ok: true,
        contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
        origin: "live",
        candidate: parsed.candidate as unknown as ScenarioBlueprintCandidate,
        diagnostics: []
      };
    }
  };
}

/**
 * 环境不可用时的占位 source：恒失败并携带注入的稳定诊断（AI_CONFIG_*）。
 * 用于生产 composition root 在配置无效时保持 API 契约稳定（fallback）。
 */
export function createUnavailableScenarioCandidateSource(
  diagnostics: readonly string[]
): ScenarioCandidateSource {
  return {
    async generate() {
      return {
        ok: false,
        contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
        origin: "unavailable",
        category: "service_error",
        diagnostics
      };
    }
  };
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

type ParseResult =
  | { ok: true; candidate: Record<string, unknown> }
  | { ok: false; category: ScenarioCandidateFailureCategory; diagnostics: readonly string[] };

/** 只接受完整 JSON 或单一 ```json fence；不从任意 prose 贪婪抽取对象。 */
function parseCandidate(content: string): ParseResult {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { ok: false, category: "empty_response", diagnostics: ["LIVE_EMPTY_RESPONSE"] };
  }

  const jsonText = extractFencedJson(trimmed) ?? trimmed;
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    // 绝不把模型原文放进诊断，仅保留稳定代码。
    return { ok: false, category: "invalid_json", diagnostics: ["LIVE_INVALID_JSON"] };
  }
  if (!hasCandidateShape(payload)) {
    return { ok: false, category: "schema_violation", diagnostics: ["LIVE_SCHEMA_VIOLATION"] };
  }
  return { ok: true, candidate: payload };
}

/** 提取单一 ```json fence 的内容；非 fence 返回 undefined。 */
function extractFencedJson(text: string): string | undefined {
  if (!text.startsWith("```")) return undefined;
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  return match ? match[1] : undefined;
}

function liveFailure(
  category: ScenarioCandidateFailureCategory,
  diagnostics: readonly string[]
): ScenarioCandidateAttempt {
  return {
    ok: false,
    contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
    origin: "live",
    category,
    diagnostics
  };
}

/** 结构存在性检查：根 object、六个数组字段、三个 object 字段（与 fixture 同级）。 */
function hasCandidateShape(candidate: unknown): candidate is Record<string, unknown> {
  if (!isRecord(candidate)) return false;
  for (const field of CANDIDATE_ARRAY_FIELDS) {
    if (!Array.isArray(candidate[field])) return false;
  }
  for (const field of CANDIDATE_OBJECT_FIELDS) {
    if (!isRecord(candidate[field])) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
