import type { CommittedNarrativeEvent, EventId } from "./events";
import type { EntityId } from "./entity/entityCore";
import type { HistoryEntry } from "./narrativeHistory";

export type NarrativeMemoryPolicy = Readonly<{
  readonly threshold: number;
  readonly batchSize: number;
  readonly rawSoftEstimatedTokens: number;
  readonly summarySourceMaxEstimatedTokens: number;
  readonly overviewMaxEstimatedTokens: number;
  readonly promptMaxEstimatedTokens: number;
}>;

export type NarrativeMemoryManifestRef = Readonly<{
  readonly ref: string;
  readonly reason: string;
  readonly mandatory: boolean;
}>;

/** Source-linked memory shared by the author or one explicitly selected NPC. */
export type NarrativeMemoryContext = Readonly<{
  readonly observerId: EntityId;
  readonly coveredThroughSequence: number;
  readonly overviewHistoryIds: readonly string[];
  readonly overviewEventIds: readonly EventId[];
  /** Observer-authorized original events selected for the historical overview. */
  readonly overviewEvents?: readonly CommittedNarrativeEvent[];
  readonly uncovered: readonly HistoryEntry[];
  readonly recalled: readonly HistoryEntry[];
  readonly requiredEvents: readonly CommittedNarrativeEvent[];
  readonly referencedEntityIds: readonly EntityId[];
  readonly ambiguousEntityIds: readonly EntityId[];
  readonly manifest: readonly NarrativeMemoryManifestRef[];
}>;
