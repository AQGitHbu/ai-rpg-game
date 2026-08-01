import { createOpenAiCompatibleTransport } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";
import { createLiveRuntimeNarrativeSources } from "./liveRuntimeNarrativeSources";
import type { StoryEvalSink } from "./storyEvalCapture";
import { NARRATIVE_CONTRACT_VERSION, type DirectorSource, type NpcLineSource, type SceneScriptSource } from "../../runtimeNarrative";

export function createRuntimeNarrativeSources(env: Record<string, string | undefined>, options: Readonly<{ logger?: GameLogger; captureSink?: StoryEvalSink }> = {}): Readonly<{ directorSource: DirectorSource; sceneScriptSource: SceneScriptSource; npcLineSource: NpcLineSource }> {
  const runtime = parseAiRuntimeConfig(env);
  // Runtime narrative deliberately stays prompt-only. Some compatible providers
  // implement response_format through guided grammar and reject it server-side.
  if (runtime.status === "available") return createLiveRuntimeNarrativeSources({ transport: createOpenAiCompatibleTransport(), config: runtime.config, logger: options.logger, captureSink: options.captureSink });
  const unavailable = () => ({ async generate(request: { traceId: string }) { return { ok: false as const, provenance: "unavailable" as const, category: "service_error" as const, diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "failed" as const, category: "service_error" as const } }; } });
  return { directorSource: unavailable(), sceneScriptSource: unavailable(), npcLineSource: unavailable() };
}
