import type { WorldState, QuestOutcome } from "@/game/domain/worldState";
import type { GameEvent } from "@/game/domain/events";

export type QuestReconcileResult = {
  readonly nextWorldState: WorldState;
  readonly events: readonly GameEvent[];
};

function isObjectiveSatisfied(ws: WorldState, objective: WorldState["quests"][number]["objectives"][number]): boolean {
  switch (objective.kind) {
    case "visit_location": return ws.visitedLocationIds.includes(objective.locationId);
    case "talk_to_npc": return ws.npcs.find((n) => n.id === objective.npcId)?.met ?? false;
    case "obtain_item": return ws.inventory.includes(objective.itemId);
    case "discover_fact": return ws.worldFacts.find((f) => f.factId === objective.factId)?.discovered ?? false;
    case "defeat_enemy": return ws.defeatedEnemyIds.includes(objective.enemyId);
  }
}

// 应用任务 outcome（只改 worldState，不碰 eventLedger——由 resolveTurn 统一按序追加）。
//   - unlock_quests：解锁 locked 任务（→active）与 locked 地点，产出 quest_unlocked/location_unlocked；
//   - reach_ending：只保持完成状态，结局由 ending resolver 独立评估，不在此绕过；
//   - closed：由调用方把任务置为 closed。
function applyOutcome(
  ws: WorldState,
  outcome: QuestOutcome,
  now: string,
): { readonly nextWorldState: WorldState; readonly events: readonly GameEvent[] } {
  switch (outcome.kind) {
    case "unlock_quests": {
      const questEvents: GameEvent[] = [];
      let nextQuests = ws.quests;
      for (const questId of outcome.questIds) {
        const target = nextQuests.find((q) => q.id === questId);
        if (target && target.status === "locked") {
          nextQuests = nextQuests.map((q) =>
            q.id === questId ? { ...q, status: "active" as const } : q,
          );
          questEvents.push({ type: "quest_unlocked", questId, occurredAt: now });
        }
      }

      const locEvents: GameEvent[] = [];
      let unlockedLocationIds = ws.unlockedLocationIds;
      for (const locationId of outcome.locationIds ?? []) {
        if (!unlockedLocationIds.includes(locationId)) {
          unlockedLocationIds = [...unlockedLocationIds, locationId];
          locEvents.push({ type: "location_unlocked", locationId, occurredAt: now });
        }
      }

      if (questEvents.length === 0 && locEvents.length === 0) {
        return { nextWorldState: ws, events: [] };
      }
      return {
        nextWorldState: { ...ws, quests: nextQuests, unlockedLocationIds },
        events: [...questEvents, ...locEvents],
      };
    }
    case "reach_ending":
      // 结局由 ending resolver 依据 quest_completed/failed/fact_discovered 独立评估。
      return { nextWorldState: ws, events: [] };
    case "closed":
      return { nextWorldState: ws, events: [] };
  }
}

export function reconcileQuests(ws: WorldState, deps: { readonly now: () => string }): QuestReconcileResult {
  const events: GameEvent[] = [];
  let nextWorldState: WorldState = ws;

  // 1) active 任务：objective 全满足 → 完成 + 应用 onSuccess（unlock_quests 解锁后续任务/地点）。
  for (const quest of ws.quests) {
    if (quest.status !== "active") continue;
    const allSatisfied = quest.objectives.every((obj) => isObjectiveSatisfied(ws, obj));
    if (!allSatisfied) continue;

    events.push({ type: "quest_completed", questId: quest.id, occurredAt: deps.now() });
    nextWorldState = {
      ...nextWorldState,
      quests: nextWorldState.quests.map((q) =>
        q.id === quest.id ? { ...q, status: "completed" as const } : q,
      ),
    };
    const successOutcome = applyOutcome(nextWorldState, quest.onSuccess, deps.now());
    nextWorldState = successOutcome.nextWorldState;
    events.push(...successOutcome.events);
  }

  // 2) failed 任务：应用 onFailure（解锁失败路线或关闭）。onFailure 为 closed 时关闭任务。
  for (const quest of ws.quests) {
    if (quest.status !== "failed") continue;
    const failureOutcome = applyOutcome(nextWorldState, quest.onFailure, deps.now());
    nextWorldState = failureOutcome.nextWorldState;
    events.push(...failureOutcome.events);
    if (quest.onFailure.kind === "closed") {
      nextWorldState = {
        ...nextWorldState,
        quests: nextWorldState.quests.map((q) =>
          q.id === quest.id ? { ...q, status: "closed" as const } : q,
        ),
      };
    }
  }

  return { nextWorldState, events };
}
