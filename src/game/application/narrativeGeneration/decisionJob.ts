// 决策任务的持久化编排（Plan 2026-09-09 / Task 10 Step 3）。
//
// 决策与初始化共享同一套 DAG 调度（runJob）与整包发布（publishJob），差别只在
// 输入与发布载荷：决策任务的 PlanningContext 是权威 world/story 快照 + 已提交
// 的 pending job，发布载荷是 ApplyStateInput。本模块负责：
//   startDecisionJob —— 从已提交的 provider_pending job 幂等补建 durable 任务
//                        （绝不提前调用 provider；同 jobId 复用已有任务）
//   runDecision —— 协调器租约作用域内 claim→runJob→装配→审批→publishJob→release
//
// 关键约束（Plan Task 10）：
//   - decision start 与 provider_pending 关联不能出现「一个提交成功而另一个
//     永久丢失」：ensure 从已提交 pending job 幂等补建 task。
//   - 「防重试乘法」：旧实现是「单个 provider 请求 × 四次完整包循环」，现在是
//     「有界 DAG 单元 × 每单元有界修复」，重试不再成倍放大调用。
//   - current 游戏读取保持只读：本模块只从已提交状态读取，不写回游戏记录；
//     唯一的写回是 publishJob 内的原子发布。

import { createHash } from "node:crypto";
import type { GameId } from "../server/persistence/gameRepository";
import type { GameRecord } from "../server/persistence/gameRepository";
import type { NarrativeRuntimeState } from "@/game/domain/narrative";
import type { StoryState } from "@/game/domain/storyState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
import { commitEventDrafts } from "@/game/domain/eventLedger";
import { reconcileCommittedMemory } from "../reconcileCommittedMemory";
import { approveNarrativeBundle, type ApprovedNarrativeBundle } from "../approveNarrativeBundle";
import { buildWorldDeltaEntityContextClosure } from "../entityContextProjection";
import { approvePlanningContext, stagedEvolutionNeed } from "./approvePlanningContext";
import type { UnitOutput } from "@/game/domain/narrativeUnit";
import { validateStagedOutputs } from "./validateStagedOutputs";
import { realizeObservations } from "./realizeObservations";
import { assembleBundle } from "./assembleBundle";
import { publishJob } from "./publishJob";
import { runJob } from "./runJob";
import { LEASE_TTL_MS, composeSignals, startLeaseKeeper } from "./leaseKeeper";
import type {
  JobCheck,
  Lease,
  NarrativeJobRepository,
  Publication,
  StoredJob,
} from "../server/persistence/narrativeJobRepository";
import type { StageSource } from "./stageSource";

// ---------------------------------------------------------------------------
// start：从已提交 pending job 幂等补建 durable 决策任务
// ---------------------------------------------------------------------------

export type StartDecisionJobInput = Readonly<{
  record: GameRecord;
  now: () => string;
}>;

export type StartDecisionJobResult =
  | { readonly ok: true; readonly job: StoredJob; readonly reused: boolean }
  | { readonly ok: false; readonly code: "NOT_PENDING" | "JOB_CONFLICT" | "INFRASTRUCTURE_FAILURE" | "UNSUPPORTED_JOB" };

/** 由 gameId + jobId + revision 派生的稳定任务 id：同一 pending job 必然同一任务。 */
export function decisionJobId(gameId: GameId, pendingJob: PendingNarrativeJob, revision: number): string {
  return `dec_${createHash("sha256")
    .update(`${String(gameId)}:${String(pendingJob.jobId)}:${revision}`)
    .digest("hex")
    .slice(0, 32)}`;
}

/** 决策任务输入摘要：world/story/job/revision 任一变化都必须判为冲突。 */
export function decisionDigest(input: Readonly<{
  gameId: GameId;
  revision: number;
  job: PendingNarrativeJob;
}>): string {
  return createHash("sha256")
    .update(JSON.stringify({
      gameId: String(input.gameId),
      revision: input.revision,
      jobId: String(input.job.jobId),
      turnNumber: input.job.turnNumber,
      actionId: input.job.actionId,
    }))
    .digest("hex");
}

/**
 * 幂等补建决策任务：ensure 可从已提交的 provider_pending job 直接调用，
 * 不提前调用 provider。同 jobId 已存在时复用（不重复创建、不重复计费）。
 */
export async function startDecisionJob(
  input: StartDecisionJobInput,
  jobs: NarrativeJobRepository,
): Promise<StartDecisionJobResult> {
  const { record } = input;
  const narrative = record.storyState.narrative;
  if (narrative.status !== "provider_pending") return { ok: false, code: "NOT_PENDING" };

  const pendingJob = narrative.job;
  const digest = decisionDigest({
    gameId: record.gameId,
    revision: record.revision,
    job: pendingJob,
  });
  const jobId = decisionJobId(record.gameId, pendingJob, record.revision);

  // 复用判定必须在 start 前读取：新创建与复用在 start 返回上不可区分。
  const existing = await jobs.get(jobId);
  if (existing.ok) return { ok: true, job: existing.value, reused: true };

  const job: StoredJob = {
    schemaVersion: 1,
    id: jobId,
    scope: "decision",
    version: 0,
    cycle: 0,
    status: "pending",
    input: {
      kind: "decision",
      world: record.worldState,
      story: record.storyState,
      job: pendingJob,
    },
    inputDigest: digest,
    baseRevision: record.revision,
    gameId: String(record.gameId),
    units: [],
    usedRequests: 0,
    baselineRequests: 6,
    deadline: new Date(Date.parse(input.now()) + 600_000).toISOString(),
    failureCode: null,
    initialization: null,
  };

  const started = await jobs.start({ requestId: jobId, digest, job });
  if (!started.ok) {
    const code = started.code === "JOB_CONFLICT" || started.code === "UNSUPPORTED_JOB"
      ? started.code
      : "INFRASTRUCTURE_FAILURE";
    return { ok: false, code };
  }
  return { ok: true, job: started.value, reused: false };
}

// ---------------------------------------------------------------------------
// 装配与审批：把已批准单元输出装配成决策发布载荷
// ---------------------------------------------------------------------------

function approvedOutputOf(unit: StoredJob["units"][number]): UnitOutput | null {
  return unit.status === "approved" && unit.value !== null && !("steps" in (unit.value as object))
    ? unit.value as UnitOutput
    : null;
}

export type BuildDecisionPublicationInput = Readonly<{
  job: StoredJob;
  createdAt: string;
}>;

export type BuildDecisionPublicationResult =
  | { readonly ok: true; readonly publication: Publication; readonly approved: ApprovedNarrativeBundle }
  | { readonly ok: false; readonly code: string };

/**
 * 由已批准计划与已批准表达单元装配决策发布载荷：
 *   assembleBundle（表达装配）→ approveNarrativeBundle（规则审批 + 事件铸造）
 *   → 事件账本提交 → 记忆重建 → ApplyStateInput。
 * 本体不写回游戏状态；写回由 publishJob 的原子发布完成。
 */
export function buildDecisionPublication(
  input: BuildDecisionPublicationInput,
): BuildDecisionPublicationResult {
  const { job } = input;
  if (job.input.kind !== "decision") return { ok: false, code: "decision_input_missing" };

  const planningUnit = job.units.find((unit) => unit.key === "planning");
  const planValue = planningUnit?.value ?? null;
  if (planValue === null || !("steps" in (planValue as object))) {
    return { ok: false, code: "decision_plan_missing" };
  }
  const planProposal = planValue as import("@/game/domain/narrativePlan").PlanProposal;

  const planApproval = approvePlanningContext(job.input, planProposal);
  if (!planApproval.ok) return { ok: false, code: planApproval.code };
  const approvedPlan = planApproval.value;

  const approvedOutputs = new Map<string, UnitOutput>();
  for (const unit of job.units) {
    const output = approvedOutputOf(unit);
    if (output !== null) approvedOutputs.set(unit.key, output);
  }

  const assembled = assembleBundle({ plan: approvedPlan, approved: approvedOutputs });
  if (!assembled.ok) return { ok: false, code: assembled.code };

  const { world, story, job: pendingJob } = job.input;
  const transition: ObjectiveTransition = pendingJob.objectiveTransition;

  // objectiveLink 只能来自权威 ObjectiveTransition：装配产物不携带链接时按
  // 服务端目标派生（有 after 即 progress，无 after 必须 null）。provider 文本
  // 不参与链接，避免「模型自报目标」与权威目标不一致。
  const proposal = withAuthoritativeObjectiveLink(assembled.value, transition);

  const approvalResult = approveNarrativeBundle({
    proposal,
    worldState: world,
    storyState: story,
    transition,
    evolutionNeed: stagedEvolutionNeed(story),
    jobId: pendingJob.jobId,
    mandatoryBeats: pendingJob.mandatoryBeats,
    entityContextClosure: buildWorldDeltaEntityContextClosure({ worldState: world, storyState: story, job: pendingJob }),
    // applyState 在下一个 revision 提交已批准场景：choice token 必须以该
    // revision 铸造，否则读模型会把新生成的所有选项判为过期。baseRevision
    // 是任务创建时读到的权威 revision，publish 的 CAS 也锚定它。
    basedOnRevision: (job.baseRevision ?? 0) + 1,
    plan: approvedPlan,
    approvedUnits: approvedOutputs,
    observationReceipts: new Set((proposal.currentScene.conditionalEvidence ?? []).map(entry => `${entry.audienceId}:${entry.observationKey}`)),
    eventContext: {
      turnId: pendingJob.turnId,
      turnNumber: pendingJob.turnNumber,
      actionId: pendingJob.actionId,
      domainEventIds: pendingJob.domainEventIds,
      episodeKey: String(pendingJob.turnId),
      eventKey: `blueprint_expanded:${pendingJob.jobId}:bundle`,
    },
    now: () => input.createdAt,
  });
  if (!approvalResult.ok) return { ok: false, code: approvalResult.code };
  const approved = approvalResult.approved;

  const narrative = story.narrative;
  const readyNarrative: NarrativeRuntimeState = {
    status: "ready",
    mode: narrative.status === "ready" || narrative.status === "provider_pending" || narrative.status === "provider_failed"
      ? narrative.mode
      : "ai",
    currentScene: approved.currentScene,
    choiceRegistry: approved.choiceRegistry,
    narrativeBundle: approved.bundle,
    ...(narrative.status === "provider_pending" && narrative.dialogueSession !== undefined
      ? { dialogueSession: narrative.dialogueSession }
      : {}),
  };

  const validated = validateStagedOutputs(approvedPlan, approvedOutputs);
  if (!validated.ok) return validated;
  const realized = realizeObservations({
    worldState: approved.nextWorldState, stepId: "current",
    observations: validated.value.observations.filter(observation => observation.point.stepKey === "current").map(observation => ({
      key: observation.key, factId: observation.fact.factId, certainty: observation.fact.certainty, source: observation.source,
    })),
    conditionalEvidence: proposal.currentScene.conditionalEvidence ?? [],
    turnId: pendingJob.turnId, actionId: pendingJob.actionId, turnNumber: pendingJob.turnNumber,
    episodeKey: String(pendingJob.turnId), locationId: approved.nextWorldState.currentLocationId, causeKeys: [],
  });
  if (!realized.ok) return realized;
  const eventCommit = commitEventDrafts({
    ledger: world.eventLedger,
    drafts: [...approved.eventDrafts, ...realized.drafts],
    source: {
      turnId: pendingJob.turnId,
      actionId: pendingJob.actionId,
      turnNumber: pendingJob.turnNumber,
      committedAt: input.createdAt,
    },
    entityStore: realized.worldState.entityStore,
  });
  if (!eventCommit.ok) return { ok: false, code: `decision_event_commit_rejected:${eventCommit.code}` };

  const nextWorldState = { ...realized.worldState, eventLedger: eventCommit.ledger };
  const nextStoryState: StoryState = {
    ...approved.nextStoryStatePreview,
    narrative: readyNarrative,
    memory: reconcileCommittedMemory({
      previous: approved.nextStoryStatePreview.memory,
      ledger: eventCommit.ledger,
    }),
  };

  return {
    ok: true,
    approved,
    publication: {
      kind: "decision",
      input: {
        gameId: job.gameId === null ? ("" as GameId) : (job.gameId as GameId),
        expectedRevision: job.baseRevision ?? 0,
        nextWorldState,
        nextStoryState,
      },
    },
  };
}

/**
 * 把装配产物的 objectiveLink 收敛到权威 ObjectiveTransition：
 * 有 after 时每个场景链接同一目标（线性图的目标身份由服务端持有），无 after
 * 时必须为 null。链接 mode 由服务端派生（progress），不采信模型自报目标。
 */
function withAuthoritativeObjectiveLink(
  proposal: import("@/game/domain/narrativeBundle").NarrativeBundleProposal,
  transition: ObjectiveTransition,
): import("@/game/domain/narrativeBundle").NarrativeBundleProposal {
  const link = transition.after === null
    ? null
    : {
        questId: String(transition.after.questId),
        objectiveIndex: transition.after.objectiveIndex,
        mode: "progress" as const,
      };
  return {
    ...proposal,
    currentScene: { ...proposal.currentScene, objectiveLink: link },
    continuationScenes: proposal.continuationScenes.map((step) => ({
      ...step,
      scene: { ...step.scene, objectiveLink: link },
    })),
  };
}

// ---------------------------------------------------------------------------
// run：协调器租约作用域内的完整执行
// ---------------------------------------------------------------------------

export type RunDecisionDeps = Readonly<{
  jobs: NarrativeJobRepository;
  source: StageSource;
  now: () => string;
  signal: AbortSignal;
  createdAt: string;
}>;

export type RunDecisionResult =
  | { readonly ok: true; readonly job: StoredJob }
  | { readonly ok: false; readonly code: string };

/**
 * 完整决策执行：claim → 启动续租 → runJob 生成与审批 → 装配审批 →
 * publishJob → 停止续租并 fenced release。租约丢失时保活层 abort，runJob
 * 在下一次 signal 检查处中止；release 只按当前租约 fenced 释放。
 */
export async function runDecision(
  id: string,
  owner: string,
  deps: RunDecisionDeps,
): Promise<RunDecisionResult> {
  const loaded = await deps.jobs.get(id);
  if (!loaded.ok) return { ok: false, code: loaded.code };
  if (loaded.value.scope !== "decision") return { ok: false, code: "JOB_CONFLICT" };

  const controller = new AbortController();
  const claimed = await deps.jobs.claim({
    id,
    owner,
    now: deps.now(),
    expiresAt: new Date(Date.parse(deps.now()) + LEASE_TTL_MS).toISOString(),
  });
  if (!claimed.ok) return { ok: false, code: claimed.code };
  const lease: Lease = claimed.value;

  const keeper = startLeaseKeeper({
    jobs: deps.jobs,
    lease,
    now: deps.now,
    controller,
  });

  async function failed(code: string): Promise<RunDecisionResult> {
    const current = await deps.jobs.get(id);
    const held = await keeper.acquire();
    if (current.ok && current.value.status === "pending" && held !== null) {
      await keeper.jobs.save({ lease: held, expectedVersion: current.value.version,
        job: { ...current.value, status: "failed", failureCode: code } });
    }
    return { ok: false, code };
  }

  try {
    const ran = await runJob({ id, lease }, {
      jobs: keeper.jobs,
      source: deps.source,
      now: deps.now,
      signal: composeSignals(deps.signal, controller.signal),
      // 惰性续租：runJob 在每次 save 前询问租约是否已过半程。
      renewLease: () => keeper.acquire(),
    });
    if (!ran.ok) return { ok: false, code: ran.code };

    const latest = await deps.jobs.get(id);
    if (!latest.ok) return { ok: false, code: latest.code };
    const pendingJob = latest.value;

    // 发布前最后续租：生成结束到 publish 之间可能已跨过 TTL 边界。
    const activeLease = await keeper.acquire();
    if (activeLease === null) return { ok: false, code: "LEASE_LOST" };

    const built = buildDecisionPublication({ job: pendingJob, createdAt: deps.createdAt });
    if (!built.ok) return await failed(built.code);

    const published = await publishJob(
      { job: pendingJob, lease: activeLease, publication: built.publication },
      keeper.jobs,
    );
    if (!published.ok) return await failed(published.code);
    return { ok: true, job: published.value };
  } catch {
    return await failed("decision_execution_failed");
  } finally {
    await keeper.stop();
    const releaseLease = keeper.current() ?? lease;
    await deps.jobs.release({ lease: releaseLease }).catch(() => undefined);
  }
}
/** 只读查询决策任务（供 ensure 判定 pending/failed 用）。 */
export async function queryDecision(jobId: string, jobs: NarrativeJobRepository): Promise<JobCheck<StoredJob>> {
  return jobs.get(jobId);
}
