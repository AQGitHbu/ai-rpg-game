import { parsePlanProposal, type PlanProposal } from "@/game/domain/narrativePlan";
import type { StoredJob } from "../server/persistence/narrativeJobRepository";
import { isStoredDialogueReview } from "./dialogueConsistencyReview";
import { narrativeInputDigest } from "./narrativeInputDigest";
import { planningSceneContract } from "./planningSceneContract";
import { approvePlanningContext } from "./approvePlanningContext";
import type { StageExecution } from "./stageSource";

export const PLANNING_CONTRACT = "dialogue_consistency_planning_contract";
export function planningAnchorDigest(plan: PlanProposal): string {
  // Tasks and candidate intentions may change; world, knowledge and rule topology may not.
  const { opening, worldDelta, steps, terminal, observations, actions } = plan;
  return narrativeInputDigest({ opening, worldDelta, steps, terminal, observations, actions });
}
export function planningSemanticFeedback(job: StoredJob): StageExecution["repair"] {
  const repair = job.planningSemanticRepair;
  if (repair?.cycle !== job.cycle || repair.used !== 1) return undefined;
  const approved = approvePlanningContext(job.input, repair.anchor);
  if (!approved.ok) return undefined;
  return { attempt: job.units.find(u => u.key === "planning")?.attempts ?? 0,
    reason: PLANNING_CONTRACT, rejectionCode: PLANNING_CONTRACT,
    detail: JSON.stringify({ violations: repair.violations, approvedProposal: repair.anchor,
      approvedOpening: repair.anchor.opening, approvedWorldDelta: repair.anchor.worldDelta,
      ...(approved.value.ruleSceneGraph === undefined ? {} : {
        sceneContract: planningSceneContract(approved.value.ruleSceneGraph,
          job.input.kind === "decision" ? job.input.job.focusNpcId ?? null : null),
      }) }) };
}
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
