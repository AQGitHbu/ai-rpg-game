import { parseEventCandidate } from "@/game/domain/candidateEvent";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type { EventProposal, ScenePerformanceProposal, ScenePerformanceNpcLine } from "./sceneSource";
import type { NarrativeEventState, NarrativeNpcLineState, NarrativeSceneState } from "@/game/domain/narrative";
import { buildNpcDialoguePages } from "@/game/domain/narrative";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { ApprovedChoice } from "@/game/domain/approvedChoice";
import { createApprovedChoice, semanticSummaryOf } from "@/game/domain/approvedChoice";
import {
  buildEventState,
  buildSelectableSceneCandidates,
  actionTargetsObjective,
  formatSceneChoiceLabel,
  usesFallbackDialogueChoiceLabels,
} from "./deterministicSceneSource";
import { asFactId, asNpcId } from "@/game/domain/worldEntity";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import { normalizeNpcSpeech } from "@/game/domain/npcSpeech";

// ---------------------------------------------------------------------------
// R4（Task 21）：候选事件池审批 + Task 6：场景表演契约审批。
// 只做 schema 解析与结构校验，绝不在写回阶段改动 World State / tension /
// 任务 / 关系，也绝不立即执行候选。核心结构非法 → 整场回退确定性源。
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
// 核心结构非法 → 整场回退确定性 source；fallback 同样经过本函数，防止契约漂移。
// ---------------------------------------------------------------------------

/** 场景核心结构非法时整场回退的原因。 */
export type SceneRejectionCode =
  | "empty_segments"
  | "invented_beat_id"
  | "missing_mandatory_beat"
  | "out_of_order_beats"
  | "unknown_dialogue_npc"
  | "npc_uses_forbidden_fact"
  | "wrong_npc_interaction"
  | "player_utterance_unanswered"
  | "npc_dialogue_too_short"
  | "stale_objective_link"
  | "quest_advanced_unnamed"
  | "stale_choice_template"
  | "semantic_duplicate_choices"
  | "duplicate_candidate_ids"
  | "illegal_choice_target"
  | "no_objective_progress_choices";

export type ApprovedSceneWriteBack = {
  readonly scene: NarrativeSceneState;
  readonly choiceRegistry: readonly ApprovedChoice[];
  readonly candidateEventPool: readonly EventCandidate[];
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
    answeredBeatIds: [...line.answeredBeatIds],
  };
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
 * - 通过后逐字段重建 ready scene 与 ApprovedChoice registry；提案对象不直达持久化。
 * 纯函数：不读时钟/随机数/DB。
 */
export function approveScenePerformance(input: {
  readonly context: SceneGenerationContext;
  readonly proposal: ScenePerformanceProposal;
  readonly basedOnRevision: number;
  readonly existingCandidateEventPool: readonly EventCandidate[];
}): ApproveScenePerformanceResult {
  const { context, proposal } = input;

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
    const present = context.presentNpcs.find((n) => String(n.id) === String(npcLine.npcId));
    if (present === undefined) return { ok: false, code: "unknown_dialogue_npc" };
    // 焦点 NPC 的开场、正式回应和终局追问都必须至少两句。提示词本身
    // 不足以防止 live output 偶尔退化成一句泛问候，因此把这一玩家可见
    // 质量门槛放进审批；不合格时整场走角色化的确定性 fallback。
    const isFocusedNpc = context.focusNpcContext !== undefined
      && String(context.focusNpcContext.id) === String(npcLine.npcId);
    if (isFocusedNpc) {
      if (!hasExpandedNpcDialogue(npcLine.text)) return { ok: false, code: "npc_dialogue_too_short" };
    }
    const allowed = new Set<string>([
      ...present.knownFactCards.map((f) => String(f.factId)),
      ...present.sceneVisibleFactIds.map(String),
    ]);
    const interactionActionIds = new Set<string>(present.recentInteractionActionIds.map(String));
    for (const factId of npcLine.usedFactIds ?? []) {
      if (!allowed.has(String(factId))) return { ok: false, code: "npc_uses_forbidden_fact" };
    }
    for (const actionId of npcLine.usedInteractionActionIds ?? []) {
      if (!interactionActionIds.has(String(actionId))) return { ok: false, code: "wrong_npc_interaction" };
    }
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

  if (!Array.isArray(proposal.choices) || proposal.choices.length !== 2) {
    return { ok: false, code: "illegal_choice_target" };
  }
  const [a, b] = proposal.choices as readonly [
    { readonly candidateId: string; readonly label: string },
    { readonly candidateId: string; readonly label: string },
  ];
  if (!isRecord(a) || !isRecord(b)
    || typeof a.candidateId !== "string"
    || typeof b.candidateId !== "string"
    || typeof a.label !== "string"
    || a.label.trim() === ""
    || typeof b.label !== "string"
    || b.label.trim() === "") {
    return { ok: false, code: "illegal_choice_target" };
  }
  if (String(a.candidateId) === String(b.candidateId)) {
    return { ok: false, code: "duplicate_candidate_ids" };
  }
  const ca = candidateById.get(String(a.candidateId));
  const cb = candidateById.get(String(b.candidateId));
  if (ca === undefined || cb === undefined) return { ok: false, code: "illegal_choice_target" };

  // 生成路径不能把本回合生成前的两个 deterministic talk label 原样带回。
  // fallback proposal 自身就是这些 label 的权威来源，因此只拦 generated，
  // 避免安全降级被审批器再次拒绝。
  if (
    proposal.source === "generated"
    && npcLine !== null
    && context.previousDialogue !== undefined
    && usesFallbackDialogueChoiceLabels(buildSelectableSceneCandidates(context), [a, b])
  ) {
    return { ok: false, code: "stale_choice_template" };
  }

  if (semanticSummaryOf(ca.action) === semanticSummaryOf(cb.action)) {
    return { ok: false, code: "semantic_duplicate_choices" };
  }

  // Step 4：after 存在且有可推进的合法候选时，至少一个选中选项必须推进目标。
  const objectiveTarget = context.objectiveTarget;
  if (after !== null && objectiveTarget !== null) {
    const progressCapableExists = selectable.some(
      (c) => actionTargetsObjective(c.action, objectiveTarget.entityId),
    );
    if (progressCapableExists) {
      const chosenProgresses = [ca.action, cb.action].some(
        (action) => actionTargetsObjective(action, objectiveTarget.entityId),
      );
      if (!chosenProgresses) return { ok: false, code: "no_objective_progress_choices" };
    }
  }

  // Step 4：幕推进时 quest_advanced segment 必须点名新目标实体。
  if (context.objectiveTransition.mode === "advanced_act" && objectiveTarget !== null) {
    const advancedBeat = context.mandatoryBeats.find((b) => b.kind === "quest_advanced");
    const advancedSegment = advancedBeat !== undefined
      ? proposal.segments.find((s) => s.beatId === advancedBeat.beatId)
      : undefined;
    if (advancedSegment === undefined || !advancedSegment.text.includes(objectiveTarget.entityName)) {
      return { ok: false, code: "quest_advanced_unnamed" };
    }
  }

  // ── 铸造 registry 与 ready scene ─────────────────────────────────────────
  const approvedA = createApprovedChoice({
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
  const approvedB = createApprovedChoice({
    sceneId: proposal.sceneId,
    basedOnRevision: input.basedOnRevision,
    label: approvedChoiceLabel(cb.action, b.label, cb.label, [
      ...(npcLine === null ? [] : [npcLine.text]),
      ...(context.previousDialogue === undefined ? [] : [context.previousDialogue.npcLine]),
    ]),
    action: cb.action,
  });
  if (!approvedA.ok || !approvedB.ok || approvedA.choice.choiceToken === approvedB.choice.choiceToken) {
    return { ok: false, code: "illegal_choice_target" };
  }

  const narration = proposal.segments.map((s) => s.text).join("\n");
  const rebuiltNpcLine = npcLine === null ? null : rebuildNpcLine(npcLine, context.presentNpcs);
  const scene: NarrativeSceneState = {
    sceneId: proposal.sceneId,
    turn: context.job.turnNumber,
    narration,
    usedFactIds: rebuiltNpcLine?.usedFactIds ?? [],
    npcLine: rebuiltNpcLine,
    choices: [
      { choiceToken: approvedA.choice.choiceToken, label: approvedA.choice.label },
      { choiceToken: approvedB.choice.choiceToken, label: approvedB.choice.label },
    ],
    source: proposal.source,
    event: rebuildEvent(buildEventState(context)),
    ...(context.presentNpcs.length > 0
      ? {
          npcDialogues: buildNpcDialoguePages(context.presentNpcs, {
            focusNpcId: rebuiltNpcLine?.npcId,
            focusSpeech: rebuiltNpcLine?.text,
          }),
        }
      : {}),
  };

  return {
    ok: true,
    scene,
    choiceRegistry: [approvedA.choice, approvedB.choice],
    // 场景表演契约不含候选事件：池原样保留，事件生命周期由独立审批处理。
    candidateEventPool: [...input.existingCandidateEventPool],
  };
}

/**
 * live 可以润色对白，但不能把 NPC 整句原话再次塞进玩家嘴里。这里仅做
 * 精确重复保护，不做主题关键词匹配；候选动作和 fallback 文案仍由服务端
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
