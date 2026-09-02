import type { WorldState, QuestOutcome } from "@/game/domain/worldState";
import type { NarrativeEventDraft } from "@/game/domain/events";
import { entitiesOfKind } from "@/game/domain/entity";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { isObjectiveSatisfied } from "@/game/gameplay/rpg/narrativeContext/objectiveRules";
import { applyEntityMutations, EntityMutationInvariantError, type EntityMutation } from "@/game/gameplay/rpg/entityWorld";

export type QuestReconcileResult = {
  readonly nextWorldState: WorldState;
  readonly drafts: readonly NarrativeEventDraft[];
};

export type QuestActionContext = {
  /** 当前行动明确记录的 NPC participant；不是由 quest 文本或 focus 推断。 */
  readonly participantNpcId: string;
  readonly actionId: string;
  readonly turnNumber: number;
  /** 由 resolveTurn 根据回合开始状态计算；不得来自 Action/AI payload。 */
  readonly actionWasAlreadyUsed?: boolean;
};

export type QuestReconcileOptions = {
  readonly talkToNpcSession?: { readonly npcId: string; readonly completed: boolean };
  readonly actionContext?: QuestActionContext;
};

export function npcUsedAction(ws: WorldState, npcId: string, actionId: string): boolean {
  const npc = entitiesOfKind(ws.entityStore, "npc").find((record) => String(record.core.id) === npcId);
  const npcMemoryUsed = npc?.history.interactions.some((entry) => entry.actionId === actionId)
    || npc?.relationships.outgoing.some((edge) => edge.evidence.some((evidence) => evidence.actionId === actionId))
    || false;
  const actionEventUsed = ws.eventLedger.some((event) => {
    if (event.actionId !== actionId) return false;
    if (event.kind === "npc_dialogue_completed" && event.payload.type === "npc_dialogue_completed") {
      return String(event.payload.npcId) === npcId;
    }
    if (event.kind === "item_given" && event.payload.type === "item_given") {
      return String(event.payload.npcId) === npcId;
    }
    return false;
  });
  return npcMemoryUsed || actionEventUsed;
}

function canEmitNpcQuestSignal(
  ws: WorldState,
  objectiveNpcId: string,
  options: QuestReconcileOptions | undefined,
): boolean {
  const session = options?.talkToNpcSession;
  const context = options?.actionContext;
  if (session === undefined || !session.completed || context === undefined) return false;
  if (session.npcId !== objectiveNpcId || context.participantNpcId !== objectiveNpcId) return false;
  const npc = entitiesOfKind(ws.entityStore, "npc").find((record) => String(record.core.id) === objectiveNpcId);
  if (npc === undefined || npc.core.lifecycle !== "active") return false;
  if (context.actionId.trim() === "" || !Number.isInteger(context.turnNumber) || context.turnNumber < 0) return false;
  return context.actionWasAlreadyUsed === true
    ? false
    : context.actionWasAlreadyUsed === false
      ? true
      : !npcUsedAction(ws, objectiveNpcId, context.actionId);
}

// 应用任务 outcome（只改 worldState，不碰 eventLedger——由 resolveTurn 统一按序追加）。
// Task 2 起任务不再引用预生成实体：
//   - advance_story：幕推进信号（Task 3 世界演化消费），本阶段零世界状态变化；
//   - resolve_story：终幕完成信号，结局由 ending resolver 独立评估，不在此绕过；
//   - closed：由调用方把任务置为 closed。
function applyOutcome(
  ws: WorldState,
  outcome: QuestOutcome,
): { readonly nextWorldState: WorldState; readonly drafts: readonly NarrativeEventDraft[] } {
  switch (outcome.kind) {
    case "advance_story":
      return { nextWorldState: ws, drafts: [] };
    case "resolve_story":
      // 结局由 ending resolver 依据 quest_completed/failed/fact_discovered 独立评估。
      return { nextWorldState: ws, drafts: [] };
    case "closed":
      return { nextWorldState: ws, drafts: [] };
  }
}

export function reconcileQuests(
  ws: WorldState,
  _deps: { readonly now: () => string },
  options?: QuestReconcileOptions,
): QuestReconcileResult {
  const drafts: NarrativeEventDraft[] = [];
  const mutations: EntityMutation[] = [];

  // 1) active 任务：objective 全满足 → 完成 + 应用 onSuccess（advance_story 零世界状态变化）。
  for (const quest of ws.quests) {
    if (quest.status !== "active") continue;
    const allSatisfied = quest.objectives.every((obj) => {
      if (obj.kind === "talk_to_npc"
        && options?.talkToNpcSession !== undefined
        && String(obj.npcId) === options.talkToNpcSession.npcId) {
        return options.talkToNpcSession.completed && isObjectiveSatisfied(ws, obj);
      }
      return isObjectiveSatisfied(ws, obj);
    });
    if (!allSatisfied) continue;

    drafts.push({
      eventKey: `quest_completed:${quest.id}`,
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [PLAYER_ENTITY_ID],
      locationId: ws.currentLocationId,
      causeKeys: [],
      factIds: [],
      questIds: [quest.id],
      outcome: "success",
      salience: 80,
      payload: { type: "quest_completed", questId: quest.id },
    });
    const npcObjective = quest.objectives.find((obj) => {
      if (obj.kind !== "talk_to_npc") return false;
      return canEmitNpcQuestSignal(ws, String(obj.npcId), options);
    });
    if (npcObjective?.kind === "talk_to_npc") {
      const context = options?.actionContext;
      if (context !== undefined) {
        mutations.push({
          kind: "apply_relationship_signal",
          fromNpcId: npcObjective.npcId,
          targetId: PLAYER_ENTITY_ID,
          signal: "kept_promise",
          source: { kind: "action", actionId: context.actionId, turnNumber: context.turnNumber },
        });
      }
    }
    mutations.push({ kind: "set_quest_status", questId: quest.id, status: "completed" });
    const successOutcome = applyOutcome(ws, quest.onSuccess);
    drafts.push(...successOutcome.drafts);
  }

  // 2) failed 任务：应用 onFailure（解锁失败路线或关闭）。onFailure 为 closed 时关闭任务。
  for (const quest of ws.quests) {
    if (quest.status !== "failed") continue;
    const failureOutcome = applyOutcome(ws, quest.onFailure);
    drafts.push(...failureOutcome.drafts);
    if (quest.onFailure.kind === "closed") {
      mutations.push({ kind: "set_quest_status", questId: quest.id, status: "closed" });
    }
  }

  if (mutations.length === 0) return { nextWorldState: ws, drafts };
  const applied = applyEntityMutations(ws, mutations);
  if (!applied.ok) throw new EntityMutationInvariantError(applied);
  return { nextWorldState: applied.worldState, drafts };
}
