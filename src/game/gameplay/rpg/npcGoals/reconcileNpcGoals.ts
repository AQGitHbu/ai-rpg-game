import type { CommittedNarrativeEvent, NarrativeEventDraft, TurnId } from "@/game/domain/events";
import { entitiesOfKind } from "@/game/domain/entity";
import type { NpcGoalResolution } from "@/game/domain/entity/npcComponents";
import type { StoryCondition } from "@/game/domain/storyInteraction";
import type { NpcId } from "@/game/domain/worldEntity";
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
  const persisted = input.worldState.eventLedger.find((event) => String(event.eventId) === eventId);
  if (persisted !== undefined) return { kind: "event_id", eventId: persisted.eventId };
  const trigger = input.triggerEvents.find((event) => String(event.eventId) === eventId);
  if (trigger !== undefined && String(trigger.turnId) === String(input.turnId)) {
    const prefix = `${String(input.turnId)}:`;
    if (String(trigger.eventId).startsWith(prefix)) {
      return { kind: "same_batch", eventKey: String(trigger.eventId).slice(prefix.length) };
    }
  }
  return { kind: "event_id", eventId: eventId as CommittedNarrativeEvent["eventId"] };
}

/** A condition only consumes evidence observable by its owning NPC. */
function isRelevantEvidence(
  worldState: WorldState,
  npcId: NpcId,
  condition: StoryCondition,
  event: CommittedNarrativeEvent,
): boolean {
  if (event.outcome === "failure") return false;
  const payload = event.payload;
  const witnessed = event.actorIds.includes(npcId) || event.targetIds.includes(npcId);
  switch (condition.kind) {
    case "goal_status": return false;
    case "investigation_observed": {
      if (condition.npcId !== npcId) return false;
      if (payload.type === "fact_discovered") return payload.factId === condition.factId
        && payload.evidenceQuality !== undefined && (payload.witnessNpcIds ?? []).includes(npcId);
      return payload.type === "story_interaction_resolved" && payload.operation === "share_known_fact"
        && payload.audienceIds.includes(npcId) && payload.factIds.includes(condition.factId)
        && payload.evidenceEventIds.some((id) => worldState.eventLedger.some((source) =>
          source.eventId === id && source.payload.type === "fact_discovered"
          && source.payload.factId === condition.factId && source.payload.evidenceQuality !== undefined));
    }
    case "knows_fact":
      if (condition.actorId !== npcId) return false;
      return (payload.type === "npc_knowledge_changed" && payload.npcId === npcId && payload.factId === condition.factId)
        || (payload.type === "fact_discovered" && payload.factId === condition.factId && (payload.witnessNpcIds ?? []).includes(npcId))
        || (payload.type === "story_interaction_resolved" && payload.operation !== "promise_confidentiality"
          && payload.audienceIds.includes(npcId) && payload.factIds.includes(condition.factId));
    case "has_item":
      return condition.ownerId === npcId && ((payload.type === "item_given" && payload.itemId === condition.itemId && payload.npcId === npcId)
        || (payload.type === "item_obtained" && payload.itemId === condition.itemId && witnessed));
    case "promise_status": {
      if (condition.npcId !== npcId || !witnessed || event.actionId === undefined) return false;
      const npc = entitiesOfKind(worldState.entityStore, "npc").find((entry) => entry.core.id === npcId);
      return npc?.relationships.outgoing.some((edge) => edge.commitments.some((promise) => {
        if (promise.commitmentId !== condition.promiseId || promise.kind !== "promise") return false;
        if (promise.source.kind === "action" && promise.source.actionId === event.actionId) return true;
        // Promise source is its creation provenance and deliberately survives
        // fulfillment. Match the actual transition's edge and event instead.
        if (edge.lastChangedAtTurn !== event.turnNumber) return false;
        if (payload.type === "npc_relationship_changed") return payload.fromNpcId === npcId
          && payload.targetId === edge.targetId && ["kept_promise", "broke_promise"].includes(payload.signal);
        if (promise.confidentiality === undefined) return false;
        if (payload.type === "item_given") return promise.status === "fulfilled";
        return promise.status === "broken" && payload.type === "story_interaction_resolved"
          && payload.operation === "share_known_fact"
          && payload.factIds.some((id) => promise.confidentiality!.protectedFactIds.includes(id))
          && payload.audienceIds.some((id) => !promise.confidentiality!.allowedAudienceIds.includes(id));
      })) ?? false;
    }
  }
}

function nextStatus(worldState: WorldState, resolution: NpcGoalResolution): "active" | "blocked" | "completed" {
  const allMet = (conditions: readonly StoryCondition[]) => conditions.length > 0
    && conditions.every((condition) => evaluateStoryCondition(worldState, condition));
  if (allMet(resolution.completeWhen)) return "completed";
  if (allMet(resolution.blockWhen)) return "blocked";
  return "active";
}

/** Reconcile only evidence-bound goals; no event means no global NPC knowledge leak. */
export function reconcileNpcGoals(input: ReconcileNpcGoalsInput): ReconcileNpcGoalsResult {
  const events = sourceEvents(input);
  const previewWorld = { ...input.worldState, eventLedger: events };
  const mutations: EntityMutation[] = [];
  const drafts: NarrativeEventDraft[] = [];
  let nextWorldState = input.worldState;

  for (const npc of entitiesOfKind(input.worldState.entityStore, "npc")) {
    if (npc.core.lifecycle !== "active") continue;
    for (const goal of npc.dynamicState.goals) {
      if (goal.resolution === undefined || goal.status === "completed" || goal.status === "abandoned") continue;
      const conditions = [...goal.resolution.completeWhen, ...goal.resolution.blockWhen];
      const relevant = (event: CommittedNarrativeEvent) => conditions.some((condition) =>
        isRelevantEvidence(previewWorld, npc.core.id, condition, event));
      if (!input.triggerEvents.some(relevant)) continue;
      const status = nextStatus(previewWorld, goal.resolution);
      if (status === goal.status) continue;
      const evidenceEventIds = events.filter(relevant).map((event) => event.eventId);
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
