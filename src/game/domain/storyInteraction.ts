import { isWellFormedEventId, type EventId } from "./events";
import type { EntityId } from "./entity/entityCore";
import type { FactId, ItemId, NpcId, PlayerEntityId } from "./worldEntity";

/** A small, closed condition language for story choices. */
export type StoryCondition =
  | Readonly<{ kind: "has_item"; itemId: ItemId; ownerId: EntityId }>
  | Readonly<{ kind: "knows_fact"; actorId: EntityId; factId: FactId }>
  | Readonly<{ kind: "promise_status"; npcId: NpcId; promiseId: string; status: "open" | "fulfilled" | "broken" | "released" }>
  | Readonly<{ kind: "goal_status"; npcId: NpcId; goalId: string; status: "active" | "blocked" | "completed" | "abandoned" }>
  | Readonly<{ kind: "investigation_observed"; npcId: NpcId; factId: FactId; evidenceQuality: "clean" | "noisy" }>;

export const STORY_INTERACTION_OPERATIONS = [
  "promise_confidentiality",
  "request_introduction",
  "request_verification",
  "share_known_fact",
] as const;
export type StoryInteractionOperation = (typeof STORY_INTERACTION_OPERATIONS)[number];

export type ConfidentialityTerms = Readonly<{
  protectedFactIds: readonly FactId[];
  allowedAudienceIds: readonly EntityId[];
  fulfillment: Readonly<{ kind: "story_delivery" }>;
}>;

/** A server-installed, bounded permission set for evidence-dependent NPC cooperation. */
export type NpcCooperationDefinition = Readonly<{
  operation: "request_introduction" | "request_verification";
  requirements: readonly StoryCondition[];
  allowedFactIds: readonly FactId[];
  allowedAudienceIds: readonly EntityId[];
}>;

export type StoryInteraction = Readonly<{
  confidentiality?: ConfidentialityTerms;
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
const CONDITION_KINDS = ["has_item", "knows_fact", "promise_status", "goal_status", "investigation_observed"] as const;
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

export function parseStoryCondition(value: unknown): StoryCondition | null {
  if (!isRecord(value) || !nonEmptyString(value.kind) || !CONDITION_KINDS.includes(value.kind as typeof CONDITION_KINDS[number])) return null;
  switch (value.kind) {
    case "has_item": return exactKeys(value, ["kind", "itemId", "ownerId"]) && nonEmptyString(value.itemId) && nonEmptyString(value.ownerId)
      ? { kind: "has_item", itemId: value.itemId as ItemId, ownerId: value.ownerId as EntityId } : null;
    case "knows_fact": return exactKeys(value, ["kind", "actorId", "factId"]) && nonEmptyString(value.actorId) && nonEmptyString(value.factId)
      ? { kind: "knows_fact", actorId: value.actorId as EntityId, factId: value.factId as FactId } : null;
    case "promise_status": return exactKeys(value, ["kind", "npcId", "promiseId", "status"]) && nonEmptyString(value.npcId) && nonEmptyString(value.promiseId) && PROMISE_STATUSES.includes(value.status as typeof PROMISE_STATUSES[number])
      ? { kind: "promise_status", npcId: value.npcId as NpcId, promiseId: value.promiseId, status: value.status as "open" | "fulfilled" | "broken" | "released" } : null;
    case "goal_status": return exactKeys(value, ["kind", "npcId", "goalId", "status"]) && nonEmptyString(value.npcId) && nonEmptyString(value.goalId) && GOAL_STATUSES.includes(value.status as typeof GOAL_STATUSES[number])
      ? { kind: "goal_status", npcId: value.npcId as NpcId, goalId: value.goalId, status: value.status as "active" | "blocked" | "completed" | "abandoned" } : null;
    case "investigation_observed": return exactKeys(value, ["kind", "npcId", "factId", "evidenceQuality"])
      && nonEmptyString(value.npcId) && nonEmptyString(value.factId)
      && (value.evidenceQuality === "clean" || value.evidenceQuality === "noisy")
      ? { kind: "investigation_observed", npcId: value.npcId as NpcId, factId: value.factId as FactId, evidenceQuality: value.evidenceQuality } : null;
  }
  return null;
}

/** Strict runtime parser for interaction definitions stored in Entity. */
export function parseStoryInteraction(value: unknown, path = "interaction"): StoryInteractionParseResult {
  if (!isRecord(value) || !exactKeys(value, ["id", "npcId", "operation", "condition", "factIds", "goalIds", "promiseId", "audienceIds", "evidenceEventIds"], ["confidentiality"])) {
    return { ok: false, code: "INVALID_INTERACTION", path };
  }
  if (!nonEmptyString(value.id) || !nonEmptyString(value.npcId) || !STORY_INTERACTION_OPERATIONS.includes(value.operation as StoryInteractionOperation)) {
    return { ok: false, code: "INVALID_INTERACTION", path };
  }
  const parsedConditions = Array.isArray(value.condition) ? value.condition.map(parseStoryCondition) : [];
  if (!Array.isArray(value.condition) || parsedConditions.some((entry) => entry === null)
    || !stringArray(value.factIds) || !stringArray(value.goalIds) || !stringArray(value.audienceIds) || !stringArray(value.evidenceEventIds)
    || !(value.evidenceEventIds as readonly string[]).every(isWellFormedEventId)
    || (value.promiseId !== null && !nonEmptyString(value.promiseId))) {
    return { ok: false, code: "INVALID_INTERACTION", path };
  }
  const confidentiality = value.confidentiality === undefined ? undefined : parseConfidentialityTerms(value.confidentiality);
  if (confidentiality === null || (value.operation === "promise_confidentiality" ? confidentiality === undefined : confidentiality !== undefined)) return { ok: false, code: "INVALID_INTERACTION", path };
  return {
    ok: true,
    value: {
      ...(confidentiality === undefined ? {} : { confidentiality }),
      id: value.id,
      npcId: value.npcId as NpcId,
      operation: value.operation as StoryInteractionOperation,
      condition: parsedConditions as StoryCondition[],
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
  ], ["confidentiality"])) {
    return { ok: false, code: "INVALID_INTERACTION", path };
  }
  if (!nonEmptyString(value.proposalKey)) return { ok: false, code: "INVALID_INTERACTION", path };
  const { proposalKey, ...interactionFields } = value;
  const parsed = parseStoryInteraction({ ...interactionFields, id: `proposal:${proposalKey}` }, path);
  if (!parsed.ok) return parsed;
  const { id: _id, ...proposal } = parsed.value;
  return { ok: true, value: { ...proposal, proposalKey } };
}

/** Strict parser for server-installed cooperation permissions. */
export function parseNpcCooperationDefinition(value: unknown): NpcCooperationDefinition | null {
  if (!isRecord(value) || !exactKeys(value, ["operation", "requirements", "allowedFactIds", "allowedAudienceIds"])) return null;
  if (value.operation !== "request_introduction" && value.operation !== "request_verification") return null;
  if (!Array.isArray(value.requirements) || value.requirements.length === 0 || value.requirements.length > 4) return null;
  if (value.requirements.some((condition) => parseStoryCondition(condition) === null)) return null;
  if (!stringArray(value.allowedFactIds) || value.allowedFactIds.length === 0) return null;
  if (!stringArray(value.allowedAudienceIds) || value.allowedAudienceIds.length === 0) return null;
  if (new Set(value.allowedFactIds).size !== value.allowedFactIds.length
    || new Set(value.allowedAudienceIds).size !== value.allowedAudienceIds.length) return null;
  return {
    operation: value.operation,
    requirements: value.requirements.map((condition) => parseStoryCondition(condition)!).filter((condition): condition is StoryCondition => condition !== null),
    allowedFactIds: value.allowedFactIds as FactId[],
    allowedAudienceIds: value.allowedAudienceIds as EntityId[],
  };
}

export function parseNpcCooperationDefinitions(value: unknown): readonly NpcCooperationDefinition[] | null {
  if (!Array.isArray(value) || value.length > 2) return null;
  const parsed = value.map(parseNpcCooperationDefinition);
  if (parsed.some((definition) => definition === null)) return null;
  const definitions = parsed as NpcCooperationDefinition[];
  return new Set(definitions.map((definition) => definition.operation)).size === definitions.length ? definitions : null;
}

export type StoryInteractionTargetId = PlayerEntityId | NpcId;

export function parseConfidentialityTerms(value: unknown): ConfidentialityTerms | null {
  if (!isRecord(value) || !exactKeys(value, ["protectedFactIds", "allowedAudienceIds", "fulfillment"])
    || !stringArray(value.protectedFactIds) || value.protectedFactIds.length === 0
    || !stringArray(value.allowedAudienceIds) || value.allowedAudienceIds.length === 0
    || !isRecord(value.fulfillment) || !exactKeys(value.fulfillment, ["kind"])
    || value.fulfillment.kind !== "story_delivery") return null;
  return { protectedFactIds: value.protectedFactIds as FactId[], allowedAudienceIds: value.allowedAudienceIds as EntityId[], fulfillment: { kind: "story_delivery" } };
}
