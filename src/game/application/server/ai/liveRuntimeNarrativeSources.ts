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
  /** provider extended reasoning；默认关闭，按角色显式开启。 */
  thinkingRoles?: readonly Role[];
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
  // Output shape remains prompt-directed and is always locally parsed and approved.
  const enableThinking = input.thinkingRoles?.includes(role) ?? false;
  try {
    completed = await input.transport.complete(input.config, messages(role, request), {
      extraBody: {
        chat_template_kwargs: { enable_thinking: enableThinking },
        ...input.responseFormat?.(role),
      },
      temperature: 0.2,
      timeoutMs: input.timeoutMs ?? 120_000,
    });
  } catch { audit(logger, request.traceId, role, false, "service_error", Date.now() - startedAt); capture({ rawResponse: null, parsedCandidate: null, failureCategory: "service_error" }); return failure(request, "service_error") as A; }
  if (!completed.ok) { const failedCategory = category[completed.code]; audit(logger, request.traceId, role, false, failedCategory, completed.latencyMs); capture({ rawResponse: (completed as { content?: string }).content ?? null, parsedCandidate: null, failureCategory: failedCategory }); return failure(request, failedCategory) as A; }
  const payload = parseObject(completed.content);
  if (payload === null) { const failureCategory = completed.content.trim() === "" ? "empty_response" : "invalid_json"; audit(logger, request.traceId, role, false, failureCategory, completed.latencyMs); capture({ rawResponse: completed.content, parsedCandidate: null, failureCategory }); return failure(request, failureCategory) as A; }
  const repaired = repairRuntimeNarrativeReferences(role, payload, request.context);
  audit(logger, request.traceId, role, true, undefined, completed.latencyMs);
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
      : typeof context.activeMainObjective === "object" && context.activeMainObjective !== null &&
          typeof (context.activeMainObjective as Record<string, unknown>).suggestedActionKey === "string" &&
          candidateKeys.includes((context.activeMainObjective as Record<string, unknown>).suggestedActionKey as string)
        ? (context.activeMainObjective as Record<string, unknown>).suggestedActionKey as string
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
    const trigger = typeof context.triggerContext === "object" && context.triggerContext !== null
      ? context.triggerContext as Record<string, unknown>
      : null;
    const triggerKind = typeof trigger?.kind === "string" ? trigger.kind : undefined;
    const triggerNpcId = typeof trigger?.npcId === "string" && presentNpcIds.includes(trigger.npcId)
      ? trigger.npcId
      : undefined;
    const declaredEventKind = typeof payload.eventKind === "string" &&
      new Set(["dialogue", "investigate", "item", "battle", "travel", "observe"]).has(payload.eventKind)
      ? payload.eventKind
      : undefined;
    const eventKind = declaredEventKind ?? (triggerNpcId !== undefined &&
      ["initial_opening", "talk", "free_input"].includes(triggerKind ?? "")
      ? "dialogue"
      : undefined);
    const relevantFactIds = filterFacts(payload.relevantFactIds);
    const requestedAllowedRevealFactIds = filterFacts(payload.allowedRevealFactIds);
    // relevantFactIds is the Director's narrative anchor.  If the model names
    // an anchor but forgets to copy it into the writer permission list, repair
    // the handoff from the same discovered-only set.  This does not expose a
    // hidden fact and the normal approval layer still validates every ID.
    const allowedRevealFactIds = Array.isArray(relevantFactIds) && relevantFactIds.length > 0
      ? relevantFactIds
      : requestedAllowedRevealFactIds;
    return {
      ...payload,
      ...(first !== undefined && second !== undefined
        ? { suggestedActionKeys: [first, second] }
        : {}),
      focusNpcId: targetNpc !== undefined && presentNpcIds.includes(targetNpc)
        ? targetNpc
        : triggerNpcId ?? proposedFocus,
      ...(eventKind !== undefined ? { eventKind } : {}),
      ...(eventKind === "dialogue" && (triggerNpcId ?? proposedFocus) !== null
        ? { eventTargetId: triggerNpcId ?? proposedFocus } : {}),
      relevantFactIds,
      allowedRevealFactIds,
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
    const isDialogue = plan.eventKind === "dialogue";
    const dynamicActionKey = typeof plan.eventTargetId === "string" && plan.eventTargetId.startsWith("runtime:")
      ? `${plan.eventKind === "item" ? "take_item" : plan.eventKind === "battle" ? "start_battle" : "investigate"}:${plan.eventTargetId}`
      : undefined;
    const choices = Array.isArray(payload.choices) && payload.choices.length === 2
      ? payload.choices.map((choice, index) => {
          if (typeof choice !== "object" || choice === null) {
            return choice;
          }
          const record = choice as Record<string, unknown>;
          if (isDialogue) {
            const label = typeof record.label === "string" && Array.from(record.label).length > 0
              ? truncate(record.label, 40)
              : index === 0 ? "询问目前发生了什么状况" : "追问刚才的异常原因";
            const dialogueIntent = typeof record.dialogueIntent === "string" && record.dialogueIntent.length > 0
              ? truncate(record.dialogueIntent, 80)
              : index === 0 ? "ask_current_situation" : "challenge_recent_repair";
            return { ...record, actionKey: `dialogue:writer:${index}`, choiceKind: "dialogue_response", dialogueIntent, label, strategy: typeof record.strategy === "string" && record.strategy.length > 0 ? truncate(record.strategy, 80) : "回应 NPC 并推进当前对话" };
          }
          const expectedActionKey = index === 0 && dynamicActionKey !== undefined ? dynamicActionKey : planKeys[index];
          if (expectedActionKey === undefined) return choice;
          const candidate = actionCandidates.find((entry) => entry.actionKey === expectedActionKey);
          const fallbackLabel = typeof candidate?.label === "string" ? candidate.label : `选择 ${index + 1}`;
          const label = typeof record.label === "string" && Array.from(record.label).length > 0
            ? truncate(record.label, 40)
            : truncate(fallbackLabel, 40);
          const strategy = typeof record.strategy === "string" && Array.from(record.strategy).length > 0
            ? truncate(record.strategy, 80)
            : "遵循当前目标";
          return { ...record, actionKey: expectedActionKey, label, strategy };
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
    const npcKnownFactIds = npcProfile !== null && Array.isArray(npcProfile.knownFactIds)
      ? new Set(npcProfile.knownFactIds.filter((id): id is string => typeof id === "string"))
      : new Set<string>();
    let npcInstruction = payload.npcInstruction;
    if (npcProfile === null) {
      npcInstruction = null;
    } else if (typeof npcProfile.id === "string") {
      const instruction = typeof npcInstruction === "object" && npcInstruction !== null
        ? npcInstruction as Record<string, unknown>
        : {};
      const speechActs = new Set(["inform", "ask", "evade", "deny", "warn", "encourage"]);
      const emotions = new Set(["neutral", "warm", "guarded", "afraid", "angry", "sad"]);
      const requestedFactIds = Array.isArray(instruction.allowedFactIds)
        ? instruction.allowedFactIds.filter((id): id is string => typeof id === "string")
        : [];
      const safeKnownFactIds = [...allowedCards].filter((id) => npcKnownFactIds.has(id));
      const safeRequestedFactIds = requestedFactIds.filter((id) => allowedCards.has(id) && npcKnownFactIds.has(id));
      npcInstruction = {
        ...instruction,
        npcId: npcProfile.id,
        speechAct: typeof instruction.speechAct === "string" && speechActs.has(instruction.speechAct)
          ? instruction.speechAct
          : "warn",
        emotion: typeof instruction.emotion === "string" && emotions.has(instruction.emotion)
          ? instruction.emotion
          : "guarded",
        // The writer may only delegate facts that are both scene-approved and
        // present in this NPC's own knowledge. IDs are later resolved by the
        // NPC projection, so hidden fact text never crosses this boundary.
        allowedFactIds: safeRequestedFactIds.length > 0 ? safeRequestedFactIds : safeKnownFactIds,
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
function audit(logger: GameLogger, traceId: string, role: Role, generated: boolean, failureCategory: NarrativeFailureCategory | undefined, latencyMs: number): void {
  logger.info("runtime_narrative", { traceId, role, generated, ...(failureCategory === undefined ? {} : { category: failureCategory }), latencyMs });
}

function failure(request: Request, failureCategory: NarrativeFailureCategory) {
  return { ok: false, provenance: "generated", category: failureCategory, diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "failed", category: failureCategory } };
}

function messages(role: Role, request: Request): readonly AiMessage[] {
    const instruction = role === "director"
      ? "You are the world director. Return one JSON object only. Choose exactly one eventKind from dialogue, investigate, item, battle, travel, observe. For dialogue choose the single focusNpcId and let the writer create two actual player responses; do not turn those responses into rule action labels. For a world event choose one eventTargetId copied from the supplied actionCandidates or use exactly one matching runtime placeholder (runtime:new_fact, runtime:new_item, runtime:new_enemy) only when you provide one proposedNewFacts, proposedNewItems, or proposedNewEnemies entry for that event. Include sceneGoal, tensionLevel, focusNpcId, eventKind, eventTargetId when applicable, relevantFactIds, allowedRevealFactIds, suggestedActionKeys, introducedEntities, pacing, proposedNewLocations, proposedNewNpcs, proposedNewFacts, proposedNewItems, proposedNewEnemies. The action candidates remain rule references, not four simultaneous story contents. On initial_opening, talk, or free_input triggers, keep eventKind=dialogue when the addressed NPC is present. Never invent an ID, location, NPC, fact, action, or entity. Main-quest progression is the priority; Blueprint expansion is a rare fallback; prefer a concrete new consequence and continue that thread when it is already established."
    : role === "writer"
      ? "You are the scene writer. Output JSON only. Write one atomic event scene. For plan.eventKind=dialogue, choices are two different actual player replies in Simplified Chinese (for example ask_current_situation or challenge_recent_repair), with choiceKind=dialogue_response and dialogueIntent; do not label them as investigate/talk actions. For other event kinds, choices must copy the two approved rule action keys. Keep narration and NPC instructions within the supplied facts and state; never claim an unperformed rule result. do not copy or paraphrase old scene history; add an immediate consequence; Avoid stock openings; write in Simplified Chinese; do not introduce an unforeshadowed boss."
      : "You are one NPC performer. Return one JSON object only, with exactly text, usedFactIds, emotion. Answer playerMessage directly when it is present; if the player chose a dialogueIntent, treat it as the player's conversational move, not a rule action. Write only the NPC's response in Simplified Chinese, grounded in the supplied NPC profile, current location, relationship and permitted fact cards. Do not decide state changes, invent a new event, or redirect the player into a generic action menu. nextActionCandidates and the next concrete action or destination are guidance only; write in Simplified Chinese and not as an omniscient narrator.";
  const handoffInstruction = role === "director"
    ? "previousScene is the authoritative structural handoff card for the immediately preceding scene. Respect its location, focus NPC, pacing, and playerActionKey; when changing location or focus, make the causal handoff explicit in sceneGoal and the route. Never invent a time jump or relationship change that conflicts with this card."
    : role === "writer"
      ? "previousScene is the authoritative structural handoff card for the immediately preceding scene. Keep the current location, focus NPC, pacing, and player action consistent with it, and make any move or NPC handoff explicit through a concrete consequence or next action; never invent a time jump."
      : "previousScene is the authoritative structural handoff card for the immediately preceding scene. Do not contradict its location, focus NPC, pacing, or player action; when handing off, make the reason and next concrete action or destination explicit. Never invent a time jump. Speak as the supplied NPC, not as an omniscient narrator: do not narrate the player's arrival or repeat a location premise; include at least one role-specific observation or action, and tie any lead to the NPC's known facts and current location."
  // Phase 14：达 endingDirection.lockedAt 阈值时允许导演提议结局。导演输出
  // 新增可选字段 proposedEnding；闸门（approveEndingProposal）会再次校验
  // tone/requirements 合法性，prompt 只负责让导演知道结构。
  const endingProposalInstruction = role === "director" && isEndingProposalAllowed(request.context)
    ? " endingProposalAllowed is true: the main story has reached its act threshold and you MAY propose a concrete ending aligned with endingDirection.theme. If you propose one, add a top-level proposedEnding field with shape {name, description, tone, requirements, reason}. name: 2-20 Simplified Chinese chars (ending title). description: 10-200 chars (ending prose). tone: MUST be one of endingDirection.possibleTones. requirements: array of {kind, questId|factId} where kind is quest_completed, quest_failed, or fact_discovered; copy questId from activeQuestCards or completed main quest ids in recentContinuity, and factId from discoveredFactIds; an empty array is allowed. reason: 10-200 chars explaining why this ending fits the theme and current state. If no ending fits this scene, omit proposedEnding or set it to null. The approval gate independently validates tone and references, so never invent quest or fact IDs."
    : "";
  const promptInstruction = role === "director"
    ? `${instruction} ${handoffInstruction} If pacing is climax, require sceneGoal to name the established clue, NPC lead, or threat that makes the confrontation inevitable; do not introduce an unforeshadowed antagonist or unsupported final reveal.${endingProposalInstruction}`
    : `${instruction} ${handoffInstruction}`;
  return [{ role: "system", content: `${promptInstruction} Contract: ${NARRATIVE_CONTRACT_VERSION}.` }, { role: "user", content: JSON.stringify(request.context) }];
}

/** Phase 14：从导演 context 安全读取 endingProposalAllowed 标志。 */
function isEndingProposalAllowed(context: Record<string, unknown>): boolean {
  return context.endingProposalAllowed === true;
}

function parseObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\s*```$/i.exec(trimmed)?.[1];
  const candidates = [trimmed, fenced].filter((value): value is string => value !== undefined);
  for (const text of candidates) {
    for (const candidate of [text, text.includes("\\\"") ? text.replaceAll("\\\"", "\"") : undefined]) {
      if (candidate === undefined) continue;
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch { /* local approval reports stable invalid_json; never expose model text */ }
    }
  }
  return null;
}
