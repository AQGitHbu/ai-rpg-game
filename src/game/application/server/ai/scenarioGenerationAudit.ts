import type { AiTransportFailureCode, AiUsage } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { ScenarioCandidateFailureCategory } from "../../scenarioGeneration";

// ---------------------------------------------------------------------------
// scenarioGenerationAudit：候选生成的脱敏审计端口（spec §4）。
//
// audit 只接受稳定的诊断字段：traceId / attempt / outcome / category /
// transportCode / latencyMs / usage tokens。默认结构化 logger 只挑选白名单字段
// 序列化输出——即使调用方误塞 prompt、模型原文或密钥也绝不泄漏。成本按本地可
// 配置单价估算；缺单价则 estimatedCostUsd 不出现。
// ---------------------------------------------------------------------------

/** 单次尝试的审计事件；只含稳定诊断字段，绝不含 prompt/响应原文/密钥。 */
export type ScenarioAuditEvent = Readonly<{
  traceId: string;
  attempt: number;
  outcome: "ok" | "failure";
  category?: ScenarioCandidateFailureCategory;
  transportCode?: AiTransportFailureCode;
  latencyMs?: number;
  usage?: AiUsage;
}>;

/** 审计端口：编排层与 source 只通过它上报，不直接写日志。 */
export type ScenarioGenerationAudit = Readonly<{
  record(event: ScenarioAuditEvent): void;
}>;

/** 本地可配置单价（美元/token）；缺项按 0 计，全缺则不估算成本。 */
export type ScenarioAuditPricing = Readonly<{
  promptUsdPerToken?: number;
  completionUsdPerToken?: number;
}>;

export type StructuredScenarioGenerationAuditOptions = Readonly<{
  log?: (line: string) => void;
  logger?: GameLogger;
  pricing?: ScenarioAuditPricing;
}>;

/**
 * 默认结构化审计：只把白名单字段序列化为单行 JSON。
 * 无注入 log 时静默丢弃（record 不抛出），避免污染标准输出。
 */
export function createStructuredScenarioGenerationAudit(
  options: StructuredScenarioGenerationAuditOptions = {}
): ScenarioGenerationAudit {
  const { log, logger, pricing } = options;
  return {
    record(event) {
      const payload = buildPayload(event, pricing);
      if (logger !== undefined) logger.info("scenario_generation", payload);
      else if (log !== undefined) log(JSON.stringify(payload));
    }
  };
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/** 只挑选允许字段构造 payload；undefined 字段经 JSON.stringify 自动省略。 */
function buildPayload(
  event: ScenarioAuditEvent,
  pricing: ScenarioAuditPricing | undefined
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    traceId: event.traceId,
    attempt: event.attempt,
    outcome: event.outcome
  };
  if (event.category !== undefined) payload.category = event.category;
  if (event.transportCode !== undefined) payload.transportCode = event.transportCode;
  if (event.latencyMs !== undefined) payload.latencyMs = event.latencyMs;
  if (event.usage?.promptTokens !== undefined) payload.promptTokens = event.usage.promptTokens;
  if (event.usage?.completionTokens !== undefined) {
    payload.completionTokens = event.usage.completionTokens;
  }
  if (event.usage?.totalTokens !== undefined) payload.totalTokens = event.usage.totalTokens;

  const cost = estimateCostUsd(event.usage, pricing);
  if (cost !== undefined) payload.estimatedCostUsd = cost;
  return payload;
}

/** 估算成本：仅当提供单价且有 usage 时计算，缺项单价按 0 计。 */
function estimateCostUsd(
  usage: AiUsage | undefined,
  pricing: ScenarioAuditPricing | undefined
): number | undefined {
  if (pricing === undefined || usage === undefined) return undefined;
  const promptPrice = pricing.promptUsdPerToken ?? 0;
  const completionPrice = pricing.completionUsdPerToken ?? 0;
  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  return promptTokens * promptPrice + completionTokens * completionPrice;
}
