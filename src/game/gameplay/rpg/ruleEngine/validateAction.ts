import type { WorldState } from "@/game/domain/worldState";
import { findLocation, findNpc, findItem } from "@/game/domain/worldState";
import type { Action } from "@/game/domain/action";

export type ValidationCode =
  | "UNKNOWN_LOCATION" | "LOCATION_NOT_CURRENT" | "LOCATION_ALREADY_CURRENT"
  | "LOCATION_NOT_CONNECTED" | "LOCATION_LOCKED" | "LOCATION_ALREADY_OBSERVED"
  | "UNKNOWN_NPC" | "NPC_NOT_PRESENT" | "NPC_ALREADY_MET"
  | "UNKNOWN_FACT" | "FACT_NOT_INVESTIGABLE" | "FACT_ALREADY_DISCOVERED"
  | "UNKNOWN_ITEM" | "ITEM_NOT_AVAILABLE_HERE" | "ITEM_ALREADY_OWNED"
  | "UNKNOWN_ENEMY" | "BATTLE_NOT_AVAILABLE" | "INTENT_NOT_ROUTED";

export type ValidateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ValidationCode; readonly params: Record<string, string> };

export function validateAction(ws: WorldState, action: Action): ValidateResult {
  switch (action.type) {
    case "move": {
      const loc = findLocation(ws, action.locationId);
      if (loc === undefined) return { ok: false, code: "UNKNOWN_LOCATION", params: { locationId: String(action.locationId) } };
      if (ws.currentLocationId === action.locationId) return { ok: false, code: "LOCATION_ALREADY_CURRENT", params: {} };
      if (!ws.unlockedLocationIds.includes(action.locationId)) return { ok: false, code: "LOCATION_LOCKED", params: {} };
      const current = findLocation(ws, ws.currentLocationId);
      if (current !== undefined && !current.connectedLocationIds.includes(action.locationId)) return { ok: false, code: "LOCATION_NOT_CONNECTED", params: {} };
      return { ok: true };
    }
    case "talk": {
      const npc = findNpc(ws, action.npcId);
      if (npc === undefined) return { ok: false, code: "UNKNOWN_NPC", params: { npcId: String(action.npcId) } };
      if (npc.locationId !== ws.currentLocationId) return { ok: false, code: "NPC_NOT_PRESENT", params: { npcId: String(action.npcId) } };
      return { ok: true };
    }
    case "investigate": {
      const fact = ws.worldFacts.find((f) => f.factId === action.factId);
      if (fact === undefined) return { ok: false, code: "UNKNOWN_FACT", params: { factId: String(action.factId) } };
      if (fact.discovered) return { ok: false, code: "FACT_ALREADY_DISCOVERED", params: {} };
      return { ok: true };
    }
    case "take_item": {
      const item = findItem(ws, action.itemId);
      if (item === undefined) return { ok: false, code: "UNKNOWN_ITEM", params: { itemId: String(action.itemId) } };
      if (ws.inventory.includes(action.itemId)) return { ok: false, code: "ITEM_ALREADY_OWNED", params: {} };
      const loc = findLocation(ws, ws.currentLocationId);
      if (loc !== undefined && !loc.availableItemIds.includes(action.itemId)) return { ok: false, code: "ITEM_NOT_AVAILABLE_HERE", params: {} };
      return { ok: true };
    }
    case "ack_prologue":
    case "explore":
    case "rest":
      return { ok: true };
    case "attack":
    case "battle_action":
      return { ok: false, code: "BATTLE_NOT_AVAILABLE", params: {} };
    default:
      return { ok: false, code: "INTENT_NOT_ROUTED", params: {} };
  }
}
