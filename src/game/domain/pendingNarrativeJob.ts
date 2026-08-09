import type { NarrativeJobId, TurnId } from "./events";
import type { ResolvedEvent } from "./resolvedEvent";
import type {
  EnemyId,
  FactId,
  ItemId,
  LocationId,
  NpcId,
} from "./scenarioBlueprint";

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
  | { readonly kind: "battle_action"; readonly action: "attack" | "guard" | "flee" }
  | { readonly kind: "rest" }
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
};

export type PendingNarrativeJobErrorCode =
  | "EMPTY_ACTION_ID"
  | "INVALID_EXPECTED_REVISION"
  | "INVALID_LEDGER_RANGE"
  | "UTTERANCE_TOO_LONG";

export type PendingNarrativeJobError = {
  readonly code: PendingNarrativeJobErrorCode;
};

export type CreatePendingNarrativeJobResult =
  | { readonly ok: true; readonly job: PendingNarrativeJob }
  | { readonly ok: false; readonly errors: readonly PendingNarrativeJobError[] };

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
      ...(input.utterance !== undefined ? { utterance: input.utterance } : {}),
      ...(input.focusNpcId !== undefined ? { focusNpcId: input.focusNpcId } : {}),
    },
  };
}