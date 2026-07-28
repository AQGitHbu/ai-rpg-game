// ---------------------------------------------------------------------------
// quests facade（Phase 4 Task 2，Phase 6 扩展 failQuest + resolveEnding）：
// application 可用的唯一 quests 入口。
// application 不能 deep import quests 内部文件。
// ---------------------------------------------------------------------------

export {
  isQuestObjectiveSatisfied,
  reconcileQuests,
  failQuest,
  type ReconcileQuestsDependencies,
  type ReconcileQuestsResult,
  type FailQuestCode,
  type FailQuestResult,
} from "./reconcileQuests";

export {
  resolveEnding,
  type ResolveEndingDependencies,
  type ResolveEndingResult,
} from "./resolveEnding";
