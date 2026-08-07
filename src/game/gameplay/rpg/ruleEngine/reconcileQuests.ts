import type { WorldState } from "@/game/domain/worldState";
import type { GameEvent } from "@/game/domain/events";
import type { QuestId } from "@/game/domain/scenarioBlueprint";
import { asQuestId } from "@/game/domain/scenarioBlueprint";

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

export function reconcileQuests(ws: WorldState, deps: { readonly now: () => string }): QuestReconcileResult {
  const events: GameEvent[] = [];
  let nextQuests = ws.quests;

  for (const quest of ws.quests) {
    if (quest.status !== "active") continue;
    const allSatisfied = quest.objectives.every((obj) => isObjectiveSatisfied(ws, obj));
    if (allSatisfied) {
      const event: GameEvent = { type: "quest_completed", questId: quest.id, occurredAt: deps.now() };
      events.push(event);
      nextQuests = nextQuests.map((q) =>
        q.id === quest.id ? { ...q, status: "completed" as const } : q,
      );
    }
  }

  return {
    nextWorldState: events.length > 0
      ? { ...ws, quests: nextQuests, eventLedger: [...ws.eventLedger, ...events] }
      : ws,
    events,
  };
}
