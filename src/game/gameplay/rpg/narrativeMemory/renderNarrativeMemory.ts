import {
  entitiesOfKind,
  getEntity,
  type EntityStore,
  type EntityKind,
  type EntityRecord,
} from "@/game/domain/entity";
import type { CommittedNarrativeEvent } from "@/game/domain/events";
import type { EntityId } from "@/game/domain/entity/entityCore";
import type { RetrievedNarrativeMemory } from "./retrieveNarrativeMemory";

export type NarrativeMemoryManifestRefs = Readonly<{
  readonly eventIds: readonly CommittedNarrativeEvent["eventId"][];
  readonly episodeIds: readonly import("@/game/domain/events").EpisodeId[];
  readonly sceneEventIds: readonly CommittedNarrativeEvent["eventId"][];
}>;

export type RenderedNarrativeMemory = Readonly<{
  readonly requiredEventsText: string;
  readonly relevantEpisodesText: string;
  readonly relevantEventsText: string;
  readonly recentScenesText: string;
  readonly manifestRefs: NarrativeMemoryManifestRefs;
}>;

function publicFactIds(entityStore: EntityStore): ReadonlySet<string> {
  const secretIds = new Set(
    entitiesOfKind(entityStore, "npc")
      .flatMap((npc) => npc.knowledge.entries)
      .filter((entry) => entry.disclosure === "secret")
      .map((entry) => String(entry.factId)),
  );
  return new Set(
    entitiesOfKind(entityStore, "fact")
      .filter((fact) => fact.fact.discovered && !secretIds.has(String(fact.core.id)))
      .map((fact) => String(fact.core.id)),
  );
}

function entityName(entityStore: EntityStore, id: string): string | undefined {
  return getEntity(entityStore, id)?.core.name;
}

function isEntityKind<K extends EntityKind>(
  record: EntityRecord,
  kind: K,
): record is Extract<EntityRecord, { readonly core: { readonly kind: K } }> {
  return record.core.kind === kind;
}

function locationName(entityStore: EntityStore, id: string | null): string {
  if (id === null) return "无";
  return entityName(entityStore, id) ?? id;
}

function entityLabels(entityStore: EntityStore, ids: readonly EntityId[]): readonly string[] {
  return ids.map(String).map((id) => {
    const name = entityName(entityStore, id);
    return name === undefined ? id : `${name}(${id})`;
  });
}

function currentStateLabel(entityStore: EntityStore, id: string): string | undefined {
  const record = getEntity(entityStore, id);
  if (record === undefined) return undefined;
  const name = `${record.core.name}(${id})`;
  if (isEntityKind(record, "npc") || isEntityKind(record, "player_character") || isEntityKind(record, "enemy")) {
    return `${name}; currentLifecycle=${record.core.lifecycle}; currentLocation=${locationName(entityStore, String(record.position.locationId))}`;
  }
  if (isEntityKind(record, "quest")) {
    return `${name}; currentLifecycle=${record.core.lifecycle}; currentQuestStatus=${record.quest.status}`;
  }
  return `${name}; currentLifecycle=${record.core.lifecycle}`;
}

function eventCard(
  event: CommittedNarrativeEvent,
  entityStore: EntityStore,
  safeFactIds: ReadonlySet<string>,
): string {
  const participants = [...event.actorIds, ...event.targetIds].map(String);
  const states = [...new Set(participants)]
    .map((id) => currentStateLabel(entityStore, id))
    .filter((value): value is string => value !== undefined);
  const facts = event.factIds.map(String).filter((id) => safeFactIds.has(id));
  const itemRef = event.payload.type === "item_obtained" || event.payload.type === "item_given"
    ? `; itemId=${event.payload.itemId}`
    : "";
  return `eventId=${event.eventId}; sequence=${event.sequence}; turn=${event.turnNumber}; kind=${event.kind}; actors=[${entityLabels(entityStore, event.actorIds as readonly EntityId[]).join(", ") || "无"}]; targets=[${entityLabels(entityStore, event.targetIds as readonly EntityId[]).join(", ") || "无"}]; thenLocation=${locationName(entityStore, event.locationId === null ? null : String(event.locationId))}; publicFactIds=[${facts.join(", ") || "无"}]; outcome=${event.outcome}; causeEventIds=[${event.causeEventIds.map(String).join(", ") || "无"}]; currentState=[${states.join(" | ") || "无"}]${itemRef}`;
}

function episodeCard(
  match: RetrievedNarrativeMemory["relevantEpisodes"][number],
  entityStore: EntityStore,
  safeFactIds: ReadonlySet<string>,
): string {
  const episode = match.episode;
  const states = episode.participantEntityIds
    .map(String)
    .map((id) => currentStateLabel(entityStore, id))
    .filter((value): value is string => value !== undefined);
  const facts = episode.factIds.map(String).filter((id) => safeFactIds.has(id));
  return `episodeId=${episode.episodeId}; kind=${episode.kind}; historyTurns=${episode.fromTurn}-${episode.toTurn}; eventKinds=[${episode.summaryKeys.join(", ") || "无"}]; eventIds=[${episode.eventIds.map(String).join(", ")}]; thenLocations=[${episode.locationIds.map(String).map((id) => locationName(entityStore, id)).join(", ") || "无"}]; publicFactIds=[${facts.join(", ") || "无"}]; outcome=${episode.outcome}; salience=${episode.salience}; matchedBy=[${match.matchedBy.join(", ")}]; currentState=[${states.join(" | ") || "无"}]`;
}

function sceneCard(
  scene: RetrievedNarrativeMemory["recentScenes"][number],
  entityStore: EntityStore,
  safeFactIds: ReadonlySet<string>,
): string {
  const facts = scene.revealedFactIds.map(String).filter((id) => safeFactIds.has(id));
  const focus = scene.focusNpcId === null
    ? "无"
    : entityName(entityStore, String(scene.focusNpcId)) ?? String(scene.focusNpcId);
  return `sceneEventId=${scene.sceneEventId}; sceneId=${scene.sceneId}; turn=${scene.turnNumber}; thenLocation=${locationName(entityStore, String(scene.locationId))}; focusNpc=${focus}; pacing=${scene.pacing}; beatIds=[${scene.beatIds.join(", ") || "无"}]; publicFactIds=[${facts.join(", ") || "无"}]`;
}

/** Render only bounded, structural cards; prose and private component history stay out. */
export function renderNarrativeMemory(input: Readonly<{
  readonly retrieved: RetrievedNarrativeMemory;
  readonly entityStore: EntityStore;
}>): RenderedNarrativeMemory {
  const safeFactIds = publicFactIds(input.entityStore);
  const eventCards = input.retrieved.requiredEvents.map((event) => eventCard(event, input.entityStore, safeFactIds));
  const episodeCards = input.retrieved.relevantEpisodes.flatMap((match) => [
    episodeCard(match, input.entityStore, safeFactIds),
    ...match.relatedItemEvents.map((event) => eventCard(event, input.entityStore, safeFactIds)),
  ]);
  const sceneCards = input.retrieved.recentScenes.map((scene) => sceneCard(scene, input.entityStore, safeFactIds));
  return {
    requiredEventsText: eventCards.join("\n"),
    relevantEpisodesText: episodeCards.join("\n"),
    relevantEventsText: [...eventCards, ...episodeCards].join("\n"),
    recentScenesText: sceneCards.join("\n"),
    manifestRefs: {
      eventIds: [...new Set([
        ...input.retrieved.requiredEvents.map((event) => event.eventId),
        ...input.retrieved.relevantEpisodes.flatMap((match) => match.relatedItemEvents.map((event) => event.eventId)),
      ])],
      episodeIds: input.retrieved.relevantEpisodes.map((match) => match.episode.episodeId),
      sceneEventIds: input.retrieved.recentScenes.map((scene) => scene.sceneEventId),
    },
  };
}
