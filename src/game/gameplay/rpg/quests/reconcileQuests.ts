import type {
  GameEvent,
  GameState,
  QuestObjective,
  ScenarioBlueprint
} from "@/game/domain";

// ---------------------------------------------------------------------------
// 纯任务 reconciliation（Phase 4 Task 2）。
//
// 输入 compiled blueprint + 行动 resolver 产出的 next GameState，输出任务状态
// 核验后的下一份不可变 state 与新增任务事件。objective 是状态事实的读取条件：
//   - visit_location 读 GameState.visitedLocationIds（含开场地点）；
//   - talk_to_npc    读 NpcRuntimeState.met；
//   - discover_fact  读 WorldFactState.discovered；
//   - obtain_item / defeat_enemy 在 Phase 4 未支持，永不满足（不得绕过完成）。
// 只有 active 任务的全部 objective 满足时才完成；完成时按序应用 onSuccess：
//   - unlock_quests：仍为 locked 的目标置为 active 并追加 quest_unlocked 事件；
//   - closed：任务标记为 closed（完成即关闭，无后续解锁）；
//   - reach_ending：保留为未支持路径，仅标记 completed，绝不伪造结局。
// 被解锁的任务在同一次 reconciliation 内继续核验（objective 只读已发生的
// 状态事实），直到没有新的状态迁移；无迁移时原样返回输入 state（幂等）。
// 不依赖 application、repository、UI、Date、Math.random 或 AI。
// ---------------------------------------------------------------------------

export type ReconcileQuestsDependencies = {
  /** ISO 8601 时间戳：由 application 层注入，domain 不读时钟。 */
  readonly now: () => string;
};

export type ReconcileQuestsResult = {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
};

/** objective 是否已被状态事实满足；未支持类型永远返回 false。 */
function isObjectiveSatisfied(state: GameState, objective: QuestObjective): boolean {
  switch (objective.kind) {
    case "visit_location":
      return state.visitedLocationIds.includes(objective.locationId);
    case "talk_to_npc":
      return state.npcs.some((npc) => npc.npcId === objective.npcId && npc.met);
    case "discover_fact":
      return state.worldFacts.some((fact) => fact.factId === objective.factId && fact.discovered);
    case "obtain_item":
    case "defeat_enemy":
      return false;
  }
}

export function reconcileQuests(
  blueprint: ScenarioBlueprint,
  state: GameState,
  deps: ReconcileQuestsDependencies,
): ReconcileQuestsResult {
  const occurredAt = deps.now();
  const statusById = new Map(state.quests.map((quest) => [quest.questId, quest.status]));
  const events: GameEvent[] = [];

  // 固定点迭代：每轮按蓝图任务顺序扫描（compile 后按 id 稳定排序），
  // 完成的任务不会回到 active，因此最多迭代任务总数轮，结果确定。
  let changed = true;
  while (changed) {
    changed = false;
    for (const quest of blueprint.quests) {
      if (statusById.get(quest.id) !== "active") continue;
      if (!quest.objectives.every((objective) => isObjectiveSatisfied(state, objective))) continue;

      // closed outcome：完成即关闭，无后续解锁；unlock_quests / reach_ending 标记 completed。
      statusById.set(quest.id, quest.onSuccess.kind === "closed" ? "closed" : "completed");
      events.push({ type: "quest_completed", questId: quest.id, occurredAt });
      if (quest.onSuccess.kind === "unlock_quests") {
        for (const targetId of quest.onSuccess.questIds) {
          if (statusById.get(targetId) === "locked") {
            statusById.set(targetId, "active");
            events.push({ type: "quest_unlocked", questId: targetId, occurredAt });
          }
        }
      }
      // reach_ending：结局判定在 Phase 4 之外，这里不追加任何结局事实。
      changed = true;
    }
  }

  if (events.length === 0) {
    return { state, events: [] };
  }

  return {
    state: {
      ...state,
      quests: state.quests.map((quest) => {
        const status = statusById.get(quest.questId) ?? quest.status;
        return status === quest.status ? quest : { ...quest, status };
      }),
      eventLedger: [...state.eventLedger, ...events],
    },
    events,
  };
}
