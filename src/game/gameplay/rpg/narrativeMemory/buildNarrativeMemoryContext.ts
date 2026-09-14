import type { EventId } from "@/game/domain/events";
import type { EntityId } from "@/game/domain/entity/entityCore";
import type { HistoryEntry } from "@/game/domain/narrativeHistory";
import type { NarrativeMemoryContext } from "@/game/domain/narrativeMemoryContext";
import type { ObserverEvidence } from "./projectObserverEvidence";
import type { EvidenceSelection } from "./retrieveStoryEvidence";

function unique<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function sortedHistory(entries: readonly HistoryEntry[]): readonly HistoryEntry[] {
  return unique([...entries].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id)), (entry) => entry.id);
}

function sourceIds(evidence: ObserverEvidence): ReadonlySet<string> {
  return new Set([
    ...evidence.history.map((entry) => entry.id),
    ...evidence.events.map((event) => String(event.eventId)),
  ]);
}

/**
 * Build a deterministic, source-linked package. It never parses prose to
 * invent entity IDs and never mutates History, Event, Entity, or Story state.
 */
export function buildNarrativeMemoryContext(input: Readonly<{
  readonly evidence: ObserverEvidence;
  readonly selection: EvidenceSelection;
  readonly coveredThroughSequence: number;
  readonly overviewHistoryIds: readonly string[];
  readonly overviewEventIds: readonly EventId[];
}>): NarrativeMemoryContext {
  const { evidence, selection } = input;
  const historyById = new Map(evidence.history.map((entry) => [entry.id, entry] as const));
  const eventById = new Map(evidence.events.map((event) => [String(event.eventId), event] as const));
  const validHistory = evidence.history.filter((entry) => entry.kind !== "shown_choice");
  const coveredThroughSequence = Number.isFinite(input.coveredThroughSequence)
    ? Math.floor(input.coveredThroughSequence)
    : -1;
  const overviewHistoryIds = unique(input.overviewHistoryIds, String)
    .filter((id) => {
      const entry = historyById.get(id);
      return entry !== undefined && entry.sequence <= coveredThroughSequence;
    })
    .sort((left, right) => {
      const leftEntry = historyById.get(left)!;
      const rightEntry = historyById.get(right)!;
      return leftEntry.sequence - rightEntry.sequence || left.localeCompare(right);
    });
  const overviewHistorySet = new Set(overviewHistoryIds);
  const overviewEventIds = unique(input.overviewEventIds, String)
    .filter((id) => eventById.has(String(id)))
    .sort((left, right) => {
      const leftEvent = eventById.get(String(left))!;
      const rightEvent = eventById.get(String(right))!;
      return leftEvent.sequence - rightEvent.sequence || String(left).localeCompare(String(right));
    });
  const uncovered = sortedHistory(validHistory.filter((entry) =>
    entry.sequence > coveredThroughSequence && !overviewHistorySet.has(entry.id)));
  const selectedHistory = [...selection.historyIds, ...overviewHistoryIds]
    .map((id) => historyById.get(id))
    .filter((entry): entry is HistoryEntry => entry !== undefined && entry.kind !== "shown_choice")
    .filter((entry) => entry.sequence <= coveredThroughSequence);
  const recalled = sortedHistory(selectedHistory);
  const mandatoryRefs = new Set(selection.manifest.filter((entry) => entry.mandatory).map((entry) => entry.ref));
  const requiredEvents = unique(selection.eventIds
    .map((id) => eventById.get(String(id)))
    .filter((event): event is ObserverEvidence["events"][number] => event !== undefined)
    .filter((event) => mandatoryRefs.has(String(event.eventId))), (event) => String(event.eventId))
    .sort((left, right) => left.sequence - right.sequence || String(left.eventId).localeCompare(String(right.eventId)));
  const renderedHistory = [...uncovered, ...recalled];
  const usedEventIds = new Set([
    ...requiredEvents.map((event) => String(event.eventId)),
    ...overviewEventIds.map(String),
    ...renderedHistory.flatMap((entry) => entry.eventIds.map(String)),
  ]);
  const usedHistoryIds = new Set(renderedHistory.map((entry) => entry.id));
  const referenced = new Set<string>();
  for (const entry of renderedHistory) {
    for (const id of [...entry.entityIds, ...(entry.speakerId === null ? [] : [entry.speakerId])]) referenced.add(String(id));
  }
  for (const event of [...requiredEvents, ...overviewEventIds.map((id) => eventById.get(String(id))).filter((event): event is ObserverEvidence["events"][number] => event !== undefined)]) {
    for (const id of [...event.actorIds, ...event.targetIds]) referenced.add(String(id));
    if (event.locationId !== null) referenced.add(String(event.locationId));
  }
  const known = new Set(evidence.knownEntityIds.map(String));
  const validSources = sourceIds(evidence);
  const manifestByRef = new Map(selection.manifest.filter((entry) => validSources.has(entry.ref)).map(entry => [entry.ref, entry]));
  for (const entry of uncovered) manifestByRef.set(entry.id, { ref: entry.id, reason: "uncovered_history", mandatory: true });
  for (const ref of [...overviewHistoryIds, ...overviewEventIds.map(String)]) {
    if (!manifestByRef.get(ref)?.mandatory) manifestByRef.set(ref, { ref, reason: "summary_source", mandatory: true });
  }
  return {
    observerId: evidence.observerId,
    coveredThroughSequence,
    overviewHistoryIds,
    overviewEventIds,
    overviewEvents: overviewEventIds.map(id => eventById.get(String(id))!),
    uncovered,
    recalled,
    requiredEvents,
    referencedEntityIds: [...referenced].filter((id) => known.has(id)) as EntityId[],
    ambiguousEntityIds: selection.ambiguousEntityIds.filter((id) => known.has(String(id))),
    manifest: [...manifestByRef.values()].filter((entry) => usedHistoryIds.has(entry.ref) || usedEventIds.has(entry.ref)),
  };
}
