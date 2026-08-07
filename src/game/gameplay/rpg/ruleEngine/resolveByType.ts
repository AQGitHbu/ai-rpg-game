import type { WorldState } from "@/game/domain/worldState";
import { findLocation, findNpc } from "@/game/domain/worldState";
import type { Action } from "@/game/domain/action";
import type { GameEvent } from "@/game/domain/events";

export type ResolveResult = {
  readonly ok: true;
  readonly nextWorldState: WorldState;
  readonly events: readonly GameEvent[];
  readonly feedback: string;
} | {
  readonly ok: false;
  readonly feedback: string;
};

export type ResolveDeps = { readonly now: () => string };

export function resolveByType(ws: WorldState, action: Action, deps: ResolveDeps): ResolveResult {
  const occurredAt = deps.now();

  switch (action.type) {
    case "move": {
      const event: GameEvent = { type: "location_visited", locationId: action.locationId, occurredAt };
      const nextWs: WorldState = {
        ...ws,
        currentLocationId: action.locationId,
        visitedLocationIds: ws.visitedLocationIds.includes(action.locationId)
          ? ws.visitedLocationIds
          : [...ws.visitedLocationIds, action.locationId],
        eventLedger: [...ws.eventLedger, event],
      };
      const locName = findLocation(ws, action.locationId)?.name ?? "未知地点";
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: `你来到了${locName}。` };
    }
    case "talk": {
      const npc = findNpc(ws, action.npcId);
      if (npc === undefined) return { ok: false, feedback: "未知角色。" };
      const event: GameEvent = { type: "npc_met", npcId: action.npcId, occurredAt, interactionKind: "greet" };
      const nextWs: WorldState = {
        ...ws,
        npcs: ws.npcs.map((n) => n.id === action.npcId ? { ...n, met: true } : n),
        eventLedger: [...ws.eventLedger, event],
      };
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: `你与${npc.name}交谈。` };
    }
    case "investigate": {
      const event: GameEvent = { type: "fact_discovered", factId: action.factId, occurredAt };
      const nextWs: WorldState = {
        ...ws,
        worldFacts: ws.worldFacts.map((f) => f.factId === action.factId ? { ...f, discovered: true } : f),
        eventLedger: [...ws.eventLedger, event],
      };
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: "你调查了这条线索。" };
    }
    case "take_item": {
      const event: GameEvent = { type: "item_obtained", itemId: action.itemId, locationId: ws.currentLocationId, occurredAt };
      const nextWs: WorldState = {
        ...ws,
        inventory: [...ws.inventory, action.itemId],
        locations: ws.locations.map((l) =>
          l.id === ws.currentLocationId
            ? { ...l, availableItemIds: l.availableItemIds.filter((id) => id !== action.itemId) }
            : l,
        ),
        eventLedger: [...ws.eventLedger, event],
      };
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: "你取得了这件物品。" };
    }
    case "ack_prologue": {
      return { ok: true, nextWorldState: { ...ws }, events: [], feedback: "" };
    }
    default:
      return { ok: false, feedback: "此行动类型暂不支持。" };
  }
}
