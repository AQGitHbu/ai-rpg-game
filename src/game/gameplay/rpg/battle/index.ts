// ---------------------------------------------------------------------------
// battle facade（Phase 6 Task 2）：application 可用的唯一 battle 入口。
// application 不能 deep import battle 内部文件。
// 只依赖 domain，不依赖 application/repository/UI/Date(Math.random)/AI。
// ---------------------------------------------------------------------------

export {
  startBattle,
  type StartBattleResult,
  type BattleFeedback,
  type BattleValidationCode,
  type BattleResolveDependencies,
} from "./startBattle";

export {
  battleAction,
  type BattleActionResult,
  type BattleAction,
} from "./battleAction";
