import type { GameLogger } from "@/game/logging";
import { parseAiRuntimeConfig, type AiOutputFormat } from "./aiRuntimeConfig";
import type { ProviderJsonMode } from "./providerRequestOptions";
import { createServerRpgAiClient, type RpgAiClient } from "./rpgAiClient";
import type { OpeningGenerationSource } from "../../createGame";
import type { SceneSource } from "../../sceneSource";
import {
  createOpeningGenerationSource as createValidatedOpeningGenerationSource,
  type OpeningGenerationResultMarker,
} from "./openingGenerationSource";
import { createDeterministicSceneSource } from "../../deterministicSceneSource";
import { createLiveWorldEvolutionSource } from "./liveWorldEvolutionSource";
import { createDeterministicEvolutionSource } from "../../deterministicEvolutionSource";
import type { WorldEvolutionSource } from "../../worldEvolutionSource";
import { createLiveScenePerformanceSource } from "./liveScenePerformanceSource";

// ---------------------------------------------------------------------------
// AI source 工厂：根据运行时配置注入 live 或 fixture/deterministic source。
// live source 共用 composition root 创建的 RpgAiClient，不各自创建 transport。
// Task 6：场景源已迁移到场景表演契约（liveScenePerformanceSource）。
// ---------------------------------------------------------------------------

export { resolveLiveNpcLine, resolvePerformanceChoices } from "./liveScenePerformanceSource";
export type { LiveNpcLineCandidate } from "./liveScenePerformanceSource";

function providerJsonModeFor(format: AiOutputFormat): ProviderJsonMode {
  return format === "json_object" ? "json_object" : "prompt_only";
}

// --- Factory ---

export function createOpeningGenerationSource(
  env: Record<string, string | undefined> = process.env,
  logger?: GameLogger,
  onResult?: (result: OpeningGenerationResultMarker) => void,
  aiClient?: RpgAiClient,
): OpeningGenerationSource {
  const runtime = parseAiRuntimeConfig(env);
  const client = aiClient ?? createServerRpgAiClient(env, logger);
  if (runtime.status === "available" && client !== undefined) {
    logger?.info("opening_source_live", { model: runtime.config.model });
    // live 源带机械修复 + 校验 + 确定性 fallback 编排。
    return createValidatedOpeningGenerationSource({
      aiClient: client,
      jsonMode: providerJsonModeFor(runtime.outputFormat),
      logger,
      allowFallback: false,
      onResult,
    });
  }
  logger?.info("opening_source_fixture", {
    diagnostics: runtime.status === "available" ? ["AI_CLIENT_UNAVAILABLE"] : runtime.diagnostics,
  });
  return createValidatedOpeningGenerationSource({ onResult });
}

export function createSceneSource(
  env: Record<string, string | undefined> = process.env,
  logger?: GameLogger,
  aiClient?: RpgAiClient,
): SceneSource {
  const runtime = parseAiRuntimeConfig(env);
  const client = aiClient ?? createServerRpgAiClient(env, logger);
  if (runtime.status === "available" && client !== undefined) {
    logger?.info("scene_source_live", { model: runtime.config.model });
    return createLiveScenePerformanceSource({
      aiClient: client,
      jsonMode: providerJsonModeFor(runtime.outputFormat),
      logger,
      // API 优先；provider 短暂不可用时仍允许同一审批链的确定性恢复，
      // 避免玩家被永久锁在 pending。成功的 live proposal 仍保持 generated。
      allowFallback: true,
    });
  }
  logger?.info("scene_source_deterministic", {
    diagnostics: runtime.status === "available" ? ["AI_CLIENT_UNAVAILABLE"] : runtime.diagnostics,
  });
  return createDeterministicSceneSource();
}

// --- World Evolution Source Factory（Task 3） ---

/**
 * Task 3：按 AI 运行时配置选择 live / deterministic WorldEvolutionSource。
 * - AI 可用 → live 源（AI 提案 → 纯解析/校验/引用过滤，失败回退确定性源）。
 * - 无配置 → 确定性源（always materializes a completable next act）。
 * 生产唯一注入点：compositionRoot。
 */
export function createWorldEvolutionSource(
  env: Record<string, string | undefined> = process.env,
  logger?: GameLogger,
  aiClient?: RpgAiClient,
): WorldEvolutionSource {
  const runtime = parseAiRuntimeConfig(env);
  const client = aiClient ?? createServerRpgAiClient(env, logger);
  if (runtime.status === "available" && client !== undefined) {
    logger?.info("world_evolution_source_live", { model: runtime.config.model });
    return createLiveWorldEvolutionSource({
      aiClient: client,
      jsonMode: providerJsonModeFor(runtime.outputFormat),
      logger,
      allowFallback: false,
    });
  }
  logger?.info("world_evolution_source_fixture", {
    diagnostics: runtime.status === "available" ? ["AI_CLIENT_UNAVAILABLE"] : runtime.diagnostics,
  });
  return createDeterministicEvolutionSource();
}
