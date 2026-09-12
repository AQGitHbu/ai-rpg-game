import { prepareReviewAttempt, reviewAllowances, reviewOutcome, type ReviewOutcome } from "./dialogueReviewRecovery";
import { fail, type Check, type Unit, type UnitOutput } from "@/game/domain/narrativeUnit";
import type { ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import type { StoredJob } from "../server/persistence/narrativeJobRepository";
import { projectUnitContext, type SafeContext } from "./perspectiveContext";
import { compileDialogueReviewChecks, routeDialogueReviewVerdict,
  type DialogueReviewSubject, type CompiledDialogueReview } from "./dialogueReviewChecks";
import { DIALOGUE_REVIEW_VERSION, DIALOGUE_REVIEW_POLICY_REVISION, DIALOGUE_REVIEW_MAX_ATTEMPTS,
  DIALOGUE_REVIEW_CONTEXT_LIMIT, isStoredDialogueReview, shouldReviewDialogueConsistency } from "./dialogueConsistencyReview";
import { narrativeInputDigest } from "./narrativeInputDigest";
import { canStartRequest } from "./jobBudget";
import type { StageSource } from "./stageSource";
import { PLANNING_CONTRACT, planningAnchorDigest } from "./planningSemanticRepair";

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
  if (job.planningSemanticRepair !== undefined && (job.planningSemanticRepair.cycle !== job.cycle
    || job.planningSemanticRepair.inputDigest !== job.inputDigest
    || job.planningSemanticRepair.reviewInFlight || job.planningSemanticRepair.reviewFailure !== undefined
    || ["pending", "exhausted"].includes(job.planningSemanticRepair.status)
    || (job.planningSemanticRepair.used === 1
      && planningAnchorDigest(plan.proposal) !== planningAnchorDigest(job.planningSemanticRepair.anchor)))) return fail(PLANNING_CONTRACT);
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
    const previousReviews = Object.values(job.planningDialogueReviews ?? {}).filter(r => r.cycle === job.cycle);
    const recovery = job.planningSemanticRepair ?? { cycle: job.cycle, inputDigest: job.inputDigest,
      used: 0 as const, status: "idle" as const, anchor: input.plan.proposal,
      protocolCorrections: previousReviews.some(r => reviewAllowances(r).protocolCorrections > 0) ? 1 as const : 0 as const,
      reviewInFlight: previousReviews.some(r => r.status === "running" || r.status === "unknown"),
      reviewFailure: previousReviews.find(r => r.lastFailure === "protocol_error" || r.lastFailure === "provider_failure"
        || r.lastFailure === "uncertain")?.lastFailure as "protocol_error" | "provider_failure" | "uncertain" | undefined };
    if (recovery.cycle !== job.cycle || recovery.inputDigest !== job.inputDigest) return fail("JOB_CONFLICT");
    if (recovery.reviewFailure === "provider_failure") return fail("AI_CALL_FAILED");
    if (recovery.reviewFailure === "uncertain") return fail("dialogue_consistency_review_uncertain");
    const correction = recovery.reviewInFlight || recovery.reviewFailure === "protocol_error"
      || pending.some(p => {
        const r = job.planningDialogueReviews?.[p.unitKey];
        return r?.cycle === job.cycle && r.attempts > 0 && r.lastFailure !== "content_recheck";
      });
    if (correction && recovery.protocolCorrections === 1) return fail("dialogue_consistency_review_exhausted");
    const prepared = pending.map(p => {
      const previous = job.planningDialogueReviews?.[p.unitKey];
      const inherited = recovery.used === 1 ? Object.values(job.planningDialogueReviews ?? {})
        .filter(r => r.cycle === job.cycle).sort((a, b) => b.attempts - a.attempts)[0] : undefined;
      const sameCycle = previous?.cycle === job.cycle ? previous : inherited === undefined ? undefined : {
        ...inherited, attempts: 1 + recovery.protocolCorrections, protocolCorrections: recovery.protocolCorrections,
        contentRepairs: 1, status: "pending" as const, lastFailure: "content_recheck" as const };
      return prepareReviewAttempt({ ...sameCycle, version: DIALOGUE_REVIEW_VERSION, cycle: job.cycle,
        inputDigest: p.digest, attempts: sameCycle?.attempts ?? 0, status: sameCycle?.status ?? "pending", passDigest: undefined,
        ...(recovery.reviewInFlight ? { lastFailure: "outcome_unknown" } : {}) });
    });
    for (const attempt of prepared) if (!attempt.ok) return fail(attempt.code);
    const budget = canStartRequest({ job, unitAttempts: 0, now: input.now() });
    if (!budget.ok) return budget;
    const update = (current: StoredJob, status: Receipt["status"], pass: boolean,
      violations?: Receipt["violations"], outcome?: ReviewOutcome): StoredJob => ({
      ...current, planningDialogueReviews: { ...current.planningDialogueReviews,
        ...Object.fromEntries(pending.map((p, index) => {
          const attempt = prepared[index]!;
          if (!attempt.ok) throw Error("unprepared review");
          return [p.unitKey, { ...attempt.receipt, status, passDigest: pass ? p.digest : undefined,
            violations: pass ? undefined : violations ?? attempt.receipt.violations,
            ...(outcome === undefined ? {} : { protocolIssue: outcome.issue,
              lastFailure: outcome.failure ?? (outcome.verdict?.verdict === "uncertain" ? "uncertain"
                : outcome.verdict?.verdict === "reject" ? "exhausted" : undefined) }) }];
        })) },
    });
    const charged = await input.persist(current => ({ ...update(current, "running", false),
      planningSemanticRepair: { ...recovery, reviewInFlight: true,
        anchor: recovery.used === 0 ? input.plan.proposal : recovery.anchor,
        protocolCorrections: correction ? 1 : recovery.protocolCorrections }, usedRequests: current.usedRequests + 1 }));
    if (charged !== true) return fail(charged);
    let outcome: ReviewOutcome;
    try {
      const repair = prepared.flatMap(p => p.ok && p.repair ? [p.repair] : [])[0];
      const result = await input.source.reviewDialogueConsistency(compiled.request, {
        repair: repair?.reason === "dialogue_consistency_content_recheck" ? { ...repair,
          detail: "planning_content_recheck: planning tasks and contracts were revised; independently review all current planning checks. Expression text is not available." } : repair,
        signal: input.signal, timeoutMs: Math.max(1, Math.min(30_000, Date.parse(job.deadline) - Date.parse(input.now()))),
        audit: { purpose: "staged_narrative_generation", trigger: "dialogue_consistency_planning_review", jobId: job.id,
          cycle: job.cycle, inputDigest: narrativeInputDigest(pending.map(p => p.digest)) },
      });
      outcome = reviewOutcome(result, compiled.request);
    } catch { outcome = { verdict: null, failure: "provider_failure" }; }
    const verdict = outcome.verdict;
    if (input.signal.aborted) return fail("JOB_ABORTED");
    if (input.now() >= job.deadline) return fail("job_deadline_exceeded");
    const rejected = verdict?.verdict === "reject";
    const passed = verdict?.verdict === "pass";
    const routed = verdict === null ? undefined : routeDialogueReviewVerdict(verdict, compiled).violations;
    const saved = await input.persist(current => {
      const updated = update(current, passed ? "approved" : "failed", passed, routed, outcome);
      const canRepair = rejected && recovery.used === 0;
      return { ...updated, planningSemanticRepair: { ...current.planningSemanticRepair!,
        reviewInFlight: false, reviewFailure: outcome.failure ?? (verdict?.verdict === "uncertain" ? "uncertain" : undefined),
        protocolIssue: outcome.issue,
        ...(rejected ? { used: 1, status: canRepair ? "pending" : "exhausted", violations: routed } : {}),
      }, ...(rejected ? {
        planningDialogueReviews: Object.fromEntries(Object.entries(updated.planningDialogueReviews ?? {}).map(([key, r]) =>
          [key, { ...r, status: "pending" as const, passDigest: undefined,
            ...(canRepair ? { contentRepairs: 1, lastFailure: "content_recheck" as const } : {}) }])),
        units: current.units.map(u => ({ ...u, status: "pending" as const, value: null, disclosureReviewDigest: undefined })),
        dialogueConsistencyReview: current.dialogueConsistencyReview === undefined ? undefined
          : { ...current.dialogueConsistencyReview, status: "pending" as const, passDigest: undefined },
      } : {}) };
    });
    if (saved !== true) return fail(saved);
    if (passed) return { ok: true, value: true };
    if (rejected) return fail(PLANNING_CONTRACT);
    if (outcome.failure === "provider_failure") return fail("AI_CALL_FAILED");
    if (verdict?.verdict === "uncertain") return fail("dialogue_consistency_review_uncertain");
    if (prepared.some(p => p.ok && p.receipt.protocolCorrections === 1)) return fail("dialogue_consistency_review_failed");
  }
}
