import type { ItemEntry, WorldState } from "@/game/domain/worldState";
import { findLocation, findNpc, findItem } from "@/game/domain/worldState";
import type { Action } from "@/game/domain/action";
import type { NarrativeEventDraft, TurnId } from "@/game/domain/events";
import { eventIdFor } from "@/game/domain/events";
import type { ResolvedEventStatus, StateChange, FactChange } from "@/game/domain/resolvedEvent";
import type { StoryState } from "@/game/domain/storyState";
import { startBattle, battleAction } from "./battleResolver";
import { resolveDialogue } from "@/game/gameplay/rpg/dialogue";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";
import { applyEntityMutations, type EntityMutation } from "@/game/gameplay/rpg/entityWorld";
import { PLAYER_ENTITY_ID, RETURN_REQUIRED_ITEM_TAG } from "@/game/domain/worldEntity";
import { resolveStoryInteraction } from "../storyInteraction";

export type ResolveResult = {
  readonly ok: true;
  readonly nextWorldState: WorldState;
  readonly drafts: readonly NarrativeEventDraft[];
  readonly feedback: string;
  readonly status: ResolvedEventStatus;
  readonly stateChanges: readonly StateChange[];
  readonly facts: readonly FactChange[];
} | {
  readonly ok: false;
  readonly feedback: string;
};

export type ResolveDeps = {
  /** 时钟注入：用于 resolveDialogue 等需要时间戳的子函数。 */
  readonly now: () => string;
  /** 当前回合的 actionId（写入 NpcInteraction.actionId，用于记忆去重）。 */
  readonly actionId: string;
  /** 当前回合号（写入 NpcInteraction.turnNumber）。 */
  readonly turnNumber: number;
  /** Task 4：当前回合的稳定 turnId，用于预铸 eventId。 */
  readonly turnId: TurnId;
};

function giftRelationshipSignal(item: ItemEntry): "gave_item" | "offered_help" {
  return item.tags.includes(RETURN_REQUIRED_ITEM_TAG) ? "gave_item" : "offered_help";
}

/** 规则已完成 Action 校验；若 store 仍拒绝写入，视为损坏状态而非部分成功。 */
function applyRuleMutations(ws: WorldState, mutations: readonly EntityMutation[]): WorldState | null {
  const result = applyEntityMutations(ws, mutations);
  return result.ok ? result.worldState : null;
}

export function resolveByType(ws: WorldState, action: Action, deps: ResolveDeps): ResolveResult {
  // freeform：零世界变化，但必须以结构化事件落账意图，
  // 让回合能形成可回应的叙事任务（spec §7.3/@13.5；事件不携带玩家原文）。
  if (action.type === "freeform") {
    const draft: NarrativeEventDraft = {
      eventKey: "player_intent_expressed:freeform",
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [PLAYER_ENTITY_ID],
      locationId: ws.currentLocationId,
      causeKeys: [],
      factIds: [],
      questIds: [],
      outcome: "neutral",
      salience: 15,
      payload: { type: "player_intent_expressed", intentCode: "unmapped_freeform" },
    };
    return {
      ok: true,
      nextWorldState: ws,
      drafts: [draft],
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
      drafts: [],
      feedback: "战斗中无法执行此行动。",
      status: "blocked",
      stateChanges: [],
      facts: [],
    };
  }

  switch (action.type) {
    case "move": {
      const draft: NarrativeEventDraft = {
        eventKey: `location_visited:${action.locationId}`,
        episodeKey: "turn",
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [PLAYER_ENTITY_ID],
        locationId: action.locationId,
        causeKeys: [],
        factIds: [],
        questIds: [],
        outcome: "neutral",
        salience: 20,
        payload: { type: "location_visited", locationId: action.locationId },
      };
      const mutated = applyRuleMutations(ws, [{ kind: "move_player", toLocationId: action.locationId, markVisited: true }]);
      if (mutated === null) return { ok: false, feedback: "世界状态不一致。" };
      const nextWs: WorldState = {
        ...mutated,
        battle: mutated.battle.status === "resolved" ? { status: "idle" } : mutated.battle,
      };
      const locName = findLocation(ws, action.locationId)?.name ?? "未知地点";
      const stateChanges: StateChange[] = [
        { path: "currentLocationId", description: `移动到 ${locName}`, operation: "set" },
        { path: "visitedLocationIds", description: `记录到访`, operation: "add" },
      ];
      return { ok: true, nextWorldState: nextWs, drafts: [draft], feedback: `你来到了${locName}。`, status: "success", stateChanges, facts: [] };
    }
    case "talk": {
      if (action.interactionId !== undefined) {
        return resolveStoryInteraction(ws, action, deps);
      }
      const npc = findNpc(ws, action.npcId);
      if (npc === undefined) return { ok: false, feedback: "未知角色。" };
      // 旧构造器可能缺失 dialogueAct（Task 9 交割前）：回退 ask
      const dialogueAct = action.dialogueAct ?? "ask";
      const dialogue = resolveDialogue(ws, npc, { ...action, dialogueAct }, {
        now: deps.now,
        actionId: deps.actionId,
        turnNumber: deps.turnNumber,
        turnId: deps.turnId,
      });
      const mutated = applyRuleMutations(ws, dialogue.mutations);
      if (mutated === null) return { ok: false, feedback: "世界状态不一致。" };
      return {
        ok: true,
        nextWorldState: mutated,
        drafts: dialogue.drafts,
        feedback: dialogue.feedback,
        status: dialogue.status,
        stateChanges: [...dialogue.stateChanges],
        // 对话披露不等于 FactChange；玩家侧知识写入由 Task 7/8 的传播链负责。
        facts: [],
      };
    }
    case "investigate": {
      const source: FactDiscoverySource = action.approachId === undefined
        ? { kind: "automatic" }
        : { kind: "player", approachId: action.approachId };
      return resolveFactDiscovery(ws, action, source);
    }
    case "take_item": {
      const draft: NarrativeEventDraft = {
        eventKey: `item_obtained:${action.itemId}`,
        episodeKey: "turn",
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [PLAYER_ENTITY_ID],
        locationId: ws.currentLocationId,
        causeKeys: [],
        factIds: [],
        questIds: [],
        outcome: "success",
        salience: 30,
        payload: { type: "item_obtained", itemId: action.itemId, locationId: ws.currentLocationId },
      };
      const mutated = applyRuleMutations(ws, [{
        kind: "transfer_item",
        itemId: action.itemId,
        owner: { kind: "player", playerId: PLAYER_ENTITY_ID },
      }]);
      if (mutated === null) return { ok: false, feedback: "世界状态不一致。" };
      const stateChanges: StateChange[] = [
        { path: "inventory", description: `获得物品 ${String(action.itemId)}`, operation: "add" },
        { path: `locations[current].availableItemIds`, description: `从地点移除物品`, operation: "remove" },
      ];
      return { ok: true, nextWorldState: mutated, drafts: [draft], feedback: "你取得了这件物品。", status: "success", stateChanges, facts: [] };
    }
    case "give_item": {
      const item = findItem(ws, action.itemId);
      const npc = findNpc(ws, action.npcId);
      if (item === undefined || npc === undefined) {
        return { ok: false, feedback: "无法交付这件物品。" };
      }
      // 保持 Task 5C2 的 actionId 去重错误契约：重放先于 possession 检查被拒绝。
      if (npc.memory.interactionHistory.some((entry) => entry.actionId === deps.actionId)) {
        return { ok: false, feedback: "世界状态不一致。" };
      }
      if (!ws.inventory.includes(action.itemId)) return { ok: false, feedback: "无法交付这件物品。" };
      const itemEventKey = `item_given:${action.itemId}:${action.npcId}`;
      const relationshipEventKey = `npc_relationship_changed:${action.npcId}:${PLAYER_ENTITY_ID}:${giftRelationshipSignal(item)}`;
      const interactionEventKey = `npc_interaction_recorded:${action.npcId}:${deps.actionId}`;
      const drafts: NarrativeEventDraft[] = [{
        eventKey: itemEventKey,
        episodeKey: "turn",
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [action.npcId],
        locationId: ws.currentLocationId,
        causeKeys: [],
        factIds: [],
        questIds: [],
        outcome: "success",
        salience: 45,
        payload: { type: "item_given", itemId: action.itemId, npcId: action.npcId, locationId: ws.currentLocationId },
      }, {
        eventKey: relationshipEventKey,
        episodeKey: "turn",
        actorIds: [action.npcId],
        targetIds: [PLAYER_ENTITY_ID],
        locationId: ws.currentLocationId,
        causeKeys: [{ kind: "same_batch", eventKey: itemEventKey }],
        factIds: [],
        questIds: [],
        outcome: "success",
        salience: 40,
        payload: {
          type: "npc_relationship_changed",
          fromNpcId: action.npcId,
          targetId: PLAYER_ENTITY_ID,
          signal: giftRelationshipSignal(item),
        },
      }, {
        eventKey: interactionEventKey,
        episodeKey: "turn",
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [action.npcId],
        locationId: ws.currentLocationId,
        causeKeys: [{ kind: "same_batch", eventKey: itemEventKey }],
        factIds: [],
        questIds: [],
        outcome: "success",
        salience: 35,
        payload: {
          type: "npc_interaction_recorded",
          npcId: action.npcId,
          dialogueAct: "offer",
        },
      }];
      const mutated = applyRuleMutations(ws, [
        { kind: "transfer_item", itemId: action.itemId, owner: { kind: "npc", npcId: action.npcId } },
        {
          kind: "apply_relationship_signal",
          fromNpcId: action.npcId,
          targetId: PLAYER_ENTITY_ID,
          signal: giftRelationshipSignal(item),
          source: { kind: "action", actionId: deps.actionId, turnNumber: deps.turnNumber },
          supportingEventId: eventIdFor(deps.turnId, `npc_relationship_changed:${action.npcId}:${PLAYER_ENTITY_ID}:${giftRelationshipSignal(item)}`),
        },
        {
          kind: "record_npc_interaction",
          npcId: action.npcId,
          turnNumber: deps.turnNumber,
          actionId: deps.actionId,
          eventId: eventIdFor(deps.turnId, `npc_interaction_recorded:${action.npcId}:${deps.actionId}`),
          locationId: ws.currentLocationId,
          dialogueAct: "offer",
          topicSummary: `收到玩家交付的${item.name}`,
          outcome: "positive",
          learnedFactIds: [],
        },
      ]);
      if (mutated === null) return { ok: false, feedback: "世界状态不一致。" };
      const stateChanges: StateChange[] = [
        { path: "inventory", description: `交出物品 ${item.name}`, operation: "remove" },
        { path: `npcs[${String(action.npcId)}].memory`, description: `${npc.name} 收下物品，关系改善`, operation: "set" },
      ];
      return { ok: true, nextWorldState: mutated, drafts, feedback: `你把${item.name}交给了${npc.name}。`, status: "success", stateChanges, facts: [] };
    }
    case "explore": {
      // 无状态行动也产生主事件（Task 29）：explore → location_explored，不得 success + 空事件。
      const draft: NarrativeEventDraft = {
        eventKey: `location_explored:${ws.currentLocationId}`,
        episodeKey: "turn",
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [PLAYER_ENTITY_ID],
        locationId: ws.currentLocationId,
        causeKeys: [],
        factIds: [],
        questIds: [],
        outcome: "neutral",
        salience: 20,
        payload: { type: "location_explored", locationId: ws.currentLocationId },
      };
      return {
        ok: true,
        nextWorldState: ws,
        drafts: [draft],
        feedback: "你探索了周围环境。",
        status: "success",
        stateChanges: [],
        facts: [],
      };
    }
    case "ack_prologue": {
      return { ok: true, nextWorldState: { ...ws }, drafts: [], feedback: "", status: "success", stateChanges: [], facts: [] };
    }
    case "attack": {
      return startBattle(ws, action.enemyId, deps.turnId);
    }
    case "battle_action": {
      return battleAction(ws, action.action, action.command, {
        turnId: deps.turnId,
        actionId: deps.actionId,
        turnNumber: deps.turnNumber + 1,
      });
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
): ResolveResult {
  const fact = ws.worldFacts.find((f) => f.factId === action.factId);
  if (fact === undefined) return { ok: false, feedback: "未知线索。" };
  if (fact.discovered) return { ok: false, feedback: "这条线索已经调查过了。" };

  const approach = source.kind === "player"
    ? fact.investigationApproaches?.find((entry) => entry.approachId === source.approachId)
    : undefined;
  if (source.kind === "player" && approach === undefined) return { ok: false, feedback: "未知的调查方式。" };

  const draft: NarrativeEventDraft = {
    eventKey: `fact_discovered:${action.factId}`,
    episodeKey: "turn",
    actorIds: [PLAYER_ENTITY_ID],
    targetIds: [PLAYER_ENTITY_ID],
    locationId: ws.currentLocationId,
    causeKeys: [],
    factIds: [action.factId],
    questIds: [],
    outcome: "success",
    salience: 65,
    payload: {
      type: "fact_discovered",
      factId: action.factId,
      ...(approach === undefined
        ? {}
        : {
            approachId: approach.approachId,
            evidenceQuality: approach.evidenceQuality,
            tensionDelta: approach.tensionDelta,
          }),
    },
  };
  const mutated = applyRuleMutations(ws, [{ kind: "discover_fact", factId: action.factId }]);
  if (mutated === null) return { ok: false, feedback: "世界状态不一致。" };
  const stateChanges: StateChange[] = [
    { path: `worldFacts[${String(action.factId)}].discovered`, description: `发现线索`, operation: "set" },
  ];
  // 玩家发现事实，但不自动传播给当前地点所有已 met NPC（§14.3：investigate 未定义
  // 在场见证者，audience 为空 → 不向任何 NPC 自动传播）。
  const facts: FactChange[] = [
    { factId: action.factId, change: "discovered", source: "scene_witness" },
  ];
  return { ok: true, nextWorldState: mutated, drafts: [draft], feedback: "你调查了这条线索。", status: "success", stateChanges, facts };
}

/**
 * 自动揭示的封闭结算结果：no-op 时 events 为空且返回同一 worldState 对象引用。
 */
export type AutoResolveInvestigationResult = {
  readonly nextWorldState: WorldState;
  readonly drafts: readonly NarrativeEventDraft[];
  readonly stateChanges: readonly StateChange[];
  readonly facts: readonly FactChange[];
};

/**
 * 纯规则的有界辅助：当前主线首目标是当前地点的 discover_fact 时，返回一次
 * automatic 事实发现结算；调查方式不再构成玩家操作入口，统一在规则边界自动确认。
 * 不运行任务 reconciliation、不自行更新 ledger、不创建 pending job（由 resolveTurn 编排）。
 */
export function autoResolveCurrentInvestigation(
  worldState: WorldState,
  storyState: StoryState,
): AutoResolveInvestigationResult {
  const noOp: AutoResolveInvestigationResult = {
    nextWorldState: worldState,
    drafts: [],
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
  const action: Extract<Action, { readonly type: "investigate" }> = { type: "investigate", factId: fact.factId };
  const resolved = resolveFactDiscovery(worldState, action, { kind: "automatic" });
  if (!resolved.ok) return noOp;
  return {
    nextWorldState: resolved.nextWorldState,
    drafts: resolved.drafts,
    stateChanges: resolved.stateChanges,
    facts: resolved.facts,
  };
}
