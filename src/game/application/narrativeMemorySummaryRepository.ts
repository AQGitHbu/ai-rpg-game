import type { EntityId } from "@/game/domain/entity/entityCore";
import type { GenerationId } from "@/game/domain/worldEntity";
import type { NarrativeJobId } from "@/game/domain/events";
import type { GameId, NarrativeJobAttemptPredicate } from "./server/persistence/gameRepository";
import type { MemorySummaryState } from "@/game/domain/narrativeMemorySummary";
import type { NarrativeMemoryContext, NarrativeMemoryPolicy } from "@/game/domain/narrativeMemoryContext";

export type MemorySummaryKey = Readonly<{
  readonly gameId: GameId;
  readonly generationId: GenerationId;
  readonly observerId: EntityId;
}>;

export type MemoryAttemptKey = Readonly<{
  readonly gameId: GameId;
  readonly generationId: GenerationId;
  readonly jobId: NarrativeJobId;
  readonly epoch: number;
}>;

export type MemoryAttemptGuard = Readonly<{
  readonly key: MemoryAttemptKey;
  readonly expectedRevision: number;
  readonly expectedNarrativeJob: NarrativeJobAttemptPredicate;
  readonly now: string;
}>;

export type PreparedNarrativeMemory = Readonly<{
  readonly formatVersion: 1;
  readonly policyVersion: "memory-p2/1";
  readonly sourceFingerprint: string;
  readonly policy: NarrativeMemoryPolicy;
  readonly summaries: "enabled" | "disabled";
  readonly player: NarrativeMemoryContext;
  readonly npc?: NarrativeMemoryContext;
}>;

export type MemoryReservationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "BUDGET_EXHAUSTED" | "STALE_ATTEMPT" | "UNAVAILABLE" };

export type NarrativeMemorySummaryRepository = Readonly<{
  load(key: MemorySummaryKey): Promise<{ readonly state: MemorySummaryState | null; readonly summaryRevision: number }>;
  publish(input: Readonly<{
    readonly key: MemorySummaryKey;
    readonly expectedSummaryRevision: number;
    readonly next: MemorySummaryState;
  }>): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: "STALE_SUMMARY" | "SOURCE_CHANGED" | "UNAVAILABLE" }>;
  loadPrepared?(key: MemoryAttemptKey): Promise<
    | { readonly ok: true; readonly prepared: PreparedNarrativeMemory | null; readonly preparedHash: string | null }
    | { readonly ok: false; readonly code: "MEMORY_PREPARATION_INVALID" | "UNAVAILABLE" }
  >;
  freezePrepared?(input: MemoryAttemptGuard & { readonly next: PreparedNarrativeMemory }): Promise<
    | { readonly ok: true; readonly prepared: PreparedNarrativeMemory; readonly preparedHash: string }
    | { readonly ok: false; readonly code: "STALE_ATTEMPT" | "MEMORY_PREPARATION_INVALID" | "UNAVAILABLE" }
  >;
  reserveBatchUpdate?(input: MemoryAttemptGuard): Promise<MemoryReservationResult>;
  reserveHttpAttempt?(input: MemoryAttemptGuard): Promise<MemoryReservationResult>;
}>;
