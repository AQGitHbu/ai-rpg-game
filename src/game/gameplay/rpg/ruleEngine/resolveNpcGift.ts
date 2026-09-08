import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { NpcId } from "@/game/domain/worldEntity";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { entitiesOfKind } from "@/game/domain/entity";
import type { NarrativeEventDraft } from "@/game/domain/events";
import type { StateChange } from "@/game/domain/resolvedEvent";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";
import { applyEntityMutations } from "@/game/gameplay/rpg/entityWorld";

/** Called only for the NPC whose formal conversation completed in this turn. */
export function resolveNpcGift(worldState: WorldState, storyState: StoryState, npcId: NpcId):
  | { readonly ok: true; readonly nextWorldState: WorldState; readonly drafts: readonly NarrativeEventDraft[]; readonly stateChanges: readonly StateChange[] }
  | { readonly ok: false } {
  const ref = currentObjectiveOf(worldState, storyState);
  const quest = worldState.quests.find(entry => entry.id === ref?.questId);
  const objective = ref === null ? undefined : quest?.objectives[ref.objectiveIndex];
  if (quest?.kind !== "main" || objective?.kind !== "obtain_item" || objective.giftFromNpcId !== npcId) {
    return { ok: true, nextWorldState: worldState, drafts: [], stateChanges: [] };
  }
  const item = entitiesOfKind(worldState.entityStore, "item").find(entry => entry.core.id === objective.itemId);
  const npc = worldState.npcs.find(entry => entry.id === npcId);
  if (npc?.locationId !== worldState.currentLocationId || item?.possession.owner.kind !== "npc" || item.possession.owner.npcId !== npcId) return { ok: false };
  const changed = applyEntityMutations(worldState, [{ kind: "transfer_item", itemId: objective.itemId, owner: { kind: "player", playerId: PLAYER_ENTITY_ID } }]);
  if (!changed.ok) return { ok: false };
  return { ok: true, nextWorldState: changed.worldState,
    drafts: [{ eventKey: `item_obtained:${objective.itemId}`, episodeKey: "turn", actorIds: [npcId], targetIds: [PLAYER_ENTITY_ID], locationId: worldState.currentLocationId,
      causeKeys: [{ kind: "same_batch", eventKey: `npc_dialogue_completed:${npcId}` }], factIds: [], questIds: [quest.id], outcome: "success", salience: 30,
      payload: { type: "item_obtained", itemId: objective.itemId, locationId: worldState.currentLocationId } }],
    stateChanges: [{ path: "inventory", operation: "add", description: `${npc.name}将${item.core.name}交给你。` }],
  };
}
