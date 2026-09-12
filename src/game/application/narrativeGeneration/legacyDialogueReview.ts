// Read-only historical receipt schema. No generation or review execution.
import { INQUIRY_ASPECTS, type InquiryAspect } from "@/game/domain/expressionTask";
import { isReviewProtocolIssue } from "./dialogueReviewChecks";
export type DialogueViolation = Readonly<{
  scope: "expression" | "planning" | "legacy";
  unitKey?: string;
  candidateId?: string;
  type: "extra_inquiry" | "missing_response" | "answer_mismatch" | "intent_mismatch";
  aspect: InquiryAspect | null;
  factId?: string;
}>;
export type DialogueConsistencyVerdict = Readonly<{
  verdict: "pass" | "reject" | "uncertain";
  violations: readonly DialogueViolation[];
}>;
/** Storage compatibility only. Live reviewer output must use parseDialogueReviewVerdict. */
export function parseDialogueConsistencyVerdict(value: unknown): DialogueConsistencyVerdict | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !["verdict", "violations"].includes(key))
    || !["pass", "reject", "uncertain"].includes(record.verdict as string)
    || !Array.isArray(record.violations) || record.violations.length > 8
    || (record.verdict === "reject" ? record.violations.length === 0 : record.violations.length !== 0)) return null;
  const id = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(v);
  for (const v of record.violations) {
    if (v === null || typeof v !== "object" || Array.isArray(v)
      || Object.keys(v).some(key => !["scope", "unitKey", "candidateId", "type", "aspect", "factId"].includes(key))
      || !["expression", "planning", "legacy"].includes(v.scope)
      || !["extra_inquiry", "missing_response", "answer_mismatch", "intent_mismatch"].includes(v.type)
      || (v.factId !== undefined && (!id(v.factId) || v.aspect === null))
      || (v.aspect !== null && !INQUIRY_ASPECTS.includes(v.aspect))
      || (v.unitKey === undefined ? !id(v.candidateId) : !id(v.unitKey) || v.candidateId !== undefined)) return null;
  }
  return record as unknown as DialogueConsistencyVerdict;
}

export function isLegacyStoredDialogueReview(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).every(key => ["version", "cycle", "inputDigest", "attempts", "status", "passDigest", "violations", "protocolCorrections", "contentRepairs", "lastFailure", "protocolIssue"].includes(key))
    && r.version === 1 && Number.isInteger(r.cycle) && Number(r.cycle) >= 0
    && Number.isInteger(r.attempts) && Number(r.attempts) >= 0 && Number(r.attempts) <= 3
    && ((r.protocolCorrections === undefined && r.contentRepairs === undefined && Number(r.attempts) <= 2)
      || ([r.protocolCorrections, r.contentRepairs].every(n => n === 0 || n === 1)
        && Number(r.protocolCorrections) + Number(r.contentRepairs) <= Number(r.attempts)
        && Number(r.attempts) <= 1 + Number(r.protocolCorrections) + Number(r.contentRepairs)))
    && (r.lastFailure === undefined || ["protocol_error", "provider_failure", "uncertain", "outcome_unknown", "content_recheck", "exhausted"].includes(r.lastFailure as string))
    && (r.protocolIssue === undefined || isReviewProtocolIssue(r.protocolIssue))
    && typeof r.inputDigest === "string" && /^[a-f0-9]{64}$/.test(r.inputDigest)
    && ["pending", "running", "approved", "failed", "unknown"].includes(r.status as string)
    && (r.passDigest === undefined || (r.status === "approved" && typeof r.passDigest === "string" && /^[a-f0-9]{64}$/.test(r.passDigest)))
    && (r.violations === undefined || parseDialogueConsistencyVerdict({ verdict: "reject", violations: r.violations }) !== null);
}
