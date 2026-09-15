import type { CommittedNarrativeEvent, NarrativeEventDraft, TurnId } from "@/game/domain/events";
import { eventIdFor } from "@/game/domain/events";
import { entitiesOfKind, getEntity } from "@/game/domain/entity";
import type { NpcGoalResolution } from "@/game/domain/entity/npcComponents";
import type { StoryCondition } from "@/game/domain/storyInteraction";
import type { FactId, NpcId } from "@/game/domain/worldEntity";
import type { WorldState } from "@/game/domain/worldState";
import { applyEntityMutations, EntityMutationInvariantError, type EntityMutation } from "@/game/gameplay/rpg/entityWorld";
import { evaluateStoryCondition } from "@/game/gameplay/rpg/storyInteraction";

export type ReconcileNpcGoalsInput = Readonly<{
  worldState: WorldState;
  triggerEvents: readonly CommittedNarrativeEvent[];
  actionId: string;
  turnId: TurnId;
  turnNumber: number;
}>;

export type ReconcileNpcGoalsResult = Readonly<{
  worldState: WorldState;
  drafts: readonly NarrativeEventDraft[];
}>;

type InvestigationObservation = Readonly<{
  eventId: CommittedNarrativeEvent["eventId"];
  factId: FactId;
  evidenceQuality: "clean" | "noisy";
}>;

function sourceEvents(input: ReconcileNpcGoalsInput): readonly CommittedNarrativeEvent[] {
  const seen = new Set<string>();
  return [...input.worldState.eventLedger, ...input.triggerEvents].filter((event) => {
    const key = String(event.eventId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function causeKeyForEvent(input: ReconcileNpcGoalsInput, eventId: string):
  | { readonly kind: "event_id"; readonly eventId: CommittedNarrativeEvent["eventId"] }
  | { readonly kind: "same_batch"; readonly eventKey: string } {
  const trigger = input.triggerEvents.find((event) => String(event.eventId) === eventId);
  if (trigger !== undefined && String(trigger.turnId) === String(input.turnId)) {
    const prefix = `${String(input.turnId)}:`;
    if (String(trigger.eventId).startsWith(prefix)) {
      return { kind: "same_batch", eventKey: String(trigger.eventId).slice(prefix.length) };
    }
  }
  return { kind: "event_id", eventId: eventId as CommittedNarrativeEvent["eventId"] };
}

function observationsForNpc(
  events: readonly CommittedNarrativeEvent[],
  npcId: NpcId,
): readonly InvestigationObservation[] {
  const observations: InvestigationObservation[] = [];
  const discoveries = new Map<string, CommittedNarrativeEvent>();
  for (const event of events) {
    if (event.payload.type !== "fact_discovered") continue;
    const quality = event.payload.evidenceQuality;
    if (quality === undefined) continue;
    discoveries.set(String(event.eventId), event);
    if ((event.payload.witnessNpcIds ?? []).some((id) => String(id) === String(npcId))) {
      observations.push({ eventId: event.eventId, factId: event.payload.factId, evidenceQuality: quality });
    }
  }
  for (const event of events) {
    if (event.payload.type !== "story_interaction_resolved" || event.payload.operation !== "share_known_fact") continue;
    if (!(event.payload.audienceIds ?? []).some((id) => String(id) === String(npcId))) continue;
    for (const sourceEventId of event.payload.evidenceEventIds) {
      const source = discoveries.get(String(sourceEventId));
      if (source === undefined) continue;
      const sourcePayload = source.payload;
      if (sourcePayload.type !== "fact_discovered" || sourcePayload.evidenceQuality === undefined) continue;
      if (!event.payload.factIds.some((factId) => String(factId) === String(sourcePayload.factId))) continue;
      observations.push({ eventId: source.eventId, factId: sourcePayload.factId, evidenceQuality: sourcePayload.evidenceQuality });
    }
  }
  return observations.filter((observation, index, all) => all.findIndex((candidate) =>
    String(candidate.eventId) === String(observation.eventId)
    && String(candidate.factId) === String(observation.factId)
    && candidate.evidenceQuality === observation.evidenceQuality) === index);
}

function observed(
  condition: Extract<StoryCondition, { kind: "investigation_observed" }>,
  observations: readonly InvestigationObservation[],
): boolean {
  return observations.some((entry) => String(entry.factId) === String(condition.factId)
    && entry.evidenceQuality === condition.evidenceQuality);
}

function conditionMet(
  worldState: WorldState,
  condition: StoryCondition,
  observations: readonly InvestigationObservation[],
): boolean {
  return condition.kind === "investigation_observed"
    ? observed(condition, observations)
    : evaluateStoryCondition(worldState, condition);
}

function hasRelevantEvidence(
  resolution: NpcGoalResolution,
  observations: readonly InvestigationObservation[],
  events: readonly CommittedNarrativeEvent[],
): boolean {
  const conditions = [...resolution.completeWhen, ...resolution.blockWhen];
  return conditions.some((condition) => condition.kind === "investigation_observed"
    ? observations.some((entry) => String(entry.factId) === String(condition.factId))
    : events.some((event) => event.payload.type === "story_interaction_resolved"
      || event.payload.type === "npc_knowledge_changed"));
}

function nextStatus(
  worldState: WorldState,
  resolution: NpcGoalResolution,
  observations: readonly InvestigationObservation[],
): "active" | "blocked" | "completed" {
  if (resolution.completeWhen.every((condition) => conditionMet(worldState, condition, observations))) return "completed";
  if (resolution.blockWhen.every((condition) => conditionMet(worldState, condition, observations))) return "blocked";
  return "active";
}

/** Reconcile only evidence-bound goals; no event means no global NPC knowledge leak. */
export function reconcileNpcGoals(input: ReconcileNpcGoalsInput): ReconcileNpcGoalsResult {
  const events = sourceEvents(input);
  const mutations: EntityMutation[] = [];
  const drafts: NarrativeEventDraft[] = [];
  let nextWorldState = input.worldState;

  for (const npc of entitiesOfKind(input.worldState.entityStore, "npc")) {
    const observations = observationsForNpc(events, npc.core.id);
    for (const goal of npc.dynamicState.goals) {
      if (goal.resolution === undefined || goal.status === "completed" || goal.status === "abandoned") continue;
      if (!hasRelevantEvidence(goal.resolution, observations, input.triggerEvents)) continue;
      const status = nextStatus(nextWorldState, goal.resolution, observations);
      if (status === goal.status) continue;
      const evidenceEventIds = observations.map((entry) => entry.eventId);
      const eventKey = `npc_goal_status_changed:${npc.core.id}:${goal.goalId}:${status}`;
      const supportingEventId = evidenceEventIds[0];
      if (supportingEventId === undefined) continue;
      mutations.push({
        kind: "set_npc_goal_status",
        npcId: npc.core.id,
        goalId: goal.goalId,
        status,
        source: { kind: "action", actionId: input.actionId, turnNumber: input.turnNumber },
        supportingEventId,
      });
      drafts.push({
        eventKey,
        episodeKey: "turn",
        actorIds: [npc.core.id],
        targetIds: [npc.core.id],
        locationId: nextWorldState.currentLocationId,
        causeKeys: evidenceEventIds.map((eventId) => causeKeyForEvent(input, String(eventId))),
        factIds: evidenceEventIds.flatMap((eventId) => events.find((event) => String(event.eventId) === String(eventId))?.factIds ?? []),
        questIds: [],
        outcome: status === "blocked" ? "mixed" : "success",
        salience: 70,
        payload: {
          type: "npc_goal_status_changed",
          npcId: npc.core.id,
          goalId: goal.goalId,
          from: goal.status,
          to: status,
          evidenceEventIds,
        },
      });
    }
  }

  if (mutations.length === 0) return { worldState: input.worldState, drafts: [] };
  const applied = applyEntityMutations(nextWorldState, mutations);
  if (!applied.ok) throw new EntityMutationInvariantError(applied);
  nextWorldState = applied.worldState;
  return { worldState: nextWorldState, drafts };
}

export const __goalEventIdFor = eventIdFor;
