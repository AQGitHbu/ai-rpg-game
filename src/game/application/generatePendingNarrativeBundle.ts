// 决策整包生成的对外编排（Plan 2026-09-09 / Task 10 Step 3）。
//
// 本模块是「后台 ensure 的执行体」，不再自己跑 provider 循环：它把已提交的
// provider_pending 任务委托给 staged 决策编排（decisionJob）的完整租约作用域
// 一次完成 —— startDecisionJob（幂等补建 durable 任务）→ runDecision
// （claim → runJob 有界 DAG → 装配审批 → publishJob 原子发布 → release）。
//
// 与旧实现的区别（防重试乘法）：
//   - 旧：「单个 provider 请求 × 四次完整包循环」——每次修复都重跑整包。
//   - 新：规划 1 次 + 每表达单元各有界修复，重试不再成倍放大调用。
//   - 旧：本函数在内存里拼装 world/story 后 applyState；新：由仓储的原子
//     publish 在同一 write transaction 内写游戏状态并标记任务已发布。
//
// decision start 与 provider_pending 的关联不会「一个提交成功而另一个永久
// 丢失」：startDecisionJob 从已提交的 pending job 幂等补建任务，不提前调用 provider。

import type { GameRepository } from "./server/persistence/gameRepository";
import type { NarrativeJobRepository } from "./server/persistence/narrativeJobRepository";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import type { GameLogger } from "@/game/logging";
import type { AiFailureKind } from "@/game/domain/narrativeGenerationFailure";
import { startDecisionJob, runDecision } from "./narrativeGeneration/decisionJob";
import type { StageSource } from "./narrativeGeneration/stageSource";
import { markNarrativeGenerationFailed } from "./markNarrativeGenerationFailed";
import { persistedAiRepairReason } from "./aiGenerationRetry";

export type GeneratePendingNarrativeBundleResult =
  | { readonly ok: true; readonly revision: number }
  | {
      readonly ok: false;
      readonly code: "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "NOT_PENDING" | "AI_CALL_FAILED" | "AI_RESPONSE_INVALID" | "INFRASTRUCTURE_FAILURE";
      readonly failureKind?: AiFailureKind;
    };

export type GeneratePendingNarrativeBundleDeps = {
  readonly repository: GameRepository;
  readonly jobs: NarrativeJobRepository;
  readonly source: StageSource;
  readonly now: () => string;
  readonly logger?: GameLogger;
  readonly auditLink?: AiTextAuditLink;
};

/**
 * 失败码 → 对外稳定码的收敛：staged 编排返回的规则/单元失败码统一映射到
 * AI_GENERATION_FAILED 语义（AI_RESPONSE_INVALID），基础设施码原样保留。
 */
function mapFailureCode(code: string): { code: GeneratePendingNarrativeBundleResult extends { ok: false; code: infer C } ? C : never; failureKind?: AiFailureKind } {
  if (code === "JOB_NOT_FOUND" || code === "JOB_CONFLICT" || code === "UNSUPPORTED_JOB" || code === "JOB_ABORTED") {
    return { code: "INFRASTRUCTURE_FAILURE" as never };
  }
  if (code === "AI_CALL_FAILED") {
    return { code: "AI_CALL_FAILED" as never, failureKind: "AI_CALL_FAILED" };
  }
  // 租约/并发冲突：任务仍在 pending，下一次 ensure 会重试。
  return { code: "AI_RESPONSE_INVALID" as never, failureKind: "AI_RESPONSE_INVALID" };
}

export async function generatePendingNarrativeBundle(
  deps: GeneratePendingNarrativeBundleDeps,
): Promise<GeneratePendingNarrativeBundleResult> {
  const current = await deps.repository.getCurrentGame();
  if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  if (current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME" };

  const narrative = current.record.storyState.narrative;
  if (narrative.status !== "provider_pending") return { ok: false, code: "NOT_PENDING" };

  // 从已提交的 pending job 幂等补建 durable 决策任务（同 jobId 复用）。
  const started = await startDecisionJob({ record: current.record, now: deps.now }, deps.jobs);
  if (!started.ok) {
    if (started.code === "NOT_PENDING") return { ok: false, code: "NOT_PENDING" };
    const mapped = mapFailureCode(started.code);
    return { ok: false, code: mapped.code, ...(mapped.failureKind === undefined ? {} : { failureKind: mapped.failureKind }) };
  }

  // 已发布（重复 ensure / 幂等补建命中已发布任务）：直接返回成功。
  if (started.job.status === "published") {
    return { ok: true, revision: current.record.revision };
  }

  // 游戏侧显式 failed→pending 已保留同 job 身份；同时恢复 durable 任务周期。
  // 普通 ensure 不允许重置失败预算，避免后台无限自动重试。
  if (started.job.status === "failed" && narrative.retryContext !== undefined) {
    const resumed = await deps.jobs.control({ id: started.job.id, expectedVersion: started.job.version,
      expectedCycle: started.job.cycle, operation: "retry", now: deps.now() });
    if (!resumed.ok) {
      // 另一 worker 已恢复同周期时可继续走 claim/fence；其他状态不猜测。
      const latest = resumed.code === "JOB_CONFLICT" ? await deps.jobs.get(started.job.id) : null;
      if (latest?.ok !== true || latest.value.status !== "pending") {
        return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      }
    }
  }

  const ran = await runDecision(started.job.id, `decision-worker:${crypto.randomUUID()}`, {
    jobs: deps.jobs,
    source: deps.source,
    now: deps.now,
    signal: new AbortController().signal,
    createdAt: deps.now(),
  });
  if (!ran.ok) {
    if (["JOB_CONFLICT", "LEASE_LOST", "JOB_ABORTED"].includes(ran.code)) {
      return { ok: false, code: "NOT_PENDING" };
    }
    deps.logger?.warn("narrative_bundle_generation_failed", { code: ran.code });
    const mapped = mapFailureCode(ran.code);
    // 失败必须落成 game 状态的 provider_failed：否则手动重试读不到失败原因，
    // ensure 轮询也永远停在 provider_pending。CAS 不递增 revision，任务身份
    // 与已铸造 token 保持不变，可经 retryNarrativeGeneration 重新入队。
    await markNarrativeGenerationFailed(deps.repository, current.record, {
      kind: mapped.failureKind ?? "AI_RESPONSE_INVALID",
      reason: ran.code === "AI_CALL_FAILED" ? "provider_failure"
        : persistedAiRepairReason({ attempt: 1, reason: ran.code }),
      phase: "scene",
      failedAt: deps.now(),
    }).catch(() => undefined);
    return { ok: false, code: mapped.code, ...(mapped.failureKind === undefined ? {} : { failureKind: mapped.failureKind }) };
  }

  // publish 已把游戏状态写入并递增 revision；返回发布后的权威 revision。
  const published = await deps.repository.getCurrentGame();
  if (!published.ok || published.status !== "active") {
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  }
  return { ok: true, revision: published.record.revision };
}
