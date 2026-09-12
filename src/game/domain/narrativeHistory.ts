import { isWellFormedEventId, type EventId, type NarrativeJobId } from "./events";
import type { EntityId } from "./entity/entityCore";
import { PLAYER_ENTITY_ID, type FactId } from "./worldEntity";
import type { Action } from "./action";
import type { NarrativeSceneState } from "./narrative";
import { sceneExpressionsOf } from "./sceneExpression";

export type HistoryEntryKind =
  | "player_choice"
  | "player_freeform"
  | "narration"
  | "npc_line"
  | "shown_choice";

/**
 * The immutable, player-facing record of one expression that was actually
 * committed. It deliberately keeps audienceIds separate for every entry:
 * hearing a private line must never be inferred from being in the same scene.
 */
export type HistoryEntry = Readonly<{
  id: string;
  segmentId: string;
  sequence: number;
  actionId: string | null;
  jobId: NarrativeJobId | null;
  sceneId: string;
  revision: number;
  turnNumber: number;
  kind: HistoryEntryKind;
  text: string;
  speakerId: EntityId | null;
  audienceIds: readonly EntityId[];
  entityIds: readonly EntityId[];
  factIds: readonly FactId[];
  eventIds: readonly EventId[];
  choiceToken: string | null;
}>;

export type NarrativeHistory = Readonly<{
  entries: readonly HistoryEntry[];
}>;

/**
 * Append committed expressions idempotently. A retry may submit the exact
 * same entry again, but an already-used identity can never be rewritten.
 */
export function appendHistory(
  history: NarrativeHistory,
  entries: readonly HistoryEntry[],
): NarrativeHistory {
  const result = [...history.entries];
  const byId = new Map(result.map((entry) => [entry.id, entry]));

  for (const entry of entries) {
    const previous = byId.get(entry.id);
    if (previous !== undefined) {
      if (!sameHistoryEntry(previous, entry)) {
        throw new Error("HISTORY_ID_CONFLICT");
      }
      continue;
    }
    result.push(entry);
    byId.set(entry.id, entry);
  }

  return { entries: result };
}

function nextSequence(history: NarrativeHistory): number {
  return history.entries.reduce((max, entry) => Math.max(max, entry.sequence + 1), 0);
}

function entityIdsForAction(action: Action): readonly EntityId[] {
  switch (action.type) {
    case "talk": return [PLAYER_ENTITY_ID, action.npcId];
    case "move": return [PLAYER_ENTITY_ID, action.locationId];
    case "investigate": return [PLAYER_ENTITY_ID, action.factId];
    case "take_item": return [PLAYER_ENTITY_ID, action.itemId];
    case "give_item": return [PLAYER_ENTITY_ID, action.itemId, action.npcId];
    case "attack": return [PLAYER_ENTITY_ID, action.enemyId];
    case "battle_action": return [PLAYER_ENTITY_ID];
    case "explore":
    case "ack_prologue":
    case "freeform": return [PLAYER_ENTITY_ID];
  }
}

/** Build the A-side entry for a player action before the narrative job is sent. */
export function playerActionHistoryEntry(input: {
  readonly history: NarrativeHistory;
  readonly action: Action;
  readonly actionId: string;
  readonly text: string;
  readonly sceneId: string;
  readonly revision: number;
  readonly turnNumber: number;
  readonly eventIds: readonly EventId[];
  readonly jobId?: NarrativeJobId | null;
}): HistoryEntry {
  return {
    id: `${input.sceneId}:player:${input.actionId}`,
    segmentId: `segment:${input.actionId}`,
    sequence: nextSequence(input.history),
    actionId: input.actionId,
    jobId: input.jobId ?? null,
    sceneId: input.sceneId,
    revision: input.revision,
    turnNumber: input.turnNumber,
    kind: input.action.type === "freeform" ? "player_freeform" : "player_choice",
    text: input.text,
    speakerId: PLAYER_ENTITY_ID,
    audienceIds: [PLAYER_ENTITY_ID],
    entityIds: entityIdsForAction(input.action),
    factIds: [],
    eventIds: [...input.eventIds],
    choiceToken: null,
  };
}

/**
 * Build B-side entries in exactly the displayed order. This function never
 * turns a choice label into a player utterance; shown choices remain their own
 * non-action history kind.
 */
export function narrativeSceneHistoryEntries(input: {
  readonly history: NarrativeHistory;
  readonly scene: NarrativeSceneState;
  readonly actionId: string | null;
  readonly jobId: NarrativeJobId | null;
  readonly revision: number;
  readonly turnNumber: number;
  readonly eventIds: readonly EventId[];
}): readonly HistoryEntry[] {
  const expressions = input.scene.expressions === undefined
    ? sceneExpressionsOf({
        segments: [{ beatId: "narration", text: input.scene.narration }],
        npcLine: input.scene.npcLine,
      })
    : input.scene.expressions;
  const entries: HistoryEntry[] = [];
  let sequence = nextSequence(input.history);
  const segmentId = `segment:${input.actionId ?? input.scene.sceneId}`;

  for (const [ordinal, expression] of expressions.entries()) {
    const isNpc = expression.kind === "npc_line";
    const audienceIds = isNpc
      ? expression.audienceIds.map((id) => id as EntityId)
      : [PLAYER_ENTITY_ID];
    const entityIds = isNpc
      ? [...new Set([expression.npcId as EntityId, ...audienceIds])]
      : expression.referencedEntityIds.map((id) => id as EntityId);
    entries.push({
      id: `${input.scene.sceneId}:${expression.kind}:${ordinal}`,
      segmentId,
      sequence,
      actionId: input.actionId,
      jobId: input.jobId,
      sceneId: input.scene.sceneId,
      revision: input.revision,
      turnNumber: input.turnNumber,
      kind: isNpc ? "npc_line" : "narration",
      text: expression.text,
      speakerId: isNpc ? expression.npcId as EntityId : null,
      audienceIds,
      entityIds,
      factIds: isNpc ? expression.usedFactIds.map((id) => id as FactId) : [],
      eventIds: isNpc ? expression.usedEventIds.map((id) => id as EventId) : [...input.eventIds],
      choiceToken: null,
    });
    sequence += 1;
  }

  for (const [ordinal, choice] of input.scene.choices.entries()) {
    entries.push({
      id: `${input.scene.sceneId}:shown_choice:${ordinal}`,
      segmentId,
      sequence,
      actionId: null,
      jobId: input.jobId,
      sceneId: input.scene.sceneId,
      revision: input.revision,
      turnNumber: input.turnNumber,
      kind: "shown_choice",
      text: choice.label,
      speakerId: null,
      audienceIds: [PLAYER_ENTITY_ID],
      entityIds: [PLAYER_ENTITY_ID],
      factIds: [],
      eventIds: [...input.eventIds],
      choiceToken: choice.choiceToken,
    });
    sequence += 1;
  }
  return entries;
}

function sameArray(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameHistoryEntry(left: HistoryEntry, right: HistoryEntry): boolean {
  return left.id === right.id
    && left.segmentId === right.segmentId
    && left.sequence === right.sequence
    && left.actionId === right.actionId
    && left.jobId === right.jobId
    && left.sceneId === right.sceneId
    && left.revision === right.revision
    && left.turnNumber === right.turnNumber
    && left.kind === right.kind
    && left.text === right.text
    && left.speakerId === right.speakerId
    && sameArray(left.audienceIds, right.audienceIds)
    && sameArray(left.entityIds, right.entityIds)
    && sameArray(left.factIds, right.factIds)
    && sameArray(left.eventIds, right.eventIds)
    && left.choiceToken === right.choiceToken;
}

type HistoryParseResult =
  | { readonly ok: true; readonly value: NarrativeHistory }
  | { readonly ok: false; readonly code: "INVALID_NARRATIVE_HISTORY"; readonly path: string };

const HISTORY_KINDS: readonly HistoryEntryKind[] = [
  "player_choice", "player_freeform", "narration", "npc_line", "shown_choice",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => expected.has(key));
}

function invalid(path: string): HistoryParseResult {
  return { ok: false, code: "INVALID_NARRATIVE_HISTORY", path };
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "segmentId", "sequence", "actionId", "jobId", "sceneId", "revision", "turnNumber",
    "kind", "text", "speakerId", "audienceIds", "entityIds", "factIds", "eventIds", "choiceToken",
  ])) return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.segmentId)
    && Number.isInteger(value.sequence) && (value.sequence as number) >= 0
    && isNullableNonEmptyString(value.actionId)
    && isNullableNonEmptyString(value.jobId)
    && isNonEmptyString(value.sceneId)
    && Number.isInteger(value.revision) && (value.revision as number) >= 0
    && Number.isInteger(value.turnNumber) && (value.turnNumber as number) >= 0
    && HISTORY_KINDS.includes(value.kind as HistoryEntryKind)
    && isNonEmptyString(value.text)
    && isNullableNonEmptyString(value.speakerId)
    && isNonEmptyStringArray(value.audienceIds)
    && isNonEmptyStringArray(value.entityIds)
    && isNonEmptyStringArray(value.factIds)
    && isStringArray(value.eventIds)
    && value.eventIds.every((eventId) => isWellFormedEventId(eventId))
    && isNullableNonEmptyString(value.choiceToken);
}

/** Strict persistence parser. JSON is not considered valid history until this succeeds. */
export function parseNarrativeHistory(value: unknown): HistoryParseResult {
  if (!isRecord(value) || !hasExactKeys(value, ["entries"]) || !Array.isArray(value.entries)) {
    return invalid("history");
  }
  for (const [index, entry] of value.entries.entries()) {
    if (!isHistoryEntry(entry)) return invalid(`history.entries[${index}]`);
  }
  try {
    return { ok: true, value: appendHistory({ entries: [] }, value.entries) };
  } catch {
    return invalid("history.entries");
  }
}

export type { HistoryParseResult };
