import type { EntityId } from "@/game/domain/entity/entityCore";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { NarrativeMemoryContext, NarrativeMemoryPolicy } from "@/game/domain/narrativeMemoryContext";
import type { MemorySummaryState } from "@/game/domain/narrativeMemorySummary";
import { buildNarrativeMemoryContext, planMemorySummary, projectObserverEvidence, retrieveStoryEvidence } from "@/game/gameplay/rpg/narrativeMemory";
import type { GameRecord } from "./server/persistence/gameRepository";
import type { NarrativeMemorySummaryRepository } from "./narrativeMemorySummaryRepository";
import type { NarrativeMemorySummarySource } from "./narrativeMemorySummarySource";
import { narrativeMemorySourceFingerprint } from "./narrativeMemorySourceFingerprint";

function estimateMemoryTokens(text: string): number {
  let total = 0;
  for (const char of text) total += char.codePointAt(0)! <= 0x7f ? 0.25 : 1;
  return Math.max(1, Math.ceil(total));
}

function rawContext(input: Readonly<{ record: GameRecord; job: PendingNarrativeJob; evidence: ReturnType<typeof projectObserverEvidence>; covered: number; selectedHistoryIds: readonly string[]; selectedEventIds: readonly string[] }>): NarrativeMemoryContext {
  const presentHistory = input.evidence.history.filter(entry => entry.sequence > input.covered || input.selectedHistoryIds.includes(entry.id));
  const contextEventIds = new Set([...input.selectedEventIds, ...presentHistory.flatMap(entry => entry.eventIds.map(String))]);
  const contextEntities = [...presentHistory.flatMap(entry => entry.entityIds),
    ...input.evidence.events.filter(event => contextEventIds.has(String(event.eventId)))
      .flatMap(event => [...event.actorIds, ...event.targetIds, ...(event.locationId === null ? [] : [event.locationId])])];
  const actionEntityIds = Object.entries(input.job.actionSummary ?? {})
    .filter(([key]) => ["npcId", "locationId", "itemId", "factId", "questId", "enemyId"].includes(key))
    .map(([, value]) => value as EntityId);
  const selection = retrieveStoryEvidence({
    worldState: input.record.worldState, storyState: input.record.storyState,
    observerId: input.evidence.observerId, visibleEvidence: input.evidence,
    text: input.job.utterance ?? input.job.selectedDialogue?.label ?? "",
    actionEntityIds,
    focusEntityIds: input.job.focusNpcId === undefined ? [] : [input.job.focusNpcId],
    contextEntityIds: [...new Set([...contextEntities, input.record.worldState.currentLocationId].filter(id => id !== undefined))],
    contextEventIds: input.evidence.events.filter(event => contextEventIds.has(String(event.eventId))).map(event => event.eventId),
    presentHistoryIds: presentHistory.map(entry => entry.id),
  });
  const requiredEventIds = input.evidence.events.filter(event => input.job.domainEventIds?.includes(event.eventId)).map(event => event.eventId);
  return buildNarrativeMemoryContext({
    evidence: input.evidence,
    selection: { ...selection, eventIds: [...selection.eventIds, ...requiredEventIds],
      manifest: [...selection.manifest, ...requiredEventIds.map(id => ({ ref: String(id), reason: "current_job_event", mandatory: true }))] },
    coveredThroughSequence: input.covered,
    overviewHistoryIds: input.selectedHistoryIds,
    overviewEventIds: input.evidence.events.filter(event => input.selectedEventIds.includes(String(event.eventId))).map(event => event.eventId),
  });
}

function sourceFitsBudget(input: Readonly<{ history: readonly unknown[]; events: readonly unknown[]; maxTokens: number }>): boolean {
  return estimateMemoryTokens(JSON.stringify({ history: input.history, events: input.events })) <= input.maxTokens;
}

function finishWithContext(input: Readonly<{ record: GameRecord; job: PendingNarrativeJob; policy: NarrativeMemoryPolicy; signal: AbortSignal }>, evidence: ReturnType<typeof projectObserverEvidence>, previous: MemorySummaryState | null) {
  if (input.signal.aborted) return { ok: false as const, code: "CANCELLED" as const };
  const context = rawContext({ ...input, evidence, covered: previous?.coveredThroughSequence ?? -1, selectedHistoryIds: previous?.overview.historyIds ?? [], selectedEventIds: previous?.overview.eventIds ?? [] });
  const estimated = estimateMemoryTokens(JSON.stringify(context));
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
  const evidence = projectObserverEvidence({ worldState: input.record.worldState, storyState: input.record.storyState, observerId: input.observerId });
  let previous: MemorySummaryState | null = null;
  if (input.summaries === "enabled") {
    const loaded = await input.repository.load({ gameId: input.record.gameId, generationId: input.record.worldState.generation.generationId, observerId: input.observerId });
    previous = loaded.state;
    const remainingHistory = evidence.history.filter(entry => entry.sequence > (previous?.coveredThroughSequence ?? -1)
      || previous?.overview.historyIds.includes(entry.id));
    const remainingEventIds = new Set([...remainingHistory.flatMap(entry => entry.eventIds.map(String)), ...(previous?.overview.eventIds ?? []).map(String)]);
    const rawEstimatedTokens = estimateMemoryTokens(JSON.stringify({ history: remainingHistory,
      events: evidence.events.filter(event => remainingEventIds.has(String(event.eventId))) }));
    const plan = planMemorySummary({
      evidence,
      previous,
      forceForLength: rawEstimatedTokens > input.policy.rawSoftEstimatedTokens,
      excludedHistoryIds: evidence.history.filter(entry =>
        input.job.actionId !== undefined && entry.actionId === input.job.actionId
        || input.job.jobId !== undefined && entry.jobId === input.job.jobId).map(entry => entry.id),
    });
    if (plan.kind === "batch" && await input.reserveBatchUpdate()) {
      if (input.signal.aborted) return { ok: false, code: "CANCELLED" };
      const batchHistory = evidence.history.filter((entry) => plan.sourceHistoryIds.includes(entry.id));
      const batchEventIds = new Set(batchHistory.flatMap(entry => entry.eventIds.map(String)));
      const batchEvents = evidence.events.filter(event => batchEventIds.has(String(event.eventId)));
      if (!sourceFitsBudget({ history: batchHistory, events: batchEvents, maxTokens: input.policy.summarySourceMaxEstimatedTokens })) {
        // Preserve the prior watermark and use the original source path below.
        return finishWithContext(input, evidence, previous);
      }
      const batchResult = await input.source.select({ kind: "batch", observerId: input.observerId, history: batchHistory, events: batchEvents, signal: input.signal, reserveHttpAttempt: input.reserveSummaryHttpAttempt });
      if (input.signal.aborted) return { ok: false, code: "CANCELLED" };
      if (batchResult.ok) {
        const leafBatches = [...(previous?.batches ?? []), {
          id: `batch:${plan.throughSequence}`,
          fromSequence: batchHistory[0]?.sequence ?? plan.throughSequence,
          throughSequence: plan.throughSequence,
          sourceHistoryIds: plan.sourceHistoryIds,
          sourceFingerprint: narrativeMemorySourceFingerprint({ worldState: input.record.worldState, storyState: input.record.storyState, observerId: input.observerId, throughSequence: plan.throughSequence }),
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
          if (input.signal.aborted) return { ok: false, code: "CANCELLED" };
          const next: MemorySummaryState = {
            formatVersion: 1, observerId: input.observerId, policyVersion: "memory-p2/1",
            summaryRevision: (previous?.summaryRevision ?? loaded.summaryRevision) + 1,
            coveredThroughSequence: plan.throughSequence,
            coveredSourceFingerprint: narrativeMemorySourceFingerprint({ worldState: input.record.worldState, storyState: input.record.storyState, observerId: input.observerId, throughSequence: plan.throughSequence }),
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
