import { isWellFormedEventId, type EventId } from "./events";
import type { EntityId } from "./entity/entityCore";
import type { FactId, ItemId, NpcId, PlayerEntityId } from "./worldEntity";

/** A small, closed condition language for story choices. */
export type StoryCondition =
  | Readonly<{ kind: "has_item"; itemId: ItemId; ownerId: EntityId }>
  | Readonly<{ kind: "knows_fact"; actorId: EntityId; factId: FactId }>
  | Readonly<{ kind: "promise_status"; npcId: NpcId; promiseId: string; status: "open" | "fulfilled" | "broken" | "released" }>
  | Readonly<{ kind: "goal_status"; npcId: NpcId; goalId: string; status: "active" | "blocked" | "completed" | "abandoned" }>;

export const STORY_INTERACTION_OPERATIONS = [
  "promise_confidentiality",
  "request_introduction",
  "request_verification",
  "share_known_fact",
] as const;
export type StoryInteractionOperation = (typeof STORY_INTERACTION_OPERATIONS)[number];

export type StoryInteraction = Readonly<{
  id: string;
  npcId: NpcId;
  operation: StoryInteractionOperation;
  condition: readonly StoryCondition[];
  factIds: readonly FactId[];
  goalIds: readonly string[];
  promiseId: string | null;
  /** Actual listeners other than the acting NPC; player is allowed. */
  audienceIds: readonly EntityId[];
  evidenceEventIds: readonly EventId[];
}>;

export type StoryInteractionProposal = Omit<StoryInteraction, "id"> & Readonly<{ proposalKey: string }>;

export type StoryConditionValidationCode = "INVALID_CONDITION" | "INVALID_INTERACTION";
export type StoryInteractionParseResult =
  | Readonly<{ ok: true; value: StoryInteraction }>
  | Readonly<{ ok: false; code: StoryConditionValidationCode; path: string }>;
export type StoryInteractionProposalParseResult =
  | Readonly<{ ok: true; value: StoryInteractionProposal }>
  | Readonly<{ ok: false; code: StoryConditionValidationCode; path: string }>;

type UnknownRecord = Record<string, unknown>;
const CONDITION_KINDS = ["has_item", "knows_fact", "promise_status", "goal_status"] as const;
const PROMISE_STATUSES = ["open", "fulfilled", "broken", "released"] as const;
const GOAL_STATUSES = ["active", "blocked", "completed", "abandoned"] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exactKeys(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString) && new Set(value).size === value.length;
}

function condition(value: unknown): value is StoryCondition {
  if (!isRecord(value) || !nonEmptyString(value.kind) || !CONDITION_KINDS.includes(value.kind as typeof CONDITION_KINDS[number])) return false;
  switch (value.kind) {
    case "has_item": return exactKeys(value, ["kind", "itemId", "ownerId"]) && nonEmptyString(value.itemId) && nonEmptyString(value.ownerId);
    case "knows_fact": return exactKeys(value, ["kind", "actorId", "factId"]) && nonEmptyString(value.actorId) && nonEmptyString(value.factId);
    case "promise_status": return exactKeys(value, ["kind", "npcId", "promiseId", "status"]) && nonEmptyString(value.npcId) && nonEmptyString(value.promiseId) && PROMISE_STATUSES.includes(value.status as typeof PROMISE_STATUSES[number]);
    case "goal_status": return exactKeys(value, ["kind", "npcId", "goalId", "status"]) && nonEmptyString(value.npcId) && nonEmptyString(value.goalId) && GOAL_STATUSES.includes(value.status as typeof GOAL_STATUSES[number]);
  }
  return false;
}

/** Strict runtime parser for interaction definitions stored in Entity. */
export function parseStoryInteraction(value: unknown, path = "interaction"): StoryInteractionParseResult {
  if (!isRecord(value) || !exactKeys(value, ["id", "npcId", "operation", "condition", "factIds", "goalIds", "promiseId", "audienceIds", "evidenceEventIds"])) {
    return { ok: false, code: "INVALID_INTERACTION", path };
  }
  if (!nonEmptyString(value.id) || !nonEmptyString(value.npcId) || !STORY_INTERACTION_OPERATIONS.includes(value.operation as StoryInteractionOperation)) {
    return { ok: false, code: "INVALID_INTERACTION", path };
  }
  if (!Array.isArray(value.condition) || !value.condition.every(condition)
    || !stringArray(value.factIds) || !stringArray(value.goalIds) || !stringArray(value.audienceIds) || !stringArray(value.evidenceEventIds)
    || !(value.evidenceEventIds as readonly string[]).every(isWellFormedEventId)
    || (value.promiseId !== null && !nonEmptyString(value.promiseId))) {
    return { ok: false, code: "INVALID_INTERACTION", path };
  }
  return {
    ok: true,
    value: {
      id: value.id,
      npcId: value.npcId as NpcId,
      operation: value.operation as StoryInteractionOperation,
      condition: value.condition,
      factIds: value.factIds as FactId[],
      goalIds: value.goalIds,
      promiseId: value.promiseId,
      audienceIds: value.audienceIds as EntityId[],
      evidenceEventIds: value.evidenceEventIds as EventId[],
    },
  };
}

/** Strict parser for provider-owned definitions before the server mints an id. */
export function parseStoryInteractionProposal(
  value: unknown,
  path = "interactionProposal",
): StoryInteractionProposalParseResult {
  if (!isRecord(value) || !exactKeys(value, [
    "proposalKey", "npcId", "operation", "condition", "factIds", "goalIds",
    "promiseId", "audienceIds", "evidenceEventIds",
  ])) {
    return { ok: false, code: "INVALID_INTERACTION", path };
  }
  if (!nonEmptyString(value.proposalKey)) return { ok: false, code: "INVALID_INTERACTION", path };
  const { proposalKey, ...interactionFields } = value;
  const parsed = parseStoryInteraction({ ...interactionFields, id: `proposal:${proposalKey}` }, path);
  if (!parsed.ok) return parsed;
  const { id: _id, ...proposal } = parsed.value;
  return { ok: true, value: { ...proposal, proposalKey } };
}

export type StoryInteractionTargetId = PlayerEntityId | NpcId;
