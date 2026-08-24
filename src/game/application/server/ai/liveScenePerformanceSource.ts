import type { AiMessage, AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type {
  SceneSource,
  SceneSourceResult,
  ScenePerformanceProposal,
  ScenePerformanceNpcDialogue,
  ScenePerformanceSegment,
  PreparedContinuationProposal,
} from "../../sceneSource";
import { sceneInvestigationResultFrom } from "../../sceneSource";
import { isFinalDialogueHandoff, type SceneGenerationContext } from "../../sceneGenerationContext";
import {
  buildSelectableSceneCandidates,
  formatSceneChoiceLabel,
  usesFallbackDialogueChoiceLabels,
  type SceneChoiceCandidate,
} from "../../sceneChoiceCandidates";
import { classifyAiFailure, transportFailureCodeToCategory } from "../../aiGenerationFailure";
import type { AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
import { NARRATIVE_EMOTIONS, type NarrativeEmotion } from "@/game/domain/narrative";
import {
  isGenericNpcAcknowledgement,
  isGenericNpcGreeting,
  isGenericNpcInquiry,
  normalizeNpcSpeech,
} from "@/game/domain/npcSpeech";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import { createRpgAiClient, RPG_AI_DEFAULT_POLICIES, type RpgAiClient } from "./rpgAiClient";
import type { ProviderJsonMode } from "./providerRequestOptions";
import { compileSceneNarrativeContext } from "./narrativeContext";
import type { NarrativePromptCompilation } from "./narrativeContext";
import { parseStructuredJsonObject } from "@/game/core/json";

// ---------------------------------------------------------------------------
// live 场景表演源（Task 6，取代 liveSceneSource）。
//
// 编排：AI 原始 JSON → 纯解析/校验（非法核心字段直接失败；线性预生成条目按权威
// ID 局部过滤）→ typed failure。
// source 只做"提案"，不做审批/铸造 token/写状态
// （那些是 approveScenePerformance 纯函数职责）。sensitive 配置绝不进日志。
// 提示词只含安全段落：风格政策、玩家本轮原话、已解决规则结果节拍、目标转换、
// 当前地点、最近故事节拍、预算/节奏、已批准实体、焦点 NPC 上下文、合法选项 ID、
// 当前主线摘要与输出 schema；绝不序列化完整 record/事件账本/全部 NPC 上下文/私密事实正文。
// ---------------------------------------------------------------------------

export type LiveScenePerformanceDeps = {
  readonly transport?: AiTransport;
  readonly config?: AiTransportConfig;
  /** Shared RPG client supplied by the server composition root. */
  readonly aiClient?: RpgAiClient;
  /** 仅由已验证兼容的 AI_OUTPUT_FORMAT=json_object 启用。 */
  readonly jsonMode?: ProviderJsonMode;
  readonly logger?: GameLogger;
};

/**
 * 场景表演必须有明确上限。该兼容 provider 在 payload 已到达前可能花去三十余秒
 * 处理 reasoning，因此 30 秒会把可用的 AI 结果误判为超时；给一次完整的服务端
 * 生成窗口。真正超时仍会记录为失败，不能计作 AI 场景通过。
 */
export const LIVE_SCENE_TIMEOUT_MS = RPG_AI_DEFAULT_POLICIES.scene.timeoutMs;
/** 场景只需旁白、两句 NPC 台词与两个选项，避免默认大输出拖慢整回合。 */
// 当前 provider 即使请求关闭 reasoning，复杂 JSON 仍会先占用约两千 token
// 的 reasoning_content；completion token 预算必须同时容纳 reasoning 和最终正文，
// 否则会得到 HTTP 200 但 message.content 为空的响应。
export const LIVE_SCENE_MAX_TOKENS = RPG_AI_DEFAULT_POLICIES.scene.maxTokens ?? 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 只记录响应的结构轮廓，帮助定位 JSON mode 的契约偏差；绝不记录模型原文、
 * 玩家输入、NPC 台词或提示词。
 */
function sceneResponseShape(raw: unknown): Record<string, string | number | boolean> {
  if (!isRecord(raw)) return { object: false, kind: Array.isArray(raw) ? "array" : typeof raw };
  return {
    object: true,
    keys: Object.keys(raw).sort().join(","),
    segmentCount: Array.isArray(raw.segments) ? raw.segments.length : -1,
    npcLineKind: raw.npcLine === null ? "null" : Array.isArray(raw.npcLine) ? "array" : typeof raw.npcLine,
    choiceCount: Array.isArray(raw.choices) ? raw.choices.length : -1,
    objectiveLinkKind: raw.objectiveLink === null ? "null" : Array.isArray(raw.objectiveLink) ? "array" : typeof raw.objectiveLink,
  };
}

function strArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

// --- NPC 台词解析（迁移自 liveSceneSource） ---

export type LiveNpcLineCandidate = {
  readonly npcId: string;
  readonly text: string;
  readonly emotion: string;
};

export type ScenePerformanceParseFailureReason =
  | "root_not_object"
  | "segments_empty"
  | "segment_invalid"
  | "segment_unknown_beat"
  | "npc_line_invalid_shape"
  | "npc_line_unusable"
  | "npc_dialogues_invalid"
  | "objective_link_invalid_shape"
  | "objective_link_invalid_fields"
  | "choices_invalid"
  | "choices_stale_template"
  | "handoff_acknowledgement_invalid"
  | "prepared_continuations_invalid";

export type ScenePerformanceParseResult =
  | { readonly ok: true; readonly proposal: ScenePerformanceProposal }
  | { readonly ok: false; readonly reason: ScenePerformanceParseFailureReason };

/** 焦点 NPC 的 ready 台词必须是两句可独立阅读的直接对白。 */
function hasDialogicContinuation(text: string): boolean {
  return normalizeNpcSpeech(text)
    .split(/[。！？!?]+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "")
    .length >= 2;
}

function isUsableLiveNpcLine<TNpcId>(
  candidate: LiveNpcLineCandidate | null,
  context: SceneGenerationContext,
): { readonly npcId: TNpcId; readonly text: string; readonly emotion: NarrativeEmotion } | null {
  const resolved = resolveLiveNpcLine(candidate, context.presentNpcs);
  if (resolved === null) return null;
  if (context.focusNpcContext !== undefined && !hasDialogicContinuation(resolved.text)) return null;
  if (isGenericNpcAcknowledgement(resolved.text) || isGenericNpcInquiry(resolved.text)) return null;
  return resolved as { readonly npcId: TNpcId; readonly text: string; readonly emotion: NarrativeEmotion };
}

/**
 * 归一化 AI 返回的 npcLine：npcId 必须真实存在于在场 NPC、text 非空、
 * emotion 收敛到合法枚举，否则返回 null（上层进入内容修复/失败流程）。
 * 纯函数：零 AI / IO / 随机。
 */
export function resolveLiveNpcLine<TNpcId>(
  candidate: LiveNpcLineCandidate | null,
  presentNpcs: readonly { readonly id: TNpcId; readonly name?: string }[],
): { readonly npcId: TNpcId; readonly text: string; readonly emotion: NarrativeEmotion } | null {
  if (candidate === null || typeof candidate !== "object") return null;
  if (typeof candidate.npcId !== "string" || typeof candidate.text !== "string") return null;
  if (candidate.text.trim() === "") return null;
  const presentNpc = presentNpcs.find((npc) => String(npc.id) === candidate.npcId)
    ?? presentNpcs.find((npc) => npc.name !== undefined && npc.name === candidate.npcId);
  if (presentNpc === undefined) return null;
  const text = normalizeNpcSpeech(candidate.text, presentNpc.name);
  if (text === "") return null;
  // 这句没有身份、地点或线索承接，AI 在新幕里返回它会把角色演绎
  // 退化成同一个模板；拒绝后由上层进入内容修复，不写入兜底台词。
  if (isGenericNpcGreeting(text)) return null;
  const emotion = NARRATIVE_EMOTIONS.includes(candidate.emotion as NarrativeEmotion)
    ? (candidate.emotion as NarrativeEmotion)
    : "neutral";
  return { npcId: presentNpc.id, text, emotion };
}

/** 把 AI 选择的两个合法 candidateId 映射为表演提案的 choices；非法/重复 → null。 */
export function resolvePerformanceChoices(
  selectable: readonly SceneChoiceCandidate[],
  selected: unknown,
  expectedCount = 2,
): ScenePerformanceProposal["choices"] | null {
  if (!Array.isArray(selected) || selected.length !== expectedCount) return null;
  const parsed = selected as readonly unknown[];
  const resolved: Array<{ readonly candidateId: string; readonly label: string }> = [];
  for (const rawChoice of parsed) {
    if (!isRecord(rawChoice) || typeof rawChoice.candidateId !== "string" || typeof rawChoice.label !== "string" || rawChoice.label.trim() === "") {
      return null;
    }
    if (resolved.some((choice) => choice.candidateId === rawChoice.candidateId)) return null;
    const candidate = selectable.find((entry) => entry.candidateId === rawChoice.candidateId);
    if (candidate === undefined) return null;
    resolved.push({
      candidateId: candidate.candidateId,
      label: formatSceneChoiceLabel(candidate.action, rawChoice.label.trim()),
    });
  }
  return resolved;
}

/** Parse the provider's natural-language seed for each server-authored descriptor. */
function parsePreparedNpcLine(
  rawValue: unknown,
  descriptor: NonNullable<SceneGenerationContext["preparedStepDescriptors"]>[number],
): ScenePerformanceProposal["npcLine"] | null {
  if (rawValue === null) return null;
  if (!isRecord(rawValue)
    || typeof rawValue.npcId !== "string"
    || typeof rawValue.text !== "string"
    || rawValue.text.trim() === "") return null;
  if (descriptor.arrivalNpc === undefined || rawValue.npcId !== String(descriptor.arrivalNpc.id)) return null;
  const text = normalizeNpcSpeech(rawValue.text, descriptor.arrivalNpc.name);
  if (text === "" || !hasDialogicContinuation(text)) return null;
  const usedFactIds = strArray(rawValue.usedFactIds);
  const allowedFactIds = new Set(descriptor.authority.visibleFactIds.map(String));
  if (usedFactIds.some((factId) => !allowedFactIds.has(factId))) return null;
  const emotion = NARRATIVE_EMOTIONS.includes(rawValue.emotion as NarrativeEmotion)
    ? rawValue.emotion as NarrativeEmotion
    : "neutral";
  return {
    npcId: String(descriptor.arrivalNpc.id),
    text,
    emotion,
    answeredBeatIds: strArray(rawValue.answeredBeatIds),
    usedFactIds,
    usedInteractionActionIds: strArray(rawValue.usedInteractionActionIds),
  };
}

function parsePreparedContinuations(
  rawValue: unknown,
  context: SceneGenerationContext,
): readonly PreparedContinuationProposal[] | null {
  const descriptors = context.preparedStepDescriptors ?? [];
  if (!Array.isArray(rawValue) || rawValue.length !== descriptors.length) return null;
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.stepId, descriptor]));
  const seen = new Set<string>();
  const result: PreparedContinuationProposal[] = [];
  for (const rawStep of rawValue) {
    if (!isRecord(rawStep) || typeof rawStep.stepId !== "string" || seen.has(rawStep.stepId)) return null;
    const descriptor = descriptorById.get(rawStep.stepId);
    if (descriptor === undefined) return null;
    if (!Array.isArray(rawStep.segments) || rawStep.segments.length === 0) return null;
    const segments: ScenePerformanceSegment[] = [];
    for (const rawSegment of rawStep.segments) {
      if (!isRecord(rawSegment)
        || typeof rawSegment.beatId !== "string"
        || rawSegment.beatId.trim() === ""
        || typeof rawSegment.text !== "string"
        || rawSegment.text.trim() === "") return null;
      const referencedEntityIds = parseReferencedEntityIds(rawSegment.referencedEntityIds, context);
      segments.push({
        beatId: rawSegment.beatId,
        text: rawSegment.text.trim(),
        ...(referencedEntityIds === undefined || referencedEntityIds.length === 0 ? {} : { referencedEntityIds }),
      });
    }
    if (!Array.isArray(rawStep.choices) || rawStep.choices.length !== descriptor.choiceCandidates.length) return null;
    const candidateIds = new Set(descriptor.choiceCandidates.map((candidate) => candidate.candidateId));
    const choices: Array<{ readonly candidateId: string; readonly label: string }> = [];
    const seenCandidates = new Set<string>();
    for (const rawChoice of rawStep.choices) {
      if (!isRecord(rawChoice)
        || typeof rawChoice.candidateId !== "string"
        || typeof rawChoice.label !== "string"
        || rawChoice.label.trim() === ""
        || !candidateIds.has(rawChoice.candidateId)
        || seenCandidates.has(rawChoice.candidateId)) return null;
      seenCandidates.add(rawChoice.candidateId);
      const candidate = descriptor.choiceCandidates.find((entry) => entry.candidateId === rawChoice.candidateId);
      if (candidate === undefined) return null;
      choices.push({
        candidateId: candidate.candidateId,
        label: formatSceneChoiceLabel(candidate.action, rawChoice.label.trim()),
      });
    }
    let objectiveLink: PreparedContinuationProposal["objectiveLink"] = null;
    if (rawStep.objectiveLink !== null && rawStep.objectiveLink !== undefined) {
      if (!isRecord(rawStep.objectiveLink)
        || typeof rawStep.objectiveLink.questId !== "string"
        || typeof rawStep.objectiveLink.objectiveIndex !== "number"
        || !["hint", "progress", "handoff"].includes(rawStep.objectiveLink.mode as string)) return null;
      objectiveLink = {
        questId: rawStep.objectiveLink.questId,
        objectiveIndex: rawStep.objectiveLink.objectiveIndex,
        mode: rawStep.objectiveLink.mode as "hint" | "progress" | "handoff",
      };
    }
    const npcLine = parsePreparedNpcLine(rawStep.npcLine, descriptor);
    if (rawStep.npcLine !== null && npcLine === null) return null;
    seen.add(rawStep.stepId);
    result.push({
      stepId: descriptor.stepId,
      segments,
      npcLine,
      objectiveLink,
      choices,
      source: "generated",
    });
  }
  return result;
}

/**
 * 解析可选的结构化叙事引用。引用只影响质量诊断，不是场景硬契约；
 * 非法字段被局部丢弃，避免一条多余 ID 让整场自然语言表演降级。
 */
function parseReferencedEntityIds(
  rawValue: unknown,
  context: SceneGenerationContext,
): readonly string[] | undefined {
  if (!Array.isArray(rawValue)) return undefined;
  const allowed = new Set((context.narrativeReferenceIds ?? []).map(String));
  const ids: string[] = [];
  for (const value of rawValue) {
    if (typeof value !== "string" || !allowed.has(value) || ids.includes(value)) continue;
    ids.push(value);
  }
  return ids;
}

/** 解析同一次 API 返回的非焦点 NPC 闲聊台词。 */
function parseNpcDialogues(
  rawValue: unknown,
  context: SceneGenerationContext,
  focusNpcId: string | undefined,
): readonly ScenePerformanceNpcDialogue[] | undefined | "invalid" {
  if (rawValue === undefined) return undefined;
  if (!Array.isArray(rawValue)) return "invalid";
  const presentIds = new Set(context.presentNpcs.map((npc) => String(npc.id)));
  const seen = new Set<string>();
  const result: ScenePerformanceNpcDialogue[] = [];
  for (const entry of rawValue) {
    if (!isRecord(entry) || typeof entry.npcId !== "string" || typeof entry.text !== "string") return "invalid";
    const npcId = entry.npcId.trim();
    if (!presentIds.has(npcId) || npcId === focusNpcId || seen.has(npcId)) return "invalid";
    const npc = context.presentNpcs.find((candidate) => String(candidate.id) === npcId);
    if (npc === undefined) return "invalid";
    const text = normalizeNpcSpeech(entry.text, npc.name);
    if (text === ""
      || isGenericNpcAcknowledgement(text)
      || isGenericNpcGreeting(text)
      || isGenericNpcInquiry(text)) return "invalid";
    seen.add(npcId);
    result.push({ npcId, text });
  }
  return result;
}

/** 把 AI 返回的任意形状解析/校验为合法表演提案；非法返回 typed failure（上层重试）。 */
export function parseScenePerformanceJson(
  raw: unknown,
  context: SceneGenerationContext,
  selectable: readonly SceneChoiceCandidate[],
  _logger?: Pick<GameLogger, "warn">,
): ScenePerformanceParseResult {
  if (!isRecord(raw)) return { ok: false, reason: "root_not_object" };

  const segments: ScenePerformanceSegment[] = [];
  const allowedBeatIds = new Set([
    ...context.mandatoryBeats.map((beat) => beat.beatId),
    ATMOSPHERE_BEAT_ID,
  ]);
  if (Array.isArray(raw.segments)) {
    for (const s of raw.segments) {
      if (!isRecord(s)
        || typeof s.beatId !== "string"
        || s.beatId.trim() === ""
        || typeof s.text !== "string"
        || s.text.trim() === "") {
        return { ok: false, reason: "segment_invalid" };
      }
      // 让“自创节拍 ID”进入机械修复路径：有焦点 NPC 时保留真实
      // API 返回的台词，只用服务端已批准的节拍/确定性段落补齐，
      // 避免到了最终审批才静默写入非法响应或永久卡 pending。
      if (!allowedBeatIds.has(s.beatId.trim())) {
        return { ok: false, reason: "segment_unknown_beat" };
      }
      const referencedEntityIds = parseReferencedEntityIds(s.referencedEntityIds, context);
      segments.push({
        beatId: s.beatId,
        text: s.text.trim(),
        ...(referencedEntityIds === undefined || referencedEntityIds.length === 0
          ? {}
          : { referencedEntityIds }),
      });
    }
  }
  if (segments.length === 0) return { ok: false, reason: "segments_empty" };

  let npcLine: ScenePerformanceProposal["npcLine"] = null;
  if (raw.npcLine !== null && raw.npcLine !== undefined) {
    if (!isRecord(raw.npcLine)) return { ok: false, reason: "npc_line_invalid_shape" };
    const resolved = isUsableLiveNpcLine(raw.npcLine as LiveNpcLineCandidate, context);
    if (resolved === null) return { ok: false, reason: "npc_line_unusable" };
    npcLine = {
      npcId: String(resolved.npcId),
      text: resolved.text,
      emotion: resolved.emotion,
      answeredBeatIds: strArray(raw.npcLine.answeredBeatIds),
      usedFactIds: strArray(raw.npcLine.usedFactIds),
      usedInteractionActionIds: strArray(raw.npcLine.usedInteractionActionIds),
    };
  }

  const npcDialogues = parseNpcDialogues(raw.npcDialogues, context, npcLine?.npcId);
  if (npcDialogues === "invalid") return { ok: false, reason: "npc_dialogues_invalid" };

  let objectiveLink: ScenePerformanceProposal["objectiveLink"] = null;
  if (raw.objectiveLink !== null && raw.objectiveLink !== undefined) {
    if (!isRecord(raw.objectiveLink)) return { ok: false, reason: "objective_link_invalid_shape" };
    const mode = raw.objectiveLink.mode;
    if (typeof raw.objectiveLink.questId !== "string"
      || typeof raw.objectiveLink.objectiveIndex !== "number"
      || !["hint", "progress", "handoff"].includes(mode as string)) {
      return { ok: false, reason: "objective_link_invalid_fields" };
    }
    objectiveLink = {
      questId: raw.objectiveLink.questId,
      objectiveIndex: raw.objectiveLink.objectiveIndex,
      mode: mode as "hint" | "progress" | "handoff",
    };
  }

  // raw.npcLine 是本轮刚生成的 NPC 回应；下一组选项以它及其结构化事实引用为锚点。
  // selectable 仍负责 candidateId/action 的权威集合，避免沿用生成请求前
  // context.previousDialogue 的旧动作；label 则由 AI 在同一故事上下文中润色。
  const currentLineSelectable = npcLine === null
    ? selectable
    : buildSelectableSceneCandidates(context, npcLine);
  const finalDialogueHandoff = isFinalDialogueHandoff(context);
  const choices = resolvePerformanceChoices(
    currentLineSelectable,
    raw.choices,
    finalDialogueHandoff ? 0 : 2,
  );
  if (choices === null) return { ok: false, reason: "choices_invalid" };
  if (
    npcLine !== null
    && (
      usesFallbackDialogueChoiceLabels(selectable, choices)
      || usesFallbackDialogueChoiceLabels(currentLineSelectable, choices)
    )
  ) {
    return { ok: false, reason: "choices_stale_template" };
  }

  const handoffAcknowledgement = raw.handoffAcknowledgement === undefined
    ? undefined
    : typeof raw.handoffAcknowledgement === "string" && raw.handoffAcknowledgement.trim() !== ""
      ? raw.handoffAcknowledgement.trim()
      : null;
  if (handoffAcknowledgement === null || (finalDialogueHandoff && handoffAcknowledgement === undefined)) {
    return { ok: false, reason: "handoff_acknowledgement_invalid" };
  }
  const descriptors = context.preparedStepDescriptors ?? [];
  const preparedRaw = raw.preparedContinuations === undefined && descriptors.length === 0
    ? []
    : raw.preparedContinuations;
  const preparedContinuations = parsePreparedContinuations(preparedRaw, context);
  if (preparedContinuations === null) return { ok: false, reason: "prepared_continuations_invalid" };

  return {
    ok: true,
    proposal: {
      sceneId: `scene-${context.job.jobId}`,
      segments,
      npcLine,
      ...(npcDialogues === undefined ? {} : { npcDialogues }),
      objectiveLink,
      choices,
      ...(handoffAcknowledgement === undefined ? {} : { handoffAcknowledgement }),
      preparedContinuations,
      source: "generated",
    },
  };
}

/**
 * JSON object mode 下 provider 偶尔把 NPC 直接台词放成字符串、或给出不合法
 * 数量的选项。此函数已废弃——live source 不再调用 deterministic source
 * 做 partial repair。保留导出仅为兼容外部测试引用；内部不再调用。
 */

/** live 场景表演源：AI 提案 → 纯解析/校验 → 失败返回稳定 typed failure，不调用 deterministic source。 */
export function createLiveScenePerformanceSource(deps: LiveScenePerformanceDeps): SceneSource {
  const { transport, config, logger, jsonMode } = deps;
  const aiClient = deps.aiClient ?? (transport && config
    ? createRpgAiClient({
      transport,
      config,
      logger,
      policies: { scene: { jsonMode: jsonMode ?? "prompt_only" } },
    })
    : undefined);

  const failScene = (
    category: Parameters<typeof classifyAiFailure>[0]["category"],
  ): Extract<SceneSourceResult, { readonly ok: false }> => {
    const failure: AiGenerationFailure = classifyAiFailure({ phase: "scene", category });
    logger?.warn("scene_generation_failed", { category, kind: failure.kind });
    return { ok: false, failure };
  };

  const generateSceneInner = async (context: SceneGenerationContext): Promise<SceneSourceResult> => {
      try {
        const selectable = buildSelectableSceneCandidates(context);
        if (selectable.length < (isFinalDialogueHandoff(context) ? 1 : 2)) return failScene("invalid_schema");
        if (aiClient === undefined) return failScene("unavailable");

        const compilation = compileLiveScenePrompt(context, selectable);
        const messages: readonly AiMessage[] = [
          { role: "system", content: compilation.prompt },
          { role: "user", content: `当前回合：${context.job.actionId}（${context.job.actionSummary.kind}）` },
        ];

        // 场景 source 只负责一次 provider attempt。transport retry 属于
        // RpgAiClient；内容修复预算与审批重试属于上层 use case。
        const result = await aiClient.complete("scene", messages, {
          purpose: "scene_performance",
          trigger: context.auditTrigger ?? `${context.job.actionSummary.kind}_action`,
          ...(context.auditLink ?? {}),
          action: context.job.actionSummary,
          narrativeContext: compilation.manifest,
        });
        if (!result.ok) {
          logger?.warn("scene_generation_ai_failed", { code: result.code });
          return result.code === "empty_response"
            ? { ...failScene(transportFailureCodeToCategory(result.code)), repairReason: "empty_response" }
            : failScene(transportFailureCodeToCategory(result.code));
        }

        const parsed = parseStructuredJsonObject(result.content);
        if (parsed.ok && parsed.normalization === "json_fence") {
          logger?.warn("scene_generation_json_fence_normalized");
        }
        const parseResult = parsed.ok
          ? parseScenePerformanceJson(parsed.value, context, selectable, logger)
          : parsed;
        if (parseResult.ok) {
          return { ok: true, proposal: parseResult.proposal };
        }

        logger?.warn("scene_generation_invalid_data", {
          reason: parseResult.reason,
          ...(parsed.ok
            ? sceneResponseShape(parsed.value)
            : { object: false, kind: "invalid_json" }),
        });
          return parsed.ok
            ? { ...failScene("invalid_schema"), repairReason: "invalid_schema" }
            : { ...failScene("invalid_json"), repairReason: "invalid_json" };
      } catch (error) {
        logger?.error("scene_generation_error", { error: error instanceof Error ? error.message : "unknown" });
        return failScene("unknown");
      }
    };

  // Task 5：已结算调查结果随提案携带（live proposal 仍保持 generated 来源）。
  const generateScene = async (context: SceneGenerationContext): Promise<SceneSourceResult> => {
    const result = await generateSceneInner(context);
    if (!result.ok) return result;
    const investigationResult = sceneInvestigationResultFrom(context);
    const proposal = investigationResult === undefined
      ? result.proposal
      : { ...result.proposal, investigationResult };
    return { ok: true, proposal };
  };

  return { generateScene };
}

/** Compatibility entry point for prompt-only callers and existing fixtures. */
export function compileLiveScenePrompt(
  context: SceneGenerationContext,
  selectable: readonly SceneChoiceCandidate[],
): NarrativePromptCompilation {
  return compileSceneNarrativeContext(context, selectable);
}

export function buildLiveScenePrompt(
  context: SceneGenerationContext,
  selectable: readonly SceneChoiceCandidate[],
): string {
  return compileLiveScenePrompt(context, selectable).prompt;
}
