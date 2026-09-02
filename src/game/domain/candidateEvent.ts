import type { EnemyId, FactId, LocationId, NpcId } from "./worldEntity";
import type { PacingNeed, ThreadId } from "./storyState";

// ---------------------------------------------------------------------------
// 可审批可执行的 AI 候选事件契约（Spec §11）
// ---------------------------------------------------------------------------

/** 支持的候选事件 kind（Spec §11.1）。 */
export type EventCandidateKind =
  | "npc_reveals_fact"
  | "hostile_force_acts"
  | "enemy_appears"
  | "thread_complicates"
  | "thread_resolves"
  | "location_state_changes";

export const EVENT_CANDIDATE_KINDS: readonly EventCandidateKind[] = [
  "npc_reveals_fact",
  "hostile_force_acts",
  "enemy_appears",
  "thread_complicates",
  "thread_resolves",
  "location_state_changes",
];

/**
 * 候选事件提议的结构化效果。effect 必须是封闭 union，由规则编译为真实领域事实，
 * 禁止任意 path patch；description 不能作为唯一执行依据。
 */
export type ProposedEffect =
  | { readonly kind: "npc_reveals_fact"; readonly npcId: NpcId; readonly factId: FactId }
  | { readonly kind: "hostile_force_acts"; readonly locationId: LocationId; readonly action: string }
  | { readonly kind: "enemy_appears"; readonly enemyId: EnemyId; readonly locationId: LocationId }
  | { readonly kind: "thread_complicates"; readonly threadId: ThreadId }
  | { readonly kind: "thread_resolves"; readonly threadId: ThreadId }
  | { readonly kind: "location_state_changes"; readonly locationId: LocationId; readonly change: string };

/**
 * AI 世界/场景提议的候选事件。结构化字段是审批与执行的依据；
 * `description` 仅用于诊断，不得作为唯一执行字段。
 */
export type EventCandidate = {
  readonly id: string;
  readonly kind: EventCandidateKind;
  readonly involvedEntityIds: readonly string[];
  readonly prerequisiteFactIds: readonly FactId[];
  readonly proposedEffects: readonly ProposedEffect[];
  readonly intendedPacing: PacingNeed;
  readonly reason: string;
  readonly proposedAtTurn: number;
  readonly expiresAtTurn: number;
  /** 仅诊断用；不得作为审批与执行的唯一依据。 */
  readonly description?: string;
};

export type EventCandidateParseErrorCode =
  | "empty_id"
  | "unknown_kind"
  | "no_executable_effect"
  | "effect_kind_mismatch"
  | "invalid_expiry"
  | "invalid_pacing"
  | "malformed";

export type ParseEventCandidateResult =
  | { readonly ok: true; readonly candidate: EventCandidate }
  | { readonly ok: false; readonly code: EventCandidateParseErrorCode };

const PACING_NEEDS: readonly PacingNeed[] = [
  "reveal", "develop", "complicate", "escalate", "climax", "resolve",
];

function isPacingNeed(value: unknown): value is PacingNeed {
  return PACING_NEEDS.includes(value as PacingNeed);
}

/**
 * 从 AI 原始 unknown 解析结构化候选事件。只做形状/枚举/长度检查；
 * 实体引用、预算、过期等规则校验留给 gameplay validator（Task 19）。
 * 纯函数：不读取时钟/随机数/环境。
 */
export function parseEventCandidate(input: unknown): ParseEventCandidateResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, code: "malformed" };
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.id !== "string" || raw.id.trim() === "") {
    return { ok: false, code: "empty_id" };
  }
  if (typeof raw.kind !== "string" || !EVENT_CANDIDATE_KINDS.includes(raw.kind as EventCandidateKind)) {
    return { ok: false, code: "unknown_kind" };
  }
  const kind = raw.kind as EventCandidateKind;

  if (!Array.isArray(raw.involvedEntityIds) || raw.involvedEntityIds.some((id) => typeof id !== "string" || id === "")) {
    return { ok: false, code: "malformed" };
  }
  if (!Array.isArray(raw.prerequisiteFactIds) || raw.prerequisiteFactIds.some((id) => typeof id !== "string")) {
    return { ok: false, code: "malformed" };
  }
  if (typeof raw.reason !== "string") {
    return { ok: false, code: "malformed" };
  }
  if (typeof raw.proposedAtTurn !== "number" || !Number.isInteger(raw.proposedAtTurn) || raw.proposedAtTurn < 1) {
    return { ok: false, code: "malformed" };
  }
  if (typeof raw.expiresAtTurn !== "number" || !Number.isInteger(raw.expiresAtTurn)) {
    return { ok: false, code: "malformed" };
  }
  if (raw.expiresAtTurn <= raw.proposedAtTurn) {
    return { ok: false, code: "invalid_expiry" };
  }
  if (!isPacingNeed(raw.intendedPacing)) {
    return { ok: false, code: "invalid_pacing" };
  }

  const effects = raw.proposedEffects;
  if (!Array.isArray(effects) || effects.length === 0) {
    return { ok: false, code: "no_executable_effect" };
  }

  const proposedEffects: ProposedEffect[] = [];
  for (const effect of effects) {
    const parsed = parseProposedEffect(effect);
    if (!parsed) {
      return { ok: false, code: "malformed" };
    }
    if (parsed.kind !== kind) {
      return { ok: false, code: "effect_kind_mismatch" };
    }
    proposedEffects.push(parsed);
  }

  return {
    ok: true,
    candidate: {
      id: raw.id,
      kind,
      involvedEntityIds: raw.involvedEntityIds as readonly string[],
      prerequisiteFactIds: raw.prerequisiteFactIds as readonly FactId[],
      proposedEffects,
      intendedPacing: raw.intendedPacing as PacingNeed,
      reason: raw.reason,
      proposedAtTurn: raw.proposedAtTurn,
      expiresAtTurn: raw.expiresAtTurn,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    },
  };
}

function parseProposedEffect(input: unknown): ProposedEffect | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const raw = input as Record<string, unknown>;
  const kind = raw.kind;
  if (typeof kind !== "string") return null;

  switch (kind) {
    case "npc_reveals_fact":
      if (typeof raw.npcId !== "string" || typeof raw.factId !== "string") return null;
      return { kind, npcId: raw.npcId as NpcId, factId: raw.factId as FactId };
    case "hostile_force_acts":
      if (typeof raw.locationId !== "string" || typeof raw.action !== "string") return null;
      return { kind, locationId: raw.locationId as LocationId, action: raw.action };
    case "enemy_appears":
      if (typeof raw.enemyId !== "string" || typeof raw.locationId !== "string") return null;
      return { kind, enemyId: raw.enemyId as EnemyId, locationId: raw.locationId as LocationId };
    case "thread_complicates":
    case "thread_resolves":
      if (typeof raw.threadId !== "string") return null;
      return { kind, threadId: raw.threadId as ThreadId };
    case "location_state_changes":
      if (typeof raw.locationId !== "string" || typeof raw.change !== "string") return null;
      return { kind, locationId: raw.locationId as LocationId, change: raw.change };
    default:
      return null;
  }
}

/**
 * 纯函数：候选事件是否在当前回合已过期。
 * 过期即 `currentTurn >= expiresAtTurn`。
 */
export function isExpiredCandidate(candidate: EventCandidate, currentTurn: number): boolean {
  return currentTurn >= candidate.expiresAtTurn;
}
