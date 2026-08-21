import type { AiMessage, AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type {
  SceneSource,
  SceneSourceResult,
  ScenePerformanceProposal,
  ScenePerformanceSegment,
  LinearActionNarrative,
} from "../../sceneSource";
import { sceneInvestigationResultFrom } from "../../sceneSource";
import type { SceneGenerationContext } from "../../sceneGenerationContext";
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

// ---------------------------------------------------------------------------
// live 场景表演源（Task 6，取代 liveSceneSource）。
//
// 编排：AI 原始 JSON → 纯解析/校验（非法字段、越权引用直接失败）→ typed failure。
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

/**
 * live prompt 只需要知道服务端允许的动作语义，不应看到离线 fixture
 * source 的自然语言 label。否则模型很容易把 fixture 示例误当成当前
 * NPC 台词对应的玩家回应，尤其是在连续对话的 support/challenge 分支。
 */
function describeChoiceCandidate(candidate: SceneChoiceCandidate): string {
  return `${candidate.candidateId}:${JSON.stringify(candidate.action)}`;
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
 * emotion 收敛到合法枚举，否则返回 null（调用方用确定性兜底）。
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
  // 退化成同一个模板。整场回退到同轨角色化台词，避免玩家看到假上下文。
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
 * 任意非法条目 → 整字段丢弃（返回 null，不阻塞主场景解析）。
 */
function parseLinearActionNarratives(
  rawValue: unknown,
  context: SceneGenerationContext,
): readonly LinearActionNarrative[] | null {
  if (!Array.isArray(rawValue)) return null;
  const upcoming = context.upcomingLinearObjectives ?? [];
  const narratives: LinearActionNarrative[] = [];
  for (const entry of rawValue) {
    if (!isRecord(entry)) return null;
    if (typeof entry.narration !== "string" || entry.narration.trim() === "") return null;
    if (entry.actionKind === "investigate") {
      if (typeof entry.factId !== "string") return null;
      if (!upcoming.some((ref) => ref.kind === "discover_fact" && String(ref.factId) === entry.factId)) {
        return null;
      }
      narratives.push({ actionKind: "investigate", factId: entry.factId, narration: entry.narration.trim() });
      continue;
    }
    if (entry.actionKind === "move") {
      if (typeof entry.locationId !== "string") return null;
      if (!upcoming.some((ref) => ref.kind === "visit_location" && String(ref.locationId) === entry.locationId)) {
        return null;
      }
      narratives.push({ actionKind: "move", locationId: entry.locationId, narration: entry.narration.trim() });
      continue;
    }
    return null;
  }
  return narratives;
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

/** 把 AI 返回的任意形状解析/校验为合法表演提案；非法返回 null（调用方走确定性兜底）。 */
export function parseScenePerformanceJson(
  raw: unknown,
  context: SceneGenerationContext,
  selectable: readonly SceneChoiceCandidate[],
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

  // 单线行动预生成叙事：非法条目整字段丢弃，绝不阻塞主场景解析/审批。
  let linearActionNarratives: ScenePerformanceProposal["linearActionNarratives"];
  if (raw.linearActionNarratives !== undefined && raw.linearActionNarratives !== null) {
    const parsed = parseLinearActionNarratives(raw.linearActionNarratives, context);
    if (parsed !== null) linearActionNarratives = parsed;
  }

  return {
    ok: true,
    proposal: {
      sceneId: `scene-${context.job.jobId}`,
      segments,
      npcLine,
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

        const messages: readonly AiMessage[] = [
          { role: "system", content: buildLiveScenePrompt(context, selectable) },
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
          ...(context.repairAttempt === undefined ? {} : { repair: context.repairAttempt }),
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
          ? parseScenePerformanceJson(parsed.value, context, selectable)
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

/** 安全段落提示词：只含最小权限上下文（Task 6 Step 3）。 */
export function buildLiveScenePrompt(
  context: SceneGenerationContext,
  selectable: readonly SceneChoiceCandidate[],
): string {
  const { job, story } = context;
  const utterance = job.utterance?.trim() ?? "";
  const transition = context.objectiveTransition;
  const after = transition.after;

  const focus = context.focusNpcContext;
  const focusSection = focus === undefined
    ? "无焦点 NPC；npcLine 必须为 null。"
    : `id=${focus.id}；${focus.name}（${focus.role}）；态度：${focus.responsePolicy.toneInstruction}；目标：${focus.goals.join("、") || "无"}；` +
      `可说线索卡：${focus.speakableFactCards.map((f) => `${f.factId}=${f.text}`).join("；") || "无（usedFactIds 必须为 []）"}；` +
      `最近交互：${focus.recentInteractions.slice(-2).map((i) => `${i.actionId}=${i.summary}`).join("；") || "无（usedInteractionActionIds 必须为 []）"}`;

  const previousDialogueSection = context.previousDialogue === undefined
    ? "无上一轮 NPC 对话；这是当前对话的开场。"
    : `上一轮 NPC 原话=${context.previousDialogue.npcLine}；` +
      `玩家上一轮选择=${context.previousDialogue.selectedChoice?.label ?? "自定义回应"}；` +
      `结构化回应=${context.previousDialogue.selectedChoice?.dialogueAct ?? "ask"}；` +
      `主题=${context.previousDialogue.selectedChoice?.topic?.kind ?? "general"}；` +
      `上一轮已引用事实=${context.previousDialogue.usedFactIds?.join("、") || "无"}。`;

  const presentNpcLine = context.presentNpcs.map((n) => `${n.id}=${n.name}`).join("、") || "无";
  const activeQuestSection = story.activeQuest === undefined
    ? "无已解析的当前主线摘要；沿用目标转换和 NPC 可说事实。"
    : `主线=${story.activeQuest.name}；主线说明=${story.activeQuest.description}；` +
      `当前目标=${story.activeQuest.objectiveLabel}（${story.activeQuest.objectiveKind}，序号${story.activeQuest.objectiveIndex}）`;
  const repairSection = context.repairAttempt === undefined
    ? ""
    : `这是同一回合的第${context.repairAttempt.attempt + 1}次内容生成。上一次提案未通过${context.repairAttempt.reason}，请只修复该契约问题，保留当前主线、NPC、历史对话和事实边界。`;

  // 审批器要求每幕至少有一个 segment。开局没有规则节拍时，必须明确告诉
  // 模型使用唯一合法的 atmosphere 节拍；否则模型很自然会返回空数组，进而
  // 把一次已成功返回的 AI 调用误标记为失败。
  const hasMandatoryBeats = context.mandatoryBeats.length > 0;
  const beatsSection = hasMandatoryBeats
    ? context.mandatoryBeats.map((b) => `- ${b.beatId} [${b.kind}] ${b.instruction}`).join("\n")
    : `- ${ATMOSPHERE_BEAT_ID} [atmosphere] 只描写玩家此刻在当前地点的即时感官体验：视觉、声音、气味、温度、触感或空间细节；让玩家感到“我现在就在这里”，不要重新解释序幕中的背景、动机或主线冲突。`;
  const segmentInstruction = hasMandatoryBeats
    ? "segments 逐条覆盖【已解决的本轮规则结果节拍】中的每个节拍并被其 beatId 点名；可额外附加一条 beatId 为 atmosphere 的氛围段，且必须放在最后；自创节拍 ID 非法。"
    : `当前没有其他强制节拍：segments 必须且只能返回一条 beatId 为 ${ATMOSPHERE_BEAT_ID} 的开场氛围段；不得返回空数组或自创 beatId。`;
  const atmosphereInstruction = `atmosphere 段只负责当前地点的临场感：使用具体的视觉、声音、气味、温度、触感或空间细节，表现此刻玩家正在经历什么。不要复述 prologue 的故事钩子、背景冲突或玩家动机，不要引入未经服务端批准的新地点、NPC、物品、事实或任务；它不能替代规则节拍，也不能创造剧情事实。`;
  const objectiveMode = transition.mode === "advanced_act"
    ? "handoff"
    : transition.completed.length > 0 ? "progress" : "hint";
  const objectiveSection = after === null
    ? "无当前目标；objectiveLink 必须为 null。"
    : `当前目标：${after.label}；objectiveLink 必须为 {"questId":"${after.questId}","objectiveIndex":${after.objectiveIndex},"mode":"${objectiveMode}"}。`;
  // Task 5：已结算调查结果只允许引用服务端下发的 approach/evidence/下一目标；
  // AI 是表演者，不得决定是否发现事实，不得修改 tension。
  const resolvedInvestigation = context.resolvedInvestigation;
  const investigationSection = resolvedInvestigation === undefined
    ? "本轮没有已结算的调查结果节拍。"
    : `本轮调查已结算（服务端权威，AI 不得更改）：所选方式=${resolvedInvestigation.approachLabel}；证据质量=${resolvedInvestigation.evidenceQuality === "clean" ? "干净无扰" : "留有动静暴露"}；` +
      `${context.objectiveTarget === null ? "" : `下一目标=${context.objectiveTarget.entityName}；`}` +
      `fact_discovered 节拍的 segment.text 必须点名方式「${resolvedInvestigation.approachLabel}」，只叙述该已结算结果，不得决定是否发现事实，不得声称与证据质量相反的动静，不得修改张力。`;
  const utteranceBeat = context.mandatoryBeats.find((beat) => beat.kind === "player_utterance");
  const utteranceContract = utteranceBeat === undefined
    ? "本轮没有玩家原话节拍。"
    : `本轮玩家原话节拍的精确 beatId 是 ${utteranceBeat.beatId}；npcLine.npcId 必须是 ${utteranceBeat.subjectIds[0] ?? "焦点 NPC"}，answeredBeatIds 必须精确包含 ["${utteranceBeat.beatId}"]。`;
  const handoffContract = context.objectiveTransition.mode === "advanced_act" && context.objectiveTarget !== null
    ? `quest_advanced 是幕交接节拍；objectiveLink 已由服务端锁定。请用自然语言表达线索如何把玩家带向新目标，不要求逐字复述当前目标标签；如需标记 grounding，可在该 segment 的 referencedEntityIds 中使用服务端允许的实体 ID。`
    : "";
  const genreContract = context.gameType === "wuxia"
    ? "题材锁定为武侠：对白和旁白只能使用江湖、门派、镖局、官府、山川、兵器、线索、武学语汇；不得出现魔法、巫师、精灵、骑士、幽灵/灵魂、祭坛、法阵、圣光、异界等奇幻或超自然词汇。"
    : `题材锁定为${context.gameType ?? "当前游戏"}，不得跨题材改写世界规则。`;

  // 单线行动预告：有权威单线链时，输出契约额外要求预生成 investigate/move 叙事。
  const upcoming = context.upcomingLinearObjectives ?? [];
  const linearJsonField = upcoming.length === 0
    ? ""
    : `,"linearActionNarratives":[{"actionKind":"investigate","factId":"权威factId","narration":"调查发现的剧情正文"},{"actionKind":"move","locationId":"权威locationId","narration":"动身与抵达的剧情正文"}]`;

  const prompt = `只输出 JSON，不能有解释或 Markdown。写一幕 RPG 场景，不得改规则。
${genreContract}
世界背景=${context.worldPremise ?? "沿用当前世界"}；故事开端=${context.storyOpening ?? "沿用当前主线"}
风格=${story.stylePolicy.narration}，${story.stylePolicy.narrationInstruction} ${story.stylePolicy.intensityInstruction}
地点=${context.currentLocation.name}：${context.currentLocation.description}
玩家角色=${context.player.name}（${context.player.identity}）；本轮输入=${utterance || "无"}
${previousDialogueSection}
NPC=${focusSection}；在场ID=${presentNpcLine}
节拍=${beatsSection}
主线剧情上下文=${activeQuestSection}
${repairSection}
目标=${objectiveSection}
调查结果=${investigationSection}
${utteranceContract} ${handoffContract}
候选动作=${selectable.map(describeChoiceCandidate).join("；")}
JSON={"segments":[{"beatId":"必须从上面节拍列表逐字复制的ID","text":"旁白","referencedEntityIds":["可选的服务端实体ID"]}],"npcLine":null或{"npcId":"在场ID","text":"第一句直接回应。第二句补充线索或下一步。","emotion":"neutral","answeredBeatIds":[],"usedFactIds":[],"usedInteractionActionIds":[]},"objectiveLink":null或{"questId":"目标questId","objectiveIndex":0,"mode":"hint"},"choices":[{"candidateId":"选项ID","label":"玩家行动"},{"candidateId":"另一选项ID","label":"玩家行动"}]${linearJsonField}}
${segmentInstruction}
${atmosphereInstruction}
NPC 台词硬约束：有焦点 NPC 时 npcLine 不能为 null，text 必须恰好包含两句以“。”、“！”或“？”结尾的直接对白；两句之间用中文句号分隔。不要使用任何引号、角色名、动作、表情或“说道/答道”等舞台说明，不要用分号代替第二句。玩家只能被称为“${context.player.name}”，不得使用其他姓名、姓氏、代号或未经上下文批准的身份称呼。若有上一轮 NPC 原话，必须先直接承接其中的问题、信息或拒答，再补充本轮可核验线索或下一步；不得突然切换到无关案件。若有 player_utterance，answeredBeatIds 必须包含对应的精确 beatId，并由该焦点 NPC 先回应玩家，再给出可核验线索或下一步。不得说“想听哪一段/想问什么/我知道了”。只能说 NPC 可说线索，不能编造私密知识。任何具体地点、人物、时间、物品或证物，都必须能在主线剧情摘要、NPC 可说线索卡、场景可见事实或上一轮已引用事实中找到依据；如果没有依据，只能使用当前 objectiveLink/目标实体给出的下一步，不得自行补出新的核验细节。选项生成顺序：先完成 npcLine，再根据本轮 npcLine 的文本和 usedFactIds 生成 choices；上一轮选择只用于理解承接关系，不得直接复用为本轮可见选项。choices 的 candidateId 必须逐字使用上方候选动作中的两个不同 ID；候选动作只提供服务端合法的 candidateId 和动作语义，不提供可直接复用的自然语言选项。label 是玩家实际要说的话或动作，不要加“回应某人/追问某人”等前缀，不要机械复述 NPC 原话；动作选项必须用全角括号包裹。两个选项都要直接回应本轮 NPC 台词，并且至少一个要推进当前主线目标或核对 NPC 刚提供的事实，不能只输出“继续调查/相信/不相信”等脱离语境的态度。请依据主线剧情上下文、NPC 可说事实和本轮台词写出两句自然、具体、互不重复的玩家对白或动作。`;
  const allowedFactIds = focus === undefined
    ? []
    : [...new Set([
      ...focus.speakableFactCards.map((fact) => String(fact.factId)),
      ...context.presentNpcs.flatMap((npc) => npc.sceneVisibleFactIds.map(String)),
    ])];
  const allowedInteractionIds = focus?.recentInteractions.map((interaction) => interaction.actionId) ?? [];
  const linearNarrativesContract = upcoming.length === 0
    ? "无单线行动预告：输出中必须省略 linearActionNarratives 字段。"
    : `单线行动预告（AI 预生成，服务端权威下发，不得增删改写）：
${upcoming.map((ref) => ref.kind === "discover_fact"
      ? `- 调查：factId=${ref.factId}；调查入口=${ref.investigationLabel}；权威正文=${ref.factText}${ref.nextObjectiveEntityName === undefined ? "" : `；下一地点=${ref.nextObjectiveEntityName}`}`
      : `- 移动：locationId=${ref.locationId}；地点名=${ref.locationName}${ref.nextObjectiveEntityName === undefined ? "" : `；下一目标=${ref.nextObjectiveEntityName}`}`).join("\n")}
输出契约：linearActionNarratives 必须为上面每个预告各生成一条叙事，形状为 [{"actionKind":"investigate","factId":"上面给出的精确factId","narration":"..."},{"actionKind":"move","locationId":"上面给出的精确locationId","narration":"..."}]；未预告的 actionKind 与实体 ID 一律不得输出。
约束：investigate 的 narration 只能演绎该条权威正文的既有事实（事实内容不得改写），并解释为何前往下一地点，下一地点实体名必须逐字照抄服务端下发；move 的 narration 描写动身与抵达该地点的所见所感；不得捏造新事实、新实体或具体时间；不得输出“主线推进到第X幕”“当前目标：”“调查完成”等系统元话术。`;
  return `${prompt}\n` +
    `${linearNarrativesContract}\n` +
    `ID 复核：segments.beatId 只能逐字复制“节拍”列表中的 ID，禁止创造 item_given、dialogue_response 等新 ID；` +
    `segments.referencedEntityIds 只能从 [${(context.narrativeReferenceIds ?? []).join(", ")}] 选择；` +
    `npcLine.usedFactIds 只能从 [${allowedFactIds.join(", ")}] 选择，npcLine.usedInteractionActionIds 只能从 [${allowedInteractionIds.join(", ")}] 选择；` +
    "没有对应引用时必须输出空数组。输出前逐项核对这些 ID。" +
    "玩家可见旁白必须是连续、具体的剧情正文；不得输出“主线推进到第X幕”“已完成：”“当前目标：”等系统元话术，任务状态由 HUD 单独展示。";
}
