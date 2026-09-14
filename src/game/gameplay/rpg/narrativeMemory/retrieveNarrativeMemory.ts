import type {
  CommittedNarrativeEvent,
  EpisodeId,
  EventId,
} from "@/game/domain/events";
import type {
  EpisodicMemoryState,
  NarrativeEpisode,
  RecentSceneMemory,
} from "@/game/domain/episodicMemory";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import type {
  FactId,
  LocationId,
  NpcId,
  QuestId,
} from "@/game/domain/worldEntity";
import type { HistoryEntry, NarrativeHistory } from "@/game/domain/narrativeHistory";
import type { EvidenceSelection } from "./retrieveStoryEvidence";

export type NarrativeMemoryQuery = Readonly<{
  readonly memory: EpisodicMemoryState;
  readonly ledger: readonly CommittedNarrativeEvent[];
  /** Current resolution stays mandatory, but is not repeated as historical memory. */
  readonly beforeSequenceExclusive?: number;
  readonly requiredEventIds?: readonly EventId[];
  readonly requiredEpisodeIds?: readonly EpisodeId[];
  readonly relevantEntityIds?: readonly string[];
  readonly relevantQuestIds?: readonly QuestId[];
  readonly relevantFactIds?: readonly FactId[];
  readonly causeEventIds?: readonly EventId[];
  /** Optional bidirectional evidence selection; its index is derived, never persisted. */
  readonly storyEvidence?: EvidenceSelection;
  readonly history?: NarrativeHistory;
  readonly currentLocationId?: LocationId | null;
  readonly focusNpcId?: NpcId | null;
  readonly maxEpisodes?: number;
  readonly maxRecentScenes?: number;
}>;

export type NarrativeMemoryMatchReason =
  | "required_event"
  | "required_episode"
  | "entity"
  | "quest"
  | "fact"
  | "location"
  | "cause";

export type NarrativeMemoryEpisodeMatch = Readonly<{
  readonly episode: NarrativeEpisode;
  /** At most three exact item events, projected from the ledger, never persisted. */
  readonly relatedItemEvents: readonly CommittedNarrativeEvent[];
  /** Descending lexicographic rank: hard refs, task/fact, entity, cause, location, salience, recency. */
  readonly rank: readonly number[];
  readonly matchedBy: readonly NarrativeMemoryMatchReason[];
}>;

export type RetrievedNarrativeMemory = Readonly<{
  readonly requiredEvents: readonly CommittedNarrativeEvent[];
  readonly relevantEpisodes: readonly NarrativeMemoryEpisodeMatch[];
  readonly recentScenes: readonly RecentSceneMemory[];
  readonly historyEntries: readonly HistoryEntry[];
}>;

function stringSet(values: readonly (string | undefined)[] | undefined): ReadonlySet<string> {
  return new Set((values ?? []).filter((value): value is string => value !== undefined));
}

function intersects(values: readonly string[], wanted: ReadonlySet<string>): boolean {
  return values.some((value) => wanted.has(String(value)));
}

function compareRank(left: NarrativeMemoryEpisodeMatch, right: NarrativeMemoryEpisodeMatch): number {
  for (let index = 0; index < Math.max(left.rank.length, right.rank.length); index += 1) {
    const leftValue = left.rank[index] ?? 0;
    const rightValue = right.rank[index] ?? 0;
    if (leftValue !== rightValue) return rightValue - leftValue;
  }
  return String(left.episode.episodeId).localeCompare(String(right.episode.episodeId));
}

function stableRequiredEvents(
  ledger: readonly CommittedNarrativeEvent[],
  requiredEventIds: readonly EventId[] | undefined,
): readonly CommittedNarrativeEvent[] {
  const byId = new Map(ledger.map((event) => [String(event.eventId), event]));
  const seen = new Set<string>();
  const result: CommittedNarrativeEvent[] = [];
  for (const eventId of requiredEventIds ?? []) {
    const key = String(eventId);
    if (seen.has(key)) continue;
    seen.add(key);
    const event = byId.get(key);
    if (event !== undefined) result.push(event);
  }
  return result;
}

/**
 * Select bounded memory cards using only structural references. Recency alone
 * cannot make an old Episode relevant; recent scenes are a separate bounded
 * working-context projection.
 */
export function retrieveNarrativeMemory(
  query: NarrativeMemoryQuery,
): RetrievedNarrativeMemory {
  const evidenceEventIds = query.storyEvidence?.eventIds ?? [];
  const mandatoryRefs = new Set(
    (query.storyEvidence?.manifest ?? [])
      .filter((ref) => ref.mandatory)
      .map((ref) => ref.ref),
  );
  const evidenceRequiredEventIds = evidenceEventIds.filter((eventId) => mandatoryRefs.has(String(eventId)));
  const requiredEventIds = stringSet([
    ...(query.requiredEventIds ?? []).map(String),
    ...evidenceRequiredEventIds.map(String),
  ]);
  const requiredEvents = stableRequiredEvents(query.ledger, [...requiredEventIds].map((id) => id as EventId));
  const memory = query.beforeSequenceExclusive === undefined
    ? query.memory
    : rebuildEpisodicMemory(query.ledger.filter((event) => event.sequence < query.beforeSequenceExclusive!));
  const requiredEpisodeIds = stringSet(query.requiredEpisodeIds?.map(String));
  const relevantEntityIds = new Set<string>([
    ...(query.relevantEntityIds ?? []).map(String),
    ...(query.storyEvidence?.entityIds ?? []).map(String),
    ...(query.focusNpcId === undefined || query.focusNpcId === null ? [] : [String(query.focusNpcId)]),
  ]);
  const relevantQuestIds = stringSet(query.relevantQuestIds?.map(String));
  const relevantFactIds = stringSet(query.relevantFactIds?.map(String));
  const causeEventIds = new Set<string>([
    ...(query.causeEventIds ?? []).map(String),
    ...evidenceEventIds.map(String),
    ...requiredEventIds,
    ...requiredEvents.flatMap((event) => event.causeEventIds.map(String)),
  ]);
  const currentLocationId = query.currentLocationId === undefined || query.currentLocationId === null
    ? undefined
    : String(query.currentLocationId);
  const itemEventsByEpisode = new Map<string, CommittedNarrativeEvent[]>();
  for (const event of query.ledger) {
    if (query.beforeSequenceExclusive !== undefined && event.sequence >= query.beforeSequenceExclusive) continue;
    const payload = event.payload;
    if ((payload.type !== "item_obtained" && payload.type !== "item_given")
      || !relevantEntityIds.has(String(payload.itemId))) continue;
    const key = String(event.episodeId);
    const events = itemEventsByEpisode.get(key) ?? [];
    events.push(event);
    itemEventsByEpisode.set(key, events);
  }

  const matches: NarrativeMemoryEpisodeMatch[] = [];
  for (const episode of memory.episodes) {
    const reasons: NarrativeMemoryMatchReason[] = [];
    const requiredEpisode = requiredEpisodeIds.has(String(episode.episodeId));
    const requiredEvent = intersects(episode.eventIds.map(String), requiredEventIds);
    const relatedItemEvents = (itemEventsByEpisode.get(String(episode.episodeId)) ?? [])
      .filter((event) => episode.eventIds.includes(event.eventId)).slice(-3);
    const entityHit = intersects(episode.participantEntityIds.map(String), relevantEntityIds)
      || relatedItemEvents.length > 0;
    const factHit = intersects(episode.factIds.map(String), relevantFactIds);
    const questHit = intersects(episode.questIds.map(String), relevantQuestIds);
    const locationHit = currentLocationId !== undefined && episode.locationIds.some((id) => String(id) === currentLocationId);
    const causeHit = intersects(episode.causeEventIds.map(String), causeEventIds)
      || intersects(episode.eventIds.map(String), causeEventIds);
    if (requiredEvent) reasons.push("required_event");
    if (requiredEpisode) reasons.push("required_episode");
    if (entityHit) reasons.push("entity");
    if (questHit) reasons.push("quest");
    if (factHit) reasons.push("fact");
    if (locationHit) reasons.push("location");
    if (causeHit) reasons.push("cause");
    if (reasons.length === 0) continue;
    matches.push({
      episode,
      relatedItemEvents,
      matchedBy: reasons,
      rank: [
        requiredEvent || requiredEpisode ? 1 : 0,
        questHit || factHit ? 1 : 0,
        entityHit ? 1 : 0,
        causeHit ? 1 : 0,
        locationHit ? 1 : 0,
        episode.salience,
        episode.toSequenceInclusive,
      ],
    });
  }

  const maxEpisodes = Math.max(0, Math.floor(query.maxEpisodes ?? 6));
  const maxRecentScenes = Math.max(0, Math.floor(query.maxRecentScenes ?? 4));
  return {
    requiredEvents,
    relevantEpisodes: matches.sort(compareRank).slice(0, maxEpisodes),
    recentScenes: maxRecentScenes === 0 ? [] : memory.recentScenes.slice(-maxRecentScenes),
    historyEntries: query.history === undefined || query.storyEvidence === undefined
      ? []
      : query.history.entries
        .filter((entry) => entry.kind !== "shown_choice"
          && query.storyEvidence!.historyIds.includes(entry.id))
        .sort((left, right) => left.sequence - right.sequence),
  };
}
