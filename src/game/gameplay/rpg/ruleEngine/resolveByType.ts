import type { WorldState } from "@/game/domain/worldState";
import { findLocation, findNpc } from "@/game/domain/worldState";
import type { Action } from "@/game/domain/action";
import type { GameEvent } from "@/game/domain/events";
import type { ResolvedEventStatus, StateChange, FactChange } from "@/game/domain/resolvedEvent";
import { relationshipTierOf, RELATIONSHIP_CHANGE } from "@/game/domain/relationship";
import { updateNpcMemory } from "./updateNpcMemory";
import type { NpcInteraction } from "@/game/domain/worldState";

export type ResolveResult = {
  readonly ok: true;
  readonly nextWorldState: WorldState;
  readonly events: readonly GameEvent[];
  readonly feedback: string;
  readonly status: ResolvedEventStatus;
  readonly stateChanges: readonly StateChange[];
  readonly facts: readonly FactChange[];
} | {
  readonly ok: false;
  readonly feedback: string;
};

export type ResolveDeps = { readonly now: () => string };

export function resolveByType(ws: WorldState, action: Action, deps: ResolveDeps): ResolveResult {
  const occurredAt = deps.now();

  // freeform：零世界变化
  if (action.type === "freeform") {
    return {
      ok: true,
      nextWorldState: ws,
      events: [],
      feedback: "",
      status: "success",
      stateChanges: [],
      facts: [],
    };
  }

  // 战斗中阻止非战斗行动
  if (ws.battle.status === "active" && action.type !== "battle_action") {
    return {
      ok: true,
      nextWorldState: ws,
      events: [],
      feedback: "战斗中无法执行此行动。",
      status: "blocked",
      stateChanges: [],
      facts: [],
    };
  }

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
      const stateChanges: StateChange[] = [
        { path: "currentLocationId", description: `移动到 ${locName}`, operation: "set" },
        { path: "visitedLocationIds", description: `记录到访`, operation: "add" },
      ];
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: `你来到了${locName}。`, status: "success", stateChanges, facts: [] };
    }
    case "talk": {
      const npc = findNpc(ws, action.npcId);
      if (npc === undefined) return { ok: false, feedback: "未知角色。" };
      const event: GameEvent = { type: "npc_met", npcId: action.npcId, occurredAt, interactionKind: "greet" };

      const interaction: NpcInteraction = {
        turn: ws.eventLedger.length,
        locationId: ws.currentLocationId,
        actionType: "talk",
        outcome: "positive",
        relationshipDelta: RELATIONSHIP_CHANGE.GREET_FIRST_MEET,
        summary: npc.met ? "再次交谈" : "首次见面，好感+5",
      };
      const updatedNpc = updateNpcMemory(npc, interaction);

      const nextWs: WorldState = {
        ...ws,
        npcs: ws.npcs.map((n) => n.id === action.npcId ? { ...updatedNpc, met: true } : n),
        eventLedger: [...ws.eventLedger, event],
      };
      const tier = relationshipTierOf(updatedNpc.memory.relationship);
      const status: ResolvedEventStatus = tier === "hostile" ? "partial_success" : "success";
      const stateChanges: StateChange[] = [
        { path: `npcs[${String(action.npcId)}].met`, description: `与${npc.name}交谈`, operation: "set" },
      ];
      if (status === "partial_success") {
        stateChanges.push({ path: `npcs[${String(action.npcId)}].relationship`, description: `${npc.name}态度敌对，勉强交流`, operation: "update" });
      }
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: `你与${npc.name}交谈。`, status, stateChanges, facts: [] };
    }
    case "investigate": {
      const event: GameEvent = { type: "fact_discovered", factId: action.factId, occurredAt };
      const nextWs: WorldState = {
        ...ws,
        worldFacts: ws.worldFacts.map((f) => f.factId === action.factId ? { ...f, discovered: true } : f),
        eventLedger: [...ws.eventLedger, event],
      };
      const stateChanges: StateChange[] = [
        { path: `worldFacts[${String(action.factId)}].discovered`, description: `发现线索`, operation: "set" },
      ];
      // 产出 FactChange：audience 为当前地点已 met 的 NPC
      const audience = ws.npcs
        .filter((n) => n.locationId === ws.currentLocationId && n.met)
        .map((n) => n.id);
      const facts: FactChange[] = [
        { factId: action.factId, change: "discovered", audience: audience.length > 0 ? audience : undefined },
      ];
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: "你调查了这条线索。", status: "success", stateChanges, facts };
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
      const stateChanges: StateChange[] = [
        { path: "inventory", description: `获得物品 ${String(action.itemId)}`, operation: "add" },
        { path: `locations[current].availableItemIds`, description: `从地点移除物品`, operation: "remove" },
      ];
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: "你取得了这件物品。", status: "success", stateChanges, facts: [] };
    }
    case "explore": {
      return { ok: true, nextWorldState: { ...ws }, events: [], feedback: "你探索了周围环境。", status: "success", stateChanges: [], facts: [] };
    }
    case "rest": {
      return { ok: true, nextWorldState: { ...ws }, events: [], feedback: "你休息了一会儿。", status: "success", stateChanges: [], facts: [] };
    }
    case "ack_prologue": {
      return { ok: true, nextWorldState: { ...ws }, events: [], feedback: "", status: "success", stateChanges: [], facts: [] };
    }
    default:
      return { ok: false, feedback: "此行动类型暂不支持。" };
  }
}
