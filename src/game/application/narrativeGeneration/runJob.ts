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
  approvePlan,
  readyUnits,
  collectDisclosures,
} from "@/game/gameplay/rpg/narrativePlanning";
import { projectUnitContext } from "./perspectiveContext";
import { approveUnit } from "./approveUnit";
import { canStartRequest } from "./jobBudget";
import type {
  Lease,
  NarrativeJobRepository,
  StoredJob,
  StoredUnit,
} from "../server/persistence/narrativeJobRepository";
import type { PlanningContext, StageRequest, StageSource } from "./stageSource";
import type { AiSourceFailure } from "@/game/application/aiGenerationRetry";

const PLANNING_UNIT_KEY = "planning";
/** 每 job 最多同时在途的 provider 请求；批调度按此上限派发。 */
const MAX_IN_FLIGHT = 2;

export type RunJobResult =
  | { readonly ok: true; readonly value: StoredJob }
  | { readonly ok: false; readonly code: string };

export type RunJobInput = Readonly<{
  id: string;
  lease: Lease;
}>;

export type RunJobDeps = Readonly<{
  jobs: NarrativeJobRepository;
  source: StageSource;
  now: () => string;
  signal: AbortSignal;
}>;

/** 存储单元类型收窄：approved 的表达单元输出。 */
function approvedOutputOf(unit: StoredUnit): UnitOutput | null {
  return unit.status === "approved" && unit.value !== null && !("steps" in (unit.value as object))
    ? unit.value as UnitOutput
    : null;
}

function unitOfKey(job: StoredJob, key: string): StoredUnit | undefined {
  return job.units.find((candidate) => candidate.key === key);
}

/**
 * 按 planning context 审批计划：opening 用初始化 envelope（generation/gameLength/seed）
 * 重建结构，不读 job.input 之外的现成世界/剧情；decision 用权威状态。
 * 任一路径都不允许「拿假的 world/story 充数」。
 */
function approvePlanningContext(
  input: PlanningContext,
  proposal: PlanProposal,
): ReturnType<typeof approvePlan> {
  if (input.kind === "opening") {
    return approvePlan({
      kind: "opening",
      proposal,
      generation: input.generation,
      gameLength: input.input.gameLength,
      seed: input.input.seed,
    });
  }
  return approvePlan({
    kind: "decision",
    proposal,
    world: input.world,
    story: input.story,
  });
}

export async function runJob(input: RunJobInput, deps: RunJobDeps): Promise<RunJobResult> {
  const loaded = await deps.jobs.get(input.id);
  if (!loaded.ok) return loaded;
  let job = loaded.value;
  if (job.status !== "pending") return fail("JOB_CONFLICT");

  // 重启恢复：在途 running → unknown，保留 charge（等待 lease 过期后有界重做）。
  if (job.units.some((unit) => unit.status === "running")) {
    job = {
      ...job,
      units: job.units.map((unit) => unit.status === "running"
        ? { ...unit, status: "unknown" as const }
        : unit),
    };
    const saved = await deps.jobs.save({ lease: input.lease, expectedVersion: job.version, job });
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
      const next = mutateJob(job);
      // next 继承当前持久化版本；save 内部做 version CAS 后递增。
      const saved = await deps.jobs.save({ lease: input.lease, expectedVersion: next.version, job: next });
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

  // -----------------------------------------------------------------------
  // planning：固定逻辑 key，成功后 approvePlan 并铸造表达单元。
  // -----------------------------------------------------------------------

  let approved: ApprovedPlan | null = null;
  const planningUnit = unitOfKey(job, PLANNING_UNIT_KEY);
  if (planningUnit !== undefined && planningUnit.status === "approved"
    && planningUnit.value !== null && "steps" in (planningUnit.value as object)) {
    const proposal = planningUnit.value as PlanProposal;
    const planApproval = approvePlanningContext(job.input, proposal);
    if (!planApproval.ok) return failJob(planApproval.code);
    approved = planApproval.value;
  } else {
    const charge = canStartRequest({ job, unitAttempts: 0, now: deps.now() });
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

    const request: StageRequest = { stage: "planning", context: job.input };
    let response = await deps.source.generate(request, {
      signal: deps.signal,
      timeoutMs: 90_000,
      audit: { purpose: "game_api", trigger: "staged_planning", jobId: job.id },
    });
    let repairAttempt = 1;
    while (!response.ok && repairAttempt < 4) {
      const retryCharge = canStartRequest({ job, unitAttempts: 0, now: deps.now() });
      if (!retryCharge.ok) return failJob(retryCharge.code);
      if (deps.signal.aborted) return fail("JOB_ABORTED");
      await persist((current) => ({
        ...current,
        usedRequests: current.usedRequests + 1,
        units: current.units.map((unit) => unit.key === PLANNING_UNIT_KEY
          ? { ...unit, attempts: unit.attempts + 1 }
          : unit),
      }));
      response = await deps.source.generate(request, {
        signal: deps.signal,
        timeoutMs: 90_000,
        audit: { purpose: "game_api", trigger: "staged_planning", jobId: job.id },
      });
      repairAttempt += 1;
    }
    if (!response.ok) {
      return failJob(response.failure.kind);
    }
    if (response.stage !== "planning") return failJob("unit_output_stage_mismatch");

    const proposal = response.value;
    const planApproval = approvePlanningContext(job.input, proposal);
    if (!planApproval.ok) return failJob(planApproval.code);
    approved = planApproval.value;
    const savedPlan = await persist((current) =>
      patchedUnit(current, PLANNING_UNIT_KEY, { status: "approved", value: proposal }));
    if (savedPlan !== true) return failJob(savedPlan);
  }

  if (approved === null) return fail("JOB_CONFLICT");

  // -----------------------------------------------------------------------
  // 表达单元调度：readyUnits 拓扑就绪，每批最多 MAX_IN_FLIGHT 在途。
  // -----------------------------------------------------------------------

  const planUnits: readonly Unit[] = approved.units;
  const expressionUnits = planUnits;
  const unitByKey = new Map<string, Unit>(expressionUnits.map((unit) => [unit.key, unit]));

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
    const batch = [...readyPlanUnits, ...redonePlanUnits].slice(0, MAX_IN_FLIGHT);
    if (batch.length === 0) break;

    const failures: string[] = [];
    for (const unit of batch) {
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
        failures.push(context.code);
        continue;
      }
      // charge/save running 先于请求；新单元在此首次写入存储。
      const charged = await persist((current) => ({
        ...current,
        units: current.units.some((candidate) => candidate.key === unit.key)
          ? current.units.map((candidate) => candidate.key === unit.key
            ? { ...candidate, attempts: attempts + 1, status: "running" as const, unit }
            : candidate)
          : [
            ...current.units,
            { unit, key: unit.key, inputDigest: current.inputDigest, attempts: attempts + 1, status: "running" as const, value: null },
          ],
      }));
      if (charged !== true) {
        failures.push(charged);
        continue;
      }

      const request: StageRequest = { stage: unit.stage, context: context.value };
      let response = await deps.source.generate(request, {
        signal: deps.signal,
        timeoutMs: 45_000,
        audit: { purpose: "game_api", trigger: "staged_expression", jobId: job.id },
      });
      let repair: AiSourceFailure | undefined = response.ok ? undefined : response;
      let attemptsUsed = attempts + 1;
      while (!response.ok && attemptsUsed < 4) {
        const retryCharge = canStartRequest({ job, unitAttempts: attemptsUsed, now: deps.now() });
        if (!retryCharge.ok) break;
        if (deps.signal.aborted) return fail("JOB_ABORTED");
        await persist((current) => patchedUnit(current, unit.key, {
          attempts: attemptsUsed + 1,
          status: "running",
        }));
        attemptsUsed += 1;
        response = await deps.source.generate(request, {
          signal: deps.signal,
          timeoutMs: 45_000,
          repair: repair === undefined ? undefined : {
            attempt: attemptsUsed - 1,
            reason: repair.failure.kind,
          },
          audit: { purpose: "game_api", trigger: "staged_expression", jobId: job.id },
        });
        repair = response.ok ? undefined : response;
      }
      if (!response.ok) {
        await persist((current) => patchedUnit(current, unit.key, { status: "failed" }));
        failures.push(response.failure.kind);
        continue;
      }
      if (response.stage !== unit.stage) {
        failures.push("unit_output_stage_mismatch");
        continue;
      }
      const output = response.value;
      const unitApproval = approveUnit({ unit, context: context.value, output });
      if (!unitApproval.ok) {
        await persist((current) => patchedUnit(current, unit.key, { status: "failed" }));
        failures.push(unitApproval.code);
        continue;
      }
      const disclosures = collectDisclosures({ plan: approved, unit, output });
      if (!disclosures.ok) {
        await persist((current) => patchedUnit(current, unit.key, { status: "failed" }));
        failures.push(disclosures.code);
        continue;
      }
      const approvedSave = await persist((current) => patchedUnit(current, unit.key, {
        status: "approved",
        value: output,
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
  return { ok: true, value: job };
}
