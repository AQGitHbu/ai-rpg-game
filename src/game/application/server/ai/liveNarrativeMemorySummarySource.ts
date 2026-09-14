import type { AiMessage } from "@ai-game/ai-transport";
import { parseStructuredJsonObject } from "@/game/core/json";
import { createAiSourceFailure } from "@/game/application/aiGenerationRetry";
import { parseMemorySummarySelection } from "@/game/domain/narrativeMemorySummary";
import type { NarrativeMemorySummarySource } from "@/game/application/narrativeMemorySummarySource";
import type { NarrativeRequestClient } from "./narrativeRequestClient";
import type { RpgAiClient } from "./rpgAiClient";
import { estimateNarrativeTokens } from "./narrativeContext/estimateNarrativeTokens";

function renderSources(input: Parameters<NarrativeMemorySummarySource["select"]>[0]): string {
  return JSON.stringify({
    kind: input.kind,
    observerId: String(input.observerId),
    history: input.history.map((entry) => ({ id: entry.id, sequence: entry.sequence, turnNumber: entry.turnNumber, kind: entry.kind, speakerId: entry.speakerId, audienceIds: entry.audienceIds, text: entry.text, eventIds: entry.eventIds })),
    events: input.events.map((event) => ({ eventId: event.eventId, sequence: event.sequence, turnNumber: event.turnNumber, kind: event.kind, actorIds: event.actorIds, targetIds: event.targetIds, locationId: event.locationId, outcome: event.outcome, payload: event.payload })),
  });
}

export function createLiveNarrativeMemorySummarySource(deps: Readonly<{
  readonly aiClient?: RpgAiClient;
  readonly requestClient?: NarrativeRequestClient;
}> = {}): NarrativeMemorySummarySource {
  return {
    async select(input) {
      if (deps.aiClient === undefined && deps.requestClient === undefined) {
        return createAiSourceFailure("scene", "transport", "provider_failure", "summary_provider_unavailable");
      }
      const messages: readonly AiMessage[] = [
        { role: "system", content: "你是来源摘录选择器。只能从给定 HistoryEntry/Event 的 ID 中选择，不得改写、复述或新增正文、事实、实体或状态。只返回 JSON：{\"historyIds\":string[],\"eventIds\":string[]}。" },
        { role: "user", content: renderSources(input) },
      ];
      const auditContext = {
        ...(input.auditLink ?? {}),
        purpose: "narrative_memory_summary" as const,
        trigger: input.kind === "batch" ? "memory_summary_batch" : "memory_summary_overview",
        revision: input.history.length,
      };
      if (input.maxEstimatedTokens !== undefined && estimateNarrativeTokens(JSON.stringify(messages)) > input.maxEstimatedTokens) {
        return createAiSourceFailure("scene", "invalid_reference", "context_budget_exceeded", "context_budget_exceeded");
      }
      try {
        const result = deps.requestClient === undefined
          ? await deps.aiClient!.complete("narrative_bundle", messages, auditContext, { signal: input.signal, beforeTransportAttempt: input.reserveHttpAttempt, policyOverride: { thinking: "on", reasoningEffort: "low", timeoutMs: 240_000, maxTokens: undefined, jsonMode: "prompt_only", maxAttempts: 2 } })
          : await deps.requestClient.completeNarrativeRequest({ purpose: "memory_summary", messages, auditContext, signal: input.signal, reserveHttpAttempt: input.reserveHttpAttempt, ...(input.maxEstimatedTokens === undefined ? {} : { maxEstimatedTokens: input.maxEstimatedTokens }) });
        if (!result.ok) return createAiSourceFailure("scene", "transport", "provider_failure", result.code);
        const parsed = parseStructuredJsonObject(result.content);
        if (!parsed.ok) return createAiSourceFailure("scene", "invalid_reference", "invalid_json", "summary_selection_json");
        const raw = parsed.value.selection ?? parsed.value;
        const selection = parseMemorySummarySelection(raw, { history: input.history, events: input.events }, input.kind === "batch" ? { maxHistoryIds: 4, maxEventIds: 4 } : { maxHistoryIds: 8, maxEventIds: 8 });
        if (!selection.ok) return createAiSourceFailure("scene", "invalid_reference", "invalid_reference", selection.code);
        return { ok: true, selection: selection.value };
      } catch {
        return createAiSourceFailure("scene", "transport", "provider_failure", "summary_selection_failed");
      }
    },
  };
}
