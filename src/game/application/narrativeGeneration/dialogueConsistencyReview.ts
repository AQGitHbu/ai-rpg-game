import { validatePlanningDialogueReviews } from "./planningDialogueReview";
import { narrativeInputDigest } from "./narrativeInputDigest";
import { INQUIRY_ASPECTS, type InquiryAspect } from "@/game/domain/expressionTask";
import { fail, type Check, type UnitOutput } from "@/game/domain/narrativeUnit";
import { readyUnits, type ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import type { StoredJob } from "../server/persistence/narrativeJobRepository";
import { approveUnit } from "./approveUnit";
import { projectUnitContext, type SafeContext } from "./perspectiveContext";

import { compileDialogueReviewChecks, type CompiledDialogueReview, type DialogueReviewSubject, type DialogueReviewRequest } from "./dialogueReviewChecks";

export const DIALOGUE_REVIEW_VERSION = 1;
/** Bump whenever review policy/prompt changes; storage schema remains readable. */
export const DIALOGUE_REVIEW_POLICY_REVISION = 4;
export const DIALOGUE_REVIEW_MAX_ATTEMPTS = 2;
export const DIALOGUE_REVIEW_CONTEXT_LIMIT = 16_000;
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
export type DialogueConsistencyReviewRequest = DialogueReviewRequest;

/** The same predicate is used for baseline accounting, execution and publication. */
export function shouldReviewDialogueConsistency(plan: ApprovedPlan): boolean {
  return plan.units.some(unit => unit.stage === "choices")
    || (plan.currentUtterance?.inquiries?.length ?? 0) > 0
    || ((plan.currentUtterance?.text.trim().length ?? 0) > 0 && plan.units.some(unit =>
      unit.stage === "character" && unit.point.stepKey === "current" && unit.speakerId === plan.currentUtterance?.npcId));
}

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

/** Only approved outputs and explicit SafeContext fields enter the reviewer DTO. */
export function dialogueConsistencyReviewInput(job: StoredJob, plan: ApprovedPlan): Check<{
  request: DialogueConsistencyReviewRequest; digest: string; compiled: CompiledDialogueReview;
} | null> {
  if (!shouldReviewDialogueConsistency(plan)) return { ok: true, value: null };
  if ((plan.currentUtterance?.inquiries?.length ?? 0) > 0 && !plan.units.some(unit =>
    unit.stage === "character" && unit.point.stepKey === "current" && unit.speakerId === plan.currentUtterance?.npcId))
    return fail("plan_reply_missing");
  const approved = new Map<string, UnitOutput>();
  const contexts: SafeContext[] = [];
  const subjects: DialogueReviewSubject[] = [];
  while (approved.size < plan.units.length) {
    const ready = readyUnits(plan.units, new Set(approved.keys()));
    if (ready.length === 0) return fail("staged_dependency_unmet");
    for (const unit of ready) {
      const stored = job.units.find(s => s.key === unit.key);
      if (stored?.status !== "approved" || stored.value === null || !("stage" in stored.value)) return fail("assemble_unit_missing");
      const output = stored.value;
      const projected = projectUnitContext({ plan, unit, approved });
      if (!projected.ok) return projected;
      const context = projected.value;
      const valid = approveUnit({ unit, context, output });
      if (!valid.ok) return valid;
      contexts.push(context);
      const currentReply = unit.stage === "character" && unit.point.stepKey === "current"
        && unit.speakerId === plan.currentUtterance?.npcId;
      const decisionReply = unit.stage === "character" && unit.point.stepKey === plan.choiceExpression?.point.stepKey
        && unit.speakerId === plan.choiceExpression?.npcId;
      if (output.stage === "choices" || (output.stage === "character" && (currentReply || decisionReply))) {
        const selectedLabel = currentReply ? context.playerUtterance : null;
        if (output.stage === "character") {
          subjects.push({ unitKey: unit.key, kind: "answer", intent: context.unit.task?.intent ?? null,
            brief: context.unit.task?.brief ?? context.taskInstruction ?? null, text: output.parts.map(part => part.text).join("\n"),
            inquiries: context.selectedDialogueContract?.inquiries ?? [], answers: context.unit.task?.answers ?? [],
            prerequisiteFactIds: context.unit.task?.prerequisiteFactIds ?? [],
            topicFactIds: (context.unit.task?.focusFactIds ?? []).filter(id => context.visibleFacts.some(f => f.id === id)),
            facts: context.visibleFacts,
            ...(selectedLabel === null ? {} : { selected: { label: selectedLabel,
              historicalChoice: job.input.kind === "decision" && job.input.job.generationKind !== "npc_free_text"
                && job.input.job.selectedDialogue !== undefined,
              topicFactIds: job.input.kind === "decision" ? (job.input.job.selectedDialogue?.task?.focusFactIds ?? [])
                .filter(id => context.visibleFacts.some(f => f.id === id)) : [],
              contract: context.selectedDialogueContract === undefined ? null : { ...context.selectedDialogueContract,
                brief: job.input.kind === "decision" ? job.input.job.selectedDialogue?.task?.brief
                  ?? context.selectedDialogueContract.brief : context.selectedDialogueContract.brief } } }),
          });
        } else for (const label of output.labels) {
          const option = context.options.find(o => o.candidateId === label.candidateId)!;
          const planned = plan.choiceExpression?.options.find(o => o.candidateId === label.candidateId);
          const task = planned !== undefined && "task" in planned ? planned.task : undefined;
          subjects.push({ unitKey: unit.key, candidateId: label.candidateId, kind: "option",
            intent: option.dialogueAct, brief: task?.brief ?? option.publicIntent.text, text: label.label,
            inquiries: option.inquiries ?? [], answers: [], prerequisiteFactIds: option.prerequisiteFactIds ?? [],
            topicFactIds: [...(task?.focusFactIds ?? []),
              ...(planned !== undefined && "topic" in planned && planned.topic.kind === "fact" ? [String(planned.topic.factId)] : [])]
              .filter(id => context.visibleFacts.some(f => f.id === id)),
            facts: context.visibleFacts,
          });
        }
      }
      approved.set(unit.key, output);
    }
  }
  const compiled = compileDialogueReviewChecks(subjects, "expression");
  const request = compiled.request;
  if ([...JSON.stringify(request)].length > DIALOGUE_REVIEW_CONTEXT_LIMIT) return fail("dialogue_consistency_context_limit");
  // Full input is hashed locally; private plan/world data is never sent to the reviewer.
  const digest = narrativeInputDigest({ version: DIALOGUE_REVIEW_VERSION, policyRevision: DIALOGUE_REVIEW_POLICY_REVISION,
    cycle: job.cycle, inputDigest: job.inputDigest, proposal: plan.proposal, contexts,
    units: job.units.map(unit => ({ key: unit.key, inputDigest: unit.inputDigest, value: unit.value })), request,
  });
  return { ok: true, value: { request, digest, compiled } };
}

export function validateJobDialogueConsistencyReview(job: StoredJob, plan: ApprovedPlan): Check<true> {
  const planning = validatePlanningDialogueReviews(job, plan);
  if (!planning.ok) return planning;
  const input = dialogueConsistencyReviewInput(job, plan);
  if (!input.ok) return input;
  if (input.value === null) return { ok: true, value: true };
  const receipt = job.dialogueConsistencyReview;
  return receipt?.version === DIALOGUE_REVIEW_VERSION && receipt.cycle === job.cycle
    && receipt.status === "approved" && receipt.attempts > 0 && receipt.attempts <= DIALOGUE_REVIEW_MAX_ATTEMPTS
    && receipt.inputDigest === input.value.digest && receipt.passDigest === input.value.digest
    ? { ok: true, value: true } : fail("dialogue_consistency_review_required");
}

export function isStoredDialogueReview(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).every(key => ["version", "cycle", "inputDigest", "attempts", "status", "passDigest", "violations"].includes(key))
    && r.version === DIALOGUE_REVIEW_VERSION && Number.isInteger(r.cycle) && Number(r.cycle) >= 0
    && Number.isInteger(r.attempts) && Number(r.attempts) >= 0 && Number(r.attempts) <= DIALOGUE_REVIEW_MAX_ATTEMPTS
    && typeof r.inputDigest === "string" && /^[a-f0-9]{64}$/.test(r.inputDigest)
    && ["pending", "running", "approved", "failed", "unknown"].includes(r.status as string)
    && (r.passDigest === undefined || (r.status === "approved" && typeof r.passDigest === "string" && /^[a-f0-9]{64}$/.test(r.passDigest)))
    && (r.violations === undefined || parseDialogueConsistencyVerdict({ verdict: "reject", violations: r.violations }) !== null);
}
