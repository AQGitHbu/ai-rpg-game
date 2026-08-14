import { createOpenAiCompatibleTransport, type AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import { parseAiRuntimeConfig, type AiOutputFormat } from "./aiRuntimeConfig";
import type { ProviderJsonMode } from "./providerRequestOptions";
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
): OpeningGenerationSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "available") {
    logger?.info("opening_source_live", { model: runtime.config.model });
    // live 源带机械修复 + 校验 + 确定性 fallback 编排。
    return createValidatedOpeningGenerationSource({
      transport: createOpenAiCompatibleTransport(),
      config: runtime.config,
      jsonMode: providerJsonModeFor(runtime.outputFormat),
      logger,
      onResult,
    });
  }
  logger?.info("opening_source_fixture", { diagnostics: runtime.diagnostics });
  return createValidatedOpeningGenerationSource({ onResult });
}

export function createSceneSource(
  env: Record<string, string | undefined> = process.env,
  logger?: GameLogger,
): SceneSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "available") {
    logger?.info("scene_source_live", { model: runtime.config.model });
    return createLiveScenePerformanceSource({
      transport: createOpenAiCompatibleTransport(),
      config: runtime.config,
      jsonMode: providerJsonModeFor(runtime.outputFormat),
      logger,
    });
  }
  logger?.info("scene_source_deterministic", { diagnostics: runtime.diagnostics });
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
): WorldEvolutionSource {
  const runtime = parseAiRuntimeConfig(env);
  if (runtime.status === "available") {
    logger?.info("world_evolution_source_live", { model: runtime.config.model });
    return createLiveWorldEvolutionSource({
      transport: createOpenAiCompatibleTransport(),
      config: runtime.config,
      jsonMode: providerJsonModeFor(runtime.outputFormat),
      logger,
    });
  }
  logger?.info("world_evolution_source_fixture", { diagnostics: runtime.diagnostics });
  return createDeterministicEvolutionSource();
}
