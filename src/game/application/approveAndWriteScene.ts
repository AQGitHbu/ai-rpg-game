import { parseEventCandidate } from "@/game/domain/candidateEvent";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type { EventProposal, ScenePerformanceProposal, ScenePerformanceNpcLine } from "./sceneSource";
import type { NarrativeEventState, NarrativeNpcLineState, NarrativeSceneState } from "@/game/domain/narrative";
import { buildNpcDialoguePages } from "@/game/domain/narrative";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { ApprovedChoice, ChoiceProposal } from "@/game/domain/approvedChoice";
import { createApprovedChoice, semanticSummaryOf } from "@/game/domain/approvedChoice";
import { buildEventState, buildSelectableSceneCandidates, actionTargetsObjective } from "./deterministicSceneSource";
import type { Action } from "@/game/domain/action";
import { DIALOGUE_ACTS } from "@/game/domain/action";
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
  | "stale_objective_link"
  | "quest_advanced_unnamed"
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

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isDialogueTopic(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "general": return hasOnlyKeys(value, ["kind"]);
    case "fact": return hasOnlyKeys(value, ["kind", "factId"]) && isNonEmptyString(value.factId);
    case "quest": return hasOnlyKeys(value, ["kind", "questId"]) && isNonEmptyString(value.questId);
    case "thread": return hasOnlyKeys(value, ["kind", "threadId"]) && isNonEmptyString(value.threadId);
    default: return false;
  }
}

/** SceneSource output is untrusted at runtime even when its TypeScript port says Action. */
function isWellFormedAction(value: unknown): value is Action {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "talk":
      return hasOnlyKeys(value, ["type", "npcId", "dialogueAct", "topic", "utterance"])
        && isNonEmptyString(value.npcId)
        && typeof value.dialogueAct === "string"
        && DIALOGUE_ACTS.includes(value.dialogueAct as (typeof DIALOGUE_ACTS)[number])
        && (value.topic === undefined || isDialogueTopic(value.topic))
        && (value.utterance === undefined || typeof value.utterance === "string");
    case "move": return hasOnlyKeys(value, ["type", "locationId"]) && isNonEmptyString(value.locationId);
    case "explore": return hasOnlyKeys(value, ["type"]);
    case "investigate":
      return hasOnlyKeys(value, ["type", "factId", "utterance"])
        && isNonEmptyString(value.factId)
        && (value.utterance === undefined || typeof value.utterance === "string");
    case "take_item": return hasOnlyKeys(value, ["type", "itemId"]) && isNonEmptyString(value.itemId);
    case "give_item": return hasOnlyKeys(value, ["type", "itemId", "npcId"]) && isNonEmptyString(value.itemId) && isNonEmptyString(value.npcId);
    case "attack": return hasOnlyKeys(value, ["type", "enemyId"]) && isNonEmptyString(value.enemyId);
      case "battle_action":
        return hasOnlyKeys(value, ["type", "action"])
          && (value.action === "attack" || value.action === "skill" || value.action === "guard" || value.action === "flee");
    case "ack_prologue": return hasOnlyKeys(value, ["type"]);
    case "freeform":
      return hasOnlyKeys(value, ["type", "intent", "rawText"])
        && typeof value.intent === "string"
        && typeof value.rawText === "string";
    default: return false;
  }
}

/** 候选选项形状校验（供非新契约路径保留）。 */
function isWellFormedChoiceProposal(value: unknown): value is ChoiceProposal {
  return isRecord(value)
    && hasOnlyKeys(value, ["label", "hint", "action"])
    && typeof value.label === "string"
    && (value.hint === undefined || typeof value.hint === "string")
    && isWellFormedAction(value.action);
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

  // Task 5 Step 4：player_utterance 应答钩子。有玩家原话节拍时，提案必须由焦点
  // NPC 出场应答并显式列出应答的节拍 ID；缺台词/错 NPC/未列出 ID → 整场拒绝。
  const utteranceBeat = context.mandatoryBeats.find((b) => b.kind === "player_utterance");
  if (utteranceBeat !== undefined) {
    const focusNpcId = utteranceBeat.subjectIds[0];
    // 幕交接时，玩家上一回合是在旧 NPC 面前发问，但新一幕的权威目标
    // NPC 才是当前场景焦点。允许这个明确的交接 NPC 承接原话，避免
    // deterministic fallback 因“回答错 NPC”被拒绝后把 generation 永久留在 pending。
    const handoffNpcId = context.objectiveTransition.mode === "advanced_act"
      && context.objectiveTarget !== null
      && context.focusNpcContext !== undefined
      && String(context.focusNpcContext.id) === String(context.objectiveTarget.entityId)
      ? context.focusNpcContext.id
      : undefined;
    const answerNpcId = handoffNpcId ?? focusNpcId;
    if (npcLine === null
      || String(npcLine.npcId) !== String(answerNpcId)
      || !(npcLine.answeredBeatIds ?? []).includes(utteranceBeat.beatId)) {
      return { ok: false, code: "player_utterance_unanswered" };
    }
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
  const selectable = buildSelectableSceneCandidates(context);
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
    label: a.label,
    action: ca.action,
  });
  const approvedB = createApprovedChoice({
    sceneId: proposal.sceneId,
    basedOnRevision: input.basedOnRevision,
    label: b.label,
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
