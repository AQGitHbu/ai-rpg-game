import type {
  CommittedNarrativeEvent,
  EpisodeId,
  EventId,
  NarrativeScenePresentedPayload,
  NpcMetPayload,
  StoryPacing,
} from "./events";
import { asEpisodeId } from "./events";
import type { EntityId } from "./entity/entityCore";
import type { FactId, LocationId, NpcId, QuestId } from "./worldEntity";

const MEMORY_VERSION = 1 as const;
const RECENT_SCENE_LIMIT = 8;

export type NpcContact = Readonly<{
  readonly npcId: NpcId;
  readonly lastContactTurn: number;
  readonly lastLocationId: LocationId;
}>;

export type NarrativeEpisode = Readonly<{
  readonly episodeId: EpisodeId;
  readonly kind: "initialization" | "turn" | "battle";
  readonly fromSequence: number;
  readonly toSequenceInclusive: number;
  readonly fromTurn: number;
  readonly toTurn: number;
  readonly eventIds: readonly EventId[];
  readonly participantEntityIds: readonly EntityId[];
  readonly locationIds: readonly LocationId[];
  readonly factIds: readonly FactId[];
  readonly questIds: readonly QuestId[];
  readonly causeEventIds: readonly EventId[];
  readonly outcome: CommittedNarrativeEvent["outcome"];
  readonly salience: number;
  readonly summaryVersion: 1;
  readonly summaryKeys: readonly string[];
}>;

export type RecentSceneMemory = Readonly<{
  readonly sceneEventId: EventId;
  readonly sceneId: string;
  readonly turnNumber: number;
  readonly locationId: LocationId;
  readonly focusNpcId: NpcId | null;
  readonly pacing: StoryPacing;
  readonly beatIds: readonly string[];
  readonly referencedEntityIds: readonly EntityId[];
  readonly revealedFactIds: readonly FactId[];
}>;

export type EpisodicMemoryState = Readonly<{
  readonly version: 1;
  readonly reducedThroughSequence: number;
  readonly episodes: readonly NarrativeEpisode[];
  readonly recentScenes: readonly RecentSceneMemory[];
  readonly npcContacts: readonly NpcContact[];
}>;

export function createEmptyEpisodicMemory(): EpisodicMemoryState {
  return {
    version: MEMORY_VERSION,
    reducedThroughSequence: -1,
    episodes: [],
    recentScenes: [],
    npcContacts: [],
  };
}

function uniqueByString<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(value);
  }
  return result;
}

function episodeKind(event: CommittedNarrativeEvent): NarrativeEpisode["kind"] {
  if (event.kind === "game_initialized") return "initialization";
  return String(event.episodeId).startsWith("episode:battle:") ? "battle" : "turn";
}

function reduceOutcome(
  current: CommittedNarrativeEvent["outcome"],
  next: CommittedNarrativeEvent["outcome"],
): CommittedNarrativeEvent["outcome"] {
  if (current === "mixed" || next === "mixed") return "mixed";
  if (current === "neutral") return next;
  if (next === "neutral" || current === next) return current;
  return "mixed";
}

function summaryKeysFor(event: CommittedNarrativeEvent): readonly string[] {
  return [event.kind, `outcome:${event.outcome}`];
}

function buildEpisode(events: readonly CommittedNarrativeEvent[]): NarrativeEpisode {
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const participants = uniqueByString(
    events.flatMap((event) => [...event.actorIds, ...event.targetIds] as readonly EntityId[]),
    String,
  );
  const locations = uniqueByString(
    events.flatMap((event) => event.locationId === null ? [] : [event.locationId]),
    String,
  );
  const factIds = uniqueByString(events.flatMap((event) => event.factIds), String);
  const questIds = uniqueByString(events.flatMap((event) => event.questIds), String);
  const causeEventIds = uniqueByString(events.flatMap((event) => event.causeEventIds), String);
  const summaryKeys = uniqueByString(
    events.flatMap(summaryKeysFor),
    (key) => key,
  );
  const outcome = events.slice(1).reduce(
    (current, event) => reduceOutcome(current, event.outcome),
    first.outcome,
  );
  return {
    episodeId: first.episodeId,
    kind: episodeKind(first),
    fromSequence: first.sequence,
    toSequenceInclusive: last.sequence,
    fromTurn: Math.min(...events.map((event) => event.turnNumber)),
    toTurn: Math.max(...events.map((event) => event.turnNumber)),
    eventIds: events.map((event) => event.eventId),
    participantEntityIds: participants,
    locationIds: locations,
    factIds,
    questIds,
    causeEventIds,
    outcome,
    salience: Math.max(...events.map((event) => event.salience)),
    summaryVersion: 1,
    summaryKeys,
  };
}

function buildRecentScenes(ledger: readonly CommittedNarrativeEvent[]): readonly RecentSceneMemory[] {
  const scenes: RecentSceneMemory[] = [];
  for (const event of ledger) {
    if (event.kind !== "narrative_scene_presented" || event.locationId === null) continue;
    const payload = event.payload as NarrativeScenePresentedPayload;
    scenes.push({
      sceneEventId: event.eventId,
      sceneId: payload.sceneId,
      turnNumber: event.turnNumber,
      locationId: event.locationId,
      focusNpcId: payload.focusNpcId,
      pacing: payload.pacing,
      beatIds: [...payload.beatIds],
      referencedEntityIds: uniqueByString(
        [...event.actorIds, ...event.targetIds] as readonly EntityId[],
        String,
      ),
      revealedFactIds: uniqueByString(payload.revealedFactIds, String),
    });
  }
  return scenes.slice(-RECENT_SCENE_LIMIT);
}

function buildNpcContacts(ledger: readonly CommittedNarrativeEvent[]): readonly NpcContact[] {
  const contacts = new Map<string, NpcContact>();
  for (const event of ledger) {
    if (event.kind !== "npc_met" || event.locationId === null) continue;
    const npcId = (event.payload as NpcMetPayload).npcId;
    contacts.set(String(npcId), {
      npcId,
      lastContactTurn: event.turnNumber,
      lastLocationId: event.locationId,
    });
  }
  return [...contacts.values()];
}

/** Rebuild the complete read model from the append-only ledger. */
export function rebuildEpisodicMemory(
  ledger: readonly CommittedNarrativeEvent[],
): EpisodicMemoryState {
  const groups = new Map<string, CommittedNarrativeEvent[]>();
  for (const event of [...ledger].sort((left, right) => left.sequence - right.sequence)) {
    const group = groups.get(String(event.episodeId));
    if (group === undefined) groups.set(String(event.episodeId), [event]);
    else if (!group.some((candidate) => String(candidate.eventId) === String(event.eventId))) group.push(event);
  }
  const episodes = [...groups.values()]
    .sort((left, right) => left[0]!.sequence - right[0]!.sequence)
    .map(buildEpisode);
  return {
    version: MEMORY_VERSION,
    reducedThroughSequence: ledger.length === 0 ? -1 : ledger.length - 1,
    episodes,
    recentScenes: buildRecentScenes(ledger),
    npcContacts: buildNpcContacts(ledger),
  };
}

/**
 * Reconcile before a CAS. Rebuilding is intentional: it makes incremental
 * updates observationally identical to a full rebuild and avoids a second
 * cursor-based source of truth.
 */
export function reconcileEpisodicMemory(input: Readonly<{
  readonly previous: EpisodicMemoryState;
  readonly ledger: readonly CommittedNarrativeEvent[];
}>): EpisodicMemoryState {
  return rebuildEpisodicMemory(input.ledger);
}

export function parseEpisodicMemory(value: unknown):
  | { readonly ok: true; readonly value: EpisodicMemoryState }
  | { readonly ok: false; readonly code: "INVALID_MEMORY" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "INVALID_MEMORY" };
  }
  const memory = value as Partial<EpisodicMemoryState>;
  if (memory.version !== MEMORY_VERSION
    || typeof memory.reducedThroughSequence !== "number"
    || !Number.isInteger(memory.reducedThroughSequence)
    || !Array.isArray(memory.episodes)
    || !Array.isArray(memory.recentScenes)
    || !Array.isArray(memory.npcContacts)) {
    return { ok: false, code: "INVALID_MEMORY" };
  }
  return { ok: true, value: memory as EpisodicMemoryState };
}
