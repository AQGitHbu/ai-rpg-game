// 有界预算（Plan 2026-09-09 / Task 8 Step 4）。
//
// 固定决策数值：单单元最多 4 次 provider 尝试；每 job 在 baseline
// （1 次规划 + 必需表达数 + 1 次最终整包保真审核）之外最多 12 次额外请求；deadline 由任务
// 持久化字段给定。最坏单元数与关键路径容纳性在规划审批检查。

import type { ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import { shouldReviewDialogueConsistency } from "./dialogueConsistencyReview";
import { fail, type Check } from "@/game/domain/narrativeUnit";
import type { StoredJob } from "../server/persistence/narrativeJobRepository";

export function baselineRequestsForPlan(plan: ApprovedPlan): number {
  return 1 + plan.units.length + (shouldReviewDialogueConsistency(plan) ? 1 : 0);
}

export const JOB_BUDGET = {
  /** 单单元最多 provider 尝试次数（含失败重试）。 */
  maxUnitAttempts: 4,
  /** baseline 之外每 job 最多额外请求数。 */
  extraRequests: 12,
} as const;

export type CanStartRequestInput = Readonly<{
  job: StoredJob;
  unitAttempts: number;
  now: string;
}>;

/** 发起 provider 请求前的预算检查：deadline、job 额度、单元尝试额度。 */
export function canStartRequest(input: CanStartRequestInput): Check<true> {
  if (input.now >= input.job.deadline) return fail("job_deadline_exceeded");
  if (input.job.usedRequests >= input.job.baselineRequests + JOB_BUDGET.extraRequests) {
    return fail("job_budget_exhausted");
  }
  if (input.unitAttempts >= JOB_BUDGET.maxUnitAttempts) {
    return fail("unit_attempts_exhausted");
  }
  return { ok: true, value: true };
}
