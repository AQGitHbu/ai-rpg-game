// 决策整包生成的对外编排（Plan 2026-09-09 / Task 10 Step 3）。
//
// 本测试锁定新的委托契约：`generatePendingNarrativeBundle` 不再自己跑 provider
// 循环，而是「startDecisionJob（幂等补建 durable 任务）→ runDecision（claim →
// runJob → 装配审批 → publishJob → release）」一次完成。
//
// 覆盖：
//   - NO_ACTIVE_GAME / NOT_PENDING 前置判定，且绝不触碰 source；
//   - 重复 ensure 幂等：命中已发布任务直接返回成功，不再重复调用 provider；
//   - 失败必须把 game 状态落成 provider_failed（否则手动重试与 ensure 轮询失效）；
//   - 成功发布后返回权威 revision，并把基于该 revision 的场景写回存档。

import { describe, it, expect } from "vitest";
import { generatePendingNarrativeBundle } from "./generatePendingNarrativeBundle";
import { retryNarrativeGeneration } from "./retryNarrativeGeneration";
import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type {
  NarrativeJobRepository,
  Publication,
  StoredJob,
} from "./server/persistence/narrativeJobRepository";
import { asGameId } from "./server/persistence/gameRepository";
import type {
  StageExecution,
  StageRequest,
  StageSource,
  StageSuccess,
} from "./narrativeGeneration/stageSource";
import type { AiSourceFailure } from "./aiGenerationRetry";
import { decisionJobId } from "./narrativeGeneration/decisionJob";
import {
  makeDecisionPlan,
  makeDecisionChoiceOutput,
  makeNarrationOutput,
  makeCharacterOutput,
  createPendingDecisionRecord,
  FIXTURE_DECISION_NPC,
} from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";

// ---------------------------------------------------------------------------
// 内存 job 仓储（与 decisionJob.test.ts 同语义，另计 start 次数）
// ---------------------------------------------------------------------------

type JobsWithCounter = NarrativeJobRepository & { readonly usedRequests: number };

/**
 * 内存 job 仓储。测试里 publish 必须真正把 publication 落到 game 状态上，
 * 否则 generatePendingNarrativeBundle 读回的 narrative 仍停在 provider_pending，
 * 与真实 SQLite 仓储「发布与游戏状态写入同一事务」的语义不符。
 */
function createMemoryJobs(applyPublication: (publication: Publication) => void): JobsWithCounter {
  const rows = new Map<string, { job: StoredJob; requestId: string; digest: string }>();
  let usedRequests = 0;
  const repo: NarrativeJobRepository = {
    async start({ requestId, digest, job }) {
      for (const row of rows.values()) {
        if (row.requestId === requestId) {
          if (row.digest !== digest) return { ok: false, code: "JOB_CONFLICT" as const };
          return { ok: true, value: row.job };
        }
      }
      usedRequests += 1;
      rows.set(job.id, { job, requestId, digest });
      return { ok: true, value: job };
    },
    async get(id) {
      const row = rows.get(id);
      if (row === undefined) return { ok: false, code: "JOB_NOT_FOUND" as const };
      return { ok: true, value: row.job };
    },
    async getInitialization() {
      return { ok: true, value: null };
    },
    async claim({ id, owner, expiresAt }) {
      const row = rows.get(id);
      if (row === undefined) return { ok: false, code: "JOB_NOT_FOUND" as const };
      return { ok: true, value: { jobId: id, owner, fence: 1, expiresAt } };
    },
    async renew({ lease, expiresAt }) {
      return { ok: true, value: { ...lease, expiresAt } };
    },
    async release() {
      return { ok: true, value: true as const };
    },
    async control({ id, operation, expectedVersion, expectedCycle }) {
      const row = rows.get(id);
      if (row === undefined) return { ok: false, code: "JOB_NOT_FOUND" as const };
      if (row.job.version !== expectedVersion || row.job.cycle !== expectedCycle) {
        return { ok: false, code: "JOB_CONFLICT" as const };
      }
      const next: StoredJob = operation === "cancel"
        ? { ...row.job, status: "cancelled", version: row.job.version + 1 }
        : { ...row.job, status: "pending", version: row.job.version + 1, cycle: row.job.cycle + 1,
          usedRequests: 0, units: row.job.units.map(unit => unit.status === "approved" ? unit : { ...unit, status: "pending", attempts: 0 }) };
      row.job = next;
      return { ok: true, value: next };
    },
    async save({ lease, expectedVersion, job }) {
      const row = rows.get(lease.jobId);
      if (row === undefined) return { ok: false, code: "JOB_NOT_FOUND" as const };
      if (row.job.version !== expectedVersion) return { ok: false, code: "JOB_CONFLICT" as const };
      row.job = { ...job, version: row.job.version + 1 };
      return { ok: true, value: row.job };
    },
    async publish({ lease, expectedVersion, publication }) {
      const row = rows.get(lease.jobId);
      if (row === undefined) return { ok: false, code: "JOB_NOT_FOUND" as const };
      if (row.job.version !== expectedVersion) return { ok: false, code: "JOB_CONFLICT" as const };
      // 与真实仓储同序：先把游戏状态写入（CAS 失败即整体失败），再标记已发布。
      try {
        applyPublication(publication);
      } catch {
        return { ok: false, code: "JOB_CONFLICT" as const };
      }
      row.job = { ...row.job, status: "published", version: row.job.version + 1 };
      return { ok: true, value: row.job };
    },
  };
  return Object.defineProperty(repo, "usedRequests", { get: () => usedRequests }) as JobsWithCounter;
}

// ---------------------------------------------------------------------------
// 脚本化 decision source：planning 返回决策计划；表达返回纯对白输出
// ---------------------------------------------------------------------------

function createDecisionSource(): StageSource & { readonly stages: string[] } {
  const stages: string[] = [];
  return {
    stages,
    async reviewDialogueConsistency() { return { ok: true, verdict: "pass", violations: [] }; },
    async generate(request: StageRequest, _execution: StageExecution): Promise<StageSuccess | AiSourceFailure> {
      stages.push(request.stage);
      if (request.stage === "planning") return { ok: true, stage: "planning", value: makeDecisionPlan() };
      if (request.stage === "narration") return { ok: true, stage: "narration", value: makeNarrationOutput() };
      if (request.stage === "character") {
        return { ok: true, stage: "character", value: makeCharacterOutput(FIXTURE_DECISION_NPC) };
      }
      return { ok: true, stage: "choices", value: makeDecisionChoiceOutput() };
    },
  };
}

function createFailingSource(): StageSource & { readonly calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async generate(): Promise<StageSuccess | AiSourceFailure> {
      calls += 1;
      return {
        ok: false,
        failure: { kind: "AI_CALL_FAILED", phase: "scene" },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 内存 game 仓储
// ---------------------------------------------------------------------------

function createInMemoryRepo(record: GameRecord | null): {
  repo: GameRepository;
  getRecord: () => GameRecord | null;
  /** 供 job 仓储的 publish 复用，模拟「发布与游戏状态写入同一事务」。 */
  applyPublication: (publication: Publication) => void;
} {
  let current: GameRecord | null = record;
  const applyState = (input: {
    expectedRevision: number;
    nextWorldState: GameRecord["worldState"];
    nextStoryState: GameRecord["storyState"];
  }) => {
    if (current === null) throw new Error("NO_ACTIVE_GAME");
    if (input.expectedRevision !== current.revision) throw new Error("STALE_GAME_REVISION");
    current = {
      ...current,
      worldState: input.nextWorldState,
      storyState: input.nextStoryState,
      revision: current.revision + 1,
    };
  };
  return {
    repo: {
      async createInitialGame(input) {
        if (current !== null) return { ok: false as const, code: "ACTIVE_GAME_EXISTS" as const };
        current = {
          gameId: input.gameId,
          worldState: input.worldState,
          storyState: input.storyState,
          revision: 0,
          createdAt: input.createdAt,
        };
        return { ok: true as const };
      },
      async getCurrentGame() {
        if (current === null) return { ok: true as const, status: "none" as const };
        return { ok: true as const, status: "active" as const, record: current };
      },
      async applyState(input) {
        if (current === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== current.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        current = {
          ...current,
          worldState: input.nextWorldState,
          storyState: input.nextStoryState,
          revision: current.revision + (input.incrementRevision === false ? 0 : 1),
        };
        return { ok: true as const, record: current };
      },
      async applySceneWriteBack(input) {
        if (current === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== current.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        current = {
          ...current,
          worldState: input.nextWorldState,
          storyState: input.nextStoryState,
          revision: current.revision + 1,
        };
        return { ok: true as const, record: current };
      },
      async clearCurrentGame() { return { ok: true as const }; },
      async replaceCurrentGame() { return { ok: true as const }; },
    } as GameRepository,
    getRecord: () => current,
    applyPublication: (publication) => {
      if (publication.kind === "decision") {
        applyState({
          expectedRevision: publication.input.expectedRevision,
          nextWorldState: publication.input.nextWorldState,
          nextStoryState: publication.input.nextStoryState,
        });
        return;
      }
      // opening publication：替换整个存档。
      current = {
        gameId: publication.input.gameId,
        worldState: publication.input.worldState,
        storyState: publication.input.storyState,
        revision: 0,
        createdAt: current?.createdAt ?? NOW,
      };
    },
  };
}

const NOW = "2026-09-09T08:00:00.000Z";

type PendingJob = Extract<GameRecord["storyState"]["narrative"], { status: "provider_pending" }>["job"];

type Harness = Readonly<{
  repo: GameRepository;
  jobs: JobsWithCounter;
  getRecord: () => GameRecord | null;
  pendingJob: PendingJob;
}>;

function harness(gameId: string): Harness {
  const record = createPendingDecisionRecord(0, gameId);
  const { repo, getRecord, applyPublication } = createInMemoryRepo(record);
  const jobs = createMemoryJobs(applyPublication);
  const narrative = record.storyState.narrative;
  if (narrative.status !== "provider_pending") throw new Error("fixture must be provider_pending");
  return { repo, jobs, getRecord, pendingJob: narrative.job };
}

describe("generatePendingNarrativeBundle", () => {
  it("独立执行使用不同 owner，租约竞争不写 provider_failed", async () => {
    const ctx = harness("lease-contention");
    const owners: string[] = [];
    ctx.jobs.claim = async input => {
      owners.push(input.owner);
      return { ok: false, code: "JOB_CONFLICT" };
    };
    const source = createDecisionSource();
    const deps = { repository: ctx.repo, jobs: ctx.jobs, source, now: () => NOW };
    expect(await generatePendingNarrativeBundle(deps)).toMatchObject({ ok: false, code: "NOT_PENDING" });
    expect(await generatePendingNarrativeBundle(deps)).toMatchObject({ ok: false, code: "NOT_PENDING" });
    expect(new Set(owners).size).toBe(2);
    expect(source.stages).toHaveLength(0);
    expect(ctx.getRecord()?.storyState.narrative.status).toBe("provider_pending");
  });
  it("显式重试同时恢复 durable failed job，普通 ensure 不自动重置周期", async () => {
    const ctx = harness("manual-durable");
    const failing = createFailingSource();
    const deps = { repository: ctx.repo, jobs: ctx.jobs, now: () => NOW };
    expect((await generatePendingNarrativeBundle({ ...deps, source: failing })).ok).toBe(false);
    const calls = failing.calls();
    expect((await generatePendingNarrativeBundle({ ...deps, source: failing })).ok).toBe(false);
    expect(failing.calls()).toBe(calls);
    expect(await retryNarrativeGeneration(ctx.repo, asGameId("manual-durable"), () => NOW))
      .toMatchObject({ ok: true, result: "requeued" });
    const source = createDecisionSource();
    expect(await generatePendingNarrativeBundle({ ...deps, source })).toMatchObject({ ok: true });
    expect(source.stages).toContain("planning");
    const job = await ctx.jobs.get(decisionJobId(asGameId("manual-durable"), ctx.pendingJob, ctx.pendingJob.basedOnRevision - 1));
    expect(job.ok && job.value).toMatchObject({ status: "published", cycle: 1 });
  });

  it("returns NO_ACTIVE_GAME when no active game exists", async () => {
    const { repo } = createInMemoryRepo(null);
    const source = createFailingSource();
    const result = await generatePendingNarrativeBundle({
      repository: repo,
      jobs: createMemoryJobs(() => undefined),
      source,
      now: () => NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_ACTIVE_GAME");
    expect(source.calls()).toBe(0);
  });

  it("returns NOT_PENDING when narrative is not provider_pending", async () => {
    const record = createPendingDecisionRecord(0, "not-pending");
    const ready: GameRecord = {
      ...record,
      storyState: { ...record.storyState, narrative: createFixtureNarrativeRuntimeState() },
    };
    const { repo } = createInMemoryRepo(ready);
    const source = createDecisionSource();
    const result = await generatePendingNarrativeBundle({
      repository: repo,
      jobs: createMemoryJobs(() => undefined),
      source,
      now: () => NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_PENDING");
    expect(source.stages).toHaveLength(0);
  });

  it("完整委托：一次 runJob 生成四段表达并原子发布，返回权威 revision", async () => {
    const ctx = harness("full-run");
    const source = createDecisionSource();

    const result = await generatePendingNarrativeBundle({
      repository: ctx.repo,
      jobs: ctx.jobs,
      source,
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...source.stages].sort()).toEqual(["character", "choices", "narration", "planning"]);

    const saved = ctx.getRecord();
    if (saved === null || saved.storyState.narrative.status !== "ready") {
      throw new Error("expected ready narrative after publish");
    }
    // 发布把 revision 推进到 baseRevision，返回值即该权威 revision。
    expect(result.revision).toBe(saved.revision);
    expect(result.revision).toBe(ctx.pendingJob.basedOnRevision);
    // choice token 以落盘 revision 铸造，读模型不会把新选项判为过期。
    expect(saved.storyState.narrative.choiceRegistry.every((choice) => choice.basedOnRevision === saved.revision)).toBe(true);
  });

  it("重复 ensure 幂等：命中已发布任务直接返回，不再重复调用 provider", async () => {
    const ctx = harness("idempotent");
    const source = createDecisionSource();

    const first = await generatePendingNarrativeBundle({
      repository: ctx.repo,
      jobs: ctx.jobs,
      source,
      now: () => NOW,
    });
    expect(first.ok).toBe(true);
    const callsAfterFirst = source.stages.length;
    expect(ctx.getRecord()?.revision).toBe(ctx.pendingJob.basedOnRevision);

    // 第一次发布后 narrative 已 ready；再 ensure 会被 NOT_PENDING 短路（不碰 provider）。
    const second = await generatePendingNarrativeBundle({
      repository: ctx.repo,
      jobs: ctx.jobs,
      source,
      now: () => NOW,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("NOT_PENDING");
    expect(source.stages.length).toBe(callsAfterFirst);

    const jobId = decisionJobId(asGameId("idempotent"), ctx.pendingJob, ctx.pendingJob.basedOnRevision - 1);
    const job = await ctx.jobs.get(jobId);
    expect(job.ok).toBe(true);
    if (job.ok) expect(job.value.status).toBe("published");
  });

  it("已发布任务被幂等补建命中时直接返回，不重新调用 provider", async () => {
    const ctx = harness("published-replay");
    const source = createDecisionSource();

    // 先跑一次真实发布。
    const first = await generatePendingNarrativeBundle({
      repository: ctx.repo,
      jobs: ctx.jobs,
      source,
      now: () => NOW,
    });
    expect(first.ok).toBe(true);
    const callsAfterFirst = source.stages.length;

    // 模拟「任务已 published，但游戏仍停留在同一 provider_pending revision」
    // 的重放场景（例如 ensure 与发布之间的读取竞争）：任务身份相同，必须短路。
    const jobId = decisionJobId(asGameId("published-replay"), ctx.pendingJob, ctx.pendingJob.basedOnRevision - 1);
    const job = await ctx.jobs.get(jobId);
    expect(job.ok).toBe(true);
    if (!job.ok) return;
    expect(job.value.status).toBe("published");

    // 把游戏状态回退到发布前的同一 revision + 同一 pending job（仅测试用）。
    const record = createPendingDecisionRecord(ctx.pendingJob.basedOnRevision - 1, "published-replay");
    const { repo: replayRepo, getRecord: replayRecord } = createInMemoryRepo(record);
    const replay = await generatePendingNarrativeBundle({
      repository: replayRepo,
      jobs: ctx.jobs,
      source,
      now: () => NOW,
    });
    expect(replay.ok).toBe(true);
    expect(source.stages.length).toBe(callsAfterFirst);
    expect(replayRecord()?.revision).toBe(ctx.pendingJob.basedOnRevision - 1);
  });

  it("调用失败把 game 落成 provider_failed，并保留 AI_CALL_FAILED 分类", async () => {
    const ctx = harness("failure");
    const source = createFailingSource();

    const result = await generatePendingNarrativeBundle({
      repository: ctx.repo,
      jobs: ctx.jobs,
      source,
      now: () => NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result).toMatchObject({ code: "AI_CALL_FAILED", failureKind: "AI_CALL_FAILED" });

    const record = ctx.getRecord();
    expect(record?.storyState.narrative).toMatchObject({
      status: "provider_failed",
      job: ctx.pendingJob,
      failure: { kind: "AI_CALL_FAILED", reason: "provider_failure", phase: "scene" },
    });
  });

  it("schema 失败持久化安全的具体原因，不伪装成 provider failure", async () => {
    const ctx = harness("schema-failure");
    const source: StageSource = { async generate() {
      return { ok: false as const, failure: { kind: "AI_RESPONSE_INVALID" as const, phase: "scene" as const },
        repairReason: "unit_output_label_invalid", repairDetail: "labels[1]: 106 Unicode code points; maximum 80 SECRET_BODY" };
    } };
    const result = await generatePendingNarrativeBundle({ repository: ctx.repo, jobs: ctx.jobs, source, now: () => NOW });
    expect(result).toMatchObject({ ok: false, code: "AI_RESPONSE_INVALID", failureKind: "AI_RESPONSE_INVALID" });
    expect(ctx.getRecord()?.storyState.narrative).toMatchObject({ status: "provider_failed",
      failure: { kind: "AI_RESPONSE_INVALID", reason: "unit_output_label_invalid", phase: "scene" } });
    expect(JSON.stringify(ctx.getRecord()?.storyState.narrative)).not.toContain("SECRET_BODY");
  });
});
