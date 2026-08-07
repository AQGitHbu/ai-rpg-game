import type { WorldState } from "@/game/domain/worldState";
import type { GameEvent } from "@/game/domain/events";
import type { ApprovedExpansion } from "./expansionTypes";

export function applyApprovedExpansion(ws: WorldState, approved: ApprovedExpansion, occurredAt: string): WorldState {
  const event: GameEvent = {
    type: "blueprint_expanded",
    newLocationIds: approved.newLocations.map((l) => l.id),
    newNpcIds: approved.newNpcs.map((n) => n.id),
    newFactIds: approved.newFacts.map((f) => f.factId),
    newItemIds: approved.newItems.map((i) => i.id),
    newEnemyIds: approved.newEnemies.map((e) => e.id),
    occurredAt,
  };

  let locations = [...ws.locations, ...approved.newLocations];
  for (const newLoc of approved.newLocations) {
    locations = locations.map((l) =>
      l.id === newLoc.connectedLocationIds[0] && !l.connectedLocationIds.includes(newLoc.id)
        ? { ...l, connectedLocationIds: [...l.connectedLocationIds, newLoc.id] }
        : l,
    );
  }

  return {
    ...ws,
    locations,
    npcs: [...ws.npcs, ...approved.newNpcs],
    items: [...ws.items, ...approved.newItems],
    enemies: [...ws.enemies, ...approved.newEnemies],
    worldFacts: [...ws.worldFacts, ...approved.newFacts],
    eventLedger: [...ws.eventLedger, event],
  };
}
