import type { GameLogger } from "@/game/logging";
import { parseAiRuntimeConfig, type AiOutputFormat } from "./aiRuntimeConfig";
import type { ProviderJsonMode } from "./providerRequestOptions";
import { createServerRpgAiClient, type RpgAiClient } from "./rpgAiClient";
import type { OpeningGenerationSource } from "../../createGame";
import type { SceneSource, SceneSourceResult } from "../../sceneSource";
import {
  createOpeningGenerationSource as createValidatedOpeningGenerationSource,
} from "./openingGenerationSource";
import { createLiveWorldEvolutionSource } from "./liveWorldEvolutionSource";
import type { WorldEvolutionSource, WorldEvolutionSourceResult } from "../../worldEvolutionSource";
import { createLiveScenePerformanceSource } from "./liveScenePerformanceSource";
import { classifyAiFailure } from "../../aiGenerationFailure";
import type { AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";

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
  aiClient?: RpgAiClient,
): OpeningGenerationSource {
  const runtime = parseAiRuntimeConfig(env);
  const client = aiClient ?? createServerRpgAiClient(env, logger);
  if (runtime.status === "available" && client !== undefined) {
    logger?.info("opening_source_live", { model: runtime.config.model });
    return createValidatedOpeningGenerationSource({
      aiClient: client,
      jsonMode: providerJsonModeFor(runtime.outputFormat),
      logger,
    });
  }
  logger?.info("opening_source_unavailable", {
    diagnostics: runtime.status === "available" ? ["AI_CLIENT_UNAVAILABLE"] : runtime.diagnostics,
  });
  // AI 配置不可用时返回不可用源，失败时抛出 AiGenerationError
  return createValidatedOpeningGenerationSource({ logger });
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
    });
  }
  logger?.info("scene_source_unavailable", {
    diagnostics: runtime.status === "available" ? ["AI_CLIENT_UNAVAILABLE"] : runtime.diagnostics,
  });
  // AI 配置不可用时返回 unavailable source，只返回 typed failure
  return createUnavailableSceneSource();
}

// --- World Evolution Source Factory（Task 3） ---

/**
 * 按 AI 运行时配置选择 live / unavailable WorldEvolutionSource。
 * - AI 可用 → live 源（AI 提案 → 纯解析/校验/引用过滤，失败返回 typed failure）。
 * - 无配置 → unavailable 源（只返回 typed failure，不调用 deterministic source）。
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
    });
  }
  logger?.info("world_evolution_source_unavailable", {
    diagnostics: runtime.status === "available" ? ["AI_CLIENT_UNAVAILABLE"] : runtime.diagnostics,
  });
  return createUnavailableWorldEvolutionSource();
}

/** AI 配置不可用时的场景源：只返回 typed failure，不调用 deterministic source。 */
function createUnavailableSceneSource(): SceneSource {
  return {
    async generateScene(): Promise<SceneSourceResult> {
      const failure: AiGenerationFailure = classifyAiFailure({ phase: "scene", category: "unavailable" });
      return { ok: false, failure };
    },
  };
}

/** AI 配置不可用时的世界演化源：只返回 typed failure，不调用 deterministic source。 */
function createUnavailableWorldEvolutionSource(): WorldEvolutionSource {
  return {
    async propose(): Promise<WorldEvolutionSourceResult> {
      const failure: AiGenerationFailure = classifyAiFailure({ phase: "world", category: "unavailable" });
      return { ok: false, failure };
    },
  };
}
