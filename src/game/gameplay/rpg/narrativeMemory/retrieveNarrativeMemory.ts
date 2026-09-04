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
import type {
  FactId,
  LocationId,
  NpcId,
  QuestId,
} from "@/game/domain/worldEntity";

export type NarrativeMemoryQuery = Readonly<{
  readonly memory: EpisodicMemoryState;
  readonly ledger: readonly CommittedNarrativeEvent[];
  readonly requiredEventIds?: readonly EventId[];
  readonly requiredEpisodeIds?: readonly EpisodeId[];
  readonly relevantEntityIds?: readonly string[];
  readonly relevantQuestIds?: readonly QuestId[];
  readonly relevantFactIds?: readonly FactId[];
  readonly causeEventIds?: readonly EventId[];
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
  | "location"
  | "cause";

export type NarrativeMemoryEpisodeMatch = Readonly<{
  readonly episode: NarrativeEpisode;
  /** Descending lexicographic rank: authority, task, entity, cause, salience, recency. */
  readonly rank: readonly number[];
  readonly matchedBy: readonly NarrativeMemoryMatchReason[];
}>;

export type RetrievedNarrativeMemory = Readonly<{
  readonly requiredEvents: readonly CommittedNarrativeEvent[];
  readonly relevantEpisodes: readonly NarrativeMemoryEpisodeMatch[];
  readonly recentScenes: readonly RecentSceneMemory[];
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
  const requiredEventIds = stringSet(query.requiredEventIds?.map(String));
  const requiredEpisodeIds = stringSet(query.requiredEpisodeIds?.map(String));
  const relevantEntityIds = new Set<string>([
    ...(query.relevantEntityIds ?? []).map(String),
    ...(query.focusNpcId === undefined || query.focusNpcId === null ? [] : [String(query.focusNpcId)]),
  ]);
  const relevantQuestIds = stringSet(query.relevantQuestIds?.map(String));
  const relevantFactIds = stringSet(query.relevantFactIds?.map(String));
  const causeEventIds = new Set<string>([
    ...(query.causeEventIds ?? []).map(String),
    ...requiredEventIds,
  ]);
  const currentLocationId = query.currentLocationId === undefined || query.currentLocationId === null
    ? undefined
    : String(query.currentLocationId);

  const matches: NarrativeMemoryEpisodeMatch[] = [];
  for (const episode of query.memory.episodes) {
    const reasons: NarrativeMemoryMatchReason[] = [];
    const requiredEpisode = requiredEpisodeIds.has(String(episode.episodeId));
    const entityHit = intersects(episode.participantEntityIds.map(String), relevantEntityIds)
      || intersects(episode.factIds.map(String), relevantFactIds);
    const questHit = intersects(episode.questIds.map(String), relevantQuestIds);
    const locationHit = currentLocationId !== undefined && episode.locationIds.some((id) => String(id) === currentLocationId);
    const causeHit = intersects(episode.causeEventIds.map(String), causeEventIds);
    if (requiredEpisode) reasons.push("required_episode");
    if (entityHit) reasons.push("entity");
    if (questHit) reasons.push("quest");
    if (locationHit) reasons.push("location");
    if (causeHit) reasons.push("cause");
    if (reasons.length === 0) continue;
    matches.push({
      episode,
      matchedBy: reasons,
      rank: [
        requiredEpisode ? 1 : 0,
        questHit ? 1 : 0,
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
    requiredEvents: stableRequiredEvents(query.ledger, query.requiredEventIds),
    relevantEpisodes: matches.sort(compareRank).slice(0, maxEpisodes),
    recentScenes: maxRecentScenes === 0 ? [] : query.memory.recentScenes.slice(-maxRecentScenes),
  };
}
