import type { EntityId } from "@/game/domain/entity/entityCore";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { NarrativeMemoryContext, NarrativeMemoryPolicy } from "@/game/domain/narrativeMemoryContext";
import type { MemorySummaryState } from "@/game/domain/narrativeMemorySummary";
import { buildNarrativeMemoryContext, planMemorySummary, projectObserverEvidence } from "@/game/gameplay/rpg/narrativeMemory";
import type { GameRecord } from "./server/persistence/gameRepository";
import type { NarrativeMemorySummaryRepository } from "./narrativeMemorySummaryRepository";
import type { NarrativeMemorySummarySource } from "./narrativeMemorySummarySource";

function sourceFingerprint(evidence: ReturnType<typeof projectObserverEvidence>, throughSequence = Number.POSITIVE_INFINITY): string {
  return JSON.stringify({
    history: evidence.history.filter((entry) => entry.sequence <= throughSequence).map((entry) => [entry.id, entry.sequence, entry.text, entry.speakerId, entry.audienceIds]),
    events: evidence.events.filter((event) => event.sequence <= throughSequence).map((event) => [event.eventId, event.sequence, event.kind, event.actorIds, event.targetIds]),
  });
}

function estimateMemoryTokens(text: string): number {
  let total = 0;
  for (const char of text) total += char.codePointAt(0)! <= 0x7f ? 0.25 : 1;
  return Math.max(1, Math.ceil(total));
}

function selectionForContext(evidence: ReturnType<typeof projectObserverEvidence>, selectedHistoryIds: readonly string[], selectedEventIds: readonly string[]) {
  const selected = new Set([...selectedHistoryIds, ...selectedEventIds]);
  return {
    entityIds: evidence.knownEntityIds,
    eventIds: evidence.events.filter((event) => selected.has(String(event.eventId))).map((event) => event.eventId),
    historyIds: [...selectedHistoryIds],
    ambiguousEntityIds: [],
    manifest: [...selectedHistoryIds.map((id) => ({ ref: id, reason: "visible_history", mandatory: true })),
      ...evidence.events.filter((event) => selected.has(String(event.eventId))).map((event) => ({ ref: String(event.eventId), reason: "summary_source", mandatory: true }))],
  };
}

function rawContext(input: Readonly<{ evidence: ReturnType<typeof projectObserverEvidence>; covered: number; selectedHistoryIds: readonly string[]; selectedEventIds: readonly string[] }>): NarrativeMemoryContext {
  const overview = new Set(input.selectedHistoryIds);
  const historyIds = input.evidence.history
    .filter((entry) => entry.sequence > input.covered || overview.has(entry.id))
    .map((entry) => entry.id);
  return buildNarrativeMemoryContext({
    evidence: input.evidence,
    selection: selectionForContext(input.evidence, historyIds, input.selectedEventIds),
    coveredThroughSequence: input.covered,
    overviewHistoryIds: input.selectedHistoryIds,
    overviewEventIds: input.selectedEventIds as never,
  });
}

function sourceFitsBudget(input: Readonly<{ history: readonly unknown[]; events: readonly unknown[]; maxTokens: number }>): boolean {
  return estimateMemoryTokens(JSON.stringify({ history: input.history, events: input.events })) <= input.maxTokens;
}

function finishWithContext(input: Readonly<{ policy: NarrativeMemoryPolicy }>, evidence: ReturnType<typeof projectObserverEvidence>, previous: MemorySummaryState | null) {
  const context = rawContext({ evidence, covered: previous?.coveredThroughSequence ?? -1, selectedHistoryIds: previous?.overview.historyIds ?? [], selectedEventIds: previous?.overview.eventIds ?? [] });
  const estimated = [...context.uncovered, ...context.recalled].reduce((total, entry) => total + estimateMemoryTokens(entry.text), 0);
  return estimated > input.policy.promptMaxEstimatedTokens
    ? { ok: false as const, code: "MEMORY_CONTEXT_OVERFLOW" as const }
    : { ok: true as const, context };
}

export async function prepareNarrativeMemory(input: Readonly<{
  readonly record: GameRecord;
  readonly observerId: EntityId;
  readonly job: PendingNarrativeJob;
  readonly source: NarrativeMemorySummarySource;
  readonly repository: NarrativeMemorySummaryRepository;
  readonly policy: NarrativeMemoryPolicy;
  readonly summaries: "enabled" | "disabled";
  readonly signal: AbortSignal;
  readonly reserveBatchUpdate: () => Promise<boolean>;
  readonly reserveSummaryHttpAttempt: () => Promise<boolean>;
}>): Promise<{ readonly ok: true; readonly context: NarrativeMemoryContext } | { readonly ok: false; readonly code: "MEMORY_CONTEXT_OVERFLOW" | "CANCELLED" }> {
  if (input.signal.aborted) return { ok: false, code: "CANCELLED" };
  void input.job;
  const evidence = projectObserverEvidence({ worldState: input.record.worldState, storyState: input.record.storyState, observerId: input.observerId });
  let previous: MemorySummaryState | null = null;
  if (input.summaries === "enabled") {
    const loaded = await input.repository.load({ gameId: input.record.gameId, generationId: input.record.worldState.generation.generationId, observerId: input.observerId });
    previous = loaded.state;
    const plan = planMemorySummary({ evidence, previous, forceForLength: false });
    if (plan.kind === "batch" && await input.reserveBatchUpdate()) {
      if (input.signal.aborted) return { ok: false, code: "CANCELLED" };
      const batchHistory = evidence.history.filter((entry) => plan.sourceHistoryIds.includes(entry.id));
      if (!sourceFitsBudget({ history: batchHistory, events: evidence.events, maxTokens: input.policy.summarySourceMaxEstimatedTokens })) {
        // Preserve the prior watermark and use the original source path below.
        return finishWithContext(input, evidence, previous);
      }
      const batchResult = await input.source.select({ kind: "batch", observerId: input.observerId, history: batchHistory, events: evidence.events, signal: input.signal, reserveHttpAttempt: input.reserveSummaryHttpAttempt });
      if (batchResult.ok) {
        const leafBatches = [...(previous?.batches ?? []), {
          id: `batch:${plan.throughSequence}`,
          fromSequence: batchHistory[0]?.sequence ?? plan.throughSequence,
          throughSequence: plan.throughSequence,
          sourceHistoryIds: plan.sourceHistoryIds,
          sourceFingerprint: sourceFingerprint(evidence, plan.throughSequence),
          selection: batchResult.selection,
        }];
        const leafHistoryIds = [...new Set(leafBatches.flatMap((batch) => batch.selection.historyIds))];
        const leafEventIds = [...new Set(leafBatches.flatMap((batch) => batch.selection.eventIds.map(String)))];
        const overviewHistory = evidence.history.filter((entry) => leafHistoryIds.includes(entry.id));
        const overviewEvents = evidence.events.filter((event) => leafEventIds.includes(String(event.eventId)));
        const overviewResult = sourceFitsBudget({ history: overviewHistory, events: overviewEvents, maxTokens: input.policy.overviewMaxEstimatedTokens })
          ? await input.source.select({ kind: "overview", observerId: input.observerId, history: overviewHistory, events: overviewEvents, signal: input.signal, reserveHttpAttempt: input.reserveSummaryHttpAttempt })
          : null;
        if (overviewResult?.ok === true) {
          const next: MemorySummaryState = {
            formatVersion: 1, observerId: input.observerId, policyVersion: "memory-p2/1",
            summaryRevision: (previous?.summaryRevision ?? loaded.summaryRevision) + 1,
            coveredThroughSequence: plan.throughSequence,
            coveredSourceFingerprint: sourceFingerprint(evidence, plan.throughSequence),
            batches: leafBatches,
            overview: overviewResult.selection,
          };
          const published = await input.repository.publish({ key: { gameId: input.record.gameId, generationId: input.record.worldState.generation.generationId, observerId: input.observerId }, expectedSummaryRevision: previous?.summaryRevision ?? loaded.summaryRevision, next });
          if (published.ok) previous = next;
        }
      }
    }
  }
  return finishWithContext(input, evidence, previous);
}
