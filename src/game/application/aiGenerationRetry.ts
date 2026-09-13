import type { AiFailurePhase, AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
import { isSafeNarrativeGenerationRepairReason, type NarrativeGenerationRepairReason } from "@/game/domain/narrativeGenerationFailure";
import { NARRATIVE_BUNDLE_PROPOSAL_REJECTION_REASONS } from "@/game/domain/narrativeBundle";
import { classifyAiFailure, type AiFailureCategory } from "./aiGenerationFailure";
import type { AiRetryContext } from "./server/ai/textAuditTypes";

/** Shared source failure contract. Only server-authored codes/details belong here. */
export type AiSourceFailure<Reason extends string = string> = {
  readonly ok: false;
  readonly failure: AiGenerationFailure;
  readonly repairReason?: Reason;
  readonly repairDetail?: string;
};

/**
 * 单次内容修复提示。attempt 在一次生成循环内逐次递增；手动重试的首次
 * 修复从 retryContext.attempt 开始。累计序号不持久化，多次手动重试不连续计数。
 */
export type AiContentRepair<Reason extends string = string, Rejection extends string = string> = {
  readonly attempt: number;
  readonly reason: Reason;
  readonly rejectionCode?: Rejection;
  readonly detail?: string;
};

/** Convert semantic review findings into bounded content-repair feedback. */
export function repairFromCandidateReview(
  defects: readonly Readonly<{ readonly code: string; readonly path: string; readonly reason: string; readonly evidence?: { readonly basisKey: string; readonly impact: string; readonly detail: string } }>[],
  attempt: number,
): AiContentRepair<"approval_rejected", never> {
  if (!Number.isInteger(attempt) || attempt < 1 || defects.length === 0) {
    throw new RangeError("candidate review requires a non-empty defect list and a positive attempt");
  }
  return {
    attempt,
    reason: "approval_rejected",
    detail: defects.map((defect) => {
      const evidence = defect.evidence === undefined ? ""
        : ` [${defect.evidence.basisKey}/${defect.evidence.impact}: ${defect.evidence.detail}]`;
      return `${defect.code}:${defect.path}:${defect.reason}${evidence}`;
    }).join(" | "),
  };
}

export function createAiSourceFailure<Reason extends string = string>(
  phase: AiFailurePhase,
  category: AiFailureCategory,
  repairReason?: Reason,
  repairDetail?: string,
): AiSourceFailure<Reason> {
  return {
    ok: false,
    failure: classifyAiFailure({ phase, category }),
    ...(repairReason === undefined ? {} : { repairReason }),
    ...(repairDetail === undefined ? {} : { repairDetail }),
  };
}

/** Every retried source failure has feedback, including old/injected sources. */
export function repairFromSourceFailure<Reason extends string>(
  result: AiSourceFailure<Reason>,
  attempt: number,
): AiContentRepair<Reason | "provider_failure" | "invalid_schema", never> {
  return {
    attempt,
    reason: result.repairReason ?? (result.failure.kind === "AI_CALL_FAILED" ? "provider_failure" : "invalid_schema"),
    ...(result.repairDetail === undefined ? {} : { detail: result.repairDetail }),
  };
}

export function aiRepairAuditContext(
  repair: AiContentRepair,
  previous?: AiRetryContext,
): AiRetryContext {
  return {
    origin: previous?.origin ?? "normal",
    mechanism: "content_repair",
    attempt: repair.attempt,
    reason: repair.rejectionCode === undefined ? repair.reason : `${repair.reason}:${repair.rejectionCode}`,
  };
}

/** One feedback envelope for every content prompt; domain hints may follow it. */
export function renderAiRepairFeedback(repair: AiContentRepair | undefined): string {
  if (repair === undefined) return "";
  return [
    "上一轮生成未完成。以下是服务端校验反馈，请遵循原输出契约重新返回完整结果。",
    `修复序号=${repair.attempt}；原因=${repair.reason}`,
    ...(repair.rejectionCode === undefined ? [] : [`拒绝码=${repair.rejectionCode}`]),
    ...(repair.detail === undefined ? [] : [`细分原因=${repair.detail}`]),
  ].join("\n");
}

/**
 * 允许以 `reason:detail` 形态随原因码一起持久化的服务端稳定细分码。
 * 码表之外的一切 detail（模型自造 ID、实体 ID、审批自由文本、未知码）
 * 一律只保留顶层原因码，防止格式恰好像码的自由文本穿透持久化。
 * transport 码清单对应 @ai-game/ai-transport 的 AiTransportFailureCode；
 * 提案解析拒绝码由 domain 的运行时清单派生。
 */
const PERSISTED_REPAIR_DETAIL_CODES: ReadonlySet<string> = new Set([
  // 编排层稳定细分码
  "source_exception",
  "unexpected_source_kind",
  "world_delta_invalid",
  "context_budget_exceeded",
  "event_commit_failed",
  // transport 层稳定失败码（AiTransportFailureCode）
  "invalid_config",
  "aborted",
  "timeout",
  "rate_limited",
  "http_error",
  "service_error",
  "network_error",
  "invalid_response",
  "empty_response",
  // 决策叙事包提案解析拒绝码
  ...NARRATIVE_BUNDLE_PROPOSAL_REJECTION_REASONS,
]);

/** Persist only allowlisted stable codes, never model text or entity-name details. */
export function persistedAiRepairReason(repair: AiContentRepair): NarrativeGenerationRepairReason {
  const code = repair.rejectionCode === undefined ? repair.reason : `approval:${repair.rejectionCode}`;
  const detailed = repair.detail !== undefined && PERSISTED_REPAIR_DETAIL_CODES.has(repair.detail)
    ? `${code}:${repair.detail}`
    : code;
  if (isSafeNarrativeGenerationRepairReason(detailed)) return detailed;
  return isSafeNarrativeGenerationRepairReason(code) ? code : "invalid_schema";
}
