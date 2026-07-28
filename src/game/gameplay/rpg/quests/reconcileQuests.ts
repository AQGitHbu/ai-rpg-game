import type {
  GameEvent,
  GameState,
  QuestId,
  QuestObjective,
  ScenarioBlueprint
} from "@/game/domain";

// ---------------------------------------------------------------------------
// 纯任务 reconciliation（Phase 4 Task 2，Phase 6 扩展 defeat_enemy + failQuest）。
//
// 输入 compiled blueprint + 行动 resolver 产出的 next GameState，输出任务状态
// 核验后的下一份不可变 state 与新增任务事件。objective 是状态事实的读取条件：
//   - visit_location 读 GameState.visitedLocationIds（含开场地点）；
//   - talk_to_npc    读 NpcRuntimeState.met；
//   - discover_fact  读 WorldFactState.discovered；
//   - obtain_item    读 GameState.inventory（Phase 5 支持）；
//   - defeat_enemy   读 GameState.defeatedEnemyIds（Phase 6 支持）。
// 只有 active 任务的全部 objective 满足时才完成；完成时按序应用 onSuccess：
//   - unlock_quests：仍为 locked 的目标置为 active 并追加 quest_unlocked 事件；
//   - closed：任务标记为 closed（完成即关闭，无后续解锁）；
//   - reach_ending：保留为未支持路径，仅标记 completed，绝不伪造结局。
// 被解锁的任务在同一次 reconciliation 内继续核验（objective 只读已发生的
// 状态事实），直到没有新的状态迁移；无迁移时原样返回输入 state（幂等）。
// Phase 6 新增 failQuest 纯入口：将 active quest 置为 failed 并仅应用 onFailure。
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

/** objective 是否已被状态事实满足；未支持类型永远返回 false。read model 投影复用。 */
export function isQuestObjectiveSatisfied(state: GameState, objective: QuestObjective): boolean {
  switch (objective.kind) {
    case "visit_location":
      return state.visitedLocationIds.includes(objective.locationId);
    case "talk_to_npc":
      return state.npcs.some((npc) => npc.npcId === objective.npcId && npc.met);
    case "discover_fact":
      return state.worldFacts.some((fact) => fact.factId === objective.factId && fact.discovered);
    case "obtain_item":
      return state.inventory.includes(objective.itemId);
    case "defeat_enemy":
      // Phase 6：读 defeatedEnemyIds。
      return state.defeatedEnemyIds.includes(objective.enemyId);
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
      if (!quest.objectives.every((objective) => isQuestObjectiveSatisfied(state, objective))) continue;

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
        // statusById 由 state.quests 全量构建，每个 questId 必命中。
        const status = statusById.get(quest.questId)!;
        return status === quest.status ? quest : { ...quest, status };
      }),
      eventLedger: [...state.eventLedger, ...events],
    },
    events,
  };
}

// ---------------------------------------------------------------------------
// Phase 6：显式任务失败入口。
//
// 将当前 active quest 置为 failed 并仅应用 onFailure：
//   - unlock_quests：仍为 locked 的目标置为 active 并追加 quest_unlocked 事件；
//   - closed / reach_ending：仅标记 failed，不伪造结局。
// 严格限制：只能失败 active quest，不能把失败当 completed 或对非 active quest 操作。
// 纯函数：不修改输入 state，不依赖 application/repository/UI/Date/Math.random/AI。
// ---------------------------------------------------------------------------

export type FailQuestCode = "QUEST_NOT_FOUND" | "QUEST_NOT_ACTIVE";

export type FailQuestResult = {
  readonly ok: true;
  readonly state: GameState;
  readonly events: readonly GameEvent[];
} | {
  readonly ok: false;
  readonly code: FailQuestCode;
};

export function failQuest(
  blueprint: ScenarioBlueprint,
  state: GameState,
  questId: QuestId,
  deps: ReconcileQuestsDependencies,
): FailQuestResult {
  const quest = blueprint.quests.find((q) => q.id === questId);
  if (quest === undefined) {
    return { ok: false, code: "QUEST_NOT_FOUND" };
  }
  const questState = state.quests.find((qs) => qs.questId === questId);
  if (questState === undefined || questState.status !== "active") {
    return { ok: false, code: "QUEST_NOT_ACTIVE" };
  }

  const occurredAt = deps.now();
  const events: GameEvent[] = [{ type: "quest_failed", questId, occurredAt }];

  const statusById = new Map(state.quests.map((qs) => [qs.questId, qs.status]));
  statusById.set(questId, "failed");

  if (quest.onFailure.kind === "unlock_quests") {
    for (const targetId of quest.onFailure.questIds) {
      if (statusById.get(targetId) === "locked") {
        statusById.set(targetId, "active");
        events.push({ type: "quest_unlocked", questId: targetId, occurredAt });
      }
    }
  }
  // reach_ending / closed：结局判定在 ending resolver 中处理，这里不追加任何结局事实。

  return {
    ok: true,
    state: {
      ...state,
      quests: state.quests.map((qs) => {
        const status = statusById.get(qs.questId)!;
        return status === qs.status ? qs : { ...qs, status };
      }),
      eventLedger: [...state.eventLedger, ...events],
    },
    events,
  };
}
