import { performTurn } from "./performTurn";
import type { PerformTurnCommand, PerformTurnDeps, PerformTurnResult } from "./performTurn";

// ---------------------------------------------------------------------------
// 兼容壳（Task 4）：performActionV2 只是 performTurn 的 thin adapter。
// action conversion、rule resolution、pending job 构造、单次 CAS commit 全部
// 集中在 performTurn；本文件仅保留旧导出类型与函数签名，避免入口层大范围破坏。
// ---------------------------------------------------------------------------

export type PerformActionV2Command = PerformTurnCommand;

export type PerformActionV2Result = PerformTurnResult;

export type PerformActionV2Deps = PerformTurnDeps;

export async function performActionV2(
  command: PerformActionV2Command,
  deps: PerformActionV2Deps,
): Promise<PerformActionV2Result> {
  return performTurn(command, deps);
}