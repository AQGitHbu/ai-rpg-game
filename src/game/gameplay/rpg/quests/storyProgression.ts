import type { GameState, ScenarioBlueprint } from "@/game/domain";
import type { ReconcileQuestsDependencies } from "./reconcileQuests";

// ---------------------------------------------------------------------------
// Phase 14 Task 8：主线幕数追踪（结局推演机制 §结局推演机制）。
//
// 纯函数：从 blueprint.quests（kind==="main"）与 state.quests 的状态交集
// 派生 currentAct（已完成/关闭的主线任务数量），并据此判断是否应让导演
// 提议结局（currentAct >= endingDirection.lockedAt 且尚未提议过结局）。
// 不修改输入、不读 IO、不调用随机源；deps 现仅保留为签名扩展占位
// （未来若 fallback 需时间戳可在此处注入），当前统计逻辑不依赖 deps。
// ---------------------------------------------------------------------------

export type ReconcileMainStoryProgressResult = {
  readonly currentAct: number;
  readonly shouldProposeEnding: boolean;
};

/**
 * 统计已完成/关闭的主线任务数量并判断是否应提议结局。
 *
 * currentAct 派生：blueprint.quests 中 kind==="main" 的任务，在 state.quests
 * 中对应状态为 "completed" 或 "closed" 的数量。failed/active/locked 不计入。
 * shouldProposeEnding：currentAct >= endingDirection.lockedAt 且
 * state.mainStoryProgress.endingProposed === false 时为 true。
 */
export function reconcileMainStoryProgress(
  blueprint: ScenarioBlueprint,
  state: GameState,
  // deps 保留以与 spec 签名对齐；当前统计逻辑不读取它（无时间戳/随机源依赖）。
  _deps: ReconcileQuestsDependencies,
): ReconcileMainStoryProgressResult {
  const mainQuestIds = new Set(
    blueprint.quests
      .filter((q) => q.kind === "main")
      .map((q) => String(q.id)),
  );
  let currentAct = 0;
  for (const sq of state.quests) {
    if (!mainQuestIds.has(String(sq.questId))) continue;
    if (sq.status === "completed" || sq.status === "closed") {
      currentAct += 1;
    }
  }
  const lockedAt = blueprint.endingDirection.lockedAt;
  const shouldProposeEnding =
    currentAct >= lockedAt && !state.mainStoryProgress.endingProposed;
  return { currentAct, shouldProposeEnding };
}
