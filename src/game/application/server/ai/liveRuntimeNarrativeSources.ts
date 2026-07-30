import type { AiMessage, AiTransport, AiTransportConfig, AiTransportFailureCode } from "@ai-game/ai-transport";
import type { DirectorProposal, NpcPerformanceProposal, SceneScriptProposal } from "@/game/gameplay/rpg/narrative";
import { NARRATIVE_CONTRACT_VERSION, type DirectorAttempt, type DirectorRequest, type DirectorSource, type NarrativeFailureCategory, type NpcLineAttempt, type NpcLineRequest, type NpcLineSource, type SceneScriptAttempt, type SceneScriptRequest, type SceneScriptSource } from "../../runtimeNarrative";

type Role = "director" | "writer" | "npc";
type Request = DirectorRequest | SceneScriptRequest | NpcLineRequest;
const category: Record<AiTransportFailureCode, NarrativeFailureCategory> = { timeout: "timeout", rate_limited: "rate_limited", empty_response: "empty_response", service_error: "service_error", network_error: "service_error", http_error: "service_error", invalid_response: "service_error", aborted: "service_error", invalid_config: "service_error" };

/** Three separate sources and requests; each builder receives only its already-projected context. */
export function createLiveRuntimeNarrativeSources(input: Readonly<{ transport: AiTransport; config: AiTransportConfig; responseFormat?: (role: Role) => Readonly<Record<string, unknown>> | undefined }>): Readonly<{ directorSource: DirectorSource; sceneScriptSource: SceneScriptSource; npcLineSource: NpcLineSource }> {
  return {
    directorSource: { generate: async (request) => run<DirectorProposal, DirectorAttempt>("director", request, input, "plan") },
    sceneScriptSource: { generate: async (request) => run<SceneScriptProposal, SceneScriptAttempt>("writer", request, input, "script") },
    npcLineSource: { generate: async (request) => run<NpcPerformanceProposal, NpcLineAttempt>("npc", request, input, "performance") },
  };
}

async function run<T extends object, A>(role: Role, request: Request, input: { transport: AiTransport; config: AiTransportConfig; responseFormat?: (role: Role) => Readonly<Record<string, unknown>> | undefined }, field: "plan" | "script" | "performance"): Promise<A> {
  const startedAt = Date.now();
  let completed;
  // Match the project's SLG consumer contract: prompt-directed JSON plus local
  // parsing/approval, with the provider-neutral reasoning switch disabled.
  try { completed = await input.transport.complete(input.config, messages(role, request), { extraBody: { reasoning_effort: "none", ...input.responseFormat?.(role) }, temperature: 0.2 }); } catch { audit(role, false, "service_error", Date.now() - startedAt); return failure(request, "service_error") as A; }
  if (!completed.ok) { audit(role, false, category[completed.code], completed.latencyMs); return failure(request, category[completed.code]) as A; }
  const payload = parseObject(completed.content);
  if (payload === null) { const failureCategory = completed.content.trim() === "" ? "empty_response" : "invalid_json"; audit(role, false, failureCategory, completed.latencyMs); return failure(request, failureCategory) as A; }
  audit(role, true, undefined, completed.latencyMs);
  return { ok: true, provenance: "generated", [field]: payload as T, diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" } } as A;
}

/** Whitelisted server telemetry: never includes prompt, output, model, URL, player text or credentials. */
function audit(role: Role, generated: boolean, failureCategory: NarrativeFailureCategory | undefined, latencyMs: number): void {
  console.log(JSON.stringify({ event: "runtime_narrative", role, generated, ...(failureCategory === undefined ? {} : { category: failureCategory }), latencyMs }));
}

function failure(request: Request, failureCategory: NarrativeFailureCategory) {
  return { ok: false, provenance: "generated", category: failureCategory, diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "failed", category: failureCategory } };
}

function messages(role: Role, request: Request): readonly AiMessage[] {
  const instruction = role === "director"
    ? "You are the world director. Return one JSON object only, with exactly sceneGoal, tensionLevel (1-5), focusNpcId (string|null), relevantFactIds (string[]), allowedRevealFactIds (string[]), suggestedActionKeys ([string,string]), introducedEntities ({kind,id}[]), pacing (setup|develop|turn|climax|resolution). Copy suggestedActionKeys exactly from actionCandidates, use two different keys. focusNpcId must be null or copied exactly from npcIdsPresent. Every fact ID must be copied from discoveredFactIds; if none are listed, both fact arrays must be []. introducedEntities must be []. Never invent an ID, location, NPC, fact, action, or entity."
    : role === "writer"
      ? "You are the scene writer. Return one JSON object only, with exactly narration, usedFactIds, npcInstruction (or null), choices. npcInstruction has npcId, speechAct, emotion, allowedFactIds, mayLie. choices is exactly two objects with actionKey, label, strategy. Copy both choice actionKey values exactly from plan.suggestedActionKeys. Copy usedFactIds only from allowedFactCards. If npcProfile is null, npcInstruction must be null; otherwise use that exact NPC id and only its supplied fact cards. Never invent an ID."
      : "You are one NPC performer. Return one JSON object only, with exactly text, usedFactIds, emotion. You may use only the supplied NPC profile and fact cards; never infer hidden facts.";
  return [{ role: "system", content: `${instruction} Contract: ${NARRATIVE_CONTRACT_VERSION}.` }, { role: "user", content: JSON.stringify(request.context) }];
}

function parseObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\s*```$/i.exec(trimmed)?.[1];
  const candidates = [trimmed, fenced].filter((value): value is string => value !== undefined);
  for (const text of candidates) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* local approval reports stable invalid_json; never expose model text */ }
  }
  return null;
}
