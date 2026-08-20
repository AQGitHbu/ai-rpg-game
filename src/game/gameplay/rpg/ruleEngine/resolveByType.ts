import type { WorldState } from "@/game/domain/worldState";
import { findLocation, findNpc, findItem } from "@/game/domain/worldState";
import type { Action } from "@/game/domain/action";
import type { GameEvent } from "@/game/domain/events";
import type { ResolvedEventStatus, StateChange, FactChange } from "@/game/domain/resolvedEvent";
import type { StoryState } from "@/game/domain/storyState";
import { startBattle, battleAction } from "./battleResolver";
import { updateNpcMemory } from "./updateNpcMemory";
import { resolveDialogue } from "@/game/gameplay/rpg/dialogue";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";

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
      const source: FactDiscoverySource = action.approachId === undefined
        ? { kind: "automatic" }
        : { kind: "player", approachId: action.approachId };
      return resolveFactDiscovery(ws, action, source, { now: deps.now });
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
    case "ack_prologue": {
      return { ok: true, nextWorldState: { ...ws }, events: [], feedback: "", status: "success", stateChanges: [], facts: [] };
    }
    case "attack": {
      return startBattle(ws, action.enemyId, deps);
    }
    case "battle_action": {
      return battleAction(ws, action.action, deps, action.command);
    }
    default:
      return { ok: false, feedback: "此行动类型暂不支持。" };
  }
}

/**
 * 事实发现的封闭来源：玩家选择已审批调查方式，或规则在揭示边界自动发现。
 * 客户端不得自造 approachId——只能来自服务端已审批调查方式的 choice token 派生。
 */
export type FactDiscoverySource =
  | { readonly kind: "player"; readonly approachId: string }
  | { readonly kind: "automatic" };

/**
 * 纯规则的事实发现结算：更新 discovered、追加 fact_discovered 事件、产生 StateChange，
 * 与 resolveByType 相同返回形状，绝不执行持久化。
 * player source 写入所选 approach 的 evidence/tension；automatic source 只写基础
 * 事实事件（省略 approach 元数据、零额外张力）。
 */
export function resolveFactDiscovery(
  ws: WorldState,
  action: Extract<Action, { readonly type: "investigate" }>,
  source: FactDiscoverySource,
  deps: { readonly now: () => string },
): ResolveResult {
  const occurredAt = deps.now();
  const fact = ws.worldFacts.find((f) => f.factId === action.factId);
  if (fact === undefined) return { ok: false, feedback: "未知线索。" };
  if (fact.discovered) return { ok: false, feedback: "这条线索已经调查过了。" };

  const approach = source.kind === "player"
    ? fact.investigationApproaches?.find((entry) => entry.approachId === source.approachId)
    : undefined;
  if (source.kind === "player" && approach === undefined) return { ok: false, feedback: "未知的调查方式。" };

  const event: GameEvent = {
    type: "fact_discovered",
    factId: action.factId,
    occurredAt,
    ...(approach === undefined
      ? {}
      : {
          approachId: approach.approachId,
          evidenceQuality: approach.evidenceQuality,
          tensionDelta: approach.tensionDelta,
        }),
  };
  const nextWs: WorldState = {
    ...ws,
    worldFacts: ws.worldFacts.map((f) => f.factId === action.factId ? { ...f, discovered: true } : f),
    eventLedger: [...ws.eventLedger, event],
  };
  const stateChanges: StateChange[] = [
    { path: `worldFacts[${String(action.factId)}].discovered`, description: `发现线索`, operation: "set" },
  ];
  // 玩家发现事实，但不自动传播给当前地点所有已 met NPC（§14.3：investigate 未定义
  // 在场见证者，audience 为空 → 不向任何 NPC 自动传播）。
  const facts: FactChange[] = [
    { factId: action.factId, change: "discovered", source: "scene_witness" },
  ];
  return { ok: true, nextWorldState: nextWs, events: [event], feedback: "你调查了这条线索。", status: "success", stateChanges, facts };
}

/**
 * 自动揭示的封闭结算结果：no-op 时 events 为空且返回同一 worldState 对象引用。
 */
export type AutoResolveInvestigationResult = {
  readonly nextWorldState: WorldState;
  readonly events: readonly GameEvent[];
  readonly stateChanges: readonly StateChange[];
  readonly facts: readonly FactChange[];
};

/**
 * 纯规则的有界辅助：当前主线首目标是当前地点、无 approach 的 discover_fact 时，
 * 返回一次 automatic 事实发现结算；否则返回 no-op。
 * 不运行任务 reconciliation、不自行更新 ledger、不创建 pending job（由 resolveTurn 编排）。
 */
export function autoResolveCurrentInvestigation(
  worldState: WorldState,
  storyState: StoryState,
  deps?: { readonly now: () => string },
): AutoResolveInvestigationResult {
  const noOp: AutoResolveInvestigationResult = {
    nextWorldState: worldState,
    events: [],
    stateChanges: [],
    facts: [],
  };
  const objective = currentObjectiveOf(worldState, storyState);
  if (objective === null) return noOp;
  const quest = worldState.quests.find((entry) => String(entry.id) === String(objective.questId));
  const target = quest?.objectives[objective.objectiveIndex];
  if (target === undefined || target.kind !== "discover_fact") return noOp;
  const fact = worldState.worldFacts.find((f) => f.factId === target.factId);
  if (fact === undefined || fact.discovered) return noOp;
  // 旧档案事实可能缺 locationId（Task 6 线性模式 legacy_fact 兼容）：视为当前地点。
  if (fact.locationId !== undefined && String(fact.locationId) !== String(worldState.currentLocationId)) return noOp;
  const approaches = fact.investigationApproaches ?? [];
  if (approaches.length >= 2) return noOp;

  const action: Extract<Action, { readonly type: "investigate" }> = { type: "investigate", factId: fact.factId };
  const resolved = resolveFactDiscovery(worldState, action, { kind: "automatic" }, { now: deps?.now ?? (() => "") });
  if (!resolved.ok) return noOp;
  return {
    nextWorldState: resolved.nextWorldState,
    events: resolved.events,
    stateChanges: resolved.stateChanges,
    facts: resolved.facts,
  };
}
