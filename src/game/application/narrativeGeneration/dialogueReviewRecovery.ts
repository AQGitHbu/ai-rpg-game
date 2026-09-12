import type { StoredJob } from "../server/persistence/narrativeJobRepository";
import type { AiContentRepair, AiSourceFailure } from "../aiGenerationRetry";
import { validateDialogueReviewVerdict, isReviewProtocolIssue, reviewProtocolDetail,
  type DialogueReviewRequest, type DialogueReviewVerdict, type ReviewProtocolIssue } from "./dialogueReviewChecks";

type Receipt = NonNullable<StoredJob["dialogueConsistencyReview"]>;
export const REVIEW_MAX_REQUESTS = 3;
/** Legacy receipts cannot demonstrate which allowance was spent. Never grant new allowance. */
export function reviewAllowances(receipt?: Receipt): { protocolCorrections: number; contentRepairs: number } {
  return { protocolCorrections: receipt?.protocolCorrections ?? (receipt?.attempts ? 1 : 0),
    contentRepairs: receipt?.contentRepairs ?? (receipt?.attempts ? 1 : 0) };
}
export function prepareReviewAttempt(receipt: Receipt):
  { ok: true; receipt: Receipt; repair?: AiContentRepair } | { ok: false; code: string } {
  const allowances = reviewAllowances(receipt);
  if (receipt.attempts >= REVIEW_MAX_REQUESTS || receipt.lastFailure === "exhausted")
    return { ok: false, code: "dialogue_consistency_review_exhausted" };
  if (receipt.lastFailure === "provider_failure") return { ok: false, code: "AI_CALL_FAILED" };
  if (receipt.lastFailure === "uncertain") return { ok: false, code: "dialogue_consistency_review_uncertain" };
  const content = receipt.lastFailure === "content_recheck" && receipt.status !== "running";
  const correction = receipt.attempts > 0 && !content;
  if (correction && allowances.protocolCorrections >= 1)
    return { ok: false, code: receipt.lastFailure === "protocol_error" ? "dialogue_consistency_review_failed" : "dialogue_consistency_review_exhausted" };
  const issue = receipt.protocolIssue ?? { code: "invalid_schema" as const, path: "$" };
  const repair = receipt.attempts === 0 ? undefined : { attempt: receipt.attempts,
    reason: content ? "dialogue_consistency_content_recheck" : receipt.lastFailure === "protocol_error"
      ? "dialogue_consistency_review_invalid" : "dialogue_consistency_outcome_unknown",
    detail: content ? "content_recheck: affected expressions and their dependencies were regenerated; independently review all current checks against their own contracts."
      : receipt.lastFailure === "protocol_error" ? reviewProtocolDetail(issue)
        : "outcome_unknown: previous request has no reusable result; return complete verdict/violations using this checkId and inquiryId contract." };
  return { ok: true, receipt: { ...receipt, ...allowances, attempts: receipt.attempts + 1,
    protocolCorrections: allowances.protocolCorrections + (correction ? 1 : 0), status: "running", passDigest: undefined,
    lastFailure: correction && receipt.lastFailure !== "protocol_error" ? "outcome_unknown" : receipt.lastFailure },
    ...(repair === undefined ? {} : { repair }) };
}
export type ReviewOutcome = { verdict: DialogueReviewVerdict; failure?: never; issue?: never }
  | { verdict: null; failure: "provider_failure" | "protocol_error"; issue?: ReviewProtocolIssue };
export function reviewOutcome(result: ({ ok: true } & DialogueReviewVerdict) | AiSourceFailure,
  request: DialogueReviewRequest): ReviewOutcome {
  if (!result.ok) {
    if (result.failure.kind === "AI_CALL_FAILED") return { verdict: null, failure: "provider_failure" };
    let issue: ReviewProtocolIssue = { code: "invalid_schema", path: "$" };
    try {
      const detail = JSON.parse(result.repairDetail ?? "null");
      const candidate = detail === null ? null : { code: detail.code, path: detail.path };
      if (isReviewProtocolIssue(candidate)) issue = candidate;
    } catch { /* Arbitrary adapter detail is never forwarded. */ }
    return { verdict: null, failure: "protocol_error", issue };
  }
  const parsed = validateDialogueReviewVerdict({ verdict: result.verdict, violations: result.violations }, request);
  return parsed.ok ? { verdict: parsed.value } : { verdict: null, failure: "protocol_error", issue: parsed.issue };
}
