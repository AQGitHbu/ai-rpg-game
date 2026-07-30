import { createOpenAiCompatibleTransport, type AiTransport } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { TownPlanCandidateSource } from "../../townPlanGeneration";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";
import {
  createLiveTownPlanSource,
  createUnavailableTownPlanSource
} from "./liveTownPlanSource";

// ---------------------------------------------------------------------------
// townPlanSourceFactory：按 AI 运行时配置装配小镇规划来源。
// - 配置有效 ⇒ live source（prompt-only JSON + 脱敏审计）；
// - 配置无效 ⇒ unavailable source（稳定 AI_CONFIG_* 诊断，pending 耗尽后
//   由 generatePendingTownPlan 降级 baseline）。
// 本工厂不读 process.env，也绝不按环境变量切入 fixture source。
// ---------------------------------------------------------------------------

/** 测试注入点：只允许替换 transport 创建（保持生产装配唯一）。 */
export type TownPlanSourceFactoryOptions = Readonly<{
  transportFactory?: () => AiTransport;
  logger?: GameLogger;
}>;

/** 依 AI 运行时配置装配来源；env 由 composition root 注入。 */
export function createTownPlanSource(
  env: Record<string, string | undefined>,
  options: TownPlanSourceFactoryOptions = {}
): TownPlanCandidateSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "unavailable") {
    return createUnavailableTownPlanSource(runtime.diagnostics);
  }
  return createLiveTownPlanSource({
    transport: (options.transportFactory ?? createOpenAiCompatibleTransport)(),
    config: runtime.config,
    logger: options.logger
  });
}
