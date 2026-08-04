import { createOpenAiCompatibleTransport } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";
import { createLiveRuntimeNarrativeSources } from "./liveRuntimeNarrativeSources";
import type { StoryEvalSink } from "../../storyEvalCaptureTypes";
import { NARRATIVE_CONTRACT_VERSION, type DirectorSource, type NpcLineSource, type SceneScriptSource } from "../../runtimeNarrative";
import { resolveAiThinkingRoles } from "./aiThinking";

function resolveStoryEvalTimeoutMs(env: Record<string, string | undefined>): number | undefined {
  if (env.STORY_EVAL_CAPTURE !== "1") return undefined;
  const value = Number(env.STORY_EVAL_AI_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 1_000 && value <= 300_000 ? value : undefined;
}

export function createRuntimeNarrativeSources(env: Record<string, string | undefined>, options: Readonly<{ logger?: GameLogger; captureSink?: StoryEvalSink }> = {}): Readonly<{ directorSource: DirectorSource; sceneScriptSource: SceneScriptSource; npcLineSource: NpcLineSource }> {
  const runtime = parseAiRuntimeConfig(env);
  // Runtime narrative deliberately stays prompt-only. Some compatible providers
  // implement response_format through guided grammar and reject it server-side.
  if (runtime.status === "available") return createLiveRuntimeNarrativeSources({ transport: createOpenAiCompatibleTransport(), config: runtime.config, logger: options.logger, captureSink: options.captureSink, timeoutMs: resolveStoryEvalTimeoutMs(env), thinkingRoles: resolveAiThinkingRoles(env).filter((role) => role !== "scenario") });
  const unavailable = () => ({ async generate(request: { traceId: string }) { return { ok: false as const, provenance: "unavailable" as const, category: "service_error" as const, diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "failed" as const, category: "service_error" as const } }; } });
  return { directorSource: unavailable(), sceneScriptSource: unavailable(), npcLineSource: unavailable() };
}
