import type { AiMessage, AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type {
  SceneSource,
  SceneSourceResult,
  ScenePerformanceProposal,
  ScenePerformanceNpcDialogue,
  ScenePerformanceSegment,
  LinearActionNarrative,
  LinearActionNpcLine,
} from "../../sceneSource";
import { sceneInvestigationResultFrom } from "../../sceneSource";
import type { SceneGenerationContext, UpcomingObjectiveRef } from "../../sceneGenerationContext";
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

type SceneJsonParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "invalid_json" };

function parseJsonResponse(text: string): SceneJsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    const match = text.match(/```json\s*([\s\S]*?)```/);
    if (match) {
      try {
        return { ok: true, value: JSON.parse(match[1]) };
      } catch {
        return { ok: false, reason: "invalid_json" };
      }
    }
    return { ok: false, reason: "invalid_json" };
  }
}

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
  | "linear_arrival_npc_line_invalid"
  | "objective_link_invalid_shape"
  | "objective_link_invalid_fields"
  | "choices_invalid"
  | "choices_stale_template";

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
): ScenePerformanceProposal["choices"] | null {
  if (!Array.isArray(selected) || selected.length !== 2) return null;
  const [x, y] = selected as readonly unknown[];
  if (!isRecord(x) || !isRecord(y)) return null;
  if (typeof x.candidateId !== "string" || typeof y.candidateId !== "string") return null;
  if (String(x.candidateId) === String(y.candidateId)) return null;
  const cx = selectable.find((c) => c.candidateId === String(x.candidateId));
  const cy = selectable.find((c) => c.candidateId === String(y.candidateId));
  if (cx === undefined || cy === undefined) return null;
  if (typeof x.label !== "string" || x.label.trim() === "" || typeof y.label !== "string" || y.label.trim() === "") return null;
  return [
    // candidateId/action 仍由服务端候选集决定；label 允许 AI 在同一份
    // 剧情上下文上生成自然措辞，最后只由服务端统一格式化，避免又被
    // 角色/关键词模板覆盖成与 NPC 台词无关的文本。
    { candidateId: cx.candidateId, label: formatSceneChoiceLabel(cx.action, x.label.trim()) },
    { candidateId: cy.candidateId, label: formatSceneChoiceLabel(cy.action, y.label.trim()) },
  ];
}

/**
 * 解析/校验 AI 返回的 linearActionNarratives（Task 1）：actionKind/factId/locationId/
 * narration 逐字段校验，引用必须命中 context.upcomingLinearObjectives 的权威实体；
 * 非法条目被忽略，合法条目继续进入队列，不让一条多余的行动叙事吞掉合法预生成结果。
 */
type LinearActionNarrativeParseResult = {
  readonly narratives: readonly LinearActionNarrative[];
  readonly ignoredCount: number;
} | { readonly requiredArrivalNpcLineInvalid: true };

function parseLinearArrivalNpcLine(
  rawValue: unknown,
  arrivalNpc: NonNullable<Extract<UpcomingObjectiveRef, { kind: "visit_location" }>["arrivalNpc"]>,
): LinearActionNpcLine | null {
  if (!isRecord(rawValue)
    || typeof rawValue.npcId !== "string"
    || rawValue.npcId.trim() !== String(arrivalNpc.id)
    || typeof rawValue.text !== "string") {
    return null;
  }
  const text = normalizeNpcSpeech(rawValue.text, arrivalNpc.name);
  if (text === ""
    || !hasDialogicContinuation(text)
    || isGenericNpcAcknowledgement(text)
    || isGenericNpcGreeting(text)
    || isGenericNpcInquiry(text)) {
    return null;
  }
  const usedFactIds = rawValue.usedFactIds === undefined
    ? []
    : Array.isArray(rawValue.usedFactIds)
      ? strArray(rawValue.usedFactIds)
      : null;
  if (usedFactIds === null) return null;
  if (Array.isArray(rawValue.usedFactIds) && usedFactIds.length !== rawValue.usedFactIds.length) return null;
  const allowedFactIds = new Set([
    ...arrivalNpc.knownFactCards.map((fact) => String(fact.factId)),
    ...arrivalNpc.sceneVisibleFactIds.map(String),
  ]);
  if (usedFactIds.some((factId) => !allowedFactIds.has(factId))) return null;
  const emotion = NARRATIVE_EMOTIONS.includes(rawValue.emotion as NarrativeEmotion)
    ? (rawValue.emotion as NarrativeEmotion)
    : "neutral";
  return {
    npcId: String(arrivalNpc.id),
    text,
    emotion,
    usedFactIds,
  };
}

function parseLinearActionNarratives(
  rawValue: unknown,
  context: SceneGenerationContext,
): LinearActionNarrativeParseResult | undefined {
  if (!Array.isArray(rawValue)) return undefined;
  const upcoming = context.upcomingLinearObjectives ?? [];
  const narratives: LinearActionNarrative[] = [];
  let ignoredCount = 0;
  for (const entry of rawValue) {
    if (!isRecord(entry)) {
      ignoredCount += 1;
      continue;
    }
    if (typeof entry.narration !== "string" || entry.narration.trim() === "") {
      ignoredCount += 1;
      continue;
    }
    if (entry.actionKind === "investigate") {
      if (typeof entry.factId !== "string") {
        ignoredCount += 1;
        continue;
      }
      if (!upcoming.some((ref) => ref.kind === "discover_fact" && String(ref.factId) === entry.factId)) {
        ignoredCount += 1;
        continue;
      }
      narratives.push({ actionKind: "investigate", factId: entry.factId, narration: entry.narration.trim() });
      continue;
    }
    if (entry.actionKind === "move") {
      if (typeof entry.locationId !== "string") {
        ignoredCount += 1;
        continue;
      }
      if (!upcoming.some((ref) => ref.kind === "visit_location" && String(ref.locationId) === entry.locationId)) {
        ignoredCount += 1;
        continue;
      }
      const ref = upcoming.find((candidate) =>
        candidate.kind === "visit_location" && String(candidate.locationId) === entry.locationId,
      );
      if (ref === undefined) {
        ignoredCount += 1;
        continue;
      }
      if (ref !== undefined && ref.kind === "visit_location" && ref.arrivalNpc !== undefined) {
        const arrivalNpcLine = parseLinearArrivalNpcLine(entry.arrivalNpcLine, ref.arrivalNpc);
        if (arrivalNpcLine === null) return { requiredArrivalNpcLineInvalid: true };
        narratives.push({
          actionKind: "move",
          locationId: entry.locationId,
          narration: entry.narration.trim(),
          arrivalNpcLine,
        });
      } else {
        narratives.push({
          actionKind: "move",
          locationId: entry.locationId,
          narration: entry.narration.trim(),
        });
      }
      continue;
    }
    ignoredCount += 1;
  }
  if (narratives.length === 0 && ignoredCount === 0) return undefined;
  return { narratives, ignoredCount };
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
  logger?: Pick<GameLogger, "warn">,
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
  const choices = resolvePerformanceChoices(currentLineSelectable, raw.choices);
  if (choices === null) return { ok: false, reason: "choices_invalid" };
  if (
    npcLine !== null
    && context.previousDialogue !== undefined
    && usesFallbackDialogueChoiceLabels(selectable, choices)
  ) {
    return { ok: false, reason: "choices_stale_template" };
  }

  // 单线行动预生成叙事：非法条目局部忽略，绝不阻塞主场景解析/审批。
  let linearActionNarratives: ScenePerformanceProposal["linearActionNarratives"];
  const requiredArrivalNpc = (context.upcomingLinearObjectives ?? [])
    .find((ref) => ref.kind === "visit_location" && ref.arrivalNpc !== undefined);
  if (requiredArrivalNpc !== undefined
    && (!Array.isArray(raw.linearActionNarratives) || raw.linearActionNarratives.length === 0)) {
    return { ok: false, reason: "linear_arrival_npc_line_invalid" };
  }
  if (raw.linearActionNarratives !== undefined && raw.linearActionNarratives !== null) {
    const parsed = parseLinearActionNarratives(raw.linearActionNarratives, context);
    if (parsed !== undefined) {
      if ("requiredArrivalNpcLineInvalid" in parsed) {
        return { ok: false, reason: "linear_arrival_npc_line_invalid" };
      }
      if (parsed.ignoredCount > 0) {
        logger?.warn("linear_narrative_entries_ignored", {
          sceneId: `scene-${context.job.jobId}`,
          ignoredCount: parsed.ignoredCount,
          acceptedCount: parsed.narratives.length,
        });
      }
      if (requiredArrivalNpc !== undefined
        && !parsed.narratives.some((entry) =>
          entry.actionKind === "move" && entry.arrivalNpcLine !== undefined,
        )) {
        return { ok: false, reason: "linear_arrival_npc_line_invalid" };
      }
      if (parsed.narratives.length > 0) linearActionNarratives = parsed.narratives;
    }
  }

  return {
    ok: true,
    proposal: {
      sceneId: `scene-${context.job.jobId}`,
      segments,
      npcLine,
      ...(npcDialogues === undefined ? {} : { npcDialogues }),
      objectiveLink,
      choices,
      ...(linearActionNarratives === undefined ? {} : { linearActionNarratives }),
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
  const maxContentRepairAttempts = 1;
  const aiClient = deps.aiClient ?? (transport && config
    ? createRpgAiClient({
      transport,
      config,
      logger,
      policies: { scene: { jsonMode: jsonMode ?? "prompt_only" } },
    })
    : undefined);

  const failScene = (category: Parameters<typeof classifyAiFailure>[0]["category"]): SceneSourceResult => {
    const failure: AiGenerationFailure = classifyAiFailure({ phase: "scene", category });
    logger?.warn("scene_generation_failed", { category, kind: failure.kind });
    return { ok: false, failure };
  };

  const generateSceneInner = async (context: SceneGenerationContext): Promise<SceneSourceResult> => {
      try {
        const selectable = buildSelectableSceneCandidates(context);
        if (selectable.length < 2) return failScene("invalid_schema");
        if (aiClient === undefined) return failScene("unavailable");

        const compilation = compileLiveScenePrompt(context, selectable);
        const messages: readonly AiMessage[] = [
          { role: "system", content: compilation.prompt },
          { role: "user", content: `当前回合：${context.job.actionId}（${context.job.actionSummary.kind}）` },
        ];

        // 场景生成位于每个玩家回合的必经等待界面。瞬态网络失败由统一 client
        // 按角色策略重试；解析/契约失败则最多再发起一次带失败原因的内容修复，
        // 修复仍失败时返回稳定 typed failure，不降级到 deterministic scene。
        const result = await aiClient.complete("scene", messages, {
          purpose: "scene_performance",
          trigger: context.auditTrigger ?? `${context.job.actionSummary.kind}_action`,
          ...(context.auditLink ?? {}),
          action: context.job.actionSummary,
          narrativeContext: compilation.manifest,
          // Task 5：内容修复写入结构化 retry（origin 沿用调用方来源），历史
          // repair 字段仅作只读兼容，不再写入新事件。
          ...(context.repairAttempt === undefined
            ? {}
            : {
                retry: {
                  origin: context.auditLink?.retry?.origin ?? "normal",
                  mechanism: "content_repair" as const,
                  attempt: context.repairAttempt.attempt,
                  reason: context.repairAttempt.reason,
                },
              }),
        });
        if (!result.ok) {
          logger?.warn("scene_generation_ai_failed", { code: result.code });
          // empty_response 没有可解析内容，RpgAiClient 不会重复相同请求；
          // 这里允许一次带修复指令的内容重试，仍为空才返回 typed failure。
          const repairAttempt = context.repairAttempt?.attempt ?? 0;
          if (result.code === "empty_response" && repairAttempt < maxContentRepairAttempts) {
            logger?.warn("scene_generation_content_retry", {
              reason: result.code,
              attempt: repairAttempt + 1,
            });
            return generateSceneInner({
              ...context,
              repairAttempt: { attempt: repairAttempt + 1, reason: result.code },
            });
          }
          return failScene(transportFailureCodeToCategory(result.code));
        }

        const parsed = parseJsonResponse(result.content);
        const parseResult = parsed.ok
          ? parseScenePerformanceJson(parsed.value, context, selectable, logger)
          : parsed;
        if (parseResult.ok) {
          const proposal = markContentRepairAttempt(parseResult.proposal, context);
          return { ok: true, proposal };
        }

        const repairAttempt = context.repairAttempt?.attempt ?? 0;
        if (repairAttempt < maxContentRepairAttempts) {
          const reason = parsed.ok ? parseResult.reason : "invalid_json";
          logger?.warn("scene_generation_content_retry", { reason, attempt: repairAttempt + 1 });
          return generateSceneInner({
            ...context,
            repairAttempt: { attempt: repairAttempt + 1, reason },
          });
        }

        logger?.warn("scene_generation_invalid_data", {
          reason: parseResult.reason,
          ...(parsed.ok
            ? sceneResponseShape(parsed.value)
            : { object: false, kind: "invalid_json" }),
        });
          return failScene(parsed.ok ? "invalid_schema" : "invalid_json");
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

function markContentRepairAttempt(
  proposal: ScenePerformanceProposal,
  context: SceneGenerationContext,
): ScenePerformanceProposal {
  return context.repairAttempt === undefined
    ? proposal
    : { ...proposal, contentRepairAttempt: context.repairAttempt.attempt };
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
