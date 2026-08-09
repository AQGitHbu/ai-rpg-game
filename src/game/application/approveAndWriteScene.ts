import { parseEventCandidate } from "@/game/domain/candidateEvent";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type { EventProposal, ScenePackageProposal } from "./sceneSource";
import type { NarrativeEventState, NarrativeNpcLineState, NarrativeSceneState } from "@/game/domain/narrative";
import { buildNpcDialoguePages } from "@/game/domain/narrative";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { ApprovedChoice, ChoiceProposal } from "@/game/domain/approvedChoice";
import { createApprovedChoice, semanticSummaryOf } from "@/game/domain/approvedChoice";
import { actionFromLegalCandidate } from "./deterministicSceneSource";
import type { Action } from "@/game/domain/action";
import { DIALOGUE_ACTS } from "@/game/domain/action";

// ---------------------------------------------------------------------------
// R4（Task 21）：SceneSource 提议 → 候选事件池审批
// 只做 schema 解析与池生命周期（去重 + FIFO 上限），绝不在写回阶段改动
// World State / tension / 任务 / 关系，也绝不立即执行候选。
// ---------------------------------------------------------------------------

/** 候选事件池 FIFO 上限（Spec §11.3）。 */
export const POOL_MAX_CANDIDATES = 8;

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
    // 1) 同 ID 去重：池内已存在 → 拒绝
    if (poolIds.has(proposal.id)) {
      rejected.push({ id: proposal.id, reasonCode: "duplicate_id" });
      continue;
    }

    // 2) 夹带任意 path patch（封闭 union 之外）→ 明确分类拒绝
    if (containsPathPatch(proposal)) {
      rejected.push({ id: proposal.id, reasonCode: "path_patch" });
      continue;
    }

    // 3) schema 解析：非法（无执行效果/未知 kind/引用缺失）→ 丢弃但记录分类
    const parsed = parseEventCandidate(proposal);
    if (!parsed.ok) {
      rejected.push({ id: proposal.id, reasonCode: "invalid_schema" });
      continue;
    }

    // 4) 合法候选入池
    nextPool = [...nextPool, parsed.candidate];
    poolIds.add(parsed.candidate.id);
    acceptedIds.push(parsed.candidate.id);
  }

  // FIFO 上限：超出从池头裁剪（保留最新的 N 条）
  if (nextPool.length > POOL_MAX_CANDIDATES) {
    nextPool = nextPool.slice(nextPool.length - POOL_MAX_CANDIDATES);
  }

  return { ok: true, nextCandidateEventPool: nextPool, acceptedIds, rejected };
}

/** 检测候选效果是否为封闭 union 之外的任意 path patch。 */
function containsPathPatch(candidate: EventCandidate): boolean {
  return candidate.proposedEffects.some((effect) => {
    const e = effect as unknown as { path?: unknown };
    // 合法的封闭 union effect 均不含 path 字段；任何携带 path 的直接状态写入视为 path patch
    return e.path !== undefined;
  });
}

// ---------------------------------------------------------------------------
// R5（Task 25）：完整场景包审批（narration/dialogue/choices/forbidden facts）
// 核心结构非法 → 整场 fallback；非核心非法（单个选项/候选）→ 丢弃保留合法场景。
// ---------------------------------------------------------------------------

/** 场景核心结构非法时整场回退的原因。 */
export type SceneRejectionCode =
  | "empty_narration"
  | "unknown_dialogue_npc"
  | "npc_uses_forbidden_fact"
  | "semantic_duplicate_choices"
  | "illegal_choice_target"
  | "illegal_event_target"
  | "invalid_choice_action";

export type ApprovedSceneWriteBack = {
  readonly scene: NarrativeSceneState;
  readonly choiceRegistry: readonly ApprovedChoice[];
  readonly candidateEventPool: readonly EventCandidate[];
};

export type ApproveScenePackageResult =
  | ({ readonly ok: true } & ApprovedSceneWriteBack)
  | { readonly ok: false; readonly code: SceneRejectionCode };

/** 对话场景只允许对焦点 NPC 提出两个不同 dialogueAct；其余场景必须命中服务端合法候选。 */
function isLegalChoiceTarget(
  context: SceneGenerationContext,
  event: NarrativeEventState,
  choice: ChoiceProposal,
): boolean {
  if (event.kind === "dialogue") {
    const focusTalkIsCurrentlyLegal = context.legalActionCandidates.some(
      (candidate) => candidate.kind === "talk" && candidate.targetId === String(event.focusNpcId),
    );
    return focusTalkIsCurrentlyLegal
      && choice.action.type === "talk"
      && choice.action.npcId === event.focusNpcId;
  }
  return context.legalActionCandidates.some((candidate) => {
    const legalAction = actionFromLegalCandidate(candidate);
    return legalAction !== null && semanticSummaryOf(legalAction) === semanticSummaryOf(choice.action);
  });
}

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
    case "attack": return hasOnlyKeys(value, ["type", "enemyId"]) && isNonEmptyString(value.enemyId);
    case "battle_action":
      return hasOnlyKeys(value, ["type", "action"])
        && (value.action === "attack" || value.action === "guard" || value.action === "flee");
    case "rest": return hasOnlyKeys(value, ["type"]);
    case "ack_prologue": return hasOnlyKeys(value, ["type"]);
    case "freeform":
      return hasOnlyKeys(value, ["type", "intent", "rawText"])
        && typeof value.intent === "string"
        && typeof value.rawText === "string";
    default: return false;
  }
}

function isWellFormedChoiceProposal(value: unknown): value is ChoiceProposal {
  return isRecord(value)
    && hasOnlyKeys(value, ["label", "hint", "action"])
    && typeof value.label === "string"
    && (value.hint === undefined || typeof value.hint === "string")
    && isWellFormedAction(value.action);
}

function includesId(ids: readonly unknown[], target: unknown): boolean {
  return typeof target === "string" && ids.some((id) => String(id) === target);
}

/** Event target must be both structurally valid and present in the authority-only context. */
function isLegalEventTarget(context: SceneGenerationContext, value: unknown): value is NarrativeEventState {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "dialogue":
      return hasOnlyKeys(value, ["kind", "focusNpcId"])
        && isNonEmptyString(value.focusNpcId)
        && context.presentNpcs.some((npc) => String(npc.id) === value.focusNpcId);
    case "investigate":
      return hasOnlyKeys(value, ["kind", "factId"])
        && includesId(context.legalEventTargets.factIds, value.factId);
    case "item":
      return hasOnlyKeys(value, ["kind", "itemId"])
        && includesId(context.legalEventTargets.itemIds, value.itemId);
    case "battle":
      return hasOnlyKeys(value, ["kind", "enemyId"])
        && includesId(context.legalEventTargets.enemyIds, value.enemyId);
    case "travel":
    case "observe":
      return hasOnlyKeys(value, ["kind", "locationId"])
        && includesId(context.legalEventTargets.locationIds, value.locationId);
    default: return false;
  }
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

function rebuildNpcLine(line: NarrativeNpcLineState | null): NarrativeNpcLineState | null {
  return line === null ? null : {
    npcId: line.npcId,
    text: line.text,
    emotion: line.emotion,
    usedFactIds: [...line.usedFactIds],
  };
}

/**
 * 审批 AI 生成的场景包（spec §10.3）：
 * - 旁白为空 → 整场拒绝（fallback）；
 * - 台词 NPC 不在场 → 整场拒绝；
 * - NPC 使用 forbidden fact（不在其 known/scene-visible 允许集合）→ 整场拒绝；
 * - 两选项语义重复 → 整场拒绝；
 * - 选项目标非法 → 整场拒绝；
 * - 通过后逐字段重建 ready scene 与 ApprovedChoice registry；提案对象不直达持久化。
 * 纯函数：不读时钟/随机数/DB。
 */
export function approveScenePackage(input: {
  readonly context: SceneGenerationContext;
  readonly proposal: ScenePackageProposal;
  readonly basedOnRevision: number;
  readonly existingCandidateEventPool: readonly EventCandidate[];
}): ApproveScenePackageResult {
  const { context, proposal } = input;

  if (proposal.narration.trim() === "") return { ok: false, code: "empty_narration" };
  if (!isLegalEventTarget(context, proposal.event)) {
    return { ok: false, code: "illegal_event_target" };
  }

  // 台词归属校验：NPC 必须在场。
  if (proposal.npcLine !== null) {
    const present = context.presentNpcs.find((n) => String(n.id) === String(proposal.npcLine!.npcId));
    if (present === undefined) return { ok: false, code: "unknown_dialogue_npc" };
    // forbidden fact：usedFactIds 必须是该 NPC 允许集合（known ∪ scene-visible）之一。
    const allowed = new Set<string>([
      ...present.knownFactCards.map((f) => String(f.factId)),
      ...present.sceneVisibleFactIds.map(String),
    ]);
    for (const factId of proposal.npcLine.usedFactIds) {
      if (!allowed.has(String(factId))) return { ok: false, code: "npc_uses_forbidden_fact" };
    }
  }

  // 选项：恰好两个、不语义重复、目标合法。
  if (!Array.isArray(proposal.choiceProposals) || proposal.choiceProposals.length !== 2) {
    return { ok: false, code: "illegal_choice_target" };
  }
  const [a, b] = proposal.choiceProposals;
  if (!isWellFormedChoiceProposal(a) || !isWellFormedChoiceProposal(b)) {
    return { ok: false, code: "invalid_choice_action" };
  }
  if (semanticSummaryOf(a.action) === semanticSummaryOf(b.action)) {
    return { ok: false, code: "semantic_duplicate_choices" };
  }
  if (!isLegalChoiceTarget(context, proposal.event, a) || !isLegalChoiceTarget(context, proposal.event, b)) {
    return { ok: false, code: "illegal_choice_target" };
  }

  const approvedA = createApprovedChoice({
    sceneId: proposal.sceneId,
    basedOnRevision: input.basedOnRevision,
    label: a.label,
    action: a.action,
  });
  const approvedB = createApprovedChoice({
    sceneId: proposal.sceneId,
    basedOnRevision: input.basedOnRevision,
    label: b.label,
    action: b.action,
  });
  if (!approvedA.ok || !approvedB.ok || approvedA.choice.choiceToken === approvedB.choice.choiceToken) {
    return { ok: false, code: "illegal_choice_target" };
  }

  const approvedEvents = approveSceneEventProposals({
    existingPool: input.existingCandidateEventPool,
    proposals: proposal.eventProposals,
  });
  if (!approvedEvents.ok) return { ok: false, code: "illegal_choice_target" };

  const npcLine = rebuildNpcLine(proposal.npcLine);
  const scene: NarrativeSceneState = {
    sceneId: proposal.sceneId,
    turn: proposal.turn,
    narration: proposal.narration,
    usedFactIds: [],
    npcLine,
    choices: [
      {
        choiceToken: approvedA.choice.choiceToken,
        label: approvedA.choice.label,
        ...(a.hint !== undefined ? { hint: a.hint } : {}),
      },
      {
        choiceToken: approvedB.choice.choiceToken,
        label: approvedB.choice.label,
        ...(b.hint !== undefined ? { hint: b.hint } : {}),
      },
    ],
    source: proposal.source,
    event: rebuildEvent(proposal.event),
    ...(context.presentNpcs.length > 0
      ? {
          npcDialogues: buildNpcDialoguePages(context.presentNpcs, {
            focusNpcId: npcLine?.npcId,
            focusSpeech: npcLine?.text,
          }),
        }
      : {}),
  };

  return {
    ok: true,
    scene,
    choiceRegistry: [approvedA.choice, approvedB.choice],
    candidateEventPool: approvedEvents.nextCandidateEventPool,
  };
}
