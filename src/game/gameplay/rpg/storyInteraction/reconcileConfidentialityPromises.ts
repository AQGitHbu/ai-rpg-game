import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { entitiesOfKind } from "@/game/domain/entity";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { applyEntityMutations, EntityMutationInvariantError, type EntityMutation } from "@/game/gameplay/rpg/entityWorld";
import { isStoryDeliveryComplete } from "@/game/gameplay/rpg/storyDelivery";

/** Only committed, post-pledge disclosure to an excluded audience breaches terms. */
export function reconcileConfidentialityPromises(worldState: WorldState, storyState: StoryState): WorldState {
  const mutations: EntityMutation[] = [];
  for (const npc of entitiesOfKind(worldState.entityStore, "npc")) {
    for (const edge of npc.relationships.outgoing) {
      for (const promise of edge.commitments) {
        if (promise.kind !== "promise" || promise.status !== "open" || promise.confidentiality === undefined || promise.source.kind !== "action") continue;
        const terms = promise.confidentiality;
        const pledgeActionId = promise.source.actionId;
        const pledgeIndex = worldState.eventLedger.findIndex((event) => event.actionId === pledgeActionId && event.outcome === "success" && event.actorIds.includes(PLAYER_ENTITY_ID)
          && event.payload.type === "story_interaction_resolved" && event.payload.operation === "promise_confidentiality"
          && event.payload.npcId === npc.core.id);
        if (pledgeIndex < 0) continue;
        const subsequent = worldState.eventLedger.slice(pledgeIndex + 1);
        const delivery = isStoryDeliveryComplete(worldState, storyState)
          ? subsequent.find((event) => event.payload.type === "item_given" && event.outcome === "success" && event.actionId !== undefined && event.actorIds.includes(PLAYER_ENTITY_ID) && event.payload.itemId === storyState.delivery?.itemId && event.payload.npcId === storyState.delivery.recipientNpcId)
          : undefined;
        const protectedPeriod = delivery === undefined ? subsequent : subsequent.slice(0, subsequent.indexOf(delivery));
        const breach = protectedPeriod.find((event) => event.payload.type === "story_interaction_resolved"
          && event.payload.operation === "share_known_fact" && event.outcome === "success" && event.actionId !== undefined && event.actorIds.includes(PLAYER_ENTITY_ID)
          && event.payload.factIds.some((id) => terms.protectedFactIds.includes(id))
          && event.payload.audienceIds.some((id) => !terms.allowedAudienceIds.includes(id)));
        const evidence = breach ?? delivery;
        if (evidence === undefined || evidence.actionId === undefined) continue;
        mutations.push({ kind: "apply_relationship_commitment", fromNpcId: npc.core.id, targetId: edge.targetId,
          operation: { kind: breach === undefined ? "fulfill" : "break", commitmentId: promise.commitmentId },
          source: { kind: "action", actionId: evidence.actionId, turnNumber: evidence.turnNumber }, supportingEventId: evidence.eventId });
      }
    }
  }
  if (mutations.length === 0) return worldState;
  const result = applyEntityMutations(worldState, mutations);
  if (!result.ok) throw new EntityMutationInvariantError(result);
  return result.worldState;
}
