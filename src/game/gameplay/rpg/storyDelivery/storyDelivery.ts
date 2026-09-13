import { getEntity } from "@/game/domain/entity";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

/** Delivery is an actual transfer to the bound recipient, never a final stance. */
export function isStoryDeliveryComplete(worldState: WorldState, storyState: StoryState): boolean {
  const delivery = storyState.delivery;
  if (delivery === undefined || delivery.recipientNpcId === null) return false;
  const recipient = getEntity(worldState.entityStore, delivery.recipientNpcId);
  const item = getEntity(worldState.entityStore, delivery.itemId);
  if (recipient?.core.kind !== "npc" || recipient.core.lifecycle !== "active"
    || item?.core.kind !== "item" || !("possession" in item)
    || item.possession.owner.kind !== "npc" || item.possession.owner.npcId !== delivery.recipientNpcId) return false;
  return worldState.eventLedger.some(event => event.outcome === "success"
    && event.actorIds.includes(PLAYER_ENTITY_ID)
    && event.payload.type === "item_given" && event.payload.itemId === delivery.itemId
    && event.payload.npcId === delivery.recipientNpcId);
}

/** Returning is also an explicit transfer, not merely losing possession. */
export function isStoryDeliveryReturned(worldState: WorldState, storyState: StoryState): boolean {
  const delivery = storyState.delivery;
  if (delivery === undefined) return false;
  const item = getEntity(worldState.entityStore, delivery.itemId);
  if (item?.core.kind !== "item" || !("possession" in item) || item.possession.owner.kind !== "npc"
    || item.possession.owner.npcId !== delivery.giverNpcId) return false;
  return worldState.eventLedger.some(event => event.outcome === "success" && event.actorIds.includes(PLAYER_ENTITY_ID)
    && event.payload.type === "item_given" && event.payload.itemId === delivery.itemId && event.payload.npcId === delivery.giverNpcId);
}
