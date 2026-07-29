import { createOpenAiCompatibleTransport } from "@ai-game/ai-transport";
import { loadScenarioProfiles } from "@/game/gameplay/rpg/scenario";
import type { ScenarioCandidateSource } from "../../scenarioGeneration";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";
import {
  createLiveScenarioCandidateSource,
  createUnavailableScenarioCandidateSource
} from "./liveScenarioCandidateSource";
import { buildScenarioPromptMessages } from "./scenarioPrompt";
import { createStructuredScenarioGenerationAudit } from "./scenarioGenerationAudit";

// ---------------------------------------------------------------------------
// scenarioCandidateSourceFactory：把 @ai-game/ai-transport 的接入收敛在
// application/server/ai 内（spec §4，边界守卫要求只有本目录可 import 该包）。
//
// composition root 只传入已解析的 env 记录，本工厂据此装配：
// - 配置有效 ⇒ live source（共享 transport + 私有 prompt + 脱敏 audit）；
// - 配置无效 ⇒ unavailable source，携带稳定 AI_CONFIG_* 诊断（玩家走 fallback）。
// 本工厂不读 process.env，也绝不按环境变量切入 fixture source。
// ---------------------------------------------------------------------------

/** 依 AI 运行时配置装配候选来源；env 由 composition root 注入，本工厂不读 process.env。 */
export function createScenarioCandidateSource(
  env: Record<string, string | undefined>
): ScenarioCandidateSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "unavailable") {
    return createUnavailableScenarioCandidateSource(runtime.diagnostics);
  }
  const profiles = loadScenarioProfiles();
  return createLiveScenarioCandidateSource({
    transport: createOpenAiCompatibleTransport(),
    config: runtime.config,
    buildMessages: (request) => buildScenarioPromptMessages(request, profiles),
    // 默认结构化审计：只输出脱敏白名单字段，绝不落 prompt/响应原文/密钥。
    audit: createStructuredScenarioGenerationAudit({ log: (line) => console.log(line) })
  });
}
