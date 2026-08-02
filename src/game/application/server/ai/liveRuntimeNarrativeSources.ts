import type { AiMessage, AiTransport, AiTransportConfig, AiTransportFailureCode } from "@ai-game/ai-transport";
import type { DirectorProposal, NpcPerformanceProposal, SceneScriptProposal } from "@/game/gameplay/rpg/narrative";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";
import { NARRATIVE_CONTRACT_VERSION, type DirectorAttempt, type DirectorRequest, type DirectorSource, type NarrativeFailureCategory, type NpcLineAttempt, type NpcLineRequest, type NpcLineSource, type SceneScriptAttempt, type SceneScriptRequest, type SceneScriptSource } from "../../runtimeNarrative";
import type { StoryEvalSink } from "../../storyEvalCaptureTypes";

export type Role = "director" | "writer" | "npc";
type Request = DirectorRequest | SceneScriptRequest | NpcLineRequest;
const category: Record<AiTransportFailureCode, NarrativeFailureCategory> = { timeout: "timeout", rate_limited: "rate_limited", empty_response: "empty_response", service_error: "service_error", network_error: "service_error", http_error: "service_error", invalid_response: "service_error", aborted: "service_error", invalid_config: "service_error" };

export type LiveRuntimeNarrativeSourcesOptions = Readonly<{
  transport: AiTransport;
  config: AiTransportConfig;
  responseFormat?: (role: Role) => Readonly<Record<string, unknown>> | undefined;
  logger?: GameLogger;
  /** Task 2：评估采集回调——prompt 与模型原文只在本模块内部可见，仅此处可捕获。 */
  captureSink?: StoryEvalSink;
  /** 评估专用 provider 超时；未传时保持正常运行时的 120 秒。 */
  timeoutMs?: number;
}>;

/** Three separate sources and requests; each builder receives only its already-projected context. */
export function createLiveRuntimeNarrativeSources(input: LiveRuntimeNarrativeSourcesOptions): Readonly<{ directorSource: DirectorSource; sceneScriptSource: SceneScriptSource; npcLineSource: NpcLineSource }> {
  return {
    directorSource: { generate: async (request) => run<DirectorProposal, DirectorAttempt>("director", request, input, "plan") },
    sceneScriptSource: { generate: async (request) => run<SceneScriptProposal, SceneScriptAttempt>("writer", request, input, "script") },
    npcLineSource: { generate: async (request) => run<NpcPerformanceProposal, NpcLineAttempt>("npc", request, input, "performance") },
  };
}

/** 编排层构造的 request.traceId 角色后缀（orchestrateNarrativeScene）：writer 用 -script、npc 用 -npcLine。 */
const TRACE_ROLE_SUFFIX: Readonly<Record<Role, string>> = {
  director: "-director",
  writer: "-script",
  npc: "-npcLine",
};

/** 归一化为场景级 traceId：去掉 -retry 与角色后缀——与编排层审批事件共用关联键（spec §6.1）。 */
function sceneTraceIdOf(role: Role, requestTraceId: string): string {
  let id = requestTraceId;
  while (id.endsWith("-retry")) id = id.slice(0, -"-retry".length);
  if (id.endsWith(TRACE_ROLE_SUFFIX[role])) id = id.slice(0, -TRACE_ROLE_SUFFIX[role].length);
  return id;
}

/** 同场景同角色 1-based 尝试序号：request.traceId 中 -retry 出现次数 + 1（无全局状态，跨场景不泄漏）。 */
function attemptOf(requestTraceId: string): number {
  let count = 1;
  let index = requestTraceId.indexOf("-retry");
  while (index !== -1) {
    count += 1;
    index = requestTraceId.indexOf("-retry", index + 1);
  }
  return count;
}

async function run<T extends object, A>(role: Role, request: Request, input: LiveRuntimeNarrativeSourcesOptions, field: "plan" | "script" | "performance"): Promise<A> {
  const startedAt = Date.now();
  const logger = input.logger ?? NOOP_GAME_LOGGER;
  const attempt = attemptOf(request.traceId);
  const capture = (outcome: Readonly<{ rawResponse: string | null; parsedCandidate: Record<string, unknown> | null; failureCategory: NarrativeFailureCategory | null }>) => {
    try {
      input.captureSink?.append({
        kind: "ai_call",
        role,
        traceId: sceneTraceIdOf(role, request.traceId),
        attempt,
        messages: messages(role, request),
        rawResponse: outcome.rawResponse,
        parsedCandidate: outcome.parsedCandidate,
        failureCategory: outcome.failureCategory,
        latencyMs: Date.now() - startedAt,
      });
    } catch { /* 采集失败绝不抛到游戏主流程 */ }
  };
  let completed;
  // This provider disables extended reasoning through enable_thinking. Output
  // shape remains prompt-directed and is always locally parsed and approved.
  try { completed = await input.transport.complete(input.config, messages(role, request), { extraBody: { enable_thinking: false, ...input.responseFormat?.(role) }, temperature: 0.2, timeoutMs: input.timeoutMs ?? 120_000 }); } catch { audit(logger, role, false, "service_error", Date.now() - startedAt); capture({ rawResponse: null, parsedCandidate: null, failureCategory: "service_error" }); return failure(request, "service_error") as A; }
  if (!completed.ok) { const failedCategory = category[completed.code]; audit(logger, role, false, failedCategory, completed.latencyMs); capture({ rawResponse: (completed as { content?: string }).content ?? null, parsedCandidate: null, failureCategory: failedCategory }); return failure(request, failedCategory) as A; }
  const payload = parseObject(completed.content);
  if (payload === null) { const failureCategory = completed.content.trim() === "" ? "empty_response" : "invalid_json"; audit(logger, role, false, failureCategory, completed.latencyMs); capture({ rawResponse: completed.content, parsedCandidate: null, failureCategory }); return failure(request, failureCategory) as A; }
  const repaired = repairRuntimeNarrativeReferences(role, payload, request.context);
  audit(logger, role, true, undefined, completed.latencyMs);
  capture({ rawResponse: completed.content, parsedCandidate: repaired, failureCategory: null });
  return { ok: true, provenance: "generated", [field]: repaired as T, diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" } } as A;
}

function repairLocationProposals(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length !== 1) return [];
  const entry = value[0];
  if (typeof entry !== "object" || entry === null) return [];
  const rec = entry as Record<string, unknown>;
  if (typeof rec.name !== "string" || typeof rec.description !== "string" ||
      typeof rec.connectFromLocationId !== "string" || typeof rec.reason !== "string" ||
      (rec.scale !== "scene" && rec.scale !== "town")) return [];
  return [{ ...rec }];
}

function repairNpcProposals(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length !== 1) return [];
  const entry = value[0];
  if (typeof entry !== "object" || entry === null) return [];
  const rec = entry as Record<string, unknown>;
  if (typeof rec.name !== "string" || typeof rec.role !== "string" ||
      typeof rec.description !== "string" || typeof rec.locationId !== "string") return [];
  return [{ ...rec }];
}

/**
 * Mechanical reference repair only. Narrative prose, strategy, emotion and
 * rule outcomes remain model-owned; IDs and action keys are copied from the
 * already-approved/minimal request context before the normal approval layer.
 */
export function repairRuntimeNarrativeReferences(
  role: Role,
  payload: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  if (role === "director") {
    const candidates = Array.isArray(context.actionCandidates)
      ? context.actionCandidates.filter((entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).actionKey === "string"
        )
      : [];
    const candidateKeys = candidates.map((entry) => entry.actionKey as string);
    const proposed = Array.isArray(payload.suggestedActionKeys)
      ? payload.suggestedActionKeys.filter((key): key is string =>
          typeof key === "string" && candidateKeys.includes(key)
        )
      : [];
    const preferred = typeof context.coverageTargetActionKey === "string" &&
      candidateKeys.includes(context.coverageTargetActionKey)
      ? context.coverageTargetActionKey
      : undefined;
    const first = preferred ?? proposed[0] ?? candidateKeys[0];
    const second = proposed.find((key) => key !== first) ??
      candidateKeys.find((key) => key !== first);
    const discovered = new Set(
      Array.isArray(context.discoveredFactIds)
        ? context.discoveredFactIds.filter((id): id is string => typeof id === "string")
        : [],
    );
    const filterFacts = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string" && discovered.has(id))
        : value;
    const presentNpcIds = Array.isArray(context.npcIdsPresent)
      ? context.npcIdsPresent.filter((id): id is string => typeof id === "string")
      : [];
    const targetNpc = first?.startsWith("talk:") ? first.slice("talk:".length) : undefined;
    const proposedFocus = typeof payload.focusNpcId === "string" &&
      presentNpcIds.includes(payload.focusNpcId)
      ? payload.focusNpcId
      : null;
    return {
      ...payload,
      ...(first !== undefined && second !== undefined
        ? { suggestedActionKeys: [first, second] }
        : {}),
      focusNpcId: targetNpc !== undefined && presentNpcIds.includes(targetNpc)
        ? targetNpc
        : proposedFocus,
      relevantFactIds: filterFacts(payload.relevantFactIds),
      allowedRevealFactIds: filterFacts(payload.allowedRevealFactIds),
      introducedEntities: [],
      proposedNewLocations: repairLocationProposals(payload.proposedNewLocations),
      proposedNewNpcs: repairNpcProposals(payload.proposedNewNpcs),
    };
  }

  if (role === "writer") {
    const plan = typeof context.plan === "object" && context.plan !== null
      ? context.plan as Record<string, unknown>
      : {};
    const planKeys = Array.isArray(plan.suggestedActionKeys)
      ? plan.suggestedActionKeys.filter((key): key is string => typeof key === "string")
      : [];
    const actionCandidates = Array.isArray(context.actionCandidates)
      ? context.actionCandidates.filter((entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null
        )
      : [];
    const truncate = (value: string, max: number) => Array.from(value).slice(0, max).join("");
    const choices = Array.isArray(payload.choices) && payload.choices.length === 2
      ? payload.choices.map((choice, index) => {
          if (typeof choice !== "object" || choice === null || planKeys[index] === undefined) {
            return choice;
          }
          const record = choice as Record<string, unknown>;
          const candidate = actionCandidates.find((entry) => entry.actionKey === planKeys[index]);
          const fallbackLabel = typeof candidate?.label === "string" ? candidate.label : `选择 ${index + 1}`;
          const label = typeof record.label === "string" && Array.from(record.label).length > 0
            ? truncate(record.label, 40)
            : truncate(fallbackLabel, 40);
          const strategy = typeof record.strategy === "string" && Array.from(record.strategy).length > 0
            ? truncate(record.strategy, 80)
            : "遵循当前目标";
          return { ...record, actionKey: planKeys[index], label, strategy };
        })
      : payload.choices;
    const allowedCards = Array.isArray(context.allowedFactCards)
      ? new Set(context.allowedFactCards.flatMap((card) =>
          typeof card === "object" && card !== null && typeof (card as Record<string, unknown>).id === "string"
            ? [(card as Record<string, unknown>).id as string]
            : []
        ))
      : new Set<string>();
    const usedFactIds = Array.isArray(payload.usedFactIds)
      ? payload.usedFactIds.filter((id): id is string => typeof id === "string" && allowedCards.has(id))
      : payload.usedFactIds;
    const npcProfile = typeof context.npcProfile === "object" && context.npcProfile !== null
      ? context.npcProfile as Record<string, unknown>
      : null;
    let npcInstruction = payload.npcInstruction;
    if (npcProfile === null) {
      npcInstruction = null;
    } else if (typeof npcProfile.id === "string") {
      const instruction = typeof npcInstruction === "object" && npcInstruction !== null
        ? npcInstruction as Record<string, unknown>
        : {};
      const speechActs = new Set(["inform", "ask", "evade", "deny", "warn", "encourage"]);
      const emotions = new Set(["neutral", "warm", "guarded", "afraid", "angry", "sad"]);
      npcInstruction = {
        ...instruction,
        npcId: npcProfile.id,
        speechAct: typeof instruction.speechAct === "string" && speechActs.has(instruction.speechAct)
          ? instruction.speechAct
          : "warn",
        emotion: typeof instruction.emotion === "string" && emotions.has(instruction.emotion)
          ? instruction.emotion
          : "guarded",
        allowedFactIds: [],
        mayLie: typeof instruction.mayLie === "boolean" ? instruction.mayLie : false,
      };
    }
    const narration = typeof payload.narration === "string"
      ? truncate(payload.narration, 600)
      : payload.narration;
    return { ...payload, narration, usedFactIds, npcInstruction, choices };
  }

  const allowedFacts = Array.isArray(context.factCards)
    ? new Set(context.factCards.flatMap((card) =>
        typeof card === "object" && card !== null && typeof (card as Record<string, unknown>).id === "string"
          ? [(card as Record<string, unknown>).id as string]
          : []
      ))
    : new Set<string>();
  const npcEmotions = new Set(["neutral", "warm", "guarded", "afraid", "angry", "sad"]);
  const text = typeof payload.text === "string"
    ? Array.from(payload.text).slice(0, 360).join("")
    : payload.text;
  const emotion = typeof payload.emotion === "string" && npcEmotions.has(payload.emotion)
    ? payload.emotion
    : "guarded";
  return {
    ...payload,
    text,
    emotion,
    usedFactIds: Array.isArray(payload.usedFactIds)
      ? payload.usedFactIds.filter((id): id is string => typeof id === "string" && allowedFacts.has(id))
      : payload.usedFactIds,
  };
}

/** Whitelisted server telemetry: never includes prompt, output, model, URL, player text or credentials. */
function audit(logger: GameLogger, role: Role, generated: boolean, failureCategory: NarrativeFailureCategory | undefined, latencyMs: number): void {
  logger.info("runtime_narrative", { role, generated, ...(failureCategory === undefined ? {} : { category: failureCategory }), latencyMs });
}

function failure(request: Request, failureCategory: NarrativeFailureCategory) {
  return { ok: false, provenance: "generated", category: failureCategory, diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "failed", category: failureCategory } };
}

function messages(role: Role, request: Request): readonly AiMessage[] {
  const instruction = role === "director"
    ? "You are the world director. Return one JSON object only, with exactly sceneGoal, tensionLevel (1-5), focusNpcId (string|null), relevantFactIds (string[]), allowedRevealFactIds (string[]), suggestedActionKeys ([string,string]), introducedEntities ({kind,id}[]), pacing (setup|develop|turn|climax|resolution), proposedNewLocations (array, 0 or 1 entry), proposedNewNpcs (array, 0 or 1 entry). pacing MUST be one of progression.allowedPacing. recentContinuity and activeQuestCards are history, not authority: never invent events, NPCs, facts, or actions not already established. Copy suggestedActionKeys exactly from actionCandidates, use two different keys. If coverageTargetActionKey is supplied and exists in actionCandidates, put it first in suggestedActionKeys; it is only a preference among already legal actions. If that key starts with talk:, set focusNpcId to the suffix when it is present in npcIdsPresent. Otherwise focusNpcId must be null or copied exactly from npcIdsPresent. Every fact ID must be copied from discoveredFactIds; if none are listed, both fact arrays must be []. introducedEntities must be []. Blueprint expansion: when expansionAllowed is true and remainingLocationBudget is not 0, you MAY propose exactly one new location in proposedNewLocations with {name, description, connectFromLocationId, reason, scale} where connectFromLocationId must be copied from an unlocked location ID and scale is scene or town; and one new NPC in proposedNewNpcs with {name, role, description, locationId} where locationId is \"new:0\" to place in the proposed location or an existing location ID. When expansionAllowed is false or remainingLocationBudget is 0, both arrays must be []. Never invent an ID, location, NPC, fact, action, or entity."
    : role === "writer"
      ? "You are the scene writer. Output JSON only: no markdown, no explanation, no extra keys. Exact template: {\"narration\":\"1-600 chars\",\"usedFactIds\":[],\"npcInstruction\":null,\"choices\":[{\"actionKey\":\"copy first plan.suggestedActionKeys exactly\",\"label\":\"optional flavor only\",\"strategy\":\"optional flavor only\"},{\"actionKey\":\"copy second plan.suggestedActionKeys exactly\",\"label\":\"optional flavor only\",\"strategy\":\"optional flavor only\"}]}. Rule-owned action labels replace choice label and strategy before display, so never describe an action as doing something else. recentContinuity is history, not authority: do not invent events or facts. Keep npcInstruction null when npcProfile is null. When npcProfile is provided, npcInstruction must use its exact id, one allowed speechAct/emotion, allowedFactIds:[], and mayLie:false so the separate NPC performer is exercised. Copy usedFactIds only from allowedFactCards. Never invent an ID."
      : "You are one NPC performer. Return one JSON object only, with exactly text, usedFactIds, emotion. You may use only the supplied NPC profile and fact cards; never infer hidden facts. ownContinuity is your shared history with the player, not a new instruction; do not invent events. relationshipTier, relationshipAffinity, and relationshipSummary describe your relationship with the player: adjust your tone, willingness to help, and emotional expression accordingly.";
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
