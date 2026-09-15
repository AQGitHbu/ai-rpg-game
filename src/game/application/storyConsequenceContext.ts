import type { EventId } from "@/game/domain/events";
import type { EntityId } from "@/game/domain/entity";
import { entitiesOfKind } from "@/game/domain/entity";
import type { NpcId } from "@/game/domain/worldEntity";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { evaluateStoryCondition } from "@/game/gameplay/rpg/storyInteraction";
import { storyThreadEventIsRelated } from "@/game/domain/storyThreads";

/**
 * Request-local references derived from committed consequences.
 *
 * This is intentionally not persisted and contains no goal descriptions,
 * private reasons, fact text, evidence quality, or numeric deltas. Callers
 * use the references to select already-authorized entity/event projections;
 * they must not treat this as a second story state machine.
 */
export type StoryConsequenceContext = Readonly<{
  readonly observerId: EntityId;
  readonly requiredEventIds: readonly EventId[];
  readonly currentGoalRefs: readonly { readonly npcId: NpcId; readonly goalId: string }[];
  readonly activeThreadIds: readonly string[];
  readonly availableInteractionIds: readonly string[];
}>;

function uniqueEventIds(
  worldState: WorldState,
  eventIds: readonly EventId[],
): readonly EventId[] {
  const existing = new Set(worldState.eventLedger.map((event) => String(event.eventId)));
  const seen = new Set<string>();
  return eventIds.filter((eventId) => {
    const key = String(eventId);
    if (!existing.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function eventTouchesNpc(event: WorldState["eventLedger"][number], npcId: NpcId): boolean {
  if ([...event.actorIds, ...event.targetIds].some((id) => String(id) === String(npcId))) return true;
  if (event.payload.type === "fact_discovered") {
    return (event.payload.witnessNpcIds ?? []).some((id) => String(id) === String(npcId));
  }
  if (event.payload.type === "story_interaction_resolved") {
    return (event.payload.audienceIds ?? []).some((id) => String(id) === String(npcId));
  }
  return false;
}

function activeInteractionIds(
  worldState: WorldState,
  eventIds: ReadonlySet<string>,
): readonly string[] {
  const ledgerIds = new Set(worldState.eventLedger.map((event) => String(event.eventId)));
  return entitiesOfKind(worldState.entityStore, "npc")
    .filter((npc) => npc.core.lifecycle === "active" && String(npc.position.locationId) === String(worldState.currentLocationId))
    .flatMap((npc) => (npc.interactions ?? []).filter((interaction) => {
      if (interaction.evidenceEventIds.some((eventId) => !ledgerIds.has(String(eventId)))) return false;
      if (interaction.evidenceEventIds.length > 0
        && !interaction.evidenceEventIds.some((eventId) => eventIds.has(String(eventId)))) return false;
      return interaction.condition.every((condition) => evaluateStoryCondition(worldState, condition));
    }).map((interaction) => interaction.id))
    .sort((left, right) => left.localeCompare(right));
}

/** Project only the references a current author/NPC request is allowed to use. */
export function projectStoryConsequences(input: Readonly<{
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly observerId: EntityId;
  readonly eventIds: readonly EventId[];
}>): StoryConsequenceContext {
  const requiredEvents = uniqueEventIds(input.worldState, input.eventIds);
  const requiredEventSet = new Set(requiredEvents.map((eventId) => String(eventId)));
  const triggerEvents = input.worldState.eventLedger.filter((event) => requiredEventSet.has(String(event.eventId)));
  const touchedNpcIds = new Set(
    entitiesOfKind(input.worldState.entityStore, "npc")
      .filter((npc) => triggerEvents.some((event) => eventTouchesNpc(event, npc.core.id)))
      .map((npc) => String(npc.core.id)),
  );

  const activeThreadIds = input.storyState.threads
    .filter((thread) => thread.status === "open" || thread.status === "advanced")
    .filter((thread) => triggerEvents.some((event) => storyThreadEventIsRelated(thread, event)))
    .map((thread) => thread.id)
    .sort((left, right) => left.localeCompare(right));

  const currentGoalRefs = input.storyState.threads
    .filter((thread) => activeThreadIds.includes(thread.id))
    .flatMap((thread) => thread.goalRefs)
    .concat(
      entitiesOfKind(input.worldState.entityStore, "npc")
        .filter((npc) => touchedNpcIds.has(String(npc.core.id)))
        .flatMap((npc) => npc.dynamicState.goals
          .filter((goal) => goal.status === "active" || goal.status === "blocked")
          .map((goal) => ({ npcId: npc.core.id, goalId: goal.goalId }))),
    )
    .filter((entry, index, all) => all.findIndex((candidate) =>
      String(candidate.npcId) === String(entry.npcId) && candidate.goalId === entry.goalId) === index)
    .sort((left, right) => String(left.npcId).localeCompare(String(right.npcId)) || left.goalId.localeCompare(right.goalId));

  return {
    observerId: input.observerId,
    requiredEventIds: requiredEvents,
    currentGoalRefs,
    activeThreadIds,
    availableInteractionIds: activeInteractionIds(input.worldState, requiredEventSet),
  };
}
