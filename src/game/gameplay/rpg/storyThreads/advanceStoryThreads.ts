import type { EventId, NarrativeEventDraft } from "@/game/domain/events";
import type { WorldState } from "@/game/domain/worldState";
import {
  storyThreadEventIsRelated,
  type StoryThread,
} from "@/game/domain/storyThreads";
import { evaluateStoryCondition } from "@/game/gameplay/rpg/storyInteraction";

export type AdvanceStoryThreadsInput = Readonly<{
  worldState: WorldState;
  threads: readonly StoryThread[];
  eventIds: readonly EventId[];
  /** Actual same-turn events that are being previewed before ledger commit. */
  triggerEvents?: readonly WorldState["eventLedger"][number][];
}>;

/**
 * Advance only from committed, related events. A state that merely happens to
 * satisfy a closure cannot resolve a thread until a relevant event is supplied.
 */
export function advanceStoryThreads(input: AdvanceStoryThreadsInput): readonly StoryThread[] {
  const eventById = new Map([
    ...input.worldState.eventLedger.map((event) => [String(event.eventId), event] as const),
    ...(input.triggerEvents ?? []).map((event) => [String(event.eventId), event] as const),
  ]);
  const events = input.eventIds
    .map((eventId) => eventById.get(String(eventId)))
    .filter((event): event is NonNullable<typeof event> => event !== undefined);
  return input.threads.map((thread) => {
    if (thread.status === "abandoned") return thread;
    const newEvidence = events
      .filter((event) => storyThreadEventIsRelated(thread, event))
      .map((event) => event.eventId)
      .filter((eventId) => !thread.evidenceEventIds.includes(eventId));
    if (newEvidence.length === 0) return thread;
    const evidenceEventIds = [...thread.evidenceEventIds, ...newEvidence];
    if (thread.status === "resolved") return { ...thread, evidenceEventIds };
    const closed = thread.closure.length > 0
      && thread.closure.every((condition) => evaluateStoryCondition(input.worldState, condition));
    return {
      ...thread,
      evidenceEventIds,
      status: closed ? "resolved" : "advanced",
    };
  });
}

export type ReconcileRuleDerivedStoryThreadsInput = Readonly<{
  worldState: WorldState;
  threads: readonly StoryThread[];
  eventDrafts?: readonly NarrativeEventDraft[];
}>;

/**
 * Rebuild the narrow, rule-derived closure used by the ending gate.
 *
 * A thread with no explicit closure/goal/promise can represent the formal
 * concern of one or more bound quests. It concludes only when every binding
 * names a resolved quest and a matching completion/failure event is committed
 * (or is part of the rule transaction currently being committed). Threads
 * with richer obligations remain open for their explicit evidence path.
 */
export function reconcileRuleDerivedStoryThreads(
  input: ReconcileRuleDerivedStoryThreadsInput,
): readonly StoryThread[] {
  const questOutcomeIds = new Set<string>();
  const committedOutcomeEventIds = new Map<string, EventId[]>();
  const collect = (payload: { readonly type: string; readonly questId?: unknown }, eventId?: EventId) => {
    if ((payload.type === "quest_completed" || payload.type === "quest_failed") && payload.questId !== undefined) {
      const questId = String(payload.questId);
      questOutcomeIds.add(questId);
      if (eventId !== undefined) committedOutcomeEventIds.set(questId, [
        ...(committedOutcomeEventIds.get(questId) ?? []),
        eventId,
      ]);
    }
  };
  input.worldState.eventLedger.forEach((event) => collect(event.payload, event.eventId));
  input.eventDrafts?.forEach((draft) => collect(draft.payload));

  return input.threads.map((thread) => {
    if (thread.status === "resolved" || thread.status === "abandoned") return thread;
    if (thread.questIds.length === 0
      || thread.closure.length > 0
      || thread.goalRefs.length > 0
      || thread.promiseRefs.length > 0) return thread;
    const boundQuestsConcluded = thread.questIds.every((questId) => {
      const quest = input.worldState.quests.find((entry) => String(entry.id) === String(questId));
      return quest !== undefined
        && (quest.status === "completed" || quest.status === "failed")
        && questOutcomeIds.has(String(questId));
    });
    if (!boundQuestsConcluded) return thread;
    const committedEvidence = thread.questIds.flatMap((questId) => committedOutcomeEventIds.get(String(questId)) ?? []);
    if (thread.kind === "question") return {
      ...thread,
      status: "advanced" as const,
      evidenceEventIds: [...new Set([...thread.evidenceEventIds, ...committedEvidence])],
    };
    return {
      ...thread,
      status: "resolved" as const,
      evidenceEventIds: [...new Set([...thread.evidenceEventIds, ...committedEvidence])],
    };
  });
}
