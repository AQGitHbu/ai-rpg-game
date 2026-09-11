import type { ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import type { StoredJob } from "../server/persistence/narrativeJobRepository";
import type { StageSource } from "./stageSource";
import { canStartRequest } from "./jobBudget";
import { DIALOGUE_REVIEW_MAX_ATTEMPTS, DIALOGUE_REVIEW_VERSION, dialogueConsistencyReviewInput,
  parseDialogueConsistencyVerdict, type DialogueViolation } from "./dialogueConsistencyReview";

type ReviewResult = { ok: true; repair: boolean } | { ok: false; code: string };
/** The runner owns scheduling/fences; this bounded state machine owns review charges and receipts. */
export async function runDialogueConsistencyReview(input: {
  plan: ApprovedPlan;
  getJob(): StoredJob;
  persist(mutate: (job: StoredJob) => StoredJob): Promise<true | string>;
  source: StageSource;
  signal: AbortSignal;
  now(): string;
}): Promise<ReviewResult> {
  const built = dialogueConsistencyReviewInput(input.getJob(), input.plan);
  if (!built.ok) return built;
  if (built.value === null) return { ok: true, repair: false };
  const { request, digest } = built.value;
  const current = input.getJob();
  const previous = current.dialogueConsistencyReview;
  if (previous?.cycle === current.cycle && previous.version === DIALOGUE_REVIEW_VERSION
    && previous.status === "approved" && previous.attempts > 0 && previous.attempts <= DIALOGUE_REVIEW_MAX_ATTEMPTS
    && previous.passDigest === digest && previous.inputDigest === digest)
    return { ok: true, repair: false };
  const reset = await input.persist(job => ({ ...job, dialogueConsistencyReview: {
    version: DIALOGUE_REVIEW_VERSION, cycle: job.cycle, inputDigest: digest,
    attempts: previous?.cycle === job.cycle ? previous.attempts : 0,
    status: previous?.status === "running" ? "unknown" : "pending",
  } }));
  if (reset !== true) return { ok: false, code: reset };
  if (input.source.reviewDialogueConsistency === undefined) return { ok: false, code: "dialogue_consistency_review_unavailable" };
  for (;;) {
    const job = input.getJob();
    if (input.signal.aborted) return { ok: false, code: "JOB_ABORTED" };
    const review = job.dialogueConsistencyReview!;
    if (review.attempts >= DIALOGUE_REVIEW_MAX_ATTEMPTS) return { ok: false, code: "dialogue_consistency_review_exhausted" };
    const budget = canStartRequest({ job, unitAttempts: 0, now: input.now() });
    if (!budget.ok) return budget;
    const charged = await input.persist(current => ({ ...current, usedRequests: current.usedRequests + 1,
      dialogueConsistencyReview: { ...current.dialogueConsistencyReview!, attempts: review.attempts + 1,
        status: "running", passDigest: undefined } }));
    if (charged !== true) return { ok: false, code: charged };
    let verdict;
    try {
      const result = await input.source.reviewDialogueConsistency(request, {
        signal: input.signal, timeoutMs: Math.max(1, Math.min(30_000, Date.parse(job.deadline) - Date.parse(input.now()))),
        audit: { purpose: "staged_narrative_generation", trigger: "dialogue_consistency_review", jobId: job.id,
          cycle: job.cycle, inputDigest: digest,
          retry: { origin: job.cycle > 0 ? "manual_failed_job" : "normal",
            mechanism: review.attempts === 0 ? "initial" : "content_repair", attempt: review.attempts,
            ...(review.attempts === 0 ? {} : { reason: "dialogue_consistency_review_retry" }) } },
      });
      verdict = result.ok ? parseDialogueConsistencyVerdict({ verdict: result.verdict, violations: result.violations }) : null;
    } catch { verdict = null; }
    if (input.signal.aborted) return { ok: false, code: "JOB_ABORTED" };
    if (input.now() >= job.deadline) return { ok: false, code: "job_deadline_exceeded" };
    const violations = verdict?.violations ?? [];
    const targetsValid = violations.every(v => request.conversations.some(c =>
      v.unitKey === c.unitKey && (v.scope !== "legacy" || c.selected?.historicalChoice === true)
      || v.candidateId !== undefined && v.scope !== "legacy" && c.options.some(o => o.candidateId === v.candidateId)));
    if (!targetsValid) verdict = null;
    const reject = verdict?.verdict === "reject";
    const legacy = reject && violations.some(v => v.scope === "legacy");
    const planning = reject && !legacy && violations.some(v => v.scope === "planning");
    const invalid = new Set<string>(!reject || legacy ? [] : planning ? input.plan.units.map(u => u.key)
      : violations.flatMap(v => request.conversations.filter(c => c.unitKey === v.unitKey
        || c.options.some(o => o.candidateId === v.candidateId)).map(c => c.unitKey)));
    if (planning) invalid.add("planning");
    for (;;) {
      const count = invalid.size;
      for (const unit of input.plan.units) if (unit.dependencies.some(key => invalid.has(key))) invalid.add(unit.key);
      if (count === invalid.size) break;
    }
    // Reject receipt and DAG invalidation are one fenced write: recovery cannot lose repair metadata.
    const saved = await input.persist(current => ({ ...current, dialogueConsistencyReview: {
      ...current.dialogueConsistencyReview!, status: verdict?.verdict === "pass" ? "approved" : "failed",
      passDigest: verdict?.verdict === "pass" ? digest : undefined,
      ...(reject ? { violations } : {}),
    }, units: current.units.map(unit => invalid.has(unit.key)
      ? { ...unit, status: "pending", value: null, disclosureReviewDigest: undefined } : unit) }));
    if (saved !== true) return { ok: false, code: saved };
    if (verdict?.verdict === "pass") return { ok: true, repair: false };
    if (reject) {
      if (legacy) return { ok: false, code: "legacy_dialogue_contract_mismatch" };
      if (planning) return { ok: false, code: "dialogue_consistency_planning_contract" };
      if (input.getJob().dialogueConsistencyReview!.attempts >= DIALOGUE_REVIEW_MAX_ATTEMPTS)
        return { ok: false, code: "dialogue_consistency_review_exhausted" };
      return { ok: true, repair: true };
    }
    if (input.getJob().dialogueConsistencyReview!.attempts >= DIALOGUE_REVIEW_MAX_ATTEMPTS)
      return { ok: false, code: verdict === null ? "dialogue_consistency_review_failed" : "dialogue_consistency_review_uncertain" };
  }
}

/** IDs, enums and aspects only; a reviewer cannot inject private text or instructions. */
export function dialogueRepairForUnit(job: StoredJob, key: string, candidateIds: readonly string[]): readonly DialogueViolation[] {
  return (job.dialogueConsistencyReview?.violations ?? []).filter(v => v.scope === "expression"
    && (v.unitKey === key || (v.candidateId !== undefined && candidateIds.includes(v.candidateId))));
}
