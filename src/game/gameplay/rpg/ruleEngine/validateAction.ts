import type { WorldState } from "@/game/domain/worldState";
import { findLocation, findNpc, findItem, findQuest } from "@/game/domain/worldState";
import type { Action } from "@/game/domain/action";
import { DIALOGUE_ACTS } from "@/game/domain/action";

export type ValidationCode =
  | "UNKNOWN_LOCATION" | "LOCATION_NOT_CURRENT" | "LOCATION_ALREADY_CURRENT"
  | "LOCATION_NOT_CONNECTED" | "LOCATION_LOCKED" | "LOCATION_ALREADY_OBSERVED"
  | "UNKNOWN_NPC" | "NPC_NOT_PRESENT" | "NPC_ALREADY_MET"
  | "UNKNOWN_FACT" | "FACT_NOT_INVESTIGABLE" | "FACT_ALREADY_DISCOVERED"
  | "UNKNOWN_QUEST"
  | "UNKNOWN_DIALOGUE_ACT"
  | "UNKNOWN_ITEM" | "ITEM_NOT_AVAILABLE_HERE" | "ITEM_ALREADY_OWNED" | "ITEM_NOT_OWNED"
  | "UNKNOWN_ENEMY" | "ENEMY_NOT_AT_LOCATION" | "BATTLE_ALREADY_ACTIVE"
  | "ENEMY_ALREADY_DEFEATED" | "NO_ACTIVE_BATTLE" | "INTENT_NOT_ROUTED";

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
      // dialogueAct 枚举守卫：旧构造器（无 act）放行回退 ask，Task 9 交割后收紧
      if (action.dialogueAct !== undefined && !DIALOGUE_ACTS.includes(action.dialogueAct)) {
        return { ok: false, code: "UNKNOWN_DIALOGUE_ACT", params: { dialogueAct: String(action.dialogueAct) } };
      }
      const topic = action.topic;
      if (topic?.kind === "fact") {
        const fact = ws.worldFacts.find((f) => f.factId === topic.factId);
        if (fact === undefined) return { ok: false, code: "UNKNOWN_FACT", params: { factId: String(topic.factId) } };
      }
      if (topic?.kind === "quest") {
        if (findQuest(ws, topic.questId) === undefined) return { ok: false, code: "UNKNOWN_QUEST", params: { questId: String(topic.questId) } };
      }
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
    case "give_item": {
      const item = findItem(ws, action.itemId);
      if (item === undefined) return { ok: false, code: "UNKNOWN_ITEM", params: { itemId: String(action.itemId) } };
      if (!ws.inventory.includes(action.itemId)) return { ok: false, code: "ITEM_NOT_OWNED", params: { itemId: String(action.itemId) } };
      const npc = findNpc(ws, action.npcId);
      if (npc === undefined) return { ok: false, code: "UNKNOWN_NPC", params: { npcId: String(action.npcId) } };
      if (npc.locationId !== ws.currentLocationId) return { ok: false, code: "NPC_NOT_PRESENT", params: { npcId: String(action.npcId) } };
      return { ok: true };
    }
    case "attack": {
      const enemy = ws.enemies.find((e) => e.id === action.enemyId);
      if (enemy === undefined) return { ok: false, code: "UNKNOWN_ENEMY", params: { enemyId: String(action.enemyId) } };
      // resolved 只保留上一场战斗的结果；只要没有 active battle，仍可再次
      // 挑战尚未击败的敌人（例如撤退后重新进入战斗）。
      if (ws.battle.status === "active") return { ok: false, code: "BATTLE_ALREADY_ACTIVE", params: {} };
      if (ws.currentLocationId !== enemy.locationId) return { ok: false, code: "ENEMY_NOT_AT_LOCATION", params: {} };
      if (ws.defeatedEnemyIds.includes(action.enemyId)) return { ok: false, code: "ENEMY_ALREADY_DEFEATED", params: {} };
      return { ok: true };
    }
    case "battle_action": {
      if (ws.battle.status !== "active") return { ok: false, code: "NO_ACTIVE_BATTLE", params: {} };
      return { ok: true };
    }
    case "ack_prologue":
    case "explore":
    case "freeform":
      return { ok: true };
    default:
      return { ok: false, code: "INTENT_NOT_ROUTED", params: {} };
  }
}
