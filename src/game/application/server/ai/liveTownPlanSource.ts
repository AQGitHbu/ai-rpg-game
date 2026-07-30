import type { AiTransport, AiTransportConfig, AiTransportFailureCode } from "@ai-game/ai-transport";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";
import {
  TOWN_PLAN_CONTRACT_VERSION,
  type TownPlanAttempt,
  type TownPlanCandidateSource,
  type TownPlanFailureCategory,
  type TownPlanRequest
} from "../../townPlanGeneration";
import { buildTownPlanPromptMessages } from "./townPlanPrompt";

// ---------------------------------------------------------------------------
// Town 层：live town plan source——@ai-game/ai-transport 的接入收敛在本目录。
// prompt-only JSON（与 runtime narrative 一致：部分兼容 provider 以 guided
// grammar 实现 response_format 并在服务端拒绝）。候选只做本地 JSON 解析，
// 语义校验与编译验证全部留给 gameplay 的 validateTownPlanCandidate。
// ---------------------------------------------------------------------------

const FAILURE_CATEGORY: Record<AiTransportFailureCode, TownPlanFailureCategory> = {
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

/** 配置无效时的稳定替身：永远失败，携带 AI_CONFIG_* 诊断（玩家走 fallback）。 */
export function createUnavailableTownPlanSource(
  diagnostics: readonly string[]
): TownPlanCandidateSource {
  return {
    async generate(): Promise<TownPlanAttempt> {
      return {
        ok: false,
        contractVersion: TOWN_PLAN_CONTRACT_VERSION,
        origin: "unavailable",
        category: "service_error",
        diagnostics
      };
    }
  };
}

export type LiveTownPlanSourceInput = Readonly<{
  transport: AiTransport;
  config: AiTransportConfig;
  /** 脱敏审计出口：由 composition root 注入；测试可收集结构化 entry。 */
  logger?: GameLogger;
}>;

/** 真实 provider 来源：一次请求 = 一次 attempt，失败映射稳定类别。 */
export function createLiveTownPlanSource(input: LiveTownPlanSourceInput): TownPlanCandidateSource {
  const logger = input.logger ?? NOOP_GAME_LOGGER;
  return {
    async generate(request: TownPlanRequest): Promise<TownPlanAttempt> {
      const startedAt = Date.now();
      let completed;
      try {
        // 与 runtime narrative 相同的 provider 约定：关闭扩展思考，低温采样。
        completed = await input.transport.complete(input.config, buildTownPlanPromptMessages(request), {
          extraBody: { enable_thinking: false },
          temperature: 0.2,
          timeoutMs: 120_000
        });
      } catch {
        audit(logger, false, "service_error", Date.now() - startedAt);
        return failure("service_error");
      }
      if (!completed.ok) {
        const category = FAILURE_CATEGORY[completed.code];
        audit(logger, false, category, completed.latencyMs);
        return failure(category);
      }
      const candidate = parseObject(completed.content);
      if (candidate === null) {
        const category = completed.content.trim() === "" ? "empty_response" : "invalid_json";
        audit(logger, false, category, completed.latencyMs);
        return failure(category);
      }
      audit(logger, true, undefined, completed.latencyMs);
      return {
        ok: true,
        contractVersion: TOWN_PLAN_CONTRACT_VERSION,
        origin: "live",
        candidate,
        diagnostics: []
      };
    }
  };
}

function failure(category: TownPlanFailureCategory): TownPlanAttempt {
  return {
    ok: false,
    contractVersion: TOWN_PLAN_CONTRACT_VERSION,
    origin: "live",
    category,
    diagnostics: []
  };
}

/** 白名单遥测：绝不含 prompt、模型输出、model、URL 或密钥。 */
function audit(
  logger: GameLogger,
  generated: boolean,
  category: TownPlanFailureCategory | undefined,
  latencyMs: number
): void {
  logger.info("town_plan", {
    generated,
    ...(category === undefined ? {} : { category }),
    latencyMs
  });
}

/** 本地解析：容忍 ```json 围栏；解析失败只映射稳定类别，绝不外泄模型文本。 */
function parseObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\s*```$/i.exec(trimmed)?.[1];
  const candidates = [trimmed, fenced].filter((value): value is string => value !== undefined);
  for (const text of candidates) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* invalid_json 由调用侧记类别 */ }
  }
  return null;
}
