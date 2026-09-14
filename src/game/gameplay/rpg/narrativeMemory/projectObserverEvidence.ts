import type { CommittedNarrativeEvent } from "@/game/domain/events";
import type { EntityId } from "@/game/domain/entity/entityCore";
import type { NpcEntityRecord, PlayerEntityRecord } from "@/game/domain/entity/entityRecord";
import type { HistoryEntry } from "@/game/domain/narrativeHistory";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";

export type ObserverEvidence = Readonly<{
  readonly observerId: EntityId;
  readonly history: readonly HistoryEntry[];
  readonly events: readonly CommittedNarrativeEvent[];
  readonly knownEntityIds: readonly EntityId[];
}>;

function hasId(values: readonly EntityId[], id: EntityId): boolean {
  return values.some((candidate) => String(candidate) === String(id));
}

function isVisibleHistoryEntry(entry: HistoryEntry, observerId: EntityId): boolean {
  return entry.kind !== "shown_choice"
    && (hasId(entry.audienceIds, observerId) || entry.speakerId !== null && String(entry.speakerId) === String(observerId));
}

function observerKnowsFact(worldState: WorldState, observerId: EntityId, factId: string): boolean {
  const record = worldState.entityStore.records.find((candidate) => String(candidate.core.id) === String(observerId));
  if (record?.core.kind === "player_character") {
    const player = record as PlayerEntityRecord;
    return player.knowledge.knownFactIds.some((knownId) => String(knownId) === factId);
  }
  if (record?.core.kind === "npc") {
    const npc = record as NpcEntityRecord;
    return npc.knowledge.entries.some((entry) => String(entry.factId) === factId);
  }
  return false;
}

function eventMayBeObserved(
  worldState: WorldState,
  event: CommittedNarrativeEvent,
  observerId: EntityId,
  visibleHistoryEventIds: ReadonlySet<string>,
): boolean {
  if (visibleHistoryEventIds.has(String(event.eventId))) return true;
  const actorIds = event.actorIds ?? [];
  const targetIds = event.targetIds ?? [];
  const isParticipant = actorIds.some((id) => String(id) === String(observerId))
    || targetIds.some((id) => String(id) === String(observerId));
  if (!isParticipant) return false;
  return (event.factIds ?? []).every((factId) => observerKnowsFact(worldState, observerId, String(factId)));
}

/**
 * Project authoritative history and ledger entries into one observer's source
 * boundary. This is deliberately a pure projection: it never grants a name,
 * fact, or event merely because it exists in the global store.
 */
export function projectObserverEvidence(input: Readonly<{
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly observerId: EntityId;
}>): ObserverEvidence {
  const history = input.storyState.history.entries.filter((entry) =>
    isVisibleHistoryEntry(entry, input.observerId));
  const visibleHistoryEventIds = new Set(history.flatMap((entry) => (entry.eventIds ?? []).map(String)));
  const events = input.worldState.eventLedger.filter((event) =>
    eventMayBeObserved(input.worldState, event, input.observerId, visibleHistoryEventIds));
  const knownEntityIds = new Set<string>([String(input.observerId)]);
  for (const entry of history) {
    for (const id of entry.entityIds ?? []) knownEntityIds.add(String(id));
  }
  for (const event of events) {
    for (const id of [...event.actorIds, ...event.targetIds]) knownEntityIds.add(String(id));
    if (event.locationId !== null && event.locationId !== undefined) knownEntityIds.add(String(event.locationId));
  }
  const recordIds = new Set(input.worldState.entityStore.records.map((record) => String(record.core.id)));
  return {
    observerId: input.observerId,
    history,
    events,
    knownEntityIds: [...knownEntityIds]
      .filter((id): id is string => recordIds.has(id)) as EntityId[],
  };
}
