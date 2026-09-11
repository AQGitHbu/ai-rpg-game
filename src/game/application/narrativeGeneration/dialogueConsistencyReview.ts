import { narrativeInputDigest } from "./narrativeInputDigest";
import { INQUIRY_ASPECTS, type ExpressionTask, type InquiryAspect } from "@/game/domain/expressionTask";
import { fail, type Check, type UnitOutput } from "@/game/domain/narrativeUnit";
import { readyUnits, type ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import type { StoredJob } from "../server/persistence/narrativeJobRepository";
import { approveUnit } from "./approveUnit";
import { projectUnitContext, type SafeContext } from "./perspectiveContext";

export const DIALOGUE_REVIEW_VERSION = 1;
export const DIALOGUE_REVIEW_MAX_ATTEMPTS = 2;
export const DIALOGUE_REVIEW_CONTEXT_LIMIT = 16_000;
export type DialogueViolation = Readonly<{
  scope: "expression" | "planning" | "legacy";
  unitKey?: string;
  candidateId?: string;
  type: "extra_inquiry" | "missing_response" | "answer_mismatch" | "intent_mismatch";
  aspect: InquiryAspect | null;
}>;
export type DialogueConsistencyVerdict = Readonly<{
  verdict: "pass" | "reject" | "uncertain";
  violations: readonly DialogueViolation[];
}>;
type Contract = Readonly<{ intent: string; inquiries: NonNullable<ExpressionTask["inquiries"]>; brief?: string | null }>;
export type DialogueConsistencyReviewRequest = Readonly<{
  version: 1;
  conversations: readonly Readonly<{
    unitKey: string;
    stepKey: string;
    speakerId: string | null;
    stage: "character" | "choices";
    brief: string | null;
    text: string | null;
    answers: NonNullable<ExpressionTask["answers"]>;
    options: readonly Readonly<{ candidateId: string; label: string; brief: string; contract: Contract }>[];
    selected: Readonly<{ label: string; historicalChoice: boolean; contract: Contract | null }> | null;
    previousReply: string | null;
    priorText: readonly string[];
    facts: SafeContext["visibleFacts"];
  }>[];
}>;

/** The same predicate is used for baseline accounting, execution and publication. */
export function shouldReviewDialogueConsistency(plan: ApprovedPlan): boolean {
  return plan.units.some(unit => unit.stage === "choices")
    || (plan.currentUtterance?.inquiries?.length ?? 0) > 0
    || ((plan.currentUtterance?.text.trim().length ?? 0) > 0 && plan.units.some(unit =>
      unit.stage === "character" && unit.point.stepKey === "current" && unit.speakerId === plan.currentUtterance?.npcId));
}

/** No arbitrary model prose survives parsing or enters a repair request. */
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
      || Object.keys(v).some(key => !["scope", "unitKey", "candidateId", "type", "aspect"].includes(key))
      || !["expression", "planning", "legacy"].includes(v.scope)
      || !["extra_inquiry", "missing_response", "answer_mismatch", "intent_mismatch"].includes(v.type)
      || (v.aspect !== null && !INQUIRY_ASPECTS.includes(v.aspect))
      || (v.unitKey === undefined ? !id(v.candidateId) : !id(v.unitKey) || v.candidateId !== undefined)) return null;
  }
  return record as unknown as DialogueConsistencyVerdict;
}

/** Only approved outputs and explicit SafeContext fields enter the reviewer DTO. */
export function dialogueConsistencyReviewInput(job: StoredJob, plan: ApprovedPlan): Check<{
  request: DialogueConsistencyReviewRequest; digest: string;
} | null> {
  if (!shouldReviewDialogueConsistency(plan)) return { ok: true, value: null };
  if ((plan.currentUtterance?.inquiries?.length ?? 0) > 0 && !plan.units.some(unit =>
    unit.stage === "character" && unit.point.stepKey === "current" && unit.speakerId === plan.currentUtterance?.npcId))
    return fail("plan_reply_missing");
  const approved = new Map<string, UnitOutput>();
  const contexts: SafeContext[] = [];
  const conversations: DialogueConsistencyReviewRequest["conversations"][number][] = [];
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
        conversations.push({ unitKey: unit.key, stepKey: unit.point.stepKey,
          speakerId: unit.speakerId, stage: output.stage,
          brief: context.taskInstruction ?? null,
          text: output.stage === "character" ? output.parts.map(part => part.text).join("\n") : null,
          answers: context.unit.task?.answers ?? [],
          options: output.stage === "choices" ? output.labels.map(label => {
            const option = context.options.find(o => o.candidateId === label.candidateId)!;
            return { ...label, brief: option.publicIntent.text,
              contract: { intent: option.dialogueAct, inquiries: option.inquiries ?? [] } };
          }) : [],
          selected: selectedLabel === null ? null : { label: selectedLabel,
            historicalChoice: job.input.kind === "decision" && job.input.job.generationKind !== "npc_free_text"
              && job.input.job.selectedDialogue !== undefined,
            contract: context.selectedDialogueContract ?? null },
          previousReply: context.previousReply ?? null,
          priorText: context.priorText.map(part => part.text), facts: context.visibleFacts,
        });
      }
      approved.set(unit.key, output);
    }
  }
  const request: DialogueConsistencyReviewRequest = { version: DIALOGUE_REVIEW_VERSION, conversations };
  if ([...JSON.stringify(request)].length > DIALOGUE_REVIEW_CONTEXT_LIMIT) return fail("dialogue_consistency_context_limit");
  // Full input is hashed locally; private plan/world data is never sent to the reviewer.
  const digest = narrativeInputDigest({ version: DIALOGUE_REVIEW_VERSION,
    cycle: job.cycle, inputDigest: job.inputDigest, proposal: plan.proposal, contexts,
    units: job.units.map(unit => ({ key: unit.key, inputDigest: unit.inputDigest, value: unit.value })), request,
  });
  return { ok: true, value: { request, digest } };
}

export function validateJobDialogueConsistencyReview(job: StoredJob, plan: ApprovedPlan): Check<true> {
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
