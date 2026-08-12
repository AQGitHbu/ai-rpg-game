import type { NarrativeJobId, TurnId } from "./events";
import type { ResolvedEvent } from "./resolvedEvent";
import type {
  EnemyId,
  FactId,
  ItemId,
  LocationId,
  NpcId,
} from "./worldEntity";
import { MAX_MANDATORY_BEATS, type MandatoryNarrativeBeat, type ObjectiveTransition } from "./narrativeBeat";

/** 玩家原话（utterance）的长度上限：全链路统一引用的常量。 */
export const PLAYER_UTTERANCE_MAX_LENGTH = 200 as const;

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
  readonly domainEventRange: {
    readonly fromLedgerIndex: number;
    readonly toLedgerIndexExclusive: number;
  };
  readonly focusNpcId?: NpcId;
  readonly requestedAt: string;
  readonly objectiveTransition: ObjectiveTransition;
  readonly mandatoryBeats: readonly MandatoryNarrativeBeat[];
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
  readonly domainEventRange: {
    readonly fromLedgerIndex: number;
    readonly toLedgerIndexExclusive: number;
  };
  readonly focusNpcId?: NpcId;
  readonly requestedAt: string;
  readonly objectiveTransition: ObjectiveTransition;
  readonly mandatoryBeats: readonly MandatoryNarrativeBeat[];
};

export type PendingNarrativeJobErrorCode =
  | "EMPTY_ACTION_ID"
  | "INVALID_EXPECTED_REVISION"
  | "INVALID_LEDGER_RANGE"
  | "UTTERANCE_TOO_LONG"
  | "OBJECTIVE_TRANSITION_INVALID"
  | "MANDATORY_BEATS_OVER_CAP";

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

/** 纯构造：拒绝空 actionId、无效 ledger range、超长 utterance 和非法 expectedRevision。 */
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
  const { fromLedgerIndex, toLedgerIndexExclusive } = input.domainEventRange;
  if (
    !Number.isInteger(fromLedgerIndex)
    || !Number.isInteger(toLedgerIndexExclusive)
    || fromLedgerIndex < 0
    || toLedgerIndexExclusive <= fromLedgerIndex
  ) {
    errors.push({ code: "INVALID_LEDGER_RANGE" });
  }
  if (
    input.utterance !== undefined
    && Array.from(input.utterance).length > PLAYER_UTTERANCE_MAX_LENGTH
  ) {
    errors.push({ code: "UTTERANCE_TOO_LONG" });
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
      domainEventRange: { fromLedgerIndex, toLedgerIndexExclusive },
      requestedAt: input.requestedAt,
      objectiveTransition: input.objectiveTransition,
      mandatoryBeats: input.mandatoryBeats,
      ...(input.utterance !== undefined ? { utterance: input.utterance } : {}),
      ...(input.focusNpcId !== undefined ? { focusNpcId: input.focusNpcId } : {}),
    },
  };
}
