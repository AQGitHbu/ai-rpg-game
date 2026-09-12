import type { EventId } from "@/game/domain/events";
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
}>;

/**
 * Advance only from committed, related events. A state that merely happens to
 * satisfy a closure cannot resolve a thread until a relevant event is supplied.
 */
export function advanceStoryThreads(input: AdvanceStoryThreadsInput): readonly StoryThread[] {
  const events = input.eventIds
    .map((eventId) => input.worldState.eventLedger.find((event) => event.eventId === eventId))
    .filter((event): event is NonNullable<typeof event> => event !== undefined);
  return input.threads.map((thread) => {
    if (thread.status === "resolved" || thread.status === "abandoned") return thread;
    const newEvidence = events
      .filter((event) => storyThreadEventIsRelated(thread, event))
      .map((event) => event.eventId)
      .filter((eventId) => !thread.evidenceEventIds.includes(eventId));
    if (newEvidence.length === 0) return thread;
    const evidenceEventIds = [...thread.evidenceEventIds, ...newEvidence];
    const closed = thread.closure.length > 0
      && thread.closure.every((condition) => evaluateStoryCondition(input.worldState, condition));
    return {
      ...thread,
      evidenceEventIds,
      status: closed ? "resolved" : "advanced",
    };
  });
}
