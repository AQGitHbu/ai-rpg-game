import type { AiFailurePhase, AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
import { isSafeNarrativeGenerationRepairReason, type NarrativeGenerationRepairReason } from "@/game/domain/narrativeGenerationFailure";
import { classifyAiFailure, type AiFailureCategory } from "./aiGenerationFailure";
import type { AiRetryContext } from "./server/ai/textAuditTypes";

/** Shared source failure contract. Only server-authored codes/details belong here. */
export type AiSourceFailure<Reason extends string = string> = {
  readonly ok: false;
  readonly failure: AiGenerationFailure;
  readonly repairReason?: Reason;
  readonly repairDetail?: string;
};

export type AiContentRepair<Reason extends string = string, Rejection extends string = string> = {
  readonly attempt: number;
  readonly reason: Reason;
  readonly rejectionCode?: Rejection;
  readonly detail?: string;
};

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

/** Persist only bounded stable codes, never model text or entity-name details. */
export function persistedAiRepairReason(repair: AiContentRepair): NarrativeGenerationRepairReason {
  const code = repair.rejectionCode === undefined ? repair.reason : `approval:${repair.rejectionCode}`;
  const detailed = repair.detail !== undefined && /^[a-z][a-z0-9_]*$/.test(repair.detail)
    ? `${code}:${repair.detail}`
    : code;
  if (isSafeNarrativeGenerationRepairReason(detailed)) return detailed;
  return isSafeNarrativeGenerationRepairReason(code) ? code : "invalid_schema";
}
