import type { CommittedNarrativeEvent } from "@/game/domain/events";
import type { EntityId } from "@/game/domain/entity/entityCore";
import type { HistoryEntry } from "@/game/domain/narrativeHistory";
import type { MemorySummarySelection } from "@/game/domain/narrativeMemorySummary";
import type { AiSourceFailure } from "./aiGenerationRetry";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";

export type NarrativeMemorySummarySource = Readonly<{
  select(input: Readonly<{
    kind: "batch" | "overview";
    observerId: EntityId;
    history: readonly HistoryEntry[];
    events: readonly CommittedNarrativeEvent[];
    signal: AbortSignal;
    reserveHttpAttempt: () => Promise<boolean>;
    auditLink?: AiTextAuditLink;
    maxEstimatedTokens?: number;
  }>): Promise<{ readonly ok: true; readonly selection: MemorySummarySelection } | AiSourceFailure>;
}>;
