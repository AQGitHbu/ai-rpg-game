// 初始化任务的持久化编排（Plan 2026-09-09 / Task 10）。
//
// 开局与决策共享同一套 DAG 调度（runJob）与整包发布（publishJob），差别只在
// 输入与发布载荷：初始化任务的 PlanningContext 是 opening 输入（含 envelope 里
// 的 generation/gameLength/seed），发布载荷是 CreateInitialGameInput（可带
// replace）。本模块负责：
//   startInitialization —— 幂等创建持久任务（同 requestId 同 digest 复用；异 digest 冲突）
//   installOpeningNarrative —— 把已批准表达装进 ready 叙事，安装真实 jobId
//   buildOpeningPublication —— 组装 CreateInitialGameInput（含观察兑现）
//   runInitialization —— 协调器租约作用域内 claim→runJob→安装→publishJob→release
//
// 结构性事实：结构与实体 ID 只由 approvePlan(opening) 内的 compileOpeningStructure
// 铸造；安装阶段只写已批准的 narration/character/choices 与观察，绝不重跑结构
// 编译或再次分配 ID。

import { createHash } from "node:crypto";
import type { GameLength } from "@/game/domain/newGame";
import type {
  CreateInitialGameInput,
  GameId,
  ReplaceCurrentGameInput,
} from "../server/persistence/gameRepository";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import { asNarrativeJobId } from "@/game/domain/events";
import type { NarrativeRuntimeState, NarrativeSceneState } from "@/game/domain/narrative";
import type { OpeningGenerationInput } from "../createGame";
import type { OpeningNoveltyRecord } from "@/game/domain/openingNovelty";
import { createApprovedChoice, type ApprovedChoice } from "@/game/domain/approvedChoice";
import { commitEventDrafts } from "@/game/domain/eventLedger";
import { reconcileCommittedMemory } from "../reconcileCommittedMemory";
import { approvePlanDecision, decisionIdOf, type ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import { OPENING_NPC_ID, resolveOpeningResponses } from "@/game/gameplay/rpg/openingGeneration";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { validateStagedOutputs } from "./validateStagedOutputs";
import { approvePlanningContext } from "./approvePlanningContext";
import { assembleBundle } from "./assembleBundle";
import { realizeObservations } from "./realizeObservations";
import { publishJob } from "./publishJob";
import { runJob } from "./runJob";
import { LEASE_TTL_MS, composeSignals, startLeaseKeeper } from "./leaseKeeper";
import type {
  InitializationEnvelope,
  JobCheck,
  Lease,
  NarrativeJobRepository,
  Publication,
  StoredJob,
} from "../server/persistence/narrativeJobRepository";
import type { PlanningContext, StageSource } from "./stageSource";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import type { UnitOutput } from "@/game/domain/narrativeUnit";

// ---------------------------------------------------------------------------
// start：幂等创建持久初始化任务
// ---------------------------------------------------------------------------

export type StartInitializationInput = Readonly<{
  requestId: string;
  gameId: GameId;
  gameType: OpeningGenerationInput["gameType"];
  gameLength: GameLength;
  seed: string;
  generation: GenerationMetadata;
  setup?: OpeningGenerationInput["setup"];
  target: InitializationEnvelope["target"];
  now: () => string;
}>;

export type StartInitializationResult =
  | { readonly ok: true; readonly job: StoredJob; readonly reused: boolean }
  | { readonly ok: false; readonly code: "JOB_CONFLICT" | "INFRASTRUCTURE_FAILURE" | "UNSUPPORTED_JOB" };

/** opening job 的规划上下文：不读现成世界，结构由 envelope 重建。 */
function openingPlanningContext(input: StartInitializationInput): PlanningContext {
  return {
    kind: "opening",
    generation: input.generation,
    input: {
      gameType: input.gameType,
      seed: input.seed,
      gameLength: input.gameLength,
      ...(input.setup === undefined ? {} : { setup: input.setup }),
    },
  };
}

/** requestId + 输入摘要：同 requestId 异输入必须被判为冲突，不得重新计费。 */
export function initializationDigest(input: Omit<StartInitializationInput, "now">): string {
  return createHash("sha256")
    .update(JSON.stringify({
      gameId: String(input.gameId),
      gameType: input.gameType,
      gameLength: input.gameLength,
      seed: input.seed,
      setup: input.setup ?? null,
      target: input.target,
      generationId: String(input.generation.generationId),
    }))
    .digest("hex");
}

/** 由 requestId + digest 派生的稳定 job id：同一请求必然指向同一任务。 */
export function initializationJobId(requestId: string, digest: string): string {
  return `init_${createHash("sha256").update(`${requestId}:${digest}`).digest("hex").slice(0, 32)}`;
}

/**
 * 幂等 start：同 requestId 同 digest 复用已有 job（不重复计费、不重复生成）；
 * 同 requestId 异输入由仓储 start 返回 JOB_CONFLICT。
 */
export async function startInitialization(
  input: StartInitializationInput,
  jobs: NarrativeJobRepository,
): Promise<StartInitializationResult> {
  const digest = initializationDigest(input);
  const jobId = initializationJobId(input.requestId, digest);
  const job: StoredJob = {
    schemaVersion: 1,
    id: jobId,
    scope: "initialization",
    version: 0,
    cycle: 0,
    status: "pending",
    input: openingPlanningContext(input),
    inputDigest: digest,
    baseRevision: null,
    gameId: null,
    units: [],
    usedRequests: 0,
    baselineRequests: 6,
    deadline: new Date(Date.parse(input.now()) + 600_000).toISOString(),
    failureCode: null,
    initialization: {
      requestId: input.requestId,
      newGameId: String(input.gameId),
      seed: input.seed,
      generation: input.generation,
      target: input.target,
    },
  };
  // 复用判定必须在 start 前读取：新创建与复用在 start 返回上不可区分
  // （新 job 也是 version 0 / pending）。slot 已指向同 requestId 即视为复用。
  const existing = await jobs.getInitialization();
  const reused = existing.ok && existing.value !== null
    && existing.value.initialization?.requestId === input.requestId;

  const started = await jobs.start({ requestId: input.requestId, digest, job });
  if (!started.ok) {
    const code = started.code === "JOB_CONFLICT" || started.code === "UNSUPPORTED_JOB"
      ? started.code
      : "INFRASTRUCTURE_FAILURE";
    return { ok: false, code };
  }
  return { ok: true, job: started.value, reused };
}

// ---------------------------------------------------------------------------
// 安装：把已批准表达装进 ready 叙事
// ---------------------------------------------------------------------------

function approvedOutputOf(unit: StoredJob["units"][number]): UnitOutput | null {
  return unit.status === "approved" && unit.value !== null && !("steps" in (unit.value as object))
    ? unit.value as UnitOutput
    : null;
}

/** 从 planning 单元取回计划提案；缺失即视为不可安装。 */
export function planningProposalOf(job: StoredJob): PlanProposal | null {
  const planningUnit = job.units.find((unit) => unit.key === "planning");
  const value = planningUnit?.value ?? null;
  if (value === null || !("steps" in (value as object))) return null;
  return value as PlanProposal;
}

export type InstallOpeningResult =
  | {
      readonly ok: true;
      readonly worldState: import("@/game/domain/worldState").WorldState;
      readonly narrative: NarrativeRuntimeState;
      /** 开局场景的条件证据（装配产物），供发布时兑现观察。 */
      readonly conditionalEvidence: readonly { readonly partIndex: number; readonly observationKey: string; readonly audienceId: string }[];
    }
  | { readonly ok: false; readonly code: string };

/**
 * 安装开局叙事：装配已批准表达，把 synthetic 初始化 job 替换为真实 jobId。
 * 缺单元 / 结构不符 / 立场候选缺失一律 fail-closed；不分配任何 ID。
 */
export function installOpeningNarrative(input: Readonly<{
  job: StoredJob;
  approved: ApprovedPlan;
}>): InstallOpeningResult {
  const { job, approved } = input;
  if (approved.proposal.opening === null) return { ok: false, code: "install_opening_missing" };

  const approvedOutputs = new Map<string, UnitOutput>();
  for (const unit of job.units) {
    const output = approvedOutputOf(unit);
    if (output !== null) approvedOutputs.set(unit.key, output);
  }

  const assembled = assembleBundle({ plan: approved, approved: approvedOutputs });
  if (!assembled.ok) return { ok: false, code: assembled.code };
  const proposal = assembled.value;

  if (proposal.continuationScenes.length !== 0) return { ok: false, code: "install_continuation_forbidden" };
  if (proposal.terminal.kind !== "next_decision" || proposal.terminal.target.kind !== "current_scene") {
    return { ok: false, code: "install_terminal_invalid" };
  }

  const scene = proposal.currentScene;
  const npcLine = scene.npcLine;
  if (npcLine === null || npcLine.npcId !== String(OPENING_NPC_ID)) {
    return { ok: false, code: "install_opening_npc_missing" };
  }

  const responses = resolveOpeningResponses(approved.proposal.opening);
  if (responses === null) return { ok: false, code: "install_opening_responses_invalid" };
  const responseById = new Map(responses.map((response) => [response.candidateId, response.action]));
  const choiceIds = scene.choices.map((choice) => choice.candidateId);
  if (choiceIds.length !== 2 || new Set(choiceIds).size !== 2
    || choiceIds.some((candidateId) => !responseById.has(candidateId))) {
    return { ok: false, code: "install_opening_choices_invalid" };
  }

  const decisionApproval = approvePlanDecision(approved);
  if (!decisionApproval.ok) return decisionApproval;
  const decision = decisionApproval.value.choiceExpression;
  if (decision?.kind !== "ordinary") return { ok: false, code: "install_decision_missing" };
  const decisionId = decisionIdOf(decision);
  const sceneId = `scene-${job.id}`;
  const choiceRegistry: ApprovedChoice[] = [];
  for (const choice of scene.choices) {
    const created = createApprovedChoice({
      sceneId,
      basedOnRevision: 0,
      label: choice.label,
      action: responseById.get(choice.candidateId)!,
      ...(decision.options.every(option => option.target !== null)
        ? { branch: { decisionId, candidateId: choice.candidateId } } : {}),
    });
    if (!created.ok) return { ok: false, code: "install_choice_rejected" };
    choiceRegistry.push(created.choice);
  }

  const currentScene: NarrativeSceneState = {
    sceneId,
    turn: 0,
    narration: scene.segments.map((segment) => segment.text).join("\n"),
    usedFactIds: npcLine.usedFactIds as never[],
    npcLine: {
      npcId: OPENING_NPC_ID,
      text: npcLine.text,
      emotion: npcLine.emotion,
      usedFactIds: npcLine.usedFactIds as never[],
      usedEventIds: [...npcLine.usedEventIds],
      answeredBeatIds: [...npcLine.answeredBeatIds],
    },
    choices: choiceRegistry.map((choice) => ({
      choiceToken: choice.choiceToken,
      label: choice.label,
    })),
    source: "generated",
    event: { kind: "dialogue", focusNpcId: OPENING_NPC_ID },
  };

  const narrative: NarrativeRuntimeState = {
    status: "ready",
    mode: "ai",
    currentScene,
    choiceRegistry,
    narrativeBundle: {
      contractVersion: 1,
      originJobId: asNarrativeJobId(job.id),
      steps: [],
      activeStepIds: [],
      terminal: { kind: "next_decision", target: { kind: "current_scene" } },
    },
  };

  return {
    ok: true,
    worldState: approved.world,
    narrative,
    conditionalEvidence: scene.conditionalEvidence ?? [],
  };
}

// ---------------------------------------------------------------------------
// 发布载荷：结构 world/story + 已安装叙事 + 观察兑现
// ---------------------------------------------------------------------------

export type BuildOpeningPublicationResult =
  | { readonly ok: true; readonly publication: Publication }
  | { readonly ok: false; readonly code: string };

/**
 * 由已批准计划、已安装叙事与初始化事件账本组装 opening Publication。
 * 观察在安装时兑现（开局场景立即呈现，不存在后续消费时机）。
 */
export function buildOpeningPublication(input: Readonly<{
  job: StoredJob;
  approved: ApprovedPlan;
  installed: Extract<InstallOpeningResult, { ok: true }>;
  createdAt: string;
  openingHistory?: OpeningNoveltyRecord;
  replace?: { readonly expectedCurrentGameId: GameId; readonly expectedRevision: number };
}>): BuildOpeningPublicationResult {
  const { job, approved, installed } = input;
  if (job.initialization === null) return { ok: false, code: "install_envelope_missing" };

  const proposal = planningProposalOf(job);
  if (proposal === null) return { ok: false, code: "install_plan_missing" };

  // 开局场景的条件证据（来自安装时的装配产物）：观察键必须能对上计划观察清单。
  const sceneConditional = installed.conditionalEvidence;
  const outputs = new Map(job.units.flatMap(unit => {
    const output = approvedOutputOf(unit); return output === null ? [] : [[unit.key, output] as const];
  }));
  const replay = validateStagedOutputs(approved, outputs);
  if (!replay.ok) return replay;
  const observationByKey = new Map(replay.value.observations.map((observation) => [observation.key, observation]));
  const observations = sceneConditional
    .map((entry) => observationByKey.get(entry.observationKey))
    .filter((observation): observation is NonNullable<typeof observation> => observation !== undefined)
    .map((observation) => ({
      key: observation.key,
      factId: observation.fact.factId,
      certainty: observation.fact.certainty,
      source: observation.source,
    }));

  const turnId = (() => {
    const ledger = approved.world.eventLedger;
    const last = ledger.length > 0 ? ledger[ledger.length - 1] : undefined;
    return last?.turnId ?? asNarrativeJobId(job.id) as never;
  })();

  const realized = realizeObservations({
    worldState: approved.world,
    stepId: "current",
    observations,
    conditionalEvidence: sceneConditional,
    turnId,
    actionId: "initialization",
    turnNumber: 0,
    episodeKey: "initialization",
    locationId: approved.world.currentLocationId,
    causeKeys: [],
  });
  if (!realized.ok) return { ok: false, code: realized.code };

  const committed = commitEventDrafts({
    ledger: realized.worldState.eventLedger,
    drafts: realized.drafts,
    source: {
      turnId,
      actionId: "initialization",
      turnNumber: 0,
      committedAt: input.createdAt,
    },
    entityStore: realized.worldState.entityStore,
  });
  if (!committed.ok) return { ok: false, code: "install_event_commit_rejected" };

  const nextWorldState = { ...realized.worldState, eventLedger: committed.ledger };
  const decisionApproval = approvePlanDecision(approved);
  if (!decisionApproval.ok) return decisionApproval;
  const decision = decisionApproval.value.choiceExpression;
  if (decision?.kind !== "ordinary") return { ok: false, code: "install_decision_missing" };
  const nextStoryState = {
    ...approved.story,
    branchDecisions: decision.options.every(option => option.target !== null)
      ? { ...approved.story.branchDecisions, [decisionIdOf(decision)]: decision } : approved.story.branchDecisions,
    prologueText: installed.narrative.status === "ready" ? installed.narrative.currentScene.narration : "",
    narrative: installed.narrative,
    memory: reconcileCommittedMemory({ previous: approved.story.memory, ledger: committed.ledger }),
  };

  const createInput: CreateInitialGameInput = {
    gameId: job.initialization.newGameId as GameId,
    worldState: nextWorldState,
    storyState: nextStoryState,
    createdAt: input.createdAt,
    ...(input.openingHistory === undefined ? {} : { openingHistory: input.openingHistory }),
  };

  if (input.replace === undefined) {
    return { ok: true, publication: { kind: "opening", input: createInput } };
  }
  const replaceInput: ReplaceCurrentGameInput = {
    ...createInput,
    expectedCurrentGameId: input.replace.expectedCurrentGameId,
    expectedRevision: input.replace.expectedRevision,
  };
  return { ok: true, publication: { kind: "opening", input: createInput, replace: replaceInput } };
}

// ---------------------------------------------------------------------------
// run：协调器租约作用域内的完整执行
// ---------------------------------------------------------------------------

export type RunInitializationDeps = Readonly<{
  jobs: NarrativeJobRepository;
  source: StageSource;
  now: () => string;
  signal: AbortSignal;
  createdAt: string;
  openingHistory?: OpeningNoveltyRecord;
}>;

export type RunInitializationResult =
  | { readonly ok: true; readonly job: StoredJob }
  | { readonly ok: false; readonly code: string };

/**
 * 完整初始化执行：claim → 启动续租 → runJob 生成与审批 → 安装 →
 * publishJob → 停止续租并 fenced release。租约丢失时保活层 abort，runJob 在
 * 下一次 signal 检查处中止；release 只按当前租约 fenced 释放。
 */
export async function runInitialization(
  id: string,
  owner: string,
  deps: RunInitializationDeps,
): Promise<RunInitializationResult> {
  const loaded = await deps.jobs.get(id);
  if (!loaded.ok) return { ok: false, code: loaded.code };
  const job = loaded.value;
  if (job.scope !== "initialization" || job.initialization === null) return { ok: false, code: "JOB_CONFLICT" };

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

  async function failed(code: string): Promise<RunInitializationResult> {
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
    const envelope = pendingJob.initialization;
    if (envelope === null || pendingJob.input.kind !== "opening") {
      return { ok: false, code: "JOB_CONFLICT" };
    }

    // 发布前最后续租：生成结束到 publish 之间可能已跨过 TTL 边界。
    const activeLease = await keeper.acquire();
    if (activeLease === null) return { ok: false, code: "LEASE_LOST" };

    const proposal = planningProposalOf(pendingJob);
    if (proposal === null) return { ok: false, code: "install_plan_missing" };
    // 与生成阶段共用同一审批入口，保留 opening 局部 topic → 权威 topic 的转换。
    // 仅重跑 approvePlan 会丢失 approvePlanDecision 的 canonical thread ID。
    const planApproval = approvePlanningContext(pendingJob.input, proposal);
    if (!planApproval.ok) return await failed(planApproval.code);

    const installed = installOpeningNarrative({ job: pendingJob, approved: planApproval.value });
    if (!installed.ok) return await failed(installed.code);

    const publication = buildOpeningPublication({
      job: pendingJob,
      approved: planApproval.value,
      installed,
      createdAt: deps.createdAt,
      ...(deps.openingHistory === undefined ? {} : { openingHistory: deps.openingHistory }),
      // replace 目标来自 durable envelope：这是 CAS 的唯一权威来源，
      // 不从当前存档或调用方参数反推。
      ...(envelope.target.kind === "replace"
        ? {
            replace: {
              expectedCurrentGameId: envelope.target.expectedGameId as GameId,
              expectedRevision: envelope.target.expectedRevision,
            },
          }
        : {}),
    });
    if (!publication.ok) return await failed(publication.code);

    const published = await publishJob(
      { job: pendingJob, lease: activeLease, publication: publication.publication },
      keeper.jobs,
    );
    if (!published.ok) return await failed(published.code);
    return { ok: true, job: published.value };
  } catch {
    return await failed("initialization_execution_failed");
  } finally {
    await keeper.stop();
    const releaseLease = keeper.current() ?? lease;
    await deps.jobs.release({ lease: releaseLease }).catch(() => undefined);
  }
}

/** 保留给 UI 的受众常量引用，避免未使用导入。 */
export const INITIALIZATION_PLAYER_AUDIENCE = PLAYER_ENTITY_ID;

// ---------------------------------------------------------------------------
// query / control：恢复入口与显式控制（不自动重试失败）
// ---------------------------------------------------------------------------

/**
 * 读当前 initialization slot 的安全视图；无 slot 返回 none。
 * getInitialization 不返回任务内容之外的任何东西——投影由上层
 * projectInitializationView 完成，本函数只负责收窄「有 / 无」。
 */
export async function queryInitialization(
  jobs: NarrativeJobRepository,
): Promise<JobCheck<StoredJob | null>> {
  return jobs.getInitialization();
}

export type ControlInitializationInput = Readonly<{
  jobId: string;
  operation: "retry" | "cancel";
  expectedVersion: number;
  expectedCycle: number;
  now: string;
}>;

/**
 * retry / cancel 经仓储 control 的 version/cycle CAS 执行，不等待 worker
 * 释放租约：cancel 使在途结果失效，retry 只恢复同任务并进入新 cycle。
 */
export async function controlInitialization(
  input: ControlInitializationInput,
  jobs: NarrativeJobRepository,
): Promise<JobCheck<StoredJob>> {
  return jobs.control({
    id: input.jobId,
    expectedVersion: input.expectedVersion,
    expectedCycle: input.expectedCycle,
    operation: input.operation,
    now: input.now,
  });
}
