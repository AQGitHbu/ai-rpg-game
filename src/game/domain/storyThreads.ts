import type { EntityId } from "./entity/entityCore";
import { parseStoryCondition, type StoryCondition } from "./storyInteraction";
import { isWellFormedEventId, type EventId, type CommittedNarrativeEvent } from "./events";
import type { NpcId, PlayerEntityId, QuestId } from "./worldEntity";

export type StoryThreadKind = "conflict" | "question" | "commitment_followup";
export type StoryThreadStatus = "open" | "advanced" | "resolved" | "abandoned";

/** A shallow, causal story concern; it is not a second quest state machine. */
export type StoryThread = Readonly<{
  id: string;
  kind: StoryThreadKind;
  participantIds: readonly EntityId[];
  causeEventIds: readonly EventId[];
  questIds: readonly QuestId[];
  goalRefs: readonly { readonly npcId: NpcId; readonly goalId: string }[];
  promiseRefs: readonly { readonly npcId: NpcId; readonly promiseId: string }[];
  question: string;
  status: StoryThreadStatus;
  evidenceEventIds: readonly EventId[];
  closure: readonly StoryCondition[];
  tentativeDirections: readonly string[];
}>;

export function createMainStoryThread(id = "main_thread"): StoryThread {
  return {
    id,
    kind: "question",
    participantIds: [],
    causeEventIds: [],
    questIds: [],
    goalRefs: [],
    promiseRefs: [],
    question: "主线仍待推进。",
    status: "open",
    evidenceEventIds: [],
    closure: [],
    tentativeDirections: [],
  };
}

export type StoryThreadParseResult =
  | Readonly<{ ok: true; value: StoryThread }>
  | Readonly<{ ok: false; path: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown, eventIds = false): value is string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string" && entry.trim() !== "" && (!eventIds || isWellFormedEventId(entry)))
    && new Set(value).size === value.length;
}

function exact(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = new Set(required);
  return required.every((key) => key in value) && Object.keys(value).every((key) => keys.has(key));
}

function ref(value: unknown, fields: readonly string[]): value is Record<string, string> {
  return isRecord(value) && exact(value, fields) && fields.every((field) => typeof value[field] === "string" && value[field].trim() !== "");
}

export function parseStoryThread(value: unknown, path = "thread"): StoryThreadParseResult {
  const keys = ["id", "kind", "participantIds", "causeEventIds", "questIds", "goalRefs", "promiseRefs", "question", "status", "evidenceEventIds", "closure", "tentativeDirections"] as const;
  if (!isRecord(value) || !exact(value, keys)) return { ok: false, path };
  if (typeof value.id !== "string" || value.id.trim() === ""
    || !["conflict", "question", "commitment_followup"].includes(value.kind as string)
    || !["open", "advanced", "resolved", "abandoned"].includes(value.status as string)
    || typeof value.question !== "string" || value.question.trim() === ""
    || !strings(value.participantIds) || !strings(value.causeEventIds, true) || !strings(value.questIds)
    || !strings(value.evidenceEventIds, true) || !strings(value.tentativeDirections)
    || !Array.isArray(value.closure)) return { ok: false, path };
  const goalRefs = Array.isArray(value.goalRefs) && value.goalRefs.every((entry) => ref(entry, ["npcId", "goalId"]));
  const promiseRefs = Array.isArray(value.promiseRefs) && value.promiseRefs.every((entry) => ref(entry, ["npcId", "promiseId"]));
  const closure = value.closure.map(parseStoryCondition);
  if (!goalRefs || !promiseRefs || closure.some((entry) => entry === null)) return { ok: false, path };
  return {
    ok: true,
    value: {
      id: value.id,
      kind: value.kind as StoryThreadKind,
      participantIds: value.participantIds as EntityId[],
      causeEventIds: value.causeEventIds as EventId[],
      questIds: value.questIds as QuestId[],
      goalRefs: value.goalRefs as { npcId: NpcId; goalId: string }[],
      promiseRefs: value.promiseRefs as { npcId: NpcId; promiseId: string }[],
      question: value.question,
      status: value.status as StoryThreadStatus,
      evidenceEventIds: value.evidenceEventIds as EventId[],
      closure: closure as StoryCondition[],
      tentativeDirections: value.tentativeDirections,
    },
  };
}

export function unresolvedStoryThreadIds(threads: readonly StoryThread[]): readonly string[] {
  return threads
    .filter((thread) => thread.status === "open" || thread.status === "advanced")
    .map((thread) => thread.id);
}

export function storyThreadEventIsRelated(
  thread: StoryThread,
  event: CommittedNarrativeEvent,
): boolean {
  if (thread.causeEventIds.includes(event.eventId) || thread.evidenceEventIds.includes(event.eventId)) return true;
  if (thread.questIds.some((questId) => event.questIds.includes(questId))) return true;
  const participants = new Set(thread.participantIds.map(String));
  for (const id of [...event.actorIds, ...event.targetIds]) {
    if (participants.has(String(id))) return true;
  }
  const referencedNpcIds = new Set([
    ...thread.goalRefs.map((entry) => String(entry.npcId)),
    ...thread.promiseRefs.map((entry) => String(entry.npcId)),
  ]);
  return [...event.actorIds, ...event.targetIds].some((id) => referencedNpcIds.has(String(id)));
}

export type StoryThreadPlayerId = PlayerEntityId;
