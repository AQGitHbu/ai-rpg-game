import type { EventId } from "@/game/domain/events";
import type { EntityId } from "@/game/domain/entity/entityCore";
import { entitiesOfKind, type EntityRecord } from "@/game/domain/entity";
import type { HistoryEntry } from "@/game/domain/narrativeHistory";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import {
  projectObserverEvidence,
  type ObserverEvidence,
} from "./projectObserverEvidence";

export type EvidenceQuery = Readonly<{
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly observerId: EntityId;
  readonly text: string;
  readonly actionEntityIds: readonly EntityId[];
  readonly focusEntityIds: readonly EntityId[];
  /** Reuse one permission projection across retrieval and rendering. */
  readonly visibleEvidence?: ObserverEvidence;
  /** Context references are optional candidates, not current-rule hard refs. */
  readonly contextEntityIds?: readonly EntityId[];
  readonly contextEventIds?: readonly EventId[];
  readonly presentHistoryIds?: readonly string[];
}>;

export type EvidenceManifestEntry = Readonly<{
  readonly ref: string;
  readonly reason: string;
  readonly mandatory: boolean;
}>;

export type EvidenceSelection = Readonly<{
  readonly entityIds: readonly EntityId[];
  readonly eventIds: readonly EventId[];
  readonly historyIds: readonly string[];
  readonly ambiguousEntityIds: readonly EntityId[];
  readonly manifest: readonly EvidenceManifestEntry[];
}>;

type Candidate = {
  readonly id: EntityId;
  score: number;
  explicit: boolean;
  exact: boolean;
  reasons: Set<string>;
  eventIds: Set<string>;
  historyIds: Set<string>;
};

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, "");
}

function unique<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function visibleAlias(
  alias: { readonly text: string; readonly observerIds: readonly EntityId[] },
  observerId: EntityId,
): boolean {
  return alias.observerIds.length === 0
    || alias.observerIds.some((id) => String(id) === String(observerId));
}

function entityTerms(
  record: EntityRecord,
  observerId: EntityId,
  includeCoreName: boolean,
): readonly string[] {
  return [
    ...(includeCoreName ? [record.core.name] : []),
    ...(record.core.aliases ?? [])
      .filter((alias) => visibleAlias(alias, observerId))
      .map((alias) => alias.text),
  ].map(normalized).filter((term) => term.length > 0);
}

function textFragments(value: string): readonly string[] {
  const chars = Array.from(normalized(value));
  const result: string[] = [];
  for (let length = 4; length >= 2; length -= 1) {
    for (let index = 0; index + length <= chars.length; index += 1) {
      result.push(chars.slice(index, index + length).join(""));
    }
  }
  return unique(result, (entry) => entry);
}

function experienceScore(queryText: string, historyText: string): number {
  const query = normalized(queryText);
  const history = normalized(historyText);
  if (query.length === 0 || history.length === 0) return 0;
  const fragments = textFragments(query).filter((fragment) => history.includes(fragment));
  const distinctive = fragments.filter((fragment) => !["之前", "然后", "当时", "什么", "的人", "一个"].includes(fragment));
  if (distinctive.length < 2) return 0;
  return distinctive.reduce((score, fragment) => score + fragment.length, 0);
}

function eventIdsForHistory(
  entry: HistoryEntry,
  eventById: ReadonlyMap<string, WorldState["eventLedger"][number]>,
): readonly EventId[] {
  return entry.eventIds.filter((eventId) => eventById.has(String(eventId)));
}

function addCandidate(
  candidates: Map<string, Candidate>,
  id: EntityId,
  score: number,
  reason: string,
  explicit: boolean,
  exact: boolean,
): Candidate {
  const key = String(id);
  const previous = candidates.get(key);
  if (previous !== undefined) {
    previous.score = Math.max(previous.score, score);
    previous.explicit ||= explicit;
    previous.exact ||= exact;
    previous.reasons.add(reason);
    return previous;
  }
  const candidate: Candidate = {
    id,
    score,
    explicit,
    exact,
    reasons: new Set([reason]),
    eventIds: new Set(),
    historyIds: new Set(),
  };
  candidates.set(key, candidate);
  return candidate;
}

function eventVisibleToObserver(
  eventId: EventId,
  visibleEventIds: ReadonlySet<string>,
): boolean {
  return visibleEventIds.has(String(eventId));
}

function addManifest(
  manifest: Map<string, EvidenceManifestEntry>,
  ref: string,
  reason: string,
  mandatory: boolean,
): void {
  const previous = manifest.get(ref);
  if (previous === undefined || (!previous.mandatory && mandatory)) {
    manifest.set(ref, { ref, reason, mandatory });
  }
}

function activeThreadRefs(query: EvidenceQuery, selected: ReadonlySet<string>): readonly {
  ref: string;
  eventIds: readonly EventId[];
}[] {
  return query.storyState.threads
    .filter((thread) => thread.status === "open" || thread.status === "advanced")
    .filter((thread) => thread.participantIds.some((id) => selected.has(String(id)))
      || thread.goalRefs.some((ref) => selected.has(String(ref.npcId)))
      || thread.promiseRefs.some((ref) => selected.has(String(ref.npcId))))
    .map((thread) => ({
      ref: `thread:${thread.id}`,
      eventIds: thread.evidenceEventIds,
    }));
}

function activePromiseRefs(query: EvidenceQuery, selected: ReadonlySet<string>): readonly {
  ref: string;
  eventIds: readonly EventId[];
}[] {
  return entitiesOfKind(query.worldState.entityStore, "npc").flatMap((npc) => {
    if (!selected.has(String(npc.core.id))) return [];
    return npc.relationships.outgoing.flatMap((edge) => edge.commitments
      .filter((commitment) => commitment.kind === "promise" && commitment.status === "open")
      .map((commitment) => ({
        ref: `promise:${npc.core.id}:${commitment.commitmentId}`,
        eventIds: query.storyState.threads
          .flatMap((thread) => thread.promiseRefs
            .filter((promise) => String(promise.npcId) === String(npc.core.id) && promise.promiseId === commitment.commitmentId)
            .flatMap(() => thread.evidenceEventIds)),
      })));
  });
}

/**
 * Rebuild a bounded evidence selection from authoritative state, ledger and
 * published History. The selection contains references only; callers decide
 * how much authorized source text to render.
 */
export function retrieveStoryEvidence(query: EvidenceQuery): EvidenceSelection {
  const visibleEvidence = query.visibleEvidence ?? projectObserverEvidence({
    worldState: query.worldState,
    storyState: query.storyState,
    observerId: query.observerId,
  });
  const dialogueFocus = query.storyState.dialogueFocus ?? null;
  const records = query.worldState.entityStore.records;
  const recordById = new Map(records.map((record) => [String(record.core.id), record] as const));
  const eventById = new Map(query.worldState.eventLedger.map((event) => [String(event.eventId), event] as const));
  const visibleHistory = visibleEvidence.history;
  const visibleEventIds = new Set(visibleEvidence.events.map((event) => String(event.eventId)));
  const knownEntityIds = new Set(visibleEvidence.knownEntityIds.map(String));
  const candidates = new Map<string, Candidate>();
  const explicitIds = new Set([
    ...query.actionEntityIds.map(String),
    ...query.focusEntityIds.map(String),
  ]);
  for (const id of explicitIds) {
    const record = recordById.get(id);
    if (record === undefined) continue;
    const candidate = addCandidate(candidates, record.core.id, query.actionEntityIds.some((entry) => String(entry) === id) ? 1000 : 900, "explicit_reference", true, true);
    if (dialogueFocus !== null && id === String(dialogueFocus.npcId)) candidate.reasons.add("dialogue_focus");
  }

  const queryText = normalized(query.text);
  const usesPronoun = ["他", "她", "那人", "当时", "那时"].some((term) => queryText.includes(term));
  const focusMatches = dialogueFocus !== null
    && query.focusEntityIds.some((id) => String(id) === String(dialogueFocus.npcId));
  if (usesPronoun && dialogueFocus !== null && query.focusEntityIds.length === 0) {
    const focus = recordById.get(String(dialogueFocus.npcId));
    if (focus !== undefined) addCandidate(candidates, focus.core.id, 900, "dialogue_focus", true, true);
  }
  for (const record of records) {
    const hasPublicAlias = (record.core.aliases ?? [])
      .some((alias) => alias.observerIds.length === 0);
    if (!knownEntityIds.has(String(record.core.id))
      && !explicitIds.has(String(record.core.id))
      && !hasPublicAlias) continue;
    const terms = entityTerms(
      record,
      query.observerId,
      knownEntityIds.has(String(record.core.id)) || explicitIds.has(String(record.core.id)),
    );
    for (const term of terms) {
      if (term.length === 0 || !queryText.includes(term)) continue;
      const isAlias = term !== normalized(record.core.name);
      const candidate = addCandidate(candidates, record.core.id, isAlias ? 500 : 650, isAlias ? "registered_alias" : "exact_name", false, true);
      if (isAlias) {
        const alias = record.core.aliases?.find((entry) => normalized(entry.text) === term);
        for (const eventId of alias?.evidenceEventIds ?? []) candidate.eventIds.add(String(eventId));
      }
    }
  }

  for (const entry of visibleHistory) {
    const score = experienceScore(query.text, entry.text);
    if (score === 0) continue;
    const eventIds = eventIdsForHistory(entry, eventById);
    const participantIds = unique([
      ...entry.entityIds,
      ...eventIds.flatMap((eventId) => {
        const event = eventById.get(String(eventId));
        return event === undefined ? [] : [...event.actorIds, ...event.targetIds] as readonly EntityId[];
      }),
    ], String);
    for (const entityId of participantIds) {
      if (!recordById.has(String(entityId))) continue;
      const candidate = addCandidate(candidates, entityId, 300 + score, "experience", false, false);
      candidate.historyIds.add(entry.id);
      for (const eventId of eventIds) {
        const event = eventById.get(String(eventId));
        if (event !== undefined && eventVisibleToObserver(eventId, visibleEventIds)) candidate.eventIds.add(String(eventId));
      }
    }
  }

  // Entity/known-ID entry path: once an entity is identified, recover its
  // authoritative event references as well. This is intentionally capped so
  // a frequently mentioned NPC cannot consume the whole context budget.
  for (const candidate of candidates.values()) {
    if (!candidate.explicit && !candidate.exact) continue;
    const relatedEvents = query.worldState.eventLedger
      .filter((event) => [...event.actorIds, ...event.targetIds]
        .some((id) => String(id) === String(candidate.id)))
      .filter((event) => eventVisibleToObserver(event.eventId, visibleEventIds))
      .slice(-8);
    for (const event of relatedEvents) candidate.eventIds.add(String(event.eventId));
  }

  for (const entityId of query.contextEntityIds ?? []) {
    if (!knownEntityIds.has(String(entityId)) || !recordById.has(String(entityId))) continue;
    addCandidate(candidates, entityId, 100, "context_reference", false, false);
  }
  for (const eventId of query.contextEventIds ?? []) {
    const event = eventById.get(String(eventId));
    if (event === undefined || !visibleEventIds.has(String(event.eventId))) continue;
    const candidate = addCandidate(candidates, event.actorIds[0] ?? query.observerId, 80, "context_event", false, false);
    candidate.eventIds.add(String(event.eventId));
  }

  const selectedCandidates = [...candidates.values()]
    .filter((candidate) => candidate.explicit || candidate.exact || candidate.reasons.has("experience")
      || candidate.reasons.has("context_reference") || candidate.reasons.has("context_event"))
    .sort((left, right) => right.score - left.score || String(left.id).localeCompare(String(right.id)));
  const selectedIds = selectedCandidates.map((candidate) => candidate.id);
  const selectedIdSet = new Set(selectedIds.map(String));
  const ambiguousEntityIds = selectedCandidates.length > 1
    && selectedCandidates[0] !== undefined
    && !selectedCandidates.some((candidate) => candidate.explicit)
    && selectedCandidates.every((candidate) => candidate.score === selectedCandidates[0]!.score)
    ? selectedCandidates.map((candidate) => candidate.id)
    : [];

  const eventIds = new Set<string>();
  const historyIds = new Set<string>();
  const manifest = new Map<string, EvidenceManifestEntry>();
  for (const candidate of selectedCandidates) {
    for (const eventId of candidate.eventIds) {
      const event = eventById.get(eventId);
      if (event === undefined || !eventVisibleToObserver(event.eventId, visibleEventIds)) continue;
      eventIds.add(eventId);
      addManifest(manifest, eventId, [...candidate.reasons].join("+"), candidate.explicit || candidate.reasons.has("experience"));
    }
    for (const historyId of candidate.historyIds) {
      historyIds.add(historyId);
      addManifest(manifest, historyId, "experience", true);
    }
  }

  if (dialogueFocus !== null && (usesPronoun || focusMatches)) {
    for (const eventId of dialogueFocus.eventIds) {
      const event = eventById.get(String(eventId));
      if (event !== undefined && eventVisibleToObserver(event.eventId, visibleEventIds)) {
        eventIds.add(String(eventId));
        addManifest(manifest, String(eventId), "dialogue_focus", true);
      }
    }
    for (const entry of visibleHistory) {
      if (entry.eventIds.some((eventId) => dialogueFocus.eventIds.some((focusId) => String(focusId) === String(eventId)))) {
        historyIds.add(entry.id);
        addManifest(manifest, entry.id, "dialogue_focus", true);
      }
    }
  }

  for (const reference of [...activeThreadRefs(query, selectedIdSet), ...activePromiseRefs(query, selectedIdSet)]) {
    addManifest(manifest, reference.ref, "active_thread_or_promise", true);
    for (const eventId of reference.eventIds) {
      const event = eventById.get(String(eventId));
      if (event !== undefined && eventVisibleToObserver(event.eventId, visibleEventIds)) {
        eventIds.add(String(eventId));
        addManifest(manifest, String(eventId), "active_thread_or_promise", true);
      }
    }
  }

  // Recover the actual authorized words behind mandatory events before applying
  // optional limits. A recent-episode window must never erase a live promise.
  for (const entry of visibleHistory) {
    if (entry.eventIds.some(id => manifest.get(String(id))?.mandatory)) {
      historyIds.add(entry.id);
      addManifest(manifest, entry.id, "required_event_source", true);
    }
  }
  const present = new Set(query.presentHistoryIds ?? []);
  const relatedByEntity = selectedCandidates.map(candidate => visibleHistory
    .filter(entry => !present.has(entry.id) && !historyIds.has(entry.id))
    .filter(entry => entry.entityIds.some(id => String(id) === String(candidate.id))
      || entry.speakerId === candidate.id
      || entry.eventIds.some(id => {
        const event = eventById.get(String(id));
        return event !== undefined && visibleEventIds.has(String(id))
          && (candidate.eventIds.has(String(id)) || [...event.actorIds, ...event.targetIds, event.locationId]
            .some(entityId => entityId !== null && String(entityId) === String(candidate.id)));
      }))
    .sort((left, right) => experienceScore(query.text, right.text) - experienceScore(query.text, left.text)
      || right.sequence - left.sequence));
  let optionalCount = 0;
  const perEntityCounts = relatedByEntity.map(() => 0);
  // Round robin gives each candidate a turn; recalled references do not seed
  // a second retrieval wave.
  for (let round = 0; round < 3 && optionalCount < 10; round += 1) {
    for (let index = 0; index < relatedByEntity.length && optionalCount < 10; index += 1) {
      if (perEntityCounts[index]! >= 3) continue;
      const entry = relatedByEntity[index]!.find(candidate => !historyIds.has(candidate.id));
      if (entry === undefined) continue;
      historyIds.add(entry.id);
      addManifest(manifest, entry.id, "related_history", false);
      perEntityCounts[index]! += 1;
      optionalCount += 1;
    }
  }

  return {
    entityIds: selectedIds,
    eventIds: [...eventIds]
      .map((id) => eventById.get(id))
      .filter((event): event is WorldState["eventLedger"][number] => event !== undefined)
      .sort((left, right) => left.sequence - right.sequence)
      .map((event) => event.eventId),
    historyIds: [...historyIds]
      .map((id) => visibleHistory.find((entry) => entry.id === id))
      .filter((entry): entry is HistoryEntry => entry !== undefined && entry.kind !== "shown_choice")
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => entry.id),
    ambiguousEntityIds,
    manifest: [...manifest.values()].sort((left, right) => left.ref.localeCompare(right.ref)),
  };
}
