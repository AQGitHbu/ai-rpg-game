import { REVIEW_MAX_REQUESTS } from "./dialogueReviewRecovery";
import { runPlanningDialogueReview, validatePlanningDialogueReviews } from "./planningDialogueReview";
// 可恢复 DAG 调度（Plan 2026-09-09 / Task 8）。
//
// runJob 不 claim/release：协调器（ensureCoordinator 的单一执行作用域）
// 负责 claim → 启动续租 → runJob → 装配 Publication → publishJob →
// finally 停止续租并 fenced release。runJob 完成生成与审批后返回待发布的
// pending job；调用方不得脱离协调器作用域发布。
//
// 顺序：charge/save running → generate → approve → save approved——绝不先发
// 请求后扣预算。planning 固定逻辑 key；表达单元 key 来自规则审批后的计划
// （approvePlan 已校验图结构与身份），模型重命名不影响存储身份。同 job 的
// 写回经互斥链串行化，避免并行完成互相覆盖。重启时在途 running 单元标
// unknown 并保留 charge，等待 lease 过期后有界重做。

import { fail } from "@/game/domain/narrativeUnit";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import type { Unit, UnitOutput } from "@/game/domain/narrativeUnit";
import type { ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import {
  readyUnits,
  collectDisclosures,
} from "@/game/gameplay/rpg/narrativePlanning";
import { projectUnitContext, narrationLayoutOf } from "./perspectiveContext";
import { approveUnit, factCertaintyCeiling, narrationLayoutRejection } from "./approveUnit";
import { disclosureReviewRequest, disclosureReviewDigest } from "./disclosureReview";
import { runDialogueConsistencyReview, dialogueRepairForUnit } from "./runDialogueConsistencyReview";
import { baselineRequestsForPlan, canStartRequest } from "./jobBudget";
import { composeSignals } from "./leaseKeeper";
import { createAiSourceFailure, persistedAiRepairReason, repairFromSourceFailure } from "../aiGenerationRetry";
import type {
  Lease,
  NarrativeJobRepository,
  StoredJob,
  StoredUnit,
} from "../server/persistence/narrativeJobRepository";
import { planningSceneContract } from "./planningSceneContract";
import { approvePlanningContext } from "./approvePlanningContext";
import type { StageExecution, StageRequest, StageSource } from "./stageSource";
import type { StageSuccess } from "./stageSource";
import type { DialogueHistoryEntry } from "./stageSource";
import { loadDialogueHistory } from "./dialogueHistory";
import { narrativeInputDigest } from "./narrativeInputDigest";

const PLANNING_UNIT_KEY = "planning";
/** 每 job 最多同时在途的 provider 请求；批调度按此上限派发。 */
const MAX_IN_FLIGHT = 2;
/**
 * 规划阶段超时（Plan 固定决策 3 的已记录偏离）：规划要产出完整骨架 JSON，
 * 比表达单元大一个量级，45s 对慢 provider 偏紧，放宽到 90s。表达单元维持
 * 45s 不变。
 */
const PLANNING_TIMEOUT_MS = 90_000;
/** 表达单元（旁白/角色/选项）超时：与固定决策 3 的 45s 一致。 */
const EXPRESSION_TIMEOUT_MS = 45_000;

function approvalRepairDetail(response: StageSuccess, rejection: string | null,
  context: Extract<StageRequest, { stage: Exclude<StageRequest["stage"], "planning"> }> ["context"]): string | undefined {
  if (rejection === "unit_output_candidate_unknown" && response.stage === "choices") {
    const index = response.value.stage === "choices" ? response.value.labels.findIndex(label =>
      !context.options.some(option => option.candidateId === label.candidateId)) : -1;
    return `labels[${index}].candidateId: not approved`;
  }
  if (rejection === "unit_output_fact_unavailable" && response.stage !== "planning"
    && response.value.stage !== "choices") {
    const ceilings = factCertaintyCeiling(context);
    for (const [partIndex, part] of response.value.parts.entries()) {
      for (const [factIndex, fact] of part.facts.entries()) {
        const ceiling = ceilings.get(fact.factId);
        if (ceiling === undefined) return `parts[${partIndex}].facts: contains unavailable fact`;
        if (ceiling === "suspected" && fact.certainty === "known")
          return `parts[${partIndex}].facts[${factIndex}].certainty: expected suspected; received known`;
      }
    }
  }
  return undefined;
}

/**
 * 按 job 剩余时间收缩请求超时：请求不得越过 job.deadline（固定决策 3
 * 「按剩余时间缩短 timeout」）。deadline 检查本身在 canStartRequest，
 * 这里只保证发起的请求不会在 deadline 之后才超时，避免「周期已死、
 * provider 还在跑」的空转。
 */
function cappedTimeoutMs(job: StoredJob, defaultMs: number, now: string): number {
  const remainingMs = Date.parse(job.deadline) - Date.parse(now);
  return Math.max(1, Math.min(defaultMs, remainingMs));
}

export type RunJobResult =
  | { readonly ok: true; readonly value: StoredJob }
  | { readonly ok: false; readonly code: string };

export type RunJobInput = Readonly<{
  id: string;
  lease: Lease;
  /** 当前执行作用域内的规划修复反馈，不写入游戏状态。 */
  planningRepair?: StageExecution["repair"];
  /** 递归规划修复复用首次只读加载的历史，不写入 StoredJob。 */
  dialogueHistory?: readonly DialogueHistoryEntry[];
}>;

export type RunJobDeps = Readonly<{
  jobs: NarrativeJobRepository;
  source: StageSource;
  now: () => string;
  signal: AbortSignal;
  /**
   * 写入前询问协调器是否续租（惰性保活）。缺省为「原样返回当前租约」，
   * 使既有测试无需改动即可走与生产相同的写入路径。返回 null 表示租约已丢，
   * 调用方必须中止——runJob 以 JOB_ABORTED 退出，不再发起新 provider 请求。
   */
  renewLease?: () => Promise<Lease | null>;
}>;

/** 存储单元类型收窄：approved 的表达单元输出。 */
function approvedOutputOf(unit: StoredUnit): UnitOutput | null {
  return unit.status === "approved" && unit.value !== null && !("steps" in (unit.value as object))
    ? unit.value as UnitOutput
    : null;
}

/** 绑定表达器实际可见的安全投影；版本升级会使旧 approved 缓存失效。 */
export function expressionProjectionDigest(context: Exclude<StageRequest, { stage: "planning" }>["context"]): string {
  return narrativeInputDigest({ version: 2, context });
}

function unitOfKey(job: StoredJob, key: string): StoredUnit | undefined {
  return job.units.find((candidate) => candidate.key === key);
}

export async function runJob(input: RunJobInput, deps: RunJobDeps): Promise<RunJobResult> {
  const loaded = await deps.jobs.get(input.id);
  if (!loaded.ok) return loaded;
  const deadline = Date.parse(loaded.value.deadline);
  const controller = new AbortController();
  const remaining = deadline - Date.parse(deps.now());
  const timer = setTimeout(() => controller.abort(), Math.max(0, remaining));
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  try {
    const result = await runJobWithinDeadline(input, { ...deps,
      signal: composeSignals(deps.signal, controller.signal) });
    if (controller.signal.aborted || Date.parse(deps.now()) >= deadline) {
      const latest = await deps.jobs.get(input.id);
      const lease = deps.renewLease === undefined ? input.lease : await deps.renewLease();
      if (lease !== null && latest.ok && latest.value.status === "pending") {
        await deps.jobs.save({ lease, expectedVersion: latest.value.version,
          job: { ...latest.value, status: "failed", failureCode: "job_deadline_exceeded" } });
      }
      return fail("job_deadline_exceeded");
    }
    return result;
  } finally { clearTimeout(timer); }
}

async function runJobWithinDeadline(input: RunJobInput, deps: RunJobDeps): Promise<RunJobResult> {
  const generate: StageSource["generate"] = async (request, execution) => {
    try { return await deps.source.generate(request, execution); }
    catch { return createAiSourceFailure("scene", "unavailable"); }
  };
  const loaded = await deps.jobs.get(input.id);
  if (!loaded.ok) return loaded;
  let job = loaded.value;
  if (job.status !== "pending") return fail("JOB_CONFLICT");
  const dialogueHistory = input.dialogueHistory ?? await loadDialogueHistory(job, deps.jobs);
  const planningContext = job.input.kind === "decision" && dialogueHistory.length > 0
    ? { ...job.input, dialogueHistory } : job.input;
  const manualRetry = job.cycle > 0
    ? { origin: "manual_failed_job" as const, mechanism: "initial" as const, attempt: 0 }
    : undefined;
  const approveGeneratedPlan = (proposal: PlanProposal) => {
    if (deps.source.requiresTaskBrief && (proposal.units.some(unit => unit.stage !== "choices"
      && (unit.task?.brief === undefined || unit.task.contentFactIds === undefined))
      || (proposal.decision?.kind === "ordinary" && proposal.decision.options.some(option => option.task?.brief === undefined
        || option.task.contentFactIds === undefined)))) {
      return { ok: false as const, code: "plan_task_missing",
        detail: "live planning task requires brief and contentFactIds" };
    }
    return approvePlanningContext(job.input, proposal);
  };

  // 惰性续租：每次写入前把租约推到 now + TTL（如已过半程）。租约丢失时
  // 立即中止——继续生成只会得到一批无法发布的单元。
  let lease: Lease = input.lease;
  const renewLease = deps.renewLease;
  async function activeLease(): Promise<Lease | null> {
    if (renewLease === undefined) return lease;
    const renewed = await renewLease();
    if (renewed === null) return null;
    lease = renewed;
    return lease;
  }

  // 重启恢复：在途 running → unknown，保留 charge（等待 lease 过期后有界重做）。
  if (job.units.some((unit) => unit.status === "running")
    || Object.values(job.planningDialogueReviews ?? {}).some(review => review.status === "running")) {
    const kept = await activeLease();
    if (kept === null) return fail("JOB_ABORTED");
    job = {
      ...job,
      ...(job.planningDialogueReviews === undefined ? {} : { planningDialogueReviews:
        Object.fromEntries(Object.entries(job.planningDialogueReviews).map(([key, review]) =>
          [key, review.status === "running" ? { ...review, status: "unknown" as const } : review])) }),
      units: job.units.map((unit) => unit.status === "running"
        ? { ...unit, status: "unknown" as const }
        : unit),
    };
    const saved = await deps.jobs.save({ lease: kept, expectedVersion: job.version, job });
    if (!saved.ok) return saved;
    job = saved.value;
  }

  // 扣费与写回互斥链：并行完成的单元串行化落盘，避免互相覆盖。
  let saveChain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(mutate: () => Promise<T>): Promise<T> => {
    const next = saveChain.then(mutate, mutate) as Promise<T>;
    saveChain = next.then(() => undefined, () => undefined);
    return next;
  };

  async function persist(mutateJob: (current: StoredJob) => StoredJob): Promise<true | string> {
    return serialized(async () => {
      const kept = await activeLease();
      if (kept === null) return "JOB_ABORTED";
      let next = mutateJob(job);
      if (next.dialogueConsistencyReview?.status === "approved"
        && (next.input !== job.input || next.units.length !== job.units.length || next.units.some(unit => {
          const before = unitOfKey(job, unit.key);
          return before?.value !== unit.value || before?.inputDigest !== unit.inputDigest;
        }))) next = { ...next, dialogueConsistencyReview: { ...next.dialogueConsistencyReview,
          status: "pending", passDigest: undefined } };

      if (next.usedRequests > job.usedRequests) {
        const budget = canStartRequest({ job, unitAttempts: 0, now: deps.now() });
        if (!budget.ok) return budget.code;
      }
      // next 继承当前持久化版本；save 内部做 version CAS 后递增。
      const saved = await deps.jobs.save({ lease: kept, expectedVersion: next.version, job: next });
      if (!saved.ok) return saved.code;
      job = saved.value;
      return true;
    });
  }

  function patchedUnit(job: StoredJob, key: string, patch: Partial<StoredUnit>): StoredJob {
    return {
      ...job,
      units: job.units.map((unit) => unit.key === key ? { ...unit, ...patch } : unit),
    };
  }

  async function failJob(code: string): Promise<RunJobResult> {
    await persist((current) => ({
      ...current,
      status: "failed",
      failureCode: code,
    }));
    return fail(code);
  }

  function approvedOutputs(current: StoredJob): ReadonlyMap<string, UnitOutput> {
    const map = new Map<string, UnitOutput>();
    for (const unit of current.units) {
      const output = approvedOutputOf(unit);
      if (output !== null) map.set(unit.key, output);
    }
    return map;
  }

  if (deps.now() >= job.deadline) return failJob("job_deadline_exceeded");
  if (job.dialogueConsistencyReview?.cycle === job.cycle && job.dialogueConsistencyReview.status === "failed"
    && job.dialogueConsistencyReview.violations?.some(v => v.scope === "legacy"))
    return failJob("legacy_dialogue_contract_mismatch");
  if (job.dialogueConsistencyReview?.cycle === job.cycle && job.dialogueConsistencyReview.status === "failed"
    && job.dialogueConsistencyReview.violations?.some(v => v.scope === "planning"))
    return failJob("dialogue_consistency_planning_contract");
  if (job.dialogueConsistencyReview?.cycle === job.cycle && job.dialogueConsistencyReview.status !== "approved"
    && (job.dialogueConsistencyReview.lastFailure === "exhausted" || job.dialogueConsistencyReview.attempts >= REVIEW_MAX_REQUESTS
      || (job.dialogueConsistencyReview.attempts > 0 && job.dialogueConsistencyReview.protocolCorrections === undefined))) return failJob("dialogue_consistency_review_exhausted");

  // -----------------------------------------------------------------------
  // planning：固定逻辑 key，成功后 approvePlan 并铸造表达单元。
  // -----------------------------------------------------------------------

  let approved: ApprovedPlan | null = null;
  let planningUnit = unitOfKey(job, PLANNING_UNIT_KEY);
  let cachedPlanRepair: StageExecution["repair"] = input.planningRepair;
  if (planningUnit !== undefined && planningUnit.status === "approved"
    && planningUnit.value !== null && "steps" in (planningUnit.value as object)) {
    const proposal = planningUnit.value as PlanProposal;
    const planApproval = approveGeneratedPlan(proposal);
    if (!planApproval.ok) {
      if (planApproval.code !== "plan_mandatory_beat_mismatch" && planApproval.code !== "beat_authority_conflict"
        && planApproval.code !== "plan_dialogue_repeated" && planApproval.code !== "plan_task_missing"
        && planApproval.code !== "plan_character_response_split" && !planApproval.code.startsWith("plan_reply_")) return failJob(planApproval.code);
      cachedPlanRepair = { attempt: planningUnit.attempts, reason: "invalid_schema",
        rejectionCode: planApproval.code, detail: planApproval.detail };
      // 旧骨架的表达不可复用。先落盘撤销，保留 attempts 与 usedRequests，
      // 即使接下来预算耗尽，也能在显式手动重试的新周期正常恢复。
      const invalidated = await persist(current => ({ ...current,
        units: current.units.map(unit => ({ ...unit, status: "pending" as const, value: null })),
      }));
      if (invalidated !== true) return fail(invalidated);
      planningUnit = unitOfKey(job, PLANNING_UNIT_KEY);
    } else approved = planApproval.value;
  }
  if (approved === null) {
    const charge = canStartRequest({ job, unitAttempts: planningUnit?.attempts ?? 0, now: deps.now() });
    if (!charge.ok) return failJob(charge.code);
    if (deps.signal.aborted) return fail("JOB_ABORTED");

    const charged = await persist((current) => ({
      ...current,
      usedRequests: current.usedRequests + 1,
      units: current.units.some((unit) => unit.key === PLANNING_UNIT_KEY)
        ? patchedUnit(current, PLANNING_UNIT_KEY, { attempts: (unitOfKey(current, PLANNING_UNIT_KEY)?.attempts ?? 0) + 1, status: "running" }).units
        : [
          ...current.units,
          { unit: null, key: PLANNING_UNIT_KEY, inputDigest: current.inputDigest, attempts: 1, status: "running" as const, value: null },
        ],
    }));
    if (charged !== true) return failJob(charged);

    const request: StageRequest = { stage: "planning", context: planningContext };
    let response = await generate(request, {
      signal: deps.signal,
      timeoutMs: cappedTimeoutMs(job, PLANNING_TIMEOUT_MS, deps.now()),
      ...(cachedPlanRepair === undefined ? {} : { repair: cachedPlanRepair }),
      audit: {
        purpose: "game_api", trigger: "staged_planning", jobId: job.id,
        ...(manualRetry === undefined ? {} : { retry: manualRetry }),
      },
    });
    let repairAttempt = (planningUnit?.attempts ?? 0) + 1;
    let planApproval = response.ok && response.stage === "planning"
      ? approveGeneratedPlan(response.value) : null;
    while ((response.ok || response.failure.kind !== "AI_CALL_FAILED")
      && (!response.ok || planApproval?.ok === false) && repairAttempt < 4) {
      const retryCharge = canStartRequest({ job, unitAttempts: repairAttempt, now: deps.now() });
      if (!retryCharge.ok) return failJob(retryCharge.code);
      if (deps.signal.aborted) return fail("JOB_ABORTED");
      const retrySaved = await persist((current) => ({
        ...current,
        usedRequests: current.usedRequests + 1,
        units: current.units.map((unit) => unit.key === PLANNING_UNIT_KEY
          ? { ...unit, attempts: unit.attempts + 1 }
          : unit),
      }));
      if (retrySaved !== true) return fail(retrySaved);
      const repair = !response.ok ? repairFromSourceFailure(response, repairAttempt)
        : { attempt: repairAttempt, reason: "invalid_schema", rejectionCode: planApproval?.ok === false ? planApproval.code : "unit_output_stage_mismatch",
          ...(planApproval?.detail === undefined ? {} : { detail: planApproval.detail }) };
      response = await generate(request, {
        signal: deps.signal,
        timeoutMs: cappedTimeoutMs(job, PLANNING_TIMEOUT_MS, deps.now()),
        repair,
        audit: {
          purpose: "game_api", trigger: "staged_planning", jobId: job.id,
          ...(manualRetry === undefined ? {} : { retry: manualRetry }),
        },
      });
      repairAttempt += 1;
      planApproval = response.ok && response.stage === "planning"
        ? approveGeneratedPlan(response.value) : null;
    }
    if (!response.ok) {
      const failure = repairFromSourceFailure(response, Math.max(1, repairAttempt - 1));
      return failJob(response.failure.kind === "AI_CALL_FAILED"
        ? response.failure.kind : persistedAiRepairReason(failure));
    }
    if (deps.now() >= job.deadline) return failJob("job_deadline_exceeded");
    if (response.stage !== "planning") return failJob("unit_output_stage_mismatch");

    const proposal = response.value;
    if (planApproval === null) return failJob("unit_output_stage_mismatch");
    if (!planApproval.ok) return failJob(planApproval.code);
    approved = planApproval.value;
    const savedPlan = await persist((current) =>
      patchedUnit({ ...current, baselineRequests: baselineRequestsForPlan(planApproval.value),
        // 新骨架不再引用的旧表达缓存可以移除；已经消耗的 job 请求额度不变。
        units: current.units.filter(unit => unit.key === PLANNING_UNIT_KEY
          || planApproval.value.units.some(planned => planned.key === unit.key)),
      }, PLANNING_UNIT_KEY, { status: "approved", value: proposal }));
    if (savedPlan !== true) return failJob(savedPlan);
  }

  if (approved === null) return fail("JOB_CONFLICT");
  const baseline = baselineRequestsForPlan(approved);
  if (job.baselineRequests !== baseline) {
    const saved = await persist(current => ({ ...current, baselineRequests: baseline }));
    if (saved !== true) return fail(saved);
  }

  // -----------------------------------------------------------------------
  // 表达单元调度：readyUnits 拓扑就绪，每批最多 MAX_IN_FLIGHT 在途。
  // -----------------------------------------------------------------------

  const planUnits: readonly Unit[] = approved.units;
  const expressionUnits = planUnits;
  const unitByKey = new Map<string, Unit>(expressionUnits.map((unit) => [unit.key, unit]));

  // 旧版本可能已批准多节拍合段，随后才在装配失败。重试保留 approved 缓存，
  // 因此调度前撤销这些旁白及其传递依赖，避免继续使用旧前文。保留规划与
  // 无关单元、已扣请求和 attempts；仍经原有 charge/审批/CAS 路径有界生成。
  const invalidated = new Set(job.units.filter(stored => {
    const output = approvedOutputOf(stored);
    return unitByKey.get(stored.key)?.stage === "narration"
      && output?.stage === "narration" && (output.parts.some(part => part.beatIds.length > 1)
        || narrationLayoutRejection(output, narrationLayoutOf(approved, unitByKey.get(stored.key)!)) !== null);
  }).map(stored => stored.key));
  for (const stored of job.units) {
    if (approvedOutputOf(stored) === null) continue;
    const unit = unitByKey.get(stored.key);
    if (unit === undefined) continue;
    const prior = new Map(approvedOutputs(job));
    prior.delete(unit.key);
    const projected = projectUnitContext({ plan: approved, unit, approved: prior });
    if (!projected.ok || stored.inputDigest !== expressionProjectionDigest(projected.value)) {
      invalidated.add(unit.key);
    }
  }
  for (const stored of job.units) {
    const output = approvedOutputOf(stored);
    const unit = unitByKey.get(stored.key);
    if (output?.stage !== "character" || unit === undefined) continue;
    const prior = new Map(approvedOutputs(job)); prior.delete(unit.key);
    const context = projectUnitContext({ plan: approved, unit, approved: prior });
    if (!context.ok) { invalidated.add(unit.key); continue; }
    const request = disclosureReviewRequest({ plan: approved, unit, output, context: context.value, approved: prior });
    if (!request.ok || (request.value !== null
      && stored.disclosureReviewDigest !== disclosureReviewDigest(unit, output, request.value))) invalidated.add(unit.key);
  }
  if (invalidated.size > 0) {
    for (;;) {
      const previousSize = invalidated.size;
      for (const unit of expressionUnits) {
        if (unit.dependencies.some(key => invalidated.has(key))) invalidated.add(unit.key);
      }
      if (invalidated.size === previousSize) break;
    }
    const saved = await persist(current => ({
      ...current,
      units: current.units.map(unit => invalidated.has(unit.key)
        ? { ...unit, status: "pending" as const, value: null } : unit),
    }));
    if (saved !== true) return fail(saved);
  }

  const preflight = await runPlanningDialogueReview({ plan: approved, getJob: () => job, persist,
    source: deps.source, signal: deps.signal, now: deps.now });
  if (!preflight.ok) return failJob(preflight.code);

  for (;;) {
    if (deps.signal.aborted) return fail("JOB_ABORTED");
    const approvedKeys = new Set(
      job.units.filter((unit) => unit.status === "approved").map((unit) => unit.key),
    );
    const retriable = job.units.filter((unit) =>
      unit.status !== "approved" && unit.key !== PLANNING_UNIT_KEY && unitByKey.has(unit.key));
    const readyPlanUnits = readyUnits(expressionUnits, approvedKeys)
      .filter((unit) => {
        const stored = unitOfKey(job, unit.key);
        return stored === undefined || stored.status === "pending";
      });
    // unknown/failed/unknown 状态的旧单元也有界重做（拓扑已就绪即可）。
    const redonePlanUnits = retriable
      .map((stored) => unitByKey.get(stored.key))
      .filter((unit): unit is Unit => unit !== undefined)
      .filter((unit) => unit.dependencies.every((dep) => approvedKeys.has(dep)));
    const batch = [...new Map([...readyPlanUnits, ...redonePlanUnits].map(unit => [unit.key, unit])).values()].slice(0, MAX_IN_FLIGHT);
    if (batch.length === 0) break;

    const failures: string[] = [];
    for (const unit of batch) {
      const planningReview = await runPlanningDialogueReview({ plan: approved, getJob: () => job, persist,
        source: deps.source, signal: deps.signal, now: deps.now, unitKey: unit.key });
      if (!planningReview.ok) return failJob(planningReview.code);
      const stored = unitOfKey(job, unit.key);
      const attempts = stored?.attempts ?? 0;
      const charge = canStartRequest({ job, unitAttempts: attempts, now: deps.now() });
      if (!charge.ok) {
        failures.push(charge.code);
        continue;
      }
      const context = projectUnitContext({
        plan: approved,
        unit,
        approved: approvedOutputs(job),
      });
      if (!context.ok) {
        if (context.code === "beat_authority_conflict") {
          const invalidated = await persist(current => ({ ...current,
            units: current.units.map(stored => ({ ...stored, status: "pending" as const, value: null })),
          }));
          if (invalidated !== true) return fail(invalidated);
          return runJob({ id: input.id, lease, dialogueHistory, planningRepair: {
            attempt: unitOfKey(job, PLANNING_UNIT_KEY)?.attempts ?? 0,
            reason: "invalid_schema", rejectionCode: context.code, detail: JSON.stringify({
              approvedWorldDelta: approved.proposal.worldDelta,
              ...(approved.ruleSceneGraph === undefined ? {} : {
                sceneContract: planningSceneContract(approved.ruleSceneGraph, job.input.kind === "decision" ? job.input.job.focusNpcId ?? null : null),
              }),
              ...JSON.parse(context.detail ?? "{}"),
            }),
          } }, deps);
        }
        failures.push(context.code);
        continue;
      }
      const projectionDigest = expressionProjectionDigest(context.value);
      // charge/save running 先于请求；新单元在此首次写入存储。
      const charged = await persist((current) => ({
        ...current,
        usedRequests: current.usedRequests + 1,
        units: current.units.some((candidate) => candidate.key === unit.key)
          ? current.units.map((candidate) => candidate.key === unit.key
            ? { ...candidate, inputDigest: projectionDigest, attempts: attempts + 1, status: "running" as const, unit }
            : candidate)
          : [
            ...current.units,
            { unit, key: unit.key, inputDigest: projectionDigest, attempts: attempts + 1, status: "running" as const, value: null },
          ],
      }));
      if (charged !== true) {
        failures.push(charged);
        continue;
      }

      const request: StageRequest = { stage: unit.stage, context: context.value };
      const dialogueRepair = dialogueRepairForUnit(job, unit.key, context.value.options.map(option => option.candidateId));
      let response = await generate(request, {
        ...(dialogueRepair.length === 0 ? {} : { repair: { attempt: attempts, reason: "invalid_schema",
          rejectionCode: "dialogue_consistency_rejected", detail: JSON.stringify({ violations: dialogueRepair }) } }),
        signal: deps.signal,
        timeoutMs: cappedTimeoutMs(job, EXPRESSION_TIMEOUT_MS, deps.now()),
        audit: { purpose: "game_api", trigger: "staged_expression", jobId: job.id,
          ...(manualRetry === undefined ? {} : { retry: manualRetry }) },
      });
      let attemptsUsed = attempts + 1;
      // 「先重试表达」（Spec §205）：provider 失败与内容审批失败（approveUnit/
      // collectDisclosures）都在剩余额度内带修复反馈自动重试；只有额度耗尽
      // 才落 failed。确属骨架语义冲突的失败码原样上报，由外层 failJob 失效。
      let approvedOutput: UnitOutput | null = null;
      let reviewDigest: string | undefined;
      let rejection: string | null = null;
      for (;;) {
        if (deps.now() >= job.deadline) return failJob("job_deadline_exceeded");
        approvedOutput = null;
        rejection = null;
        if (!response.ok) {
          rejection = response.failure.kind;
        } else if (response.stage !== unit.stage) {
          rejection = "unit_output_stage_mismatch";
        } else {
          const unitApproval = approveUnit({ unit, context: context.value, output: response.value });
          if (!unitApproval.ok) {
            rejection = unitApproval.code;
          } else {
            const disclosures = collectDisclosures({ plan: approved, unit, output: response.value, approved: approvedOutputs(job) });
            if (!disclosures.ok) {
              rejection = disclosures.code;
            } else {
              const review = disclosureReviewRequest({ plan: approved, unit, output: response.value,
                context: context.value, approved: approvedOutputs(job) });
              if (!review.ok) rejection = review.code;
              else if (review.value === null) approvedOutput = response.value;
              else if (deps.source.reviewDisclosure === undefined) {
                rejection = "disclosure_review_unavailable";
                break;
              } else {
                // 审核独立计费且先扣预算；不增加内容单元尝试数。
                const budget = canStartRequest({ job, unitAttempts: 0, now: deps.now() });
                if (!budget.ok) return failJob(budget.code);
                if (deps.now() >= job.deadline) return failJob("job_deadline_exceeded");
                if (deps.signal.aborted) return fail("JOB_ABORTED");
                const chargedReview = await persist(current => ({ ...current, usedRequests: current.usedRequests + 1 }));
                if (chargedReview !== true) return fail(chargedReview);
                let result;
                try { result = await deps.source.reviewDisclosure(review.value, {
                  signal: deps.signal, timeoutMs: cappedTimeoutMs(job, 30_000, deps.now()),
                  audit: { purpose: "staged_narrative_generation", trigger: "disclosure_review",
                    jobId: job.id, unitKey: unit.key, cycle: job.cycle,
                    inputDigest: disclosureReviewDigest(unit, response.value, review.value) },
                }); } catch { result = createAiSourceFailure("scene", "unavailable"); }
                if (deps.now() >= job.deadline) return failJob("job_deadline_exceeded");
                if (deps.signal.aborted) return fail("JOB_ABORTED");
                if (!result.ok) { rejection = "disclosure_review_failed"; break; }
                if (result.verdict !== "pass") rejection = `disclosure_review_${result.verdict}`;
                else {
                  reviewDigest = disclosureReviewDigest(unit, response.value, review.value);
                  approvedOutput = response.value;
                }
              }
            }
          }
        }
        if (approvedOutput !== null) break;
        if (!response.ok && response.failure.kind === "AI_CALL_FAILED") break;
        if (attemptsUsed >= 4) break;
        const retryCharge = canStartRequest({ job, unitAttempts: attemptsUsed, now: deps.now() });
        if (!retryCharge.ok) break;
        if (deps.signal.aborted) return fail("JOB_ABORTED");
        const retrySaved = await persist((current) => patchedUnit({ ...current, usedRequests: current.usedRequests + 1 }, unit.key, {
          attempts: attemptsUsed + 1,
          status: "running",
        }));
        if (retrySaved !== true) return fail(retrySaved);
        attemptsUsed += 1;
        const repair = !response.ok ? repairFromSourceFailure(response, attemptsUsed - 1) : {
          attempt: attemptsUsed - 1,
          reason: "invalid_schema" as const,
          rejectionCode: rejection ?? undefined,
          ...(rejection === "unit_output_beat_layout" ? { detail: JSON.stringify({
            allowedBeatIds: context.value.requiredBeats.map(beat => beat.beatId),
            allowAtmosphere: context.value.narrationLayout?.allowAtmosphere,
            repairInstruction: context.value.narrationLayout?.allowAtmosphere === false
              ? "本单元每个 part.beatIds 必须恰好一个上列 ID，不能出现 [] 或 atmosphere。不要添加开头或结尾的独立氛围段；只表达本单元的具体节拍。"
              : "先按节拍连续表达完必选内容，再写氛围；不能先写 beatIds=[] 再插入必选节拍。",
          }) } : response.ok ? (() => {
            const detail = approvalRepairDetail(response, rejection, context.value);
            return detail === undefined ? {} : { detail };
          })() : {}),
        };
        response = await generate(request, {
          signal: deps.signal,
          timeoutMs: cappedTimeoutMs(job, EXPRESSION_TIMEOUT_MS, deps.now()),
          repair,
          audit: { purpose: "game_api", trigger: "staged_expression", jobId: job.id,
            ...(manualRetry === undefined ? {} : { retry: manualRetry }) },
        });
      }
      if (approvedOutput === null) {
        await persist((current) => patchedUnit(current, unit.key, { status: "failed" }));
        const terminal = !response.ok
          ? (response.failure.kind === "AI_CALL_FAILED" ? response.failure.kind
            : persistedAiRepairReason(repairFromSourceFailure(response, attemptsUsed)))
          : rejection ?? "unknown_failure";
        failures.push(terminal);
        continue;
      }
      const approvedSave = await persist((current) => patchedUnit(current, unit.key, {
        status: "approved",
        value: approvedOutput,
        disclosureReviewDigest: reviewDigest,
      }));
      if (approvedSave !== true) failures.push(approvedSave);
    }
    if (failures.length > 0) {
      return failJob(failures[0] ?? "unknown_failure");
    }
  }

  // 全部单元 approved：返回待发布的 pending job。
  if (!job.units.every((unit) => unit.status === "approved")) {
    return failJob("unit_output_missing");
  }
  if (deps.now() >= job.deadline) return failJob("job_deadline_exceeded");
  const planningCoverage = validatePlanningDialogueReviews(job, approved);
  if (!planningCoverage.ok) return failJob(planningCoverage.code);
  const review = await runDialogueConsistencyReview({ plan: approved, getJob: () => job, persist,
    source: deps.source, signal: deps.signal, now: deps.now });
  if (!review.ok) return review.code === "JOB_ABORTED" || review.code === "LEASE_LOST" || review.code === "JOB_CONFLICT"
    ? fail(review.code) : failJob(review.code);
  if (review.repair) return runJob({ ...input, lease, dialogueHistory }, deps);
  return { ok: true, value: job };
}
