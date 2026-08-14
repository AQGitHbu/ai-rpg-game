import type { WorldState, QuestOutcome } from "@/game/domain/worldState";
import type { GameEvent } from "@/game/domain/events";
import { isObjectiveSatisfied } from "@/game/gameplay/rpg/narrativeContext/objectiveRules";

export type QuestReconcileResult = {
  readonly nextWorldState: WorldState;
  readonly events: readonly GameEvent[];
};

// 应用任务 outcome（只改 worldState，不碰 eventLedger——由 resolveTurn 统一按序追加）。
// Task 2 起任务不再引用预生成实体：
//   - advance_story：幕推进信号（Task 3 世界演化消费），本阶段零世界状态变化；
//   - resolve_story：终幕完成信号，结局由 ending resolver 独立评估，不在此绕过；
//   - closed：由调用方把任务置为 closed。
function applyOutcome(
  ws: WorldState,
  outcome: QuestOutcome,
  now: string,
): { readonly nextWorldState: WorldState; readonly events: readonly GameEvent[] } {
  switch (outcome.kind) {
    case "advance_story":
      return { nextWorldState: ws, events: [] };
    case "resolve_story":
      // 结局由 ending resolver 依据 quest_completed/failed/fact_discovered 独立评估。
      return { nextWorldState: ws, events: [] };
    case "closed":
      return { nextWorldState: ws, events: [] };
  }
}

export function reconcileQuests(ws: WorldState, deps: { readonly now: () => string }): QuestReconcileResult {
  const events: GameEvent[] = [];
  let nextWorldState: WorldState = ws;

  // 1) active 任务：objective 全满足 → 完成 + 应用 onSuccess（advance_story 零世界状态变化）。
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
