import { parseEventCandidate } from "@/game/domain/candidateEvent";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type {
  EventProposal,
  ScenePerformanceProposal,
  ScenePerformanceNpcLine,
} from "./sceneSource";
import type { NarrativeEventState, NarrativeNpcLineState, NarrativeSceneState } from "@/game/domain/narrative";
import type { WorldState } from "@/game/domain/worldState";
import { buildNpcDialoguePages } from "@/game/domain/narrative";
import { isFinalDialogueHandoff, type SceneGenerationContext } from "./sceneGenerationContext";
import type { ApprovedChoice } from "@/game/domain/approvedChoice";
import { createApprovedChoice, semanticSummaryOf } from "@/game/domain/approvedChoice";
import type { GameLogger } from "@/game/logging";
import {
  buildEventState,
  buildSelectableSceneCandidates,
  actionTargetsObjective,
  formatSceneChoiceLabel,
  usesFallbackDialogueChoiceLabels,
} from "./deterministicSceneSource";
import { asFactId, asNpcId } from "@/game/domain/worldEntity";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import { approvePreparedContinuation } from "./approvePreparedContinuation";
import {
  validateNpcSpeechReferences,
  type NpcSpeechReferenceAuthority,
} from "./npcSpeechAuthority";
import {
  isGenericNpcAcknowledgement,
  isGenericNpcGreeting,
  isGenericNpcInquiry,
  normalizeNpcSpeech,
} from "@/game/domain/npcSpeech";

// ---------------------------------------------------------------------------
// R4（Task 21）：候选事件池审批 + Task 6：场景表演契约审批。
// 只做 schema 解析与结构校验，绝不在写回阶段改动 World State / tension /
// 任务 / 关系，也绝不立即执行候选。核心结构非法 → 返回稳定审批失败；是否
// 继续重试由上层编排决定，生产 live 路径不在此处创建确定性场景。
// ---------------------------------------------------------------------------

/** 候选事件池 FIFO 上限（Spec §11.3）。 */
export const POOL_MAX_CANDIDATES = 8;

/** 服务端氛围节拍 ID：可选表演段（最后放置）。 */
export { ATMOSPHERE_BEAT_ID };

export type CandidateRejectionReason =
  | "invalid_schema"
  | "path_patch"
  | "duplicate_id";

export type ApproveSceneEventProposalsResult =
  | {
      readonly ok: true;
      readonly nextCandidateEventPool: readonly EventCandidate[];
      readonly acceptedIds: readonly string[];
      readonly rejected: readonly { readonly id: string; readonly reasonCode: CandidateRejectionReason }[];
    }
  | { readonly ok: false; readonly code: "INTERNAL" };

/**
 * 审批场景提议的候选事件：
 * - 经 `parseEventCandidate` schema 解析，非法候选丢弃，不让整个合法场景失败；
 * - 夹带任意 path patch 的候选以 `path_patch` 分类拒绝；
 * - 与池内已存在 ID 重复的候选以 `duplicate_id` 拒绝；
 * - 合法候选按 FIFO 追加，超出 `POOL_MAX_CANDIDATES` 从池头裁剪。
 * 纯函数：不读时钟/随机数/DB，不改 World/Story 事实。
 * Task 6：场景表演提案不再携带事件；此函数仍供池生命周期单独调用。
 */
export function approveSceneEventProposals(input: {
  readonly existingPool: readonly EventCandidate[];
  readonly proposals: readonly EventProposal[];
}): ApproveSceneEventProposalsResult {
  const acceptedIds: string[] = [];
  const rejected: { readonly id: string; readonly reasonCode: CandidateRejectionReason }[] = [];
  const poolIds = new Set(input.existingPool.map((c) => c.id));
  let nextPool = [...input.existingPool];

  for (const proposal of input.proposals) {
    if (poolIds.has(proposal.id)) {
      rejected.push({ id: proposal.id, reasonCode: "duplicate_id" });
      continue;
    }
    if (containsPathPatch(proposal)) {
      rejected.push({ id: proposal.id, reasonCode: "path_patch" });
      continue;
    }
    const parsed = parseEventCandidate(proposal);
    if (!parsed.ok) {
      rejected.push({ id: proposal.id, reasonCode: "invalid_schema" });
      continue;
    }
    nextPool = [...nextPool, parsed.candidate];
    poolIds.add(parsed.candidate.id);
    acceptedIds.push(parsed.candidate.id);
  }

  if (nextPool.length > POOL_MAX_CANDIDATES) {
    nextPool = nextPool.slice(nextPool.length - POOL_MAX_CANDIDATES);
  }

  return { ok: true, nextCandidateEventPool: nextPool, acceptedIds, rejected };
}

/** 检测候选效果是否为封闭 union 之外的任意 path patch。 */
function containsPathPatch(candidate: EventCandidate): boolean {
  return candidate.proposedEffects.some((effect) => {
    const e = effect as unknown as { path?: unknown };
    return e.path !== undefined;
  });
}

// ---------------------------------------------------------------------------
// Task 6：场景表演审批（approveScenePerformance）。
// 核心结构非法 → 返回稳定审批失败；显式 offline fixture 仍复用本函数，防止契约漂移。
// ---------------------------------------------------------------------------

/** 场景核心结构非法时整场拒绝的原因。 */
export type SceneRejectionCode =
  | "empty_segments"
  | "invented_beat_id"
  | "missing_mandatory_beat"
  | "out_of_order_beats"
  | "unknown_dialogue_npc"
  | "duplicate_npc_reference"
  | "npc_uses_forbidden_fact"
  | "wrong_npc_interaction"
  | "player_utterance_unanswered"
  | "npc_dialogue_too_short"
  | "stale_objective_link"
  | "stale_choice_template"
  | "semantic_duplicate_choices"
  | "duplicate_candidate_ids"
  | "illegal_choice_target"
  | "focused_dialogue_requires_talk_choices"
  | "no_objective_progress_choices"
  | "invalid_investigation_narrative"
  | "handoff_npc_unanswered"
  | "handoff_missing_objective_reference"
  | "missing_non_focus_npc_dialogue"
  | "missing_arrival_npc_dialogue"
  | "missing_focus_npc_dialogue"
  | "invalid_prepared_continuation";

/**
 * 场景核心结构合法后，仍可供运营/评测观察的叙事质量信号。
 * 普通场景只记录这些信号；handoff 缺少新目标引用时由审批器升级为内容修复失败。
 */
export type SceneQualityWarningCode =
  | "missing_objective_reference"
  | "invalid_objective_reference"
  | "missing_objective_surface";

export type ApprovedSceneWriteBack = {
  readonly scene: NarrativeSceneState;
  readonly choiceRegistry: readonly ApprovedChoice[];
  readonly candidateEventPool: readonly EventCandidate[];
  readonly preparedContinuation: import("@/game/domain/preparedContinuation").PreparedContinuationState;
  /** 叙事质量告警：只用于日志/审计，不阻断场景写回。 */
  readonly qualityWarnings: readonly SceneQualityWarningCode[];
};

export type ApproveScenePerformanceResult =
  | ({ readonly ok: true } & ApprovedSceneWriteBack)
  | { readonly ok: false; readonly code: SceneRejectionCode };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rebuildEvent(event: NarrativeEventState): NarrativeEventState {
  switch (event.kind) {
    case "dialogue": return { kind: "dialogue", focusNpcId: event.focusNpcId };
    case "investigate": return { kind: "investigate", factId: event.factId };
    case "item": return { kind: "item", itemId: event.itemId };
    case "battle": return { kind: "battle", enemyId: event.enemyId };
    case "travel": return { kind: "travel", locationId: event.locationId };
    case "observe": return { kind: "observe", locationId: event.locationId };
  }
}

function rebuildNpcLine(
  line: ScenePerformanceNpcLine,
  presentNpcs: SceneGenerationContext["presentNpcs"],
): NarrativeNpcLineState {
  const npcName = presentNpcs.find((npc) => String(npc.id) === String(line.npcId))?.name;
  return {
    npcId: asNpcId(line.npcId),
    text: normalizeNpcSpeech(line.text, npcName),
    emotion: line.emotion,
    usedFactIds: line.usedFactIds.map((id) => asFactId(id)),
    usedInteractionActionIds: [...line.usedInteractionActionIds],
    answeredBeatIds: [...line.answeredBeatIds],
  };
}

function projectedNpcSpeechAuthority(
  npc: SceneGenerationContext["presentNpcs"][number],
  context: SceneGenerationContext,
): NpcSpeechReferenceAuthority | undefined {
  const focusAuthority = context.focusNpcContext?.speechAuthority;
  if (focusAuthority !== undefined && String(focusAuthority.speakerNpcId) === String(npc.id)) {
    return focusAuthority;
  }
  const speakerAuthority = npc.speechAuthority;
  return speakerAuthority !== undefined
    && String(speakerAuthority.speakerNpcId) === String(npc.id)
    ? speakerAuthority
    : undefined;
}

function validateNpcSpeechReferencesForSpeaker(input: {
  readonly npc: SceneGenerationContext["presentNpcs"][number];
  readonly context: SceneGenerationContext;
  readonly usedFactIds: readonly string[];
  readonly usedInteractionActionIds: readonly string[];
}): ReturnType<typeof validateNpcSpeechReferences> {
  const authority = projectedNpcSpeechAuthority(input.npc, input.context);
  if (authority === undefined) {
    // Empty reference arrays are safe for legacy hand-built contexts. Any
    // non-empty array without the speaker's real authority fails closed.
    if (input.usedFactIds.length > 0) return { ok: false, code: "invalid_fact_reference" };
    if (input.usedInteractionActionIds.length > 0) return { ok: false, code: "invalid_interaction_reference" };
    return { ok: true };
  }
  return validateNpcSpeechReferences({
    authority,
    usedFactIds: input.usedFactIds,
    usedInteractionActionIds: input.usedInteractionActionIds,
  });
}

function buildGeneratedNpcDialogueMap(
  proposal: ScenePerformanceProposal,
  context: SceneGenerationContext,
  focusNpcId: string | undefined,
): { readonly ok: true; readonly lines: ReadonlyMap<string, { readonly text: string; readonly usedFactIds: readonly string[]; readonly usedInteractionActionIds: readonly string[] }> } | { readonly ok: false; readonly code: SceneRejectionCode } {
  const entries = proposal.npcDialogues ?? [];
  const presentIds = new Set(context.presentNpcs.map((npc) => String(npc.id)));
  const lines = new Map<string, { readonly text: string; readonly usedFactIds: readonly string[]; readonly usedInteractionActionIds: readonly string[] }>();
  for (const entry of entries) {
    if (!isRecord(entry)
      || typeof entry.npcId !== "string"
      || typeof entry.text !== "string"
      || !presentIds.has(String(entry.npcId))
      || String(entry.npcId) === focusNpcId
      || lines.has(String(entry.npcId))) {
      return { ok: false, code: "missing_non_focus_npc_dialogue" };
    }
    const npc = context.presentNpcs.find((candidate) => String(candidate.id) === String(entry.npcId));
    if (npc === undefined) return { ok: false, code: "missing_non_focus_npc_dialogue" };
    if (!Array.isArray(entry.usedFactIds) || !Array.isArray(entry.usedInteractionActionIds)) {
      return { ok: false, code: "missing_non_focus_npc_dialogue" };
    }
    const text = normalizeNpcSpeech(entry.text, npc.name);
    if (text === ""
      || isGenericNpcAcknowledgement(text)
      || isGenericNpcGreeting(text)
      || isGenericNpcInquiry(text)) {
      return { ok: false, code: "missing_non_focus_npc_dialogue" };
    }
    const referenceCheck = validateNpcSpeechReferencesForSpeaker({
      npc,
      context,
      usedFactIds: entry.usedFactIds,
      usedInteractionActionIds: entry.usedInteractionActionIds,
    });
    if (!referenceCheck.ok) {
      return {
        ok: false,
        code: referenceCheck.code === "invalid_fact_reference"
          ? "npc_uses_forbidden_fact"
          : referenceCheck.code === "invalid_interaction_reference"
            ? "wrong_npc_interaction"
            : "duplicate_npc_reference",
      };
    }
    lines.set(String(entry.npcId), {
      text,
      usedFactIds: [...entry.usedFactIds],
      usedInteractionActionIds: [...entry.usedInteractionActionIds],
    });
  }

  const requiresCoverage = proposal.source === "generated"
    && context.focusNpcContext !== undefined
    && proposal.npcLine !== null
    && context.presentNpcs.length > 1;
  if (requiresCoverage) {
    const expectedIds = context.presentNpcs
      .map((npc) => String(npc.id))
      .filter((npcId) => npcId !== focusNpcId);
    if (expectedIds.length !== lines.size || expectedIds.some((npcId) => !lines.has(npcId))) {
      return { ok: false, code: "missing_non_focus_npc_dialogue" };
    }
  }
  return { ok: true, lines };
}

/** 焦点 NPC 的可见对白至少应是两句可独立阅读的话，不能把开场或回答压成一句。 */
function hasExpandedNpcDialogue(text: string): boolean {
  return normalizeNpcSpeech(text)
    .split(/[。！？!?]+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "")
    .length >= 2;
}

/**
 * 审批 AI 生成的场景表演提案（spec §10.3，Task 6）：
 * - 分段旁白：每个强制节拍恰好一个 segment 且按节拍顺序排列；atmosphere 可选且最后；
 * - NPC 台词：归属在场 NPC，fact/交互引用必须属于该 NPC 的允许集合；
 * - player_utterance 必须由焦点 NPC 应答并列出节拍 ID；
 * - objectiveLink 必须与 ObjectiveTransition.after 一致；
 * - 选项必须来自服务端合法候选、两两不同，且 after 存在时至少一项推进目标；
 * - Task 4：preparedContinuations 逐条复建为 server-authored continuation state；
 * - 通过后逐字段重建 ready scene 与 ApprovedChoice registry；提案对象不直达持久化。
 * 纯函数：不读时钟/随机数/DB（可选 logger 仅为可观测性，不改变结果）。
 */
export function approveScenePerformance(input: {
  readonly context: SceneGenerationContext;
  readonly proposal: ScenePerformanceProposal;
  readonly basedOnRevision: number;
  readonly existingCandidateEventPool: readonly EventCandidate[];
  /** Prepared continuation authority must be derived from this same preview world. */
  readonly worldState?: WorldState;
  /** Task 2：整字段丢弃预生成叙事时记录稳定事件（不拒整场）。 */
  readonly logger?: Pick<GameLogger, "warn">;
}): ApproveScenePerformanceResult {
  const { context } = input;
  const proposal = input.proposal;

  // ── 分段旁白校验 ───────────────────────────────────────────────────────
  if (!Array.isArray(proposal.segments) || proposal.segments.length === 0) {
    return { ok: false, code: "empty_segments" };
  }
  for (const segment of proposal.segments) {
    if (!isRecord(segment)
      || typeof segment.beatId !== "string"
      || segment.beatId === ""
      || typeof segment.text !== "string"
      || segment.text.trim() === "") {
      return { ok: false, code: "empty_segments" };
    }
  }

  const providedBeatIds = new Set<string>([
    ATMOSPHERE_BEAT_ID,
    ...context.mandatoryBeats.map((b) => b.beatId),
  ]);
  // atmosphere 恒为可选尾部节拍，即使 context.mandatoryBeats 中不存在（如开局场景）。
  const atmosphereSet = new Set<string>([ATMOSPHERE_BEAT_ID]);
  const requiredIds = context.mandatoryBeats
    .filter((b) => b.beatId !== ATMOSPHERE_BEAT_ID)
    .map((b) => b.beatId);

  const segmentIds = proposal.segments.map((s) => s.beatId);

  // 1) 自创节拍 ID
  for (const id of segmentIds) {
    if (!providedBeatIds.has(id)) return { ok: false, code: "invented_beat_id" };
  }
  // 2) 每个强制节拍恰好一次
  const counts = new Map<string, number>();
  for (const id of segmentIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of requiredIds) {
    if (counts.get(id) !== 1) return { ok: false, code: "missing_mandatory_beat" };
  }
  // 3) 强制节拍按上下文顺序，atmosphere 只能位于尾部
  const body = segmentIds.slice(0, requiredIds.length);
  for (let i = 0; i < requiredIds.length; i += 1) {
    if (body[i] !== requiredIds[i]) return { ok: false, code: "out_of_order_beats" };
  }
  for (let i = requiredIds.length; i < segmentIds.length; i += 1) {
    if (!atmosphereSet.has(segmentIds[i])) return { ok: false, code: "out_of_order_beats" };
  }

  // ── Task 5：已结算调查结果的叙事一致性校验 ──────────────────────────────
  // 规则层已把玩家所选方式写入 eventLedger（fact_discovered）。表演只能引用
  // 该已结算结果：旁白必须点名所选方式，且不得声称与证据质量相反的动静。
  // 非法正文就地替换为确定性结算旁白（buildInvestigationOutcomeNarrative），
  // 不拒绝规则结果（事件账本/tension 权威归规则层持有）。
  const resolvedInvestigation = context.resolvedInvestigation;
  if (resolvedInvestigation !== undefined) {
    const discoveryBeat = context.mandatoryBeats.find((beat) => beat.kind === "fact_discovered");
    if (discoveryBeat !== undefined) {
      const discoverySegmentIndex = proposal.segments.findIndex((segment) => segment.beatId === discoveryBeat.beatId);
      if (discoverySegmentIndex >= 0) {
        const discoveryText = proposal.segments[discoverySegmentIndex]!.text;
        const contradictsSettledOutcome = resolvedInvestigation.evidenceQuality === "clean"
          ? /(?:留下了动静|动静不小|惊动了什么|声响|响声|吵醒|暴露)/u.test(discoveryText)
          : /(?:没有惊动任何人|干净利落|无声无息|悄无声息)/u.test(discoveryText);
        if (!discoveryText.includes(resolvedInvestigation.approachLabel) || contradictsSettledOutcome) {
          return { ok: false, code: "invalid_investigation_narrative" };
        }
      }
    }
  }

  // ── NPC 台词校验 ────────────────────────────────────────────────────────
  const npcLine = proposal.npcLine;
  if (npcLine !== null) {
    if (!isRecord(npcLine)
      || typeof npcLine.npcId !== "string"
      || typeof npcLine.text !== "string"
      || npcLine.text.trim() === ""
      || typeof npcLine.emotion !== "string") {
      return { ok: false, code: "unknown_dialogue_npc" };
    }
    if (!Array.isArray(npcLine.usedFactIds) || !Array.isArray(npcLine.usedInteractionActionIds)) {
      return { ok: false, code: "unknown_dialogue_npc" };
    }
    const present = context.presentNpcs.find((n) => String(n.id) === String(npcLine.npcId));
    if (present === undefined) return { ok: false, code: "unknown_dialogue_npc" };
    // 焦点 NPC 的开场、正式回应和终局追问都必须至少两句。提示词本身
    // 不足以防止 live output 偶尔退化成一句泛问候，因此把这一玩家可见
    // 质量门槛放进审批；不合格时返回稳定审批失败。
    const isFocusedNpc = context.focusNpcContext !== undefined
      && String(context.focusNpcContext.id) === String(npcLine.npcId);
    if (isFocusedNpc) {
      if (!hasExpandedNpcDialogue(npcLine.text)) return { ok: false, code: "npc_dialogue_too_short" };
    }
    const referenceCheck = validateNpcSpeechReferencesForSpeaker({
      npc: present,
      context,
      usedFactIds: npcLine.usedFactIds,
      usedInteractionActionIds: npcLine.usedInteractionActionIds,
    });
    if (!referenceCheck.ok) {
      return {
        ok: false,
        code: referenceCheck.code === "invalid_fact_reference"
          ? "npc_uses_forbidden_fact"
          : referenceCheck.code === "invalid_interaction_reference"
            ? "wrong_npc_interaction"
            : "duplicate_npc_reference",
      };
    }
  }

  const generatedNpcDialogues = buildGeneratedNpcDialogueMap(
    proposal,
    context,
    npcLine === null ? undefined : String(npcLine.npcId),
  );
  if (!generatedNpcDialogues.ok) return generatedNpcDialogues;

  const handoffFocusNpcId = context.objectiveTransition.mode === "advanced_act"
    ? context.focusNpcContext?.id
    : undefined;
  if (handoffFocusNpcId !== undefined
    && (npcLine === null || String(npcLine.npcId) !== String(handoffFocusNpcId))) {
    return { ok: false, code: "handoff_npc_unanswered" };
  }

  // Task 5 Step 4：player_utterance 应答钩子。有玩家原话节拍时，提案必须由
  // 实际被玩家交谈的 NPC 应答并显式列出节拍 ID；幕交接中的新目标 NPC
  // 不能篡改成这句话的收件人。
  const utteranceBeat = context.mandatoryBeats.find((b) => b.kind === "player_utterance");
  if (utteranceBeat !== undefined) {
    const focusNpcId = utteranceBeat.subjectIds[0];
    if (npcLine === null
      || String(npcLine.npcId) !== String(focusNpcId)
      || !(npcLine.answeredBeatIds ?? []).includes(utteranceBeat.beatId)) {
      return { ok: false, code: "player_utterance_unanswered" };
    }
    // 先确认说话者确实是本轮的对象，再执行长度门槛。这样错把旧问题交给
    // 另一名 NPC 时仍稳定报告归属错误，而不是被单句问题掩盖。
    if (!hasExpandedNpcDialogue(npcLine.text)) return { ok: false, code: "npc_dialogue_too_short" };
  }

  // 移动抵达后若权威目标已经是当前地点的 NPC，必须使用已生成的目标首句；
  // 不能让 fast path 以 npcLine=null 写回，再由 read model 合成 fallback。
  const moveArrivalNpc = proposal.source === "generated"
    && context.job.actionSummary.kind === "move"
    && context.objectiveTarget !== null
    ? context.presentNpcs.find((npc) => String(npc.id) === String(context.objectiveTarget?.entityId))
    : undefined;
  if (moveArrivalNpc !== undefined
    && (npcLine === null || String(npcLine.npcId) !== String(moveArrivalNpc.id))) {
    return { ok: false, code: "missing_arrival_npc_dialogue" };
  }

  // generated 场景只要有明确的焦点 NPC，就必须写入该 NPC 的真实台词。
  // 如果允许 npcLine=null，buildNpcDialoguePages 会在写回后合成 fallback
  // 问候，导致“抵达下一目标”看似成功却丢失剧情交接。对白回合保留原
  // focusNpcId；非对白回合的 focusNpcId 已由 context 切到当前目标 NPC。
  const generatedFocusNpc = proposal.source === "generated"
    ? context.focusNpcContext
    : undefined;
  if (generatedFocusNpc !== undefined
    && (npcLine === null || String(npcLine.npcId) !== String(generatedFocusNpc.id))) {
    return { ok: false, code: "missing_focus_npc_dialogue" };
  }

  // ── 目标一致性：objectiveLink 必须匹配 after ────────────────────────────
  const after = context.objectiveTransition.after;
  const objectiveLink = proposal.objectiveLink;
  if (after === null) {
    if (objectiveLink !== null) return { ok: false, code: "stale_objective_link" };
  } else {
    if (objectiveLink === null
      || typeof objectiveLink.objectiveIndex !== "number"
      || !["hint", "progress", "handoff"].includes(objectiveLink.mode)
      || String(objectiveLink.questId) !== String(after.questId)
      || objectiveLink.objectiveIndex !== after.objectiveIndex) {
      return { ok: false, code: "stale_objective_link" };
    }
  }

  // ── 选项校验：合法候选、两两不同、目标推进 ───────────────────────────────
  // NPC 本轮台词是在 proposal 中才最终确定的。对白选项必须锚定这句
  // 当前台词，不能继续使用 context.previousDialogue 的上一轮原话。
  const selectable = buildSelectableSceneCandidates(context, npcLine === null ? undefined : npcLine);
  const candidateById = new Map(selectable.map((c) => [c.candidateId, c]));

  const finalDialogueHandoff = isFinalDialogueHandoff(context);
  const localHandoff = finalDialogueHandoff && proposal.handoffAcknowledgement !== undefined;
  const expectedChoiceCount = localHandoff ? 0 : finalDialogueHandoff ? 1 : 2;
  if (!Array.isArray(proposal.choices) || proposal.choices.length !== expectedChoiceCount) {
    return { ok: false, code: "illegal_choice_target" };
  }
  const [a, b] = proposal.choices;
  if (localHandoff) {
    if (proposal.handoffAcknowledgement.trim() === "") return { ok: false, code: "illegal_choice_target" };
  }
  if (!localHandoff && (!isRecord(a)
    || typeof a.candidateId !== "string"
    || typeof a.label !== "string"
    || a.label.trim() === ""
    || (!finalDialogueHandoff && (!isRecord(b)
      || typeof b.candidateId !== "string"
      || typeof b.label !== "string"
      || b.label.trim() === "")))) {
    return { ok: false, code: "illegal_choice_target" };
  }
  if (!localHandoff && !finalDialogueHandoff && String(a?.candidateId) === String(b?.candidateId)) {
    return { ok: false, code: "duplicate_candidate_ids" };
  }
  const ca = localHandoff ? undefined : candidateById.get(String(a?.candidateId));
  const cb = localHandoff || finalDialogueHandoff || b === undefined
    ? undefined
    : candidateById.get(String(b.candidateId));
  if (!localHandoff && (ca === undefined || (!finalDialogueHandoff && cb === undefined))) return { ok: false, code: "illegal_choice_target" };

  // 生成路径不能把本回合生成前的两个 fixture talk label 原样带回。
  // 只拦 generated，避免 live 响应复用离线模板。
  if (
    proposal.source === "generated"
    && npcLine !== null
    && !localHandoff
    && (
      usesFallbackDialogueChoiceLabels(buildSelectableSceneCandidates(context), [a, ...(b === undefined ? [] : [b])])
      || usesFallbackDialogueChoiceLabels(selectable, [a, ...(b === undefined ? [] : [b])])
    )
  ) {
    return { ok: false, code: "stale_choice_template" };
  }

  if (!localHandoff && !finalDialogueHandoff && cb !== undefined && ca !== undefined && semanticSummaryOf(ca.action) === semanticSummaryOf(cb.action)) {
    return { ok: false, code: "semantic_duplicate_choices" };
  }

  // 移动抵达后若当前权威目标是现场 NPC，场景已进入该 NPC 的对话入口。
  // 两个已批准选项都必须是该 NPC 的 talk，不能让一个离开/探索动作混入
  // 对话框，绕过“每个对话选项都应有剧情推进意义”的契约。
  const focusedArrivalObjectiveNpc = context.job.actionSummary.kind === "move"
    && context.objectiveTarget !== null
    ? context.presentNpcs.find((npc) => String(npc.id) === String(context.objectiveTarget?.entityId))
    : undefined;
  const selectedActions = [
    ...(ca === undefined ? [] : [ca.action]),
    ...(cb === undefined ? [] : [cb.action]),
  ];
  if (focusedArrivalObjectiveNpc !== undefined
    && !selectedActions.every((action) =>
      action.type === "talk" && String(action.npcId) === String(focusedArrivalObjectiveNpc.id))) {
    return { ok: false, code: "focused_dialogue_requires_talk_choices" };
  }

  // Step 4：after 存在且有可推进的合法候选时，至少一个选中选项必须推进目标。
  const objectiveTarget = context.objectiveTarget;
  if (!localHandoff && after !== null && objectiveTarget !== null) {
    const progressCapableExists = selectable.some(
      (c) => actionTargetsObjective(c.action, objectiveTarget.entityId),
    );
    if (progressCapableExists) {
      const chosenProgresses = selectedActions.some(
        (action) => actionTargetsObjective(action, objectiveTarget.entityId),
      );
      if (!chosenProgresses) return { ok: false, code: "no_objective_progress_choices" };
    }
  }

  // 叙事 grounding 质量诊断：目标身份由 objectiveLink 与稳定实体 ID
  // 决定；普通场景不因旁白未逐字包含 entityName 拒绝，handoff 的目标引用
  // 则必须存在，否则交给同一 pending 回合的内容修复。
  const qualityWarnings: SceneQualityWarningCode[] = [];
  if (context.objectiveTransition.mode === "advanced_act" && objectiveTarget !== null) {
    const advancedBeat = context.mandatoryBeats.find((b) => b.kind === "quest_advanced");
    const advancedSegment = advancedBeat !== undefined
      ? proposal.segments.find((s) => s.beatId === advancedBeat.beatId)
      : undefined;
    if (advancedSegment === undefined || advancedSegment.text.trim() === "") {
      qualityWarnings.push("missing_objective_surface");
    } else {
      const allowedReferenceIds = new Set((context.narrativeReferenceIds ?? []).map(String));
      const referencedEntityIds = advancedSegment.referencedEntityIds ?? [];
      if (referencedEntityIds.some((id: string) => !allowedReferenceIds.has(String(id)))) {
        qualityWarnings.push("invalid_objective_reference");
      }
      if (!referencedEntityIds.some((id: string) => String(id) === String(objectiveTarget.entityId))) {
        qualityWarnings.push("missing_objective_reference");
      }
    }
  }
  if (
    context.objectiveTransition.mode === "advanced_act"
    && objectiveTarget !== null
    && (qualityWarnings.includes("missing_objective_surface") || qualityWarnings.includes("missing_objective_reference"))
  ) {
    return { ok: false, code: "handoff_missing_objective_reference" };
  }

  // ── 铸造 registry 与 ready scene ─────────────────────────────────────────
  const approvedA = ca === undefined || a === undefined
    ? null
    : createApprovedChoice({
    sceneId: proposal.sceneId,
    basedOnRevision: input.basedOnRevision,
    // candidateId/action 由服务端候选集决定；对白 label 可以由 live source
    // 根据同一份故事上下文润色，审批只重新套用直接对白/动作格式契约。
    label: approvedChoiceLabel(ca.action, a.label, ca.label, [
      ...(npcLine === null ? [] : [npcLine.text]),
      ...(context.previousDialogue === undefined ? [] : [context.previousDialogue.npcLine]),
    ]),
    action: ca.action,
  });
  const approvedB = cb === undefined || b === undefined
    ? null
    : createApprovedChoice({
        sceneId: proposal.sceneId,
        basedOnRevision: input.basedOnRevision,
        label: approvedChoiceLabel(cb.action, b.label, cb.label, [
          ...(npcLine === null ? [] : [npcLine.text]),
          ...(context.previousDialogue === undefined ? [] : [context.previousDialogue.npcLine]),
        ]),
        action: cb.action,
      });
  if ((approvedA !== null && !approvedA.ok) || (approvedB !== null && !approvedB.ok)
    || (approvedA !== null && approvedB !== null && approvedA.choice.choiceToken === approvedB.choice.choiceToken)) {
    return { ok: false, code: "illegal_choice_target" };
  }
  const approvedChoices = approvedA === null
    ? []
    : approvedB === null
      ? [approvedA.choice]
      : [approvedA.choice, approvedB.choice];

  const narration = proposal.segments.map((s) => s.text).join("\n");
  const rebuiltNpcLine = npcLine === null ? null : rebuildNpcLine(npcLine, context.presentNpcs);
  const builtNpcDialogues = context.presentNpcs.length > 0
    ? buildNpcDialoguePages(context.presentNpcs, {
      focusNpcId: rebuiltNpcLine?.npcId,
      focusSpeech: rebuiltNpcLine?.text,
      generatedNpcLines: new Map(
        [...generatedNpcDialogues.lines.entries()].map(([id, line]) => [id, line.text]),
      ),
      speechSource: proposal.source,
    })
    : undefined;
  const npcDialogues = builtNpcDialogues?.map((dialogue) => {
    const references = dialogue.npcId === rebuiltNpcLine?.npcId
      ? {
        usedFactIds: (rebuiltNpcLine?.usedFactIds ?? []).map((id) => asFactId(String(id))),
        usedInteractionActionIds: rebuiltNpcLine?.usedInteractionActionIds ?? [],
      }
      : (() => {
        const line = generatedNpcDialogues.lines.get(String(dialogue.npcId));
        return line === undefined ? undefined : {
          ...line,
          usedFactIds: line.usedFactIds.map((id) => asFactId(id)),
        };
      })();
    return references === undefined ? dialogue : { ...dialogue, ...references };
  });
  const scene: NarrativeSceneState = {
    sceneId: proposal.sceneId,
    turn: context.job.turnNumber,
    narration,
    usedFactIds: rebuiltNpcLine?.usedFactIds ?? [],
    npcLine: rebuiltNpcLine,
    choices: approvedChoices.map((choice) => ({
      choiceToken: choice.choiceToken,
      label: choice.label,
    })),
    ...(proposal.handoffAcknowledgement === undefined
      ? {}
      : { handoffAcknowledgement: proposal.handoffAcknowledgement.trim() }),
    source: proposal.source,
    event: rebuildEvent(buildEventState(context)),
    ...(npcDialogues === undefined ? {} : { npcDialogues }),
  };

  const preparedApproval = approvePreparedContinuation({
    originJobId: context.job.jobId,
    proposals: proposal.preparedContinuations ?? [],
    descriptors: context.preparedStepDescriptors ?? [],
    activeStepIds: context.preparedActiveStepIds ?? [],
    ...(input.worldState === undefined ? {} : { worldState: input.worldState }),
  });
  if (!preparedApproval.ok) return { ok: false, code: "invalid_prepared_continuation" };

  return {
    ok: true,
    scene,
    choiceRegistry: approvedChoices,
    // 场景表演契约不含候选事件：池原样保留，事件生命周期由独立审批处理。
    candidateEventPool: [...input.existingCandidateEventPool],
    preparedContinuation: preparedApproval.prepared,
    qualityWarnings,
  };
}

/**
 * live 可以润色对白，但不能把 NPC 整句原话再次塞进玩家嘴里。这里仅做
 * 精确重复保护，不做主题关键词匹配；候选动作和 fixture 文案仍由服务端
 * 提供，避免把一次文案质量问题扩大成整场审批失败。
 */
function approvedChoiceLabel(
  action: ApprovedChoice["action"],
  proposedLabel: string,
  fallbackLabel: string,
  npcLines: readonly string[],
): string {
  const formatted = formatSceneChoiceLabel(action, proposedLabel);
  if (action.type !== "talk") return formatted;
  if (!npcLines.some((line) => compactDialogueText(formatted) === compactDialogueText(line))) return formatted;
  return formatSceneChoiceLabel(action, fallbackLabel);
}

function compactDialogueText(text: string): string {
  return text.replace(/[\s“”"「」『』。！？!?，,；;：:、（）()]/gu, "");
}
