import { fail, type Check, type Unit, type UnitOutput } from "@/game/domain/narrativeUnit";
import type { ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import type { StoredJob } from "../server/persistence/narrativeJobRepository";
import { projectUnitContext, type SafeContext } from "./perspectiveContext";
import { compileDialogueReviewChecks, parseDialogueReviewVerdict, routeDialogueReviewVerdict,
  type DialogueReviewSubject, type CompiledDialogueReview } from "./dialogueReviewChecks";
import { DIALOGUE_REVIEW_VERSION, DIALOGUE_REVIEW_POLICY_REVISION, DIALOGUE_REVIEW_MAX_ATTEMPTS,
  DIALOGUE_REVIEW_CONTEXT_LIMIT, isStoredDialogueReview, shouldReviewDialogueConsistency } from "./dialogueConsistencyReview";
import { narrativeInputDigest } from "./narrativeInputDigest";
import { canStartRequest } from "./jobBudget";
import type { StageSource } from "./stageSource";

type Receipt = NonNullable<StoredJob["dialogueConsistencyReview"]>;
type Projection = { unitKey: string; digest: string; subjects: readonly DialogueReviewSubject[] };
export function planningDialogueUnits(plan: ApprovedPlan): readonly Unit[] {
  if (!shouldReviewDialogueConsistency(plan)) return [];
  return plan.units.filter(u => u.stage === "choices" || (u.stage === "character"
    && ((u.point.stepKey === "current" && u.speakerId === plan.currentUtterance?.npcId)
      || (u.point.stepKey === plan.choiceExpression?.point.stepKey && u.speakerId === plan.choiceExpression?.npcId))));
}

function subjectsOf(plan: ApprovedPlan, context: SafeContext): readonly DialogueReviewSubject[] {
  const unit = context.unit;
  if (unit.stage === "character") return [{ unitKey: unit.key, kind: "answer", intent: unit.task?.intent ?? null,
    brief: unit.task?.brief ?? context.taskInstruction ?? null,
    inquiries: context.selectedDialogueContract?.inquiries ?? [], answers: unit.task?.answers ?? [],
    prerequisiteFactIds: unit.task?.prerequisiteFactIds ?? [], topicFactIds: unit.task?.focusFactIds ?? [],
    facts: context.visibleFacts,
    ...(context.playerUtterance === null ? {} : { selected: { label: context.playerUtterance,
      historicalChoice: false, contract: context.selectedDialogueContract ?? null } }),
  }];
  return context.options.map(option => {
    const planned = plan.choiceExpression?.options.find(o => o.candidateId === option.candidateId);
    const task = planned !== undefined && "task" in planned ? planned.task : undefined;
    return { unitKey: unit.key, candidateId: option.candidateId, kind: "option", intent: option.dialogueAct,
      brief: task?.brief ?? option.publicIntent.text, inquiries: option.inquiries ?? [], answers: [],
      prerequisiteFactIds: option.prerequisiteFactIds ?? [],
      topicFactIds: [...(task?.focusFactIds ?? []), ...(planned !== undefined && "topic" in planned
        && planned.topic.kind === "fact" ? [String(planned.topic.factId)] : [])], facts: context.visibleFacts };
  });
}

function outputsOf(job: StoredJob): ReadonlyMap<string, UnitOutput> {
  return new Map(job.units.flatMap(u => u.status === "approved" && u.value !== null && "stage" in u.value
    ? [[u.key, u.value] as const] : []));
}

/** Only missing facts explicitly backed by pending, prior observation owners can wait. */
function canDefer(plan: ApprovedPlan, unit: Unit, approved: ReadonlyMap<string, UnitOutput>,
  error: { code: string; detail?: string }): boolean {
  if (!["beat_authority_conflict", "choice_intent_authority_conflict"].includes(error.code)) return false;
  const detail = JSON.parse(error.detail ?? "{}") as { unavailableFactIds?: string[];
    unavailableEvidence?: { kind: string; observationKey?: string }[]; unavailableTargetName?: string };
  const ancestors = new Set(unit.dependencies);
  for (;;) {
    const count = ancestors.size;
    for (const candidate of plan.units) if (ancestors.has(candidate.key))
      for (const key of candidate.dependencies) ancestors.add(key);
    if (count === ancestors.size) break;
  }
  const pending = plan.proposal.observations.filter(o =>
    o.audienceIds.includes(unit.speakerId ?? "player_0") && o.audienceIds.includes("player_0")
    && plan.units.some(owner => ancestors.has(owner.key) && !approved.has(owner.key)
      && owner.requiredObservationKeys.includes(o.key) && owner.point.stepKey === o.point.stepKey
      && owner.point.order >= o.point.order
      && (o.source.kind === "speech" ? owner.stage === "character" && owner.speakerId === o.source.speakerId
        : owner.stage === "narration")
      && (owner.point.stepKey !== unit.point.stepKey || owner.point.order < unit.point.order)));
  const ids = detail.unavailableFactIds ?? [];
  const evidence = detail.unavailableEvidence ?? [];
  const name = detail.unavailableTargetName;
  return (ids.length + evidence.length > 0 || name !== undefined)
    && ids.every(id => pending.some(o => o.fact.factId === id))
    && evidence.every(e => e.kind === "conditional" && pending.some(o => o.key === e.observationKey))
    && (name === undefined || pending.some(o => plan.world.worldFacts.some(f =>
      String(f.factId) === o.fact.factId && f.text.includes(name))));
}

function project(job: StoredJob, plan: ApprovedPlan, unit: Unit, allowDeferred: boolean): Check<Projection | null> {
  const approved = outputsOf(job);
  const context = projectUnitContext({ plan, unit, approved, purpose: "planning" });
  if (!context.ok) return allowDeferred && canDefer(plan, unit, approved, context)
    ? { ok: true, value: null } : context;
  const subjects = subjectsOf(plan, context.value);
  // Compile each unit independently for the receipt: batched check positions never affect its digest.
  const request = compileDialogueReviewChecks(subjects, "planning").request;
  const digest = narrativeInputDigest({ version: DIALOGUE_REVIEW_VERSION, policyRevision: DIALOGUE_REVIEW_POLICY_REVISION,
    cycle: job.cycle, inputDigest: job.inputDigest, proposal: plan.proposal, unitKey: unit.key, request });
  return { ok: true, value: { unitKey: unit.key, digest, subjects } };
}
function valid(receipt: Receipt | undefined, job: StoredJob, digest: string): boolean {
  return receipt?.version === DIALOGUE_REVIEW_VERSION && receipt.cycle === job.cycle && receipt.status === "approved"
    && receipt.attempts > 0 && receipt.attempts <= DIALOGUE_REVIEW_MAX_ATTEMPTS
    && receipt.inputDigest === digest && receipt.passDigest === digest;
}
export function validatePlanningDialogueReviews(job: StoredJob, plan: ApprovedPlan): Check<true> {
  for (const unit of planningDialogueUnits(plan)) {
    const built = project(job, plan, unit, false);
    if (!built.ok) return built;
    if (built.value === null || !valid(job.planningDialogueReviews?.[unit.key], job, built.value.digest))
      return fail("dialogue_consistency_planning_review_required");
  }
  return { ok: true, value: true };
}
export function isStoredPlanningDialogueReviews(value: unknown): boolean {
  return value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).length <= 48 && Object.entries(value).every(([key, receipt]) =>
      /^[a-zA-Z0-9_:-]{1,128}$/.test(key) && receipt !== undefined && isStoredDialogueReview(receipt)));
}

/** One pre-expression batch, then only units whose real upstream disclosure made projection possible. */
export async function runPlanningDialogueReview(input: {
  plan: ApprovedPlan; getJob(): StoredJob; persist(mutate: (job: StoredJob) => StoredJob): Promise<true | string>;
  source: StageSource; signal: AbortSignal; now(): string; unitKey?: string;
}): Promise<Check<true>> {
  const pending: Projection[] = [];
  for (const unit of planningDialogueUnits(input.plan).filter(u => input.unitKey === undefined || input.unitKey === u.key)) {
    const built = project(input.getJob(), input.plan, unit, input.unitKey === undefined);
    if (!built.ok) return built;
    if (built.value !== null && !valid(input.getJob().planningDialogueReviews?.[unit.key], input.getJob(), built.value.digest))
      pending.push(built.value);
  }
  if (pending.length === 0) return { ok: true, value: true };
  const compiled: CompiledDialogueReview = compileDialogueReviewChecks(pending.flatMap(p => p.subjects), "planning");
  if ([...JSON.stringify(compiled.request)].length > DIALOGUE_REVIEW_CONTEXT_LIMIT) return fail("dialogue_consistency_context_limit");
  if (input.source.reviewDialogueConsistency === undefined) return fail("dialogue_consistency_review_unavailable");
  for (;;) {
    const job = input.getJob();
    if (input.signal.aborted) return fail("JOB_ABORTED");
    const attempts = Math.max(...pending.map(p => {
      const r = job.planningDialogueReviews?.[p.unitKey]; return r?.cycle === job.cycle ? r.attempts : 0;
    }));
    if (attempts >= DIALOGUE_REVIEW_MAX_ATTEMPTS) return fail("dialogue_consistency_review_exhausted");
    const budget = canStartRequest({ job, unitAttempts: 0, now: input.now() });
    if (!budget.ok) return budget;
    const update = (current: StoredJob, status: Receipt["status"], pass: boolean, violations?: Receipt["violations"]): StoredJob => ({
      ...current, planningDialogueReviews: { ...current.planningDialogueReviews,
        ...Object.fromEntries(pending.map(p => [p.unitKey, { version: DIALOGUE_REVIEW_VERSION, cycle: current.cycle,
          inputDigest: p.digest, attempts: attempts + 1, status,
          ...(pass ? { passDigest: p.digest } : {}), ...(violations?.length ? { violations } : {}) }])) },
    });
    const charged = await input.persist(current => ({ ...update(current, "running", false), usedRequests: current.usedRequests + 1 }));
    if (charged !== true) return fail(charged);
    let verdict = null;
    try {
      const result = await input.source.reviewDialogueConsistency(compiled.request, {
        signal: input.signal, timeoutMs: Math.max(1, Math.min(30_000, Date.parse(job.deadline) - Date.parse(input.now()))),
        audit: { purpose: "staged_narrative_generation", trigger: "dialogue_consistency_planning_review", jobId: job.id,
          cycle: job.cycle, inputDigest: narrativeInputDigest(pending.map(p => p.digest)) },
      });
      verdict = result.ok ? parseDialogueReviewVerdict({ verdict: result.verdict, violations: result.violations }, compiled.request) : null;
    } catch { /* provider/protocol failure stays bounded by the same review attempt limit */ }
    if (input.signal.aborted) return fail("JOB_ABORTED");
    if (input.now() >= job.deadline) return fail("job_deadline_exceeded");
    const rejected = verdict?.verdict === "reject";
    const passed = verdict?.verdict === "pass";
    const routed = verdict === null ? undefined : routeDialogueReviewVerdict(verdict, compiled).violations;
    const saved = await input.persist(current => ({ ...update(current, passed ? "approved" : "failed", passed, routed),
      ...(rejected ? { units: current.units.map(u => ({ ...u, status: "pending" as const, value: null,
        disclosureReviewDigest: undefined })) } : {}),
    }));
    if (saved !== true) return fail(saved);
    if (passed) return { ok: true, value: true };
    if (rejected) return fail("dialogue_consistency_planning_contract");
    if (attempts + 1 >= DIALOGUE_REVIEW_MAX_ATTEMPTS)
      return fail(verdict === null ? "dialogue_consistency_review_failed" : "dialogue_consistency_review_uncertain");
  }
}
