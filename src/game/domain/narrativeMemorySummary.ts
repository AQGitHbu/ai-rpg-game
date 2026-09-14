import { isWellFormedEventId, type EventId } from "./events";
import type { EntityId } from "./entity/entityCore";
import type { CommittedNarrativeEvent } from "./events";
import type { HistoryEntry } from "./narrativeHistory";

export type MemorySummarySelection = Readonly<{
  readonly historyIds: readonly string[];
  readonly eventIds: readonly EventId[];
}>;

export type MemorySummaryBatch = Readonly<{
  readonly id: string;
  readonly fromSequence: number;
  readonly throughSequence: number;
  readonly sourceHistoryIds: readonly string[];
  readonly sourceFingerprint: string;
  readonly selection: MemorySummarySelection;
}>;

export type MemorySummaryState = Readonly<{
  readonly formatVersion: 1;
  readonly observerId: EntityId;
  readonly policyVersion: "memory-p2/1";
  readonly summaryRevision: number;
  readonly coveredThroughSequence: number;
  readonly coveredSourceFingerprint: string;
  readonly batches: readonly MemorySummaryBatch[];
  readonly overview: MemorySummarySelection;
}>;

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly path: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => expected.has(key));
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "");
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function parseMemorySummarySelection(
  value: unknown,
  sources: Readonly<{ history: readonly HistoryEntry[]; events: readonly CommittedNarrativeEvent[] }>,
  limits: Readonly<{ maxHistoryIds?: number; maxEventIds?: number }> = {},
): ParseResult<MemorySummarySelection> {
  if (!record(value) || !exactKeys(value, ["historyIds", "eventIds"]) || !stringArray(value.historyIds) || !stringArray(value.eventIds)) {
    return { ok: false, code: "INVALID_SELECTION", path: "selection" };
  }
  const historyIds = value.historyIds;
  const eventIds = value.eventIds;
  if (!unique(historyIds) || !unique(eventIds)) return { ok: false, code: "DUPLICATE_REFERENCE", path: "selection" };
  if (historyIds.length > (limits.maxHistoryIds ?? 8)) return { ok: false, code: "TOO_MANY_HISTORY_REFS", path: "historyIds" };
  if (eventIds.length > (limits.maxEventIds ?? 8)) return { ok: false, code: "TOO_MANY_EVENT_REFS", path: "eventIds" };
  if (historyIds.length === 0 && eventIds.length === 0) return { ok: false, code: "EMPTY_SELECTION", path: "selection" };
  const historySet = new Set(sources.history.map((entry) => entry.id));
  const eventSet = new Set(sources.events.map((event) => String(event.eventId)));
  if (historyIds.some((id) => !historySet.has(id))) return { ok: false, code: "UNKNOWN_HISTORY_REF", path: "historyIds" };
  if (eventIds.some((id) => !isWellFormedEventId(id) || !eventSet.has(id))) return { ok: false, code: "UNKNOWN_EVENT_REF", path: "eventIds" };
  return { ok: true, value: { historyIds: [...historyIds], eventIds: eventIds.map((id) => id as EventId) } };
}

function parseBatch(value: unknown, index: number): ParseResult<MemorySummaryBatch> {
  if (!record(value) || !exactKeys(value, ["id", "fromSequence", "throughSequence", "sourceHistoryIds", "sourceFingerprint", "selection"])) {
    return { ok: false, code: "INVALID_BATCH", path: `batches[${index}]` };
  }
  const fromSequence = value.fromSequence;
  const throughSequence = value.throughSequence;
  const sourceHistoryIds = value.sourceHistoryIds;
  if (typeof value.id !== "string" || value.id.trim() === ""
    || typeof fromSequence !== "number" || !Number.isInteger(fromSequence) || fromSequence < 0
    || typeof throughSequence !== "number" || !Number.isInteger(throughSequence) || throughSequence < fromSequence
    || !stringArray(sourceHistoryIds) || !unique(sourceHistoryIds)
    || typeof value.sourceFingerprint !== "string" || value.sourceFingerprint.trim() === "") {
    return { ok: false, code: "INVALID_BATCH", path: `batches[${index}]` };
  }
  const selectionEvents = record(value.selection) && stringArray(value.selection.eventIds)
    ? value.selection.eventIds.map((eventId) => ({ eventId: eventId as EventId } as CommittedNarrativeEvent))
    : [];
  const selection = parseMemorySummarySelection(value.selection, { history: sourceHistoryIds.map((id) => ({ id } as HistoryEntry)), events: selectionEvents }, { maxHistoryIds: 4, maxEventIds: 4 });
  if (!selection.ok) return { ok: false, code: selection.code, path: `batches[${index}].${selection.path}` };
  if (selection.value.historyIds.some((id) => !sourceHistoryIds.includes(id))) return { ok: false, code: "SELECTION_OUTSIDE_BATCH", path: `batches[${index}].selection.historyIds` };
  return { ok: true, value: {
    id: value.id,
    fromSequence,
    throughSequence,
    sourceHistoryIds: [...sourceHistoryIds],
    sourceFingerprint: value.sourceFingerprint,
    selection: selection.value,
  } };
}

export function parseMemorySummaryState(value: unknown): ParseResult<MemorySummaryState> {
  if (!record(value) || !exactKeys(value, ["formatVersion", "observerId", "policyVersion", "summaryRevision", "coveredThroughSequence", "coveredSourceFingerprint", "batches", "overview"])) {
    return { ok: false, code: "INVALID_STATE", path: "state" };
  }
  if (value.formatVersion !== 1) return { ok: false, code: "UNSUPPORTED_FORMAT", path: "formatVersion" };
  if (typeof value.observerId !== "string" || value.observerId.trim() === "") return { ok: false, code: "INVALID_STATE", path: "observerId" };
  if (value.policyVersion !== "memory-p2/1") return { ok: false, code: "UNSUPPORTED_POLICY", path: "policyVersion" };
  if (!Number.isInteger(value.summaryRevision) || (value.summaryRevision as number) < 0
    || !Number.isInteger(value.coveredThroughSequence) || (value.coveredThroughSequence as number) < -1
    || typeof value.coveredSourceFingerprint !== "string" || value.coveredSourceFingerprint.trim() === ""
    || !Array.isArray(value.batches) || !record(value.overview)) {
    return { ok: false, code: "INVALID_STATE", path: "state" };
  }
  const batches: MemorySummaryBatch[] = [];
  const batchIds = new Set<string>();
  for (const [index, batchValue] of value.batches.entries()) {
    const batch = parseBatch(batchValue, index);
    if (!batch.ok) return batch;
    if (batchIds.has(batch.value.id)) return { ok: false, code: "DUPLICATE_BATCH", path: `batches[${index}].id` };
    batchIds.add(batch.value.id);
    batches.push(batch.value);
  }
  if (!exactKeys(value.overview, ["historyIds", "eventIds"])) return { ok: false, code: "INVALID_SELECTION", path: "overview" };
  if (!stringArray(value.overview.historyIds) || !stringArray(value.overview.eventIds)
    || !unique(value.overview.historyIds) || !unique(value.overview.eventIds)
    || value.overview.eventIds.some((id) => !isWellFormedEventId(id))) return { ok: false, code: "INVALID_SELECTION", path: "overview" };
  return { ok: true, value: {
    formatVersion: 1,
    observerId: value.observerId as EntityId,
    policyVersion: "memory-p2/1",
    summaryRevision: value.summaryRevision as number,
    coveredThroughSequence: value.coveredThroughSequence as number,
    coveredSourceFingerprint: value.coveredSourceFingerprint,
    batches,
    overview: { historyIds: [...value.overview.historyIds], eventIds: value.overview.eventIds.map((id) => id as EventId) },
  } };
}
