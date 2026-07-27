// ---------------------------------------------------------------------------
// quests facade（Phase 4 Task 2）：application 可用的唯一 quests 入口。
// application 不能 deep import quests 内部文件。
// ---------------------------------------------------------------------------

export {
  isQuestObjectiveSatisfied,
  reconcileQuests,
  type ReconcileQuestsDependencies,
  type ReconcileQuestsResult,
} from "./reconcileQuests";
