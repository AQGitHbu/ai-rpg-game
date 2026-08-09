import type { WorldState } from "@/game/domain/worldState";
import { findLocation, findNpc, findItem } from "@/game/domain/worldState";
import type { Action } from "@/game/domain/action";
import type { GameEvent } from "@/game/domain/events";
import type { ResolvedEventStatus, StateChange, FactChange } from "@/game/domain/resolvedEvent";
import { startBattle, battleAction } from "./battleResolver";
import { updateNpcMemory } from "./updateNpcMemory";
import { resolveDialogue } from "@/game/gameplay/rpg/dialogue";

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

export type ResolveDeps = {
  readonly now: () => string;
  /** 当前回合的 actionId（写入 NpcInteraction.actionId，用于记忆去重）。 */
  readonly actionId: string;
  /** 当前回合号（写入 NpcInteraction.turnNumber）。 */
  readonly turnNumber: number;
};

export function resolveByType(ws: WorldState, action: Action, deps: ResolveDeps): ResolveResult {
  const occurredAt = deps.now();

  // freeform：零世界变化，但必须以结构化事件落账意图，
  // 让回合能形成可回应的叙事任务（spec §7.3/@13.5；事件不携带玩家原文）。
  if (action.type === "freeform") {
    const event: GameEvent = { type: "player_intent_expressed", intent: action.intent, occurredAt };
    return {
      ok: true,
      nextWorldState: { ...ws, eventLedger: [...ws.eventLedger, event] },
      events: [event],
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
        battle: ws.battle.status === "resolved" ? { status: "idle" } : ws.battle,
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
      // 旧构造器可能缺失 dialogueAct（Task 9 交割前）：回退 ask
      const dialogueAct = action.dialogueAct ?? "ask";
      const dialogue = resolveDialogue(ws, npc, { ...action, dialogueAct }, {
        now: deps.now,
        actionId: deps.actionId,
        turnNumber: deps.turnNumber,
      });
      const nextWs: WorldState = {
        ...ws,
        npcs: ws.npcs.map((n) => n.id === action.npcId ? dialogue.npcAfter : n),
        eventLedger: [...ws.eventLedger, dialogue.event],
      };
      return {
        ok: true,
        nextWorldState: nextWs,
        events: [dialogue.event],
        feedback: dialogue.feedback,
        status: dialogue.status,
        stateChanges: [...dialogue.stateChanges],
        facts: [],
      };
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
      // 产出 FactChange：玩家发现事实，但不自动传播给当前地点所有已 met NPC
      // （§14.3：不得把"在场"假设为全地点已 met NPC；investigate 未定义在场见证者，
      // 故 audience 为空 → 不向任何 NPC 自动传播）。
      const facts: FactChange[] = [
        { factId: action.factId, change: "discovered", source: "scene_witness" },
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
    case "give_item": {
      const item = findItem(ws, action.itemId);
      const npc = findNpc(ws, action.npcId);
      if (item === undefined || npc === undefined) return { ok: false, feedback: "无法交付这件物品。" };
      const event: GameEvent = { type: "item_given", itemId: action.itemId, npcId: action.npcId, locationId: ws.currentLocationId, occurredAt };
      // 移交是善意互动：好感 +1，记入交互历史（同 actionId 去重由 appendInteraction 保证）。
      const npcAfter = updateNpcMemory(npc, {
        turnNumber: deps.turnNumber,
        actionId: deps.actionId,
        locationId: ws.currentLocationId,
        dialogueAct: "offer",
        topicSummary: `收到玩家交付的${item.name}`,
        outcome: "positive",
        relationshipDelta: 1,
        learnedFactIds: [],
        summary: `收下了${item.name}`,
      });
      const nextWs: WorldState = {
        ...ws,
        inventory: ws.inventory.filter((id) => id !== action.itemId),
        npcs: ws.npcs.map((n) => n.id === action.npcId ? npcAfter : n),
        eventLedger: [...ws.eventLedger, event],
      };
      const stateChanges: StateChange[] = [
        { path: "inventory", description: `交出物品 ${item.name}`, operation: "remove" },
        { path: `npcs[${String(action.npcId)}].memory`, description: `${npc.name} 收下物品，关系改善`, operation: "set" },
      ];
      return { ok: true, nextWorldState: nextWs, events: [event], feedback: `你把${item.name}交给了${npc.name}。`, status: "success", stateChanges, facts: [] };
    }
    case "explore": {
      // 无状态行动也产生主事件（Task 29）：explore → location_explored，不得 success + 空事件。
      const event: GameEvent = { type: "location_explored", locationId: ws.currentLocationId, occurredAt };
      return {
        ok: true,
        nextWorldState: { ...ws, eventLedger: [...ws.eventLedger, event] },
        events: [event],
        feedback: "你探索了周围环境。",
        status: "success",
        stateChanges: [],
        facts: [],
      };
    }
    case "rest": {
      // 无状态行动也产生主事件（Task 29）：rest → player_rested，不得 success + 空事件。
      const event: GameEvent = { type: "player_rested", occurredAt };
      return {
        ok: true,
        nextWorldState: { ...ws, eventLedger: [...ws.eventLedger, event] },
        events: [event],
        feedback: "你休息了一会儿。",
        status: "success",
        stateChanges: [],
        facts: [],
      };
    }
    case "ack_prologue": {
      return { ok: true, nextWorldState: { ...ws }, events: [], feedback: "", status: "success", stateChanges: [], facts: [] };
    }
    case "attack": {
      return startBattle(ws, action.enemyId, deps);
    }
    case "battle_action": {
      return battleAction(ws, action.action, deps);
    }
    default:
      return { ok: false, feedback: "此行动类型暂不支持。" };
  }
}
