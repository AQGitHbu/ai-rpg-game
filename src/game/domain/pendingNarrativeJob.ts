import { isWellFormedEventId, type EventId, type NarrativeJobId, type TurnId } from "./events";
import type { ResolvedEvent } from "./resolvedEvent";
import type {
  EnemyId,
  FactId,
  ItemId,
  LocationId,
  NpcId,
  QuestId,
} from "./worldEntity";
import type { Action } from "./action";
import { MAX_MANDATORY_BEATS, type MandatoryNarrativeBeat, type ObjectiveTransition } from "./narrativeBeat";
import {
  createNarrativeGenerationAttempt,
  parseNarrativeGenerationAttempt,
  type NarrativeGenerationAttempt,
} from "./narrativeGenerationAttempt";
import type { ResultBoundaryProof } from "./resultBoundary";

/** 玩家原话（utterance）的长度上限：全链路统一引用的常量。 */
export const PLAYER_UTTERANCE_MAX_LENGTH = 200 as const;

// ---------------------------------------------------------------------------
// Decision boundary classification (additive — Task 1 of the narrative bundle
// plan). The legacy PROVIDER_GENERATION_KINDS / NarrativeSceneRequestKind
// remain until Task 7 switches every caller and removes them atomically.
// ---------------------------------------------------------------------------

/** 新语义决策边界种类：唯一合法的 AI 触发点。 */
export const DECISION_BOUNDARY_KINDS = [
  "initialization",
  "narrative_choice",
  "npc_free_text",
  "investigation_result",
  "changed_revisit",
] as const;

export type DecisionBoundaryKind = (typeof DECISION_BOUNDARY_KINDS)[number];

/** 分类器输入：从已保存的 ready 场景和 registry 证明触发来源。 */
export type DecisionBoundaryProofInput = {
  readonly action: Action;
  readonly interactionKind: "fixed_choice" | "free_text" | null;
  readonly fixedChoiceIsCurrentFormalDecision: boolean;
  readonly focusedNpcId: NpcId | null;
  readonly resultBoundaryProof?: ResultBoundaryProof | null;
};

/**
 * 将一次玩家提交分类为语义决策边界或 null。
 *
 * - `narrative_choice`：talk + fixed_choice + fixedChoiceIsCurrentFormalDecision
 * - `npc_free_text`：talk + free_text + 目标是当前焦点 NPC
 * - `null`：其他所有情况
 *
 * Task 7 在迁移全部 caller 后移除 `worldBoundaryNeedsPreparation` 和
 * `npc_fixed_choice`。
 */
export function classifyProviderDecisionBoundary(
  input: DecisionBoundaryProofInput,
): DecisionBoundaryKind | null {
  if (input.resultBoundaryProof !== undefined && input.resultBoundaryProof !== null) {
    return input.resultBoundaryProof.kind;
  }

  // Formal fixed choice: must be a talk action with a fixed_choice interaction
  // that has been proven to belong to the current formal decision.
  if (
    (input.action.type === "talk" || input.action.type === "abandon_quest")
    && input.interactionKind === "fixed_choice"
    && input.fixedChoiceIsCurrentFormalDecision
  ) {
    return "narrative_choice";
  }

  // Free text: must be a talk action targeting the current focus NPC.
  if (
    input.action.type === "talk"
    && input.interactionKind === "free_text"
    && input.focusedNpcId !== null
    && input.action.npcId === input.focusedNpcId
  ) {
    return "npc_free_text";
  }

  return null;
}

/** 生产环境允许触发 provider 调用的生成种类（白名单）。 */
export const PROVIDER_GENERATION_KINDS = [
  "opening",
  "npc_fixed_choice",
  "npc_free_text",
  "story_exit",
  "investigation_result",
  "changed_revisit",
] as const;

export type ProviderGenerationKind = (typeof PROVIDER_GENERATION_KINDS)[number];

/** 场景请求种类：与 generationKind 配对，决定 prompt 路由。 */
export type NarrativeSceneRequestKind =
  | "opening"
  | "npc_response"
  | "npc_handoff"
  | "story_exit"
  | "investigation_result"
  | "changed_revisit";
const NARRATIVE_SCENE_REQUEST_KINDS = [
  "opening",
  "npc_response",
  "npc_handoff",
  "story_exit",
  "investigation_result",
  "changed_revisit",
] as const satisfies readonly NarrativeSceneRequestKind[];

/** 合法的 generationKind + sceneRequestKind 配对。 */
const VALID_KIND_PAIRS: ReadonlyMap<string, readonly NarrativeSceneRequestKind[]> = new Map([
  ["opening", ["opening"]],
  ["npc_fixed_choice", ["npc_response", "npc_handoff"]],
  ["npc_free_text", ["npc_response", "npc_handoff"]],
  ["story_exit", ["story_exit"]],
  ["investigation_result", ["investigation_result"]],
  ["changed_revisit", ["changed_revisit"]],
]);

function isValidKindPair(
  generationKind: unknown,
  sceneRequestKind: unknown,
): boolean {
  if (generationKind === null || sceneRequestKind === null) {
    return generationKind === null && sceneRequestKind === null;
  }
  if (typeof generationKind !== "string" || typeof sceneRequestKind !== "string") return false;
  const allowed = VALID_KIND_PAIRS.get(generationKind);
  return allowed !== undefined && (allowed as readonly string[]).includes(sceneRequestKind);
}

function isKnownSceneRequestKind(value: unknown): value is NarrativeSceneRequestKind {
  return typeof value === "string"
    && (NARRATIVE_SCENE_REQUEST_KINDS as readonly string[]).includes(value);
}

/**
 * 当前场景生成所需的结构化行动摘要：只收藏状态实体引用（封闭 union），
 * 不保存完整 World State，也不允许任意 path patch。
 */
export type StructuredActionSummary =
  | { readonly kind: "talk"; readonly npcId: NpcId }
  | { readonly kind: "move"; readonly locationId: LocationId }
  | { readonly kind: "explore" }
  | { readonly kind: "investigate"; readonly factId: FactId }
  | { readonly kind: "take_item"; readonly itemId: ItemId }
  | { readonly kind: "give_item"; readonly itemId: ItemId; readonly npcId: NpcId }
  | { readonly kind: "abandon_quest"; readonly questId: QuestId }
  | { readonly kind: "attack"; readonly enemyId: EnemyId }
  | { readonly kind: "battle_action"; readonly action: "attack" | "skill" | "guard" | "flee" }
  | { readonly kind: "ack_prologue" }
  | { readonly kind: "freeform" };

export type PendingNarrativeJob = {
  readonly jobId: NarrativeJobId;
  readonly turnId: TurnId;
  readonly actionId: string;
  /** 包含该 job 的规则提交完成后的 revision，即 expectedRevision + 1。 */
  readonly basedOnRevision: number;
  readonly turnNumber: number;
  readonly actionSummary: StructuredActionSummary;
  /** 有界玩家原文；其他任何领域对象不得保存玩家原文。 */
  readonly utterance?: string;
  readonly resolvedEvent: ResolvedEvent;
  /** 本回合规则提交产生的稳定 Event ID，顺序与 ledger 追加顺序一致。 */
  readonly domainEventIds: readonly EventId[];
  readonly focusNpcId?: NpcId;
  /** 当前固定选项/自由输入的结构化对白上下文；旧 job 缺失时按兼容路径读取。 */
  readonly selectedDialogue?: {
    readonly dialogueAct: import("./action").DialogueAct;
    readonly topic?: import("./action").DialogueTopic;
    readonly label?: string;
  };
  readonly requestedAt: string;
  readonly objectiveTransition: ObjectiveTransition;
  readonly mandatoryBeats: readonly MandatoryNarrativeBeat[];
  /** 该 job 触发的 provider 生成种类；必须属于 PROVIDER_GENERATION_KINDS 白名单。 */
  readonly generationKind: ProviderGenerationKind | null;
  /** 场景请求种类；必须与 generationKind 合法配对。 */
  readonly sceneRequestKind: NarrativeSceneRequestKind | null;
  /** 由服务端规则证明的结果边界；普通 NPC job 不设置。 */
  readonly resultBoundaryProof?: ResultBoundaryProof;
  /** Durable candidate/lease/HTTP accounting for this logical job epoch. */
  readonly attempt: NarrativeGenerationAttempt;
};

export type CreatePendingNarrativeJobInput = {
  readonly jobId: NarrativeJobId;
  readonly turnId: TurnId;
  readonly actionId: string;
  /** 规则提交前的期望 revision；job.basedOnRevision 取其 +1。 */
  readonly expectedRevision: number;
  readonly turnNumber: number;
  readonly actionSummary: StructuredActionSummary;
  readonly utterance?: string;
  readonly resolvedEvent: ResolvedEvent;
  readonly domainEventIds: readonly EventId[];
  readonly focusNpcId?: NpcId;
  readonly selectedDialogue?: {
    readonly dialogueAct: import("./action").DialogueAct;
    readonly topic?: import("./action").DialogueTopic;
    readonly label?: string;
  };
  readonly requestedAt: string;
  readonly objectiveTransition: ObjectiveTransition;
  readonly mandatoryBeats: readonly MandatoryNarrativeBeat[];
  /** 该 job 触发的 provider 生成种类；必须属于 PROVIDER_GENERATION_KINDS 白名单。 */
  readonly generationKind: ProviderGenerationKind | null;
  /** 场景请求种类；必须与 generationKind 合法配对。 */
  readonly sceneRequestKind: NarrativeSceneRequestKind | null;
  /** 由服务端规则证明的结果边界；客户端输入不得伪造。 */
  readonly resultBoundaryProof?: ResultBoundaryProof;
  readonly attempt?: NarrativeGenerationAttempt;
};

export type PendingNarrativeJobErrorCode =
  | "EMPTY_ACTION_ID"
  | "INVALID_EXPECTED_REVISION"
  | "INVALID_EVENT_IDS"
  | "UTTERANCE_TOO_LONG"
  | "OBJECTIVE_TRANSITION_INVALID"
  | "MANDATORY_BEATS_OVER_CAP"
  | "INVALID_GENERATION_KIND"
  | "INVALID_SCENE_REQUEST_KIND"
  | "INVALID_KIND_PAIR"
  | "RESULT_BOUNDARY_PROOF_INVALID"
  | "ATTEMPT_INVALID";

export type PendingNarrativeJobError = {
  readonly code: PendingNarrativeJobErrorCode;
};

export type CreatePendingNarrativeJobResult =
  | { readonly ok: true; readonly job: PendingNarrativeJob }
  | { readonly ok: false; readonly errors: readonly PendingNarrativeJobError[] };

const OBJECTIVE_TRANSITION_MODES: ReadonlySet<string> = new Set([
  "unchanged", "progressed", "advanced_act", "ready_for_ending",
]);

const MANDATORY_BEAT_KINDS: ReadonlySet<string> = new Set([
  "player_utterance", "item_obtained", "fact_discovered", "quest_progress",
  "quest_advanced", "battle_started", "battle_round", "battle_resolved",
  "entity_introduced", "atmosphere",
]);

function isValidObjectiveRef(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  const ref = candidate as { questId?: unknown; objectiveIndex?: unknown; label?: unknown };
  return typeof ref.questId === "string"
    && typeof ref.objectiveIndex === "number"
    && Number.isInteger(ref.objectiveIndex)
    && ref.objectiveIndex >= 0
    && typeof ref.label === "string"
    && ref.label.length > 0;
}

function isValidObjectiveTransition(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  const transition = candidate as {
    before?: unknown; completed?: unknown; after?: unknown; mode?: unknown;
  };
  if (typeof transition.mode !== "string" || !OBJECTIVE_TRANSITION_MODES.has(transition.mode)) {
    return false;
  }
  if (transition.before !== null && !isValidObjectiveRef(transition.before)) return false;
  if (transition.after !== null && !isValidObjectiveRef(transition.after)) return false;
  return Array.isArray(transition.completed) && transition.completed.every((c) => isValidObjectiveRef(c));
}

function isValidMandatoryBeat(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  const beat = candidate as {
    beatId?: unknown; kind?: unknown; subjectIds?: unknown; instruction?: unknown;
  };
  return typeof beat.beatId === "string"
    && beat.beatId.length > 0
    && typeof beat.kind === "string"
    && MANDATORY_BEAT_KINDS.has(beat.kind)
    && Array.isArray(beat.subjectIds)
    && beat.subjectIds.every((s) => typeof s === "string")
    && typeof beat.instruction === "string"
    && beat.instruction.length > 0;
}

function isValidResultBoundaryProof(candidate: unknown): candidate is ResultBoundaryProof {
  if (!candidate || typeof candidate !== "object") return false;
  const proof = candidate as Record<string, unknown>;
  const keys = proof.kind === "investigation_result"
    ? ["kind", "factId", "approachId", "sourceEventIds"]
    : ["kind", "locationId", "previousSceneEventId", "sourceEventIds"];
  if (Object.keys(proof).some((key) => !keys.includes(key))) return false;
  if (!Array.isArray(proof.sourceEventIds)
    || proof.sourceEventIds.length === 0
    || proof.sourceEventIds.some((id) => typeof id !== "string" || !isWellFormedEventId(id))
    || new Set(proof.sourceEventIds).size !== proof.sourceEventIds.length) return false;
  if (proof.kind === "investigation_result") {
    return typeof proof.factId === "string"
      && proof.factId.trim() !== ""
      && typeof proof.approachId === "string"
      && proof.approachId.trim() !== "";
  }
  if (proof.kind === "changed_revisit") {
    return typeof proof.locationId === "string"
      && proof.locationId.trim() !== ""
      && typeof proof.previousSceneEventId === "string"
      && isWellFormedEventId(proof.previousSceneEventId);
  }
  return false;
}

/** 纯构造：拒绝空 actionId、无效 Event 引用、超长 utterance 和非法 expectedRevision。 */
export function createPendingNarrativeJob(
  input: CreatePendingNarrativeJobInput,
): CreatePendingNarrativeJobResult {
  const errors: PendingNarrativeJobError[] = [];

  if (input.actionId.trim() === "") {
    errors.push({ code: "EMPTY_ACTION_ID" });
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    errors.push({ code: "INVALID_EXPECTED_REVISION" });
  }
  if (
    !Array.isArray(input.domainEventIds)
    || input.domainEventIds.length === 0
    || input.domainEventIds.some((id) => typeof id !== "string" || !isWellFormedEventId(id))
    || new Set(input.domainEventIds.map(String)).size !== input.domainEventIds.length
  ) {
    errors.push({ code: "INVALID_EVENT_IDS" });
  }
  if (
    input.utterance !== undefined
    && Array.from(input.utterance).length > PLAYER_UTTERANCE_MAX_LENGTH
  ) {
    errors.push({ code: "UTTERANCE_TOO_LONG" });
  }
  if (!isValidKindPair(input.generationKind, input.sceneRequestKind)) {
    if (input.generationKind !== null && !VALID_KIND_PAIRS.has(input.generationKind)) {
      errors.push({ code: "INVALID_GENERATION_KIND" });
    } else if (input.sceneRequestKind !== null && !isKnownSceneRequestKind(input.sceneRequestKind)) {
      errors.push({ code: "INVALID_SCENE_REQUEST_KIND" });
    } else {
      errors.push({ code: "INVALID_KIND_PAIR" });
    }
  }
  const proof = input.resultBoundaryProof;
  const requiresResultProof = input.generationKind === "investigation_result" || input.generationKind === "changed_revisit";
  const validProof = proof === undefined ? !requiresResultProof
    : isValidResultBoundaryProof(proof) && proof.kind === input.generationKind
      && (proof.kind === "investigation_result"
        ? input.actionSummary.kind === "investigate" && input.actionSummary.factId === proof.factId
        : input.actionSummary.kind === "move" && input.actionSummary.locationId === proof.locationId);
  if (!validProof) {
    errors.push({ code: "RESULT_BOUNDARY_PROOF_INVALID" });
  }
  if (!isValidObjectiveTransition(input.objectiveTransition)) {
    errors.push({ code: "OBJECTIVE_TRANSITION_INVALID" });
  }
  if (
    !Array.isArray(input.mandatoryBeats)
    || input.mandatoryBeats.length > MAX_MANDATORY_BEATS
    || !input.mandatoryBeats.every((beat) => isValidMandatoryBeat(beat))
  ) {
    errors.push({ code: "MANDATORY_BEATS_OVER_CAP" });
  }
  const attempt = input.attempt === undefined
    ? { ok: true as const, value: createNarrativeGenerationAttempt() }
    : parseNarrativeGenerationAttempt(input.attempt);
  if (!attempt.ok) errors.push({ code: "ATTEMPT_INVALID" });

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    job: {
      jobId: input.jobId,
      turnId: input.turnId,
      actionId: input.actionId,
      basedOnRevision: input.expectedRevision + 1,
      turnNumber: input.turnNumber,
      actionSummary: input.actionSummary,
      resolvedEvent: input.resolvedEvent,
      domainEventIds: [...input.domainEventIds],
      requestedAt: input.requestedAt,
      objectiveTransition: input.objectiveTransition,
      mandatoryBeats: input.mandatoryBeats,
      generationKind: input.generationKind,
      sceneRequestKind: input.sceneRequestKind,
      attempt: attempt.ok ? attempt.value : createNarrativeGenerationAttempt(),
      ...(input.resultBoundaryProof === undefined ? {} : { resultBoundaryProof: input.resultBoundaryProof }),
      ...(input.utterance !== undefined ? { utterance: input.utterance } : {}),
      ...(input.focusNpcId !== undefined ? { focusNpcId: input.focusNpcId } : {}),
      ...(input.selectedDialogue !== undefined ? { selectedDialogue: input.selectedDialogue } : {}),
    },
  };
}

/** 解析未知值为 PendingNarrativeJob；拒绝非白名单 kind 和非法配对。 */
export type ParsePendingNarrativeJobResult =
  | { readonly ok: true; readonly job: PendingNarrativeJob }
  | { readonly ok: false; readonly code: "INVALID_PENDING_NARRATIVE_JOB" };

export function parsePendingNarrativeJob(value: unknown): ParsePendingNarrativeJobResult {
  if (!value || typeof value !== "object") return { ok: false, code: "INVALID_PENDING_NARRATIVE_JOB" };
  const v = value as Record<string, unknown>;
  if (!("attempt" in v)) return { ok: false, code: "INVALID_PENDING_NARRATIVE_JOB" };
  const result = createPendingNarrativeJob({
    jobId: v.jobId as NarrativeJobId,
    turnId: v.turnId as TurnId,
    actionId: v.actionId as string,
    expectedRevision: typeof v.basedOnRevision === "number" ? v.basedOnRevision - 1 : -1,
    turnNumber: v.turnNumber as number,
    actionSummary: v.actionSummary as StructuredActionSummary,
    utterance: v.utterance as string | undefined,
    resolvedEvent: v.resolvedEvent as ResolvedEvent,
    domainEventIds: v.domainEventIds as readonly EventId[],
    focusNpcId: v.focusNpcId as NpcId | undefined,
    selectedDialogue: v.selectedDialogue as {
      readonly dialogueAct: import("./action").DialogueAct;
      readonly topic?: import("./action").DialogueTopic;
      readonly label?: string;
    } | undefined,
    requestedAt: v.requestedAt as string,
    objectiveTransition: v.objectiveTransition as ObjectiveTransition,
    mandatoryBeats: v.mandatoryBeats as readonly MandatoryNarrativeBeat[],
    generationKind: v.generationKind as ProviderGenerationKind | null,
    sceneRequestKind: v.sceneRequestKind as NarrativeSceneRequestKind | null,
    resultBoundaryProof: v.resultBoundaryProof as ResultBoundaryProof | undefined,
    attempt: v.attempt as NarrativeGenerationAttempt,
  });
  if (!result.ok) return { ok: false, code: "INVALID_PENDING_NARRATIVE_JOB" };
  return { ok: true, job: result.job };
}
