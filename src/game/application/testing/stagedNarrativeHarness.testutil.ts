// 可恢复 DAG 调度的测试 harness（Plan 2026-09-09 / Task 8；Task 12 扩充观测面）。
//
// createStagedHarness 提供 jobs（内存 NarrativeJobRepository）、source
// （脚本化 provider）、calls、requests、clock、controller、startDecision()、
// startInitialization()、run()、publish()。
// 基于生产 approvePlan/projectUnitContext/approveUnit/collectDisclosures，
// 只有 provider 响应是脚本化的。clock 支持 advance(ms)；source 支持
// failNext(stage)、hold(stage)、release(stage)。
//
// Task 12 追加的观测能力（断言 Spec §11「输入隔离」「固定职责分离」「初始化
// 任务恢复」「超时与迟到响应」等行时需要）：
//   requests —— 保留每次 provider 请求的完整 StageRequest，用于逐字段证明
//                旁白请求不含完整骨架/隐藏动机，角色请求不含他人私密正文；
//   startInitialization —— 走生产的 startInitialization + runInitialization，
//                覆盖「无 GameRecord 时仍可查询和重试同一失败任务」；
//   publications —— 累积每次 publish 的载荷，用于证明失败时零半包发布。

import { asEventId, asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { asGameId } from "@/game/application/server/persistence/gameRepository";
import { asGenerationId, asLocationId, asNpcId, asQuestId, type GenerationMetadata } from "@/game/domain/worldEntity";
import {
  makeStagedPlan,
  makeOpeningStagedPlan,
  makeNarrationOutput,
  makeCharacterOutput,
  makeChoiceOutput,
} from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { PlanningContext, StageRequest, StageExecution, StageSource, StageSuccess } from "@/game/application/narrativeGeneration/stageSource";
import type { AiSourceFailure } from "@/game/application/aiGenerationRetry";
import { createAiSourceFailure } from "@/game/application/aiGenerationRetry";
import { runJob } from "@/game/application/narrativeGeneration/runJob";
import { publishJob } from "@/game/application/narrativeGeneration/publishJob";
import {
  startInitialization as startInitializationJob,
  runInitialization,
} from "@/game/application/narrativeGeneration/initializationJob";
import { createFixtureOpeningCandidateSource } from "@/game/application/createGame";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import type { Publication, StoredJob, NarrativeJobRepository, Lease } from "@/game/application/server/persistence/narrativeJobRepository";

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("gen_harness"), seed: "harness-seed", templateVersion: "v2",
  inputDigest: "", gameType: "wuxia",
};

function harnessWorld(): WorldState {
  const projection: EntityCompatibilityProjection = {
    player: { name: "少侠", identity: "过路人", stats: { hp: 100, attack: 10, defense: 5 } },
    locations: [
      { id: asLocationId("loc_0"), name: "渡口", description: "d", kind: "main", connectedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")], npcIds: [asNpcId("npc_0"), asNpcId("npc_1")], availableItemIds: [], tags: [], scale: "scene" },
      { id: asLocationId("loc_1"), name: "废窑", description: "d", kind: "main", connectedLocationIds: [asLocationId("loc_0")], npcIds: [], availableItemIds: [], tags: [], scale: "scene" },
      { id: asLocationId("loc_2"), name: "义庄", description: "d", kind: "main", connectedLocationIds: [asLocationId("loc_0")], npcIds: [], availableItemIds: [], tags: [], scale: "scene" },
    ],
    currentLocationId: asLocationId("loc_0"),
    unlockedLocationIds: [asLocationId("loc_0"), asLocationId("loc_1"), asLocationId("loc_2")],
    visitedLocationIds: [asLocationId("loc_0")],
    npcs: [
      { id: asNpcId("npc_0"), name: "老陈", role: "知情者", description: "守渡口", locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: true, memory: { npcId: asNpcId("npc_0"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } },
      { id: asNpcId("npc_1"), name: "哑姑", role: "向导", description: "义庄向导", locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: true, memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } },
    ],
    items: [],
    inventory: [],
    worldFacts: [],
    quests: [{
      id: asQuestId("quest_harness"), name: "渡口疑云", description: "查清去向",
      objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_0") }],
      onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
      tags: [], kind: "main", stage: 1, status: "active",
    }],
    enemies: [],
    defeatedEnemyIds: [],
    factions: [],
  };
  return createWorldStateFixtureWith({ generation: GENERATION, base: projection });
}

function harnessStory(): StoryState {
  return createInitialStoryState({
    gameLength: "short",
    initialEntityCounts: { locations: 3, npcs: 2, quests: 1, events: 0 },
    initialNarrative: createFixtureNarrativeRuntimeState(),
  });
}

// ---------------------------------------------------------------------------
// 内存 NarrativeJobRepository：语义与 sqliteNarrativeJobs 对齐（lease/fence/
// 版本 CAS），但不落盘、不校验 payload 细节。
// ---------------------------------------------------------------------------

type MemoryRow = {
  job: StoredJob;
  requestId: string;
  digest: string;
  lease: { owner: string; fence: number; expiresAt: string } | null;
};

function createMemoryJobRepository(): NarrativeJobRepository & { initializeSchema(): Promise<void>; close(): Promise<void> } {
  const rows = new Map<string, MemoryRow>();
  // initialization slot：只指向最近一次 initialization 任务，语义与
  // sqliteNarrativeJobs 的 current slot 对齐（无任务为 null）。
  let initializationJobId: string | null = null;

  function rowOf(id: string): MemoryRow | null {
    return rows.get(id) ?? null;
  }

  function leaseMatches(row: MemoryRow, lease: Lease): boolean {
    return row.lease !== null
      && row.lease.owner === lease.owner
      && row.lease.fence === lease.fence
      && row.lease.expiresAt === lease.expiresAt;
  }

  return {
    async initializeSchema(): Promise<void> {},
    async close(): Promise<void> {},

    async start({ requestId, digest, job }) {
      for (const row of rows.values()) {
        if (row.requestId === requestId) {
          if (row.digest !== digest) return { ok: false, code: "JOB_CONFLICT" as const };
          return { ok: true, value: row.job };
        }
      }
      if (job.scope === "decision" && job.gameId !== null) {
        for (const row of rows.values()) {
          if (row.job.scope === "decision" && row.job.gameId === job.gameId && row.job.status === "pending") {
            return { ok: false, code: "JOB_CONFLICT" as const };
          }
        }
      }
      rows.set(job.id, { job, requestId, digest, lease: null });
      if (job.scope === "initialization") initializationJobId = job.id;
      return { ok: true, value: job };
    },

    async get(id) {
      const row = rowOf(id);
      if (row === null) return { ok: false, code: "JOB_NOT_FOUND" };
      return { ok: true, value: row.job };
    },

    async getInitialization() {
      if (initializationJobId === null) return { ok: true, value: null };
      const row = rowOf(initializationJobId);
      return row === null ? { ok: true, value: null } : { ok: true, value: row.job };
    },

    async claim({ id, owner, now, expiresAt }) {
      const row = rowOf(id);
      if (row === null) return { ok: false, code: "JOB_NOT_FOUND" };
      if (row.job.status === "published" || row.job.status === "cancelled") {
        return { ok: false, code: "JOB_CONFLICT" };
      }
      if (row.lease !== null && row.lease.expiresAt > now) {
        if (row.lease.owner === owner) {
          return { ok: true, value: { jobId: id, owner, fence: row.lease.fence, expiresAt: row.lease.expiresAt } };
        }
        return { ok: false, code: "JOB_CONFLICT" };
      }
      const fence = (row.lease?.fence ?? 0) + 1;
      row.lease = { owner, fence, expiresAt };
      return { ok: true, value: { jobId: id, owner, fence, expiresAt } };
    },

    async renew({ lease, now, expiresAt }) {
      const row = rowOf(lease.jobId);
      if (row === null) return { ok: false, code: "JOB_NOT_FOUND" };
      // 与生产一致：不否决已过期但未被接管的租约（fence 是并发权威）。
      if (!leaseMatches(row, lease)) {
        return { ok: false, code: "LEASE_LOST" };
      }
      row.lease = { owner: lease.owner, fence: lease.fence, expiresAt };
      return { ok: true, value: { ...lease, expiresAt } };
    },

    async release({ lease }) {
      const row = rowOf(lease.jobId);
      if (row === null) return { ok: false, code: "JOB_NOT_FOUND" };
      if (!leaseMatches(row, lease)) return { ok: false, code: "LEASE_LOST" };
      row.lease = null;
      return { ok: true, value: true };
    },

    async control({ id, expectedVersion, expectedCycle, operation, now }) {
      const row = rowOf(id);
      if (row === null) return { ok: false, code: "JOB_NOT_FOUND" };
      if (row.job.version !== expectedVersion || row.job.cycle !== expectedCycle) {
        return { ok: false, code: "JOB_CONFLICT" };
      }
      if (operation === "cancel") {
        if (row.job.status !== "pending" && row.job.status !== "failed") {
          return { ok: false, code: "JOB_CONFLICT" };
        }
        row.job = { ...row.job, status: "cancelled", version: row.job.version + 1 };
      } else {
        if (row.job.status !== "failed") return { ok: false, code: "JOB_CONFLICT" };
        row.job = {
          ...row.job,
          status: "pending",
          version: row.job.version + 1,
          cycle: row.job.cycle + 1,
          usedRequests: 0,
          deadline: new Date(Date.parse(now) + 600_000).toISOString(),
          units: row.job.units.map((unit) => unit.status === "approved"
            ? unit
            : { ...unit, status: "pending" as const, attempts: 0 }),
        };
      }
      row.lease = null;
      return { ok: true, value: row.job };
    },

    async save({ lease, expectedVersion, job }) {
      const row = rowOf(lease.jobId);
      if (row === null) return { ok: false, code: "JOB_NOT_FOUND" };
      if (!leaseMatches(row, lease)) return { ok: false, code: "LEASE_LOST" };
      if (row.job.version !== expectedVersion) return { ok: false, code: "JOB_CONFLICT" };
      if (row.job.status === "published" || row.job.status === "cancelled") {
        return { ok: false, code: "JOB_CONFLICT" };
      }
      row.job = { ...job, version: row.job.version + 1 };
      return { ok: true, value: row.job };
    },

    async publish({ lease, expectedVersion }) {
      const row = rowOf(lease.jobId);
      if (row === null) return { ok: false, code: "JOB_NOT_FOUND" };
      if (!leaseMatches(row, lease)) return { ok: false, code: "LEASE_LOST" };
      if (row.job.version !== expectedVersion) return { ok: false, code: "JOB_CONFLICT" };
      if (!row.job.units.every((unit) => unit.status === "approved")) {
        return { ok: false, code: "JOB_CONFLICT" };
      }
      row.job = { ...row.job, status: "published", version: row.job.version + 1 };
      row.lease = null;
      return { ok: true, value: row.job };
    },
  };
}

// ---------------------------------------------------------------------------
// 脚本化 source
// ---------------------------------------------------------------------------

export type HarnessSource = {
  requiresTaskBrief?: boolean;
  generate(request: StageRequest, execution: StageExecution): Promise<StageSuccess | AiSourceFailure>;
  calls: readonly { readonly stage: StageRequest["stage"]; readonly timeoutMs: number; readonly repair?: StageExecution["repair"] }[];
  /** 完整请求正文（与 calls 一一对应），供输入隔离类断言逐字段取证。 */
  requests: readonly StageRequest[];
  failNext(stage: StageRequest["stage"]): void;
  /** 下一次该 stage 的成功响应改为「审批必失败」的输出（ok 但不合规）。 */
  failApprovalNext(stage: StageRequest["stage"]): void;
  hold(stage: StageRequest["stage"]): void;
  release(stage: StageRequest["stage"]): void;
};

function createScriptedSource(): HarnessSource {
  const calls: { stage: StageRequest["stage"]; timeoutMs: number; repair?: StageExecution["repair"] }[] = [];
  const requests: StageRequest[] = [];
  const failCounts = new Map<StageRequest["stage"], number>();
  const approvalFailCounts = new Map<StageRequest["stage"], number>();
  const held = new Map<StageRequest["stage"], (() => void)[]>();

  function successFor(request: StageRequest): StageSuccess {
    if (request.stage === "planning") {
      return { ok: true, stage: "planning", value: makeStagedPlan() };
    }
    if (request.stage === "narration") {
      return { ok: true, stage: "narration", value: makeNarrationOutput() };
    }
    if (request.stage === "character") {
      const speakerId = request.context.unit.speakerId ?? "npc_0";
      return { ok: true, stage: "character", value: makeCharacterOutput(speakerId) };
    }
    return { ok: true, stage: "choices", value: makeChoiceOutput() };
  }

  /** 审批必失败的响应：provider 成功但输出违反 approveUnit 的引用契约。 */
  function poisonedSuccessFor(request: StageRequest): StageSuccess {
    if (request.stage === "choices") {
      // candidateId 不在计划的候选里 → unit_output_candidate_unknown。
      const labels = makeChoiceOutput().labels;
      return {
        ok: true,
        stage: "choices",
        value: { stage: "choices", labels: [{ candidateId: "poisoned_candidate", label: labels[0]?.label ?? "坏。" }, ...labels.slice(1)] },
      };
    }
    if (request.stage === "character") {
      const speakerId = request.context.unit.speakerId ?? "npc_0";
      return {
        ok: true,
        stage: "character",
        value: {
          ...makeCharacterOutput(speakerId),
          parts: [{ text: "坏句子。", facts: [{ factId: "fact_poisoned", certainty: "known" as const }], evidence: [], beatIds: [] }],
        },
      };
    }
    if (request.stage === "narration") {
      // 引用不可见事实 → unit_output_fact_unavailable。
      return {
        ok: true,
        stage: "narration",
        value: {
          stage: "narration",
          parts: [{ text: "坏句子。", facts: [{ factId: "fact_poisoned", certainty: "known" as const }], evidence: [], beatIds: [] }],
          actionKeys: [],
        },
      };
    }
    return successFor(request);
  }

  return {
    calls,
    requests,
    failNext(stage) { failCounts.set(stage, (failCounts.get(stage) ?? 0) + 1); },
    failApprovalNext(stage) { approvalFailCounts.set(stage, (approvalFailCounts.get(stage) ?? 0) + 1); },
    hold(stage) {
      if (!held.has(stage)) held.set(stage, []);
    },
    release(stage) {
      const resolvers = held.get(stage);
      held.delete(stage);
      for (const resolve of resolvers ?? []) resolve();
    },
    async generate(request, execution) {
      calls.push({ stage: request.stage, timeoutMs: execution.timeoutMs, ...(execution.repair === undefined ? {} : { repair: execution.repair }) });
      requests.push(request);
      if (execution.signal.aborted) {
        return createAiSourceFailure("scene", "transport");
      }
      const pendingFailures = failCounts.get(request.stage) ?? 0;
      if (pendingFailures > 0) {
        failCounts.set(request.stage, pendingFailures - 1);
        return createAiSourceFailure("scene", "invalid_schema", "unit_output_invalid");
      }
      const resolvers = held.get(request.stage);
      if (resolvers !== undefined && held.has(request.stage)) {
        await new Promise<void>((resolve) => { resolvers.push(resolve); });
      }
      const pendingApprovalFailures = approvalFailCounts.get(request.stage) ?? 0;
      if (pendingApprovalFailures > 0) {
        approvalFailCounts.set(request.stage, pendingApprovalFailures - 1);
        return poisonedSuccessFor(request);
      }
      return successFor(request);
    },
  };
}

// ---------------------------------------------------------------------------
// harness 入口
// ---------------------------------------------------------------------------

export function createStagedHarness() {
  const jobs = createMemoryJobRepository();
  const source = createScriptedSource();
  const controller = new AbortController();

  const clock = {
    epochMs: Date.parse("2026-09-09T08:00:00.000Z"),
    now(): string { return new Date(this.epochMs).toISOString(); },
    advance(ms: number): void { this.epochMs += ms; },
  };

  let currentJobId: string | null = null;
  let currentLease: Lease | null = null;
  let currentOpeningPlan: PlanProposal | null = null;
  const publications: Publication[] = [];

  /** opening 候选计划的输入来源：结构由 approvePlan(opening) 唯一铸造。 */
  async function openingCandidate(): Promise<PlanProposal> {
    const candidate = createFixtureOpeningCandidateSource();
    const generated = await candidate.generate({ gameType: "wuxia", seed: "harness-seed", gameLength: "short" });
    return makeOpeningStagedPlan(generated);
  }
  /**
   * opening 臂的 planning 响应必须来自 opening 计划；其余阶段沿用同一脚本化
   * source，保证 expression 阶段的调用计数与 decision 路径一致可比。
   */
  function scriptedOpeningSource(base: HarnessSource, plan: PlanProposal): StageSource {
    return {
      async generate(request, execution) {
        if (request.stage === "planning") {
          (base.calls as { stage: StageRequest["stage"]; timeoutMs: number; repair?: StageExecution["repair"] }[]).push({
            stage: "planning",
            timeoutMs: execution.timeoutMs,
            ...(execution.repair === undefined ? {} : { repair: execution.repair }),
          });
          (base.requests as StageRequest[]).push(request);
          return { ok: true, stage: "planning", value: plan };
        }
        return base.generate(request, execution);
      },
    };
  }

  /** 开局发布载荷的等价视图不在此复制：生产组装发生在 runInitialization 内部，
   *  测试只从 job 状态与 initialization slot 观察发布事实，避免第二套组装逻辑。 */

  async function startDecision(): Promise<void> {
    const planningInput: PlanningContext = {
      kind: "decision",
      world: harnessWorld(),
      story: harnessStory(),
      job: (() => {
        const result = createPendingNarrativeJob({
          jobId: asNarrativeJobId("harness-pending"),
          turnId: asTurnId("turn-1"),
          actionId: "action-1",
          expectedRevision: 0,
          turnNumber: 1,
          actionSummary: { kind: "talk", npcId: asNpcId("npc_0") },
          resolvedEvent: {
            actionId: "action-1", status: "success", eventKind: "observe",
            facts: [], stateChanges: [], costs: [], rewards: [],
            triggeredEvents: [], rejectedEffects: [],
          },
          domainEventIds: [asEventId("turn-1:event-1")],
          focusNpcId: asNpcId("npc_0"),
          requestedAt: clock.now(),
          objectiveTransition: { before: null, completed: [], after: { questId: asQuestId("quest_harness"), objectiveIndex: 0, label: "对话" }, mode: "unchanged" },
          mandatoryBeats: [],
          generationKind: "npc_fixed_choice",
          sceneRequestKind: "npc_response",
        });
        if (!result.ok) throw new Error("harness pending job 构造失败");
        return result.job;
      })(),
    };
    const job: StoredJob = {
      schemaVersion: 1,
      id: "harness-job",
      scope: "decision",
      version: 0,
      cycle: 0,
      status: "pending",
      input: planningInput,
      inputDigest: "harness-digest",
      baseRevision: 0,
      gameId: "game-harness",
      units: [],
      usedRequests: 0,
      baselineRequests: 1,
      deadline: new Date(clock.epochMs + 600_000).toISOString(),
      failureCode: null,
      initialization: null,
    };
    const started = await jobs.start({ requestId: "harness-request", digest: job.inputDigest, job });
    if (!started.ok) throw new Error(`harness start failed: ${started.code}`);
    const lease = await jobs.claim({ id: job.id, owner: "harness-worker", now: clock.now(), expiresAt: new Date(clock.epochMs + 30_000).toISOString() });
    if (!lease.ok) throw new Error(`harness claim failed: ${lease.code}`);
    currentJobId = job.id;
    currentLease = lease.value;
  }

  async function run(): Promise<Awaited<ReturnType<typeof runJob>>> {
    if (currentJobId === null || currentLease === null) throw new Error("harness 未 startDecision");
    return runJob({ id: currentJobId, lease: currentLease }, {
      jobs,
      source,
      now: () => clock.now(),
      signal: controller.signal,
    });
  }

  /**
   * 走生产的 startInitialization：覆盖「无 GameRecord 时仍可查询和重试同一
   * 失败任务」。planning 阶段改由 opening 专用计划供给（decision 的
   * planning 响应对 opening 臂不合法），其余阶段复用同一脚本化 source。
   */
  async function startInitialization(requestId = "harness-init-request"): Promise<StoredJob> {
    const opening = await openingCandidate();
    const started = await startInitializationJob(
      {
        requestId,
        gameId: asGameId("game-init"),
        gameType: "wuxia",
        gameLength: "short",
        seed: "harness-seed",
        generation: GENERATION,
        target: { kind: "create" },
        now: () => clock.now(),
      },
      jobs,
    );
    if (!started.ok) throw new Error(`harness initialization start failed: ${started.code}`);
    currentJobId = started.job.id;
    currentLease = null;
    currentOpeningPlan = opening;
    return started.job;
  }

  /** 走生产的 runInitialization：claim → runJob → 安装 → publishJob → release。 */
  async function runInitializationJob(): Promise<Awaited<ReturnType<typeof runInitialization>>> {
    if (currentJobId === null) throw new Error("harness 未 startInitialization");
    const plan = currentOpeningPlan;
    if (plan === null) throw new Error("harness 未持有 opening 计划");
    return runInitialization(currentJobId, "harness-init-worker", {
      jobs,
      source: scriptedOpeningSource(source, plan),
      now: () => clock.now(),
      signal: controller.signal,
      createdAt: clock.now(),
    });
  }

  /** 决策发布的 Publication：与 harness 世界/故事同源，只用于驱动 publishJob 的复核路径。 */
  function decisionPublication(): Publication {
    return {
      kind: "decision",
      input: {
        gameId: asGameId("game-harness"),
        expectedRevision: 0,
        nextWorldState: harnessWorld(),
        nextStoryState: harnessStory(),
      },
    };
  }

  async function publish(publication: Publication = decisionPublication()) {
    if (currentJobId === null || currentLease === null) throw new Error("harness 未 startDecision");
    const job = await jobs.get(currentJobId);
    if (!job.ok) return job;
    const result = await publishJob({ job: job.value, lease: currentLease, publication, now: () => clock.now() }, jobs);
    if (result.ok) publications.push(publication);
    return result;
  }

  async function cancel() {
    if (currentJobId === null) throw new Error("harness 未 startDecision");
    const job = await jobs.get(currentJobId);
    if (!job.ok) return job;
    // 保留本地租约引用：取消后若仍尝试运行，应由状态机（而非 harness）
    // 拒绝，这样「取消后不发布迟到结果」才是被真正验证的语义。
    return jobs.control({
      id: currentJobId,
      expectedVersion: job.value.version,
      expectedCycle: job.value.cycle,
      operation: "cancel",
      now: clock.now(),
    });
  }

  async function retry() {
    if (currentJobId === null) throw new Error("harness 未 startDecision");
    const job = await jobs.get(currentJobId);
    if (!job.ok) return job;
    return jobs.control({
      id: currentJobId,
      expectedVersion: job.value.version,
      expectedCycle: job.value.cycle,
      operation: "retry",
      now: clock.now(),
    });
  }

  /** 重新读取当前 job：用于观察 run 之后的状态与 units 审批结果。 */
  async function readJob(): Promise<Awaited<ReturnType<typeof jobs.get>>> {
    if (currentJobId === null) throw new Error("harness 未 startDecision");
    return jobs.get(currentJobId);
  }

  /** 已发布载荷（只含真正 publish 成功的那些），用于证明失败时零半包。 */
  function publishedCount(): number {
    return publications.length;
  }

  return {
    jobs,
    source,
    clock,
    controller,
    requests: source.requests,
    calls: source.calls,
    publications: () => publications.slice(),
    publishedCount,
    startDecision,
    startInitialization,
    runInitializationJob,
    run,
    readJob,
    publish,
    decisionPublication,
    cancel,
    retry,
    jobId(): string {
      if (currentJobId === null) throw new Error("harness 未 startDecision");
      return currentJobId;
    },
    lease(): Lease {
      if (currentLease === null) throw new Error("harness 未 startDecision");
      return currentLease;
    },
  };
}
