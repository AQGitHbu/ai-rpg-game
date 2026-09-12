import type { ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import type { StoredJob } from "../server/persistence/narrativeJobRepository";
import type { StageSource } from "./stageSource";
import { canStartRequest } from "./jobBudget";
import { DIALOGUE_REVIEW_MAX_ATTEMPTS, DIALOGUE_REVIEW_VERSION, dialogueConsistencyReviewInput, parsePolishReviewVerdict } from "./dialogueConsistencyReview";

type ReviewResult = { ok: true; repair: boolean } | { ok: false; code: string };
export async function runDialogueConsistencyReview(input: {
  plan: ApprovedPlan; getJob(): StoredJob; persist(mutate: (job: StoredJob) => StoredJob): Promise<true | string>;
  source: StageSource; signal: AbortSignal; now(): string;
}): Promise<ReviewResult> {
  const built = dialogueConsistencyReviewInput(input.getJob(), input.plan);
  if (!built.ok) return built;
  if (built.value === null) return { ok: true, repair: false };
  const { request, digest, routes } = built.value;
  const initial = input.getJob();
  const previous = initial.dialogueConsistencyReview;
  if (previous?.version === DIALOGUE_REVIEW_VERSION && previous.cycle === initial.cycle && previous.status === "approved"
    && previous.attempts > 0 && previous.attempts <= DIALOGUE_REVIEW_MAX_ATTEMPTS
    && previous.passDigest === digest && previous.inputDigest === digest) return { ok: true, repair: false };
  if (input.source.reviewDialogueConsistency === undefined) return { ok: false, code: "dialogue_consistency_review_unavailable" };
  for (;;) {
    const job = input.getJob();
    const old = job.dialogueConsistencyReview;
    const attempts = old?.cycle === job.cycle ? old.attempts : 0;
    if (attempts >= DIALOGUE_REVIEW_MAX_ATTEMPTS) return { ok: false, code: "dialogue_consistency_review_exhausted" };
    if (old?.cycle === job.cycle && (old.lastFailure === "provider_failure" || old.lastFailure === "uncertain"))
      return { ok: false, code: old.lastFailure === "provider_failure" ? "AI_CALL_FAILED" : "dialogue_consistency_review_uncertain" };
    if (input.signal.aborted) return { ok: false, code: "JOB_ABORTED" };
    const budget = canStartRequest({ job, unitAttempts: 0, now: input.now() });
    if (!budget.ok) return budget;
    const charged = await input.persist(current => ({ ...current, usedRequests: current.usedRequests + 1,
      dialogueConsistencyReview: { version: DIALOGUE_REVIEW_VERSION, cycle: job.cycle, inputDigest: digest,
        attempts: attempts + 1, status: "running", failedIds: old?.failedIds } }));
    if (charged !== true) return { ok: false, code: charged };
    let verdict: ReturnType<typeof parsePolishReviewVerdict> | undefined;
    let failure: "provider_failure" | "protocol_error" | undefined;
    try {
      const result = await input.source.reviewDialogueConsistency(request, {
        ...(old?.lastFailure === "protocol_error" ? { repair: { attempt: attempts, reason: "invalid_schema", rejectionCode: "dialogue_consistency_review_invalid",
          detail: 'Only return verdict and failedIds. pass/uncertain: []; reject: existing item IDs.' } } : {}),
        signal: input.signal, timeoutMs: Math.max(1, Math.min(30_000, Date.parse(job.deadline) - Date.parse(input.now()))),
        audit: { purpose: "staged_narrative_generation", trigger: "dialogue_consistency_review", jobId: job.id, cycle: job.cycle, inputDigest: digest } });
      if (!result.ok) failure = result.failure.kind === "AI_CALL_FAILED" ? "provider_failure" : "protocol_error";
      else { const { ok: _, ...payload } = result; verdict = parsePolishReviewVerdict(payload, request); if (!verdict.ok) failure = "protocol_error"; }
    } catch { failure = "provider_failure"; }
    if (input.signal.aborted) return { ok: false, code: "JOB_ABORTED" };
    if (input.now() >= job.deadline) return { ok: false, code: "job_deadline_exceeded" };
    const value = verdict?.ok ? verdict.value : undefined;
    const canRepair = value?.verdict === "reject" && attempts + 1 < DIALOGUE_REVIEW_MAX_ATTEMPTS;
    const invalid = new Set<string>(canRepair ? value.failedIds.map(id => routes.get(id)!) : []);
    for (;;) { const size = invalid.size; for (const unit of input.plan.units) if (unit.dependencies.some(key => invalid.has(key))) invalid.add(unit.key); if (size === invalid.size) break; }
    const saved = await input.persist(current => ({ ...current, dialogueConsistencyReview: {
      version: DIALOGUE_REVIEW_VERSION, cycle: job.cycle, inputDigest: digest, attempts: attempts + 1,
      status: value?.verdict === "pass" ? "approved" : "failed", passDigest: value?.verdict === "pass" ? digest : undefined,
      failedIds: value?.failedIds, lastFailure: failure ?? (value?.verdict === "uncertain" ? "uncertain" : value?.verdict === "reject" ? canRepair ? "content_recheck" : "exhausted" : undefined),
    }, units: current.units.map(unit => invalid.has(unit.key) ? { ...unit, status: "pending", value: null, disclosureReviewDigest: undefined } : unit) }));
    if (saved !== true) return { ok: false, code: saved };
    if (value?.verdict === "pass") return { ok: true, repair: false };
    if (value?.verdict === "reject") return canRepair ? { ok: true, repair: true } : { ok: false, code: "dialogue_consistency_review_exhausted" };
    if (value?.verdict === "uncertain") return { ok: false, code: "dialogue_consistency_review_uncertain" };
    if (failure === "provider_failure") return { ok: false, code: "AI_CALL_FAILED" };
  }
}
/** No review prose is ever sent to a polisher. */
export function dialogueRepairForUnit(job: StoredJob): readonly string[] {
  return job.dialogueConsistencyReview?.lastFailure === "content_recheck" ? job.dialogueConsistencyReview.failedIds ?? [] : [];
}
