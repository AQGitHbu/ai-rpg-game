// Historical data reader only; this state no longer participates in generation or publication.
import { parsePlanProposal } from "@/game/domain/narrativePlan";
import type { StoredJob } from "../server/persistence/narrativeJobRepository";
import { isLegacyStoredDialogueReview as isStoredDialogueReview } from "./legacyDialogueReview";
import { narrativeInputDigest } from "./narrativeInputDigest";
export function isStoredPlanningSemanticRepair(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as NonNullable<StoredJob["planningSemanticRepair"]>;
  return Object.keys(r).every(k => ["cycle", "inputDigest", "used", "status", "anchor", "protocolCorrections",
    "reviewInFlight", "reviewFailure", "protocolIssue", "violations"].includes(k))
    && Number.isInteger(r.cycle) && r.cycle >= 0 && typeof r.inputDigest === "string"
    && r.inputDigest.length > 0 && r.inputDigest.length <= 256 && (r.used === 0 || r.used === 1)
    && ["idle", "pending", "replanned", "exhausted"].includes(r.status)
    && (r.used === 0 ? r.status === "idle" : r.status !== "idle")
    && (r.used === 0 ? r.violations === undefined : Array.isArray(r.violations) && r.violations.length > 0
      && r.violations.every(v => v !== null && typeof v === "object" && v.scope === "planning"))
    && (r.protocolCorrections === 0 || r.protocolCorrections === 1) && typeof r.reviewInFlight === "boolean"
    && (r.reviewFailure === undefined || ["protocol_error", "provider_failure", "uncertain"].includes(r.reviewFailure))
    && parsePlanProposal(r.anchor).ok
    && isStoredDialogueReview({ version: 1, cycle: r.cycle, inputDigest: narrativeInputDigest(r.inputDigest), attempts: 1,
      status: "pending", violations: r.violations, protocolIssue: r.protocolIssue });
}
