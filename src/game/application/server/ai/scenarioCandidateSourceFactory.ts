import { createOpenAiCompatibleTransport, type AiTransport } from "@ai-game/ai-transport";
import { createBudgetPolicy } from "@/game/domain";
import { loadScenarioProfiles } from "@/game/gameplay/rpg/scenario";
import type { GameLogger } from "@/game/logging";
import type { ScenarioCandidateSource } from "../../scenarioGeneration";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";
import {
  createLiveScenarioCandidateSource,
  createUnavailableScenarioCandidateSource
} from "./liveScenarioCandidateSource";
import { buildScenarioPromptMessages } from "./scenarioPrompt";
import { createStructuredScenarioGenerationAudit } from "./scenarioGenerationAudit";
import { buildScenarioResponseFormatExtraBody } from "./scenarioResponseFormat";

// ---------------------------------------------------------------------------
// scenarioCandidateSourceFactory：把 @ai-game/ai-transport 的接入收敛在
// application/server/ai 内（spec §4，边界守卫要求只有本目录可 import 该包）。
//
// composition root 只传入已解析的 env 记录，本工厂据此装配：
// - 配置有效 ⇒ live source（共享 transport + 私有 prompt + 脱敏 audit）；
// - 配置无效 ⇒ unavailable source，携带稳定 AI_CONFIG_* 诊断（玩家走 fallback）。
// 本工厂不读 process.env，也绝不按环境变量切入 fixture source。
// Phase 4C：额外按 AI_OUTPUT_FORMAT 解析出的 outputFormat 装配 response_format
// extraBody（prompt_only ⇒ undefined，请求形状与 Phase 4B 完全一致）。
// ---------------------------------------------------------------------------

/** 测试注入点：只允许替换 transport 创建（保持生产装配唯一）。 */
export type ScenarioCandidateSourceFactoryOptions = Readonly<{
  transportFactory?: () => AiTransport;
  logger?: GameLogger;
}>;

/** 依 AI 运行时配置装配候选来源；env 由 composition root 注入，本工厂不读 process.env。 */
export function createScenarioCandidateSource(
  env: Record<string, string | undefined>,
  options: ScenarioCandidateSourceFactoryOptions = {}
): ScenarioCandidateSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "unavailable") {
    return createUnavailableScenarioCandidateSource(runtime.diagnostics);
  }
  const profiles = loadScenarioProfiles();
  return createLiveScenarioCandidateSource({
    transport: (options.transportFactory ?? createOpenAiCompatibleTransport)(),
    config: runtime.config,
    buildMessages: (request) => buildScenarioPromptMessages(request, profiles),
    // 默认结构化审计：只输出脱敏白名单字段，绝不落 prompt/响应原文/密钥。
    audit: createStructuredScenarioGenerationAudit({ logger: options.logger }),
    // Phase 4C：按显式输出格式构建 response_format；prompt_only ⇒ undefined。
    // Task 9 将改为按请求的 gameLength 动态构建。
    extraBody: buildScenarioResponseFormatExtraBody(runtime.outputFormat, createBudgetPolicy("open"))
  });
}
