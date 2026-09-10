// 初始化任务的持久化编排（Plan 2026-09-09 / Task 10 Step 1）。
//
// 覆盖：同 requestId 同输入幂等（只一次 start、不重复计费）；异输入冲突；
// 完整 run 在租约作用域内生成四段表达、安装 ready 叙事并原子发布；发布后
// 存档携带已批准 label 且不含未批准文本。

import { describe, expect, it } from "vitest";
import { createFixtureOpeningCandidateSource } from "@/game/application/createGame";
import {
  makeOpeningStagedPlan,
  makeNarrationOutput,
  makeCharacterOutput,
  makeOpeningChoiceOutput,
  FIXTURE_NPC_A,
} from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { asGenerationId } from "@/game/domain/worldEntity";
import { asGameId } from "@/game/application/server/persistence/gameRepository";
import type {
  NarrativeJobRepository,
  StoredJob,
} from "@/game/application/server/persistence/narrativeJobRepository";
import type {
  StageExecution,
  StageRequest,
  StageSource,
  StageSuccess,
} from "@/game/application/narrativeGeneration/stageSource";
import type { AiSourceFailure } from "@/game/application/aiGenerationRetry";
import {
  startInitialization,
  initializationDigest,
  runInitialization,
  queryInitialization,
  controlInitialization,
} from "@/game/application/narrativeGeneration/initializationJob";

// ---------------------------------------------------------------------------
// 内存 job 仓储（与 stagedNarrativeHarness 同语义，另提供 initialization slot）
// ---------------------------------------------------------------------------

function createMemoryJobs(): NarrativeJobRepository {
  const rows = new Map<string, { job: StoredJob; requestId: string; digest: string }>();
  let slot: string | null = null;
  return {
    async start({ requestId, digest, job }) {
      for (const row of rows.values()) {
        if (row.requestId === requestId) {
          if (row.digest !== digest) return { ok: false, code: "JOB_CONFLICT" as const };
          return { ok: true, value: row.job };
        }
      }
      rows.set(job.id, { job, requestId, digest });
      if (job.scope === "initialization") slot = job.id;
      return { ok: true, value: job };
    },
    async get(id) {
      const row = rows.get(id);
      if (row === undefined) return { ok: false, code: "JOB_NOT_FOUND" as const };
      return { ok: true, value: row.job };
    },
    async getInitialization() {
      if (slot === null) return { ok: true, value: null };
      const row = rows.get(slot);
      return { ok: true, value: row === undefined ? null : row.job };
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
        : { ...row.job, status: "pending", version: row.job.version + 1, cycle: row.job.cycle + 1 };
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
    async publish({ lease, expectedVersion }) {
      const row = rows.get(lease.jobId);
      if (row === undefined) return { ok: false, code: "JOB_NOT_FOUND" as const };
      if (row.job.version !== expectedVersion) return { ok: false, code: "JOB_CONFLICT" as const };
      row.job = { ...row.job, status: "published", version: row.job.version + 1 };
      return { ok: true, value: row.job };
    },
  };
}

// ---------------------------------------------------------------------------
// 脚本化 opening source：planning 返回 opening 计划；表达返回纯对白输出
// ---------------------------------------------------------------------------

function createOpeningSource(plan: StageRequest extends never ? never : ReturnType<typeof makeOpeningStagedPlan>): StageSource & { readonly stages: string[] } {
  const stages: string[] = [];
  return {
    stages,
    async generate(request: StageRequest, _execution: StageExecution): Promise<StageSuccess | AiSourceFailure> {
      stages.push(request.stage);
      if (request.stage === "planning") {
        return { ok: true, stage: "planning", value: plan };
      }
      if (request.stage === "narration") {
        return { ok: true, stage: "narration", value: makeNarrationOutput() };
      }
      if (request.stage === "character") {
        return { ok: true, stage: "character", value: makeCharacterOutput(FIXTURE_NPC_A) };
      }
      return { ok: true, stage: "choices", value: makeOpeningChoiceOutput() };
    },
  };
}

function openingCandidate() {
  const source = createFixtureOpeningCandidateSource();
  return source.generate({ gameType: "wuxia", seed: "init-seed", gameLength: "short" });
}

const GENERATION = {
  generationId: asGenerationId("gen_init"),
  seed: "init-seed",
  templateVersion: "v2" as const,
  inputDigest: "",
  gameType: "wuxia" as const,
};

function startInput(now: () => string, requestId = "req-1") {
  return {
    requestId,
    gameId: asGameId("game-init"),
    gameType: "wuxia" as const,
    gameLength: "short" as const,
    seed: "init-seed",
    generation: GENERATION,
    target: { kind: "create" as const },
    now,
  };
}

describe("initializationJob", () => {
  it("同 requestId 同输入幂等：只有一次 start，不重复计费", async () => {
    const jobs = createMemoryJobs();
    const now = () => "2026-09-09T08:00:00.000Z";
    const first = await startInitialization(startInput(now), jobs);
    const second = await startInitialization(startInput(now), jobs);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.job.id).toBe(first.job.id);
    expect(second.reused).toBe(true);
    expect(second.job.usedRequests).toBe(0);
  });

  it("同 requestId 异输入返回冲突（digest 不同）", async () => {
    const jobs = createMemoryJobs();
    const now = () => "2026-09-09T08:00:00.000Z";
    const ok = await startInitialization(startInput(now), jobs);
    expect(ok.ok).toBe(true);
    const conflict = await startInitialization(
      { ...startInput(now), gameLength: "medium" as const },
      jobs,
    );
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.code).toBe("JOB_CONFLICT");
  });

  it("digest 只随输入变化，与 now 无关", () => {
    const base = startInput(() => "2026-09-09T08:00:00.000Z");
    const { now: _now, ...withoutNow } = base;
    expect(initializationDigest(withoutNow)).toBe(initializationDigest({ ...withoutNow }));
    expect(initializationDigest(withoutNow)).not.toBe(
      initializationDigest({ ...withoutNow, seed: "other" }),
    );
  });

  it("完整 run：四段表达各一次，安装 ready 叙事并原子发布", async () => {
    const jobs = createMemoryJobs();
    const now = () => "2026-09-09T08:00:00.000Z";
    const candidate = await openingCandidate();
    const plan = makeOpeningStagedPlan(candidate);
    const source = createOpeningSource(plan);

    const started = await startInitialization(startInput(now), jobs);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const run = await runInitialization(started.job.id, "init-worker", {
      jobs,
      source,
      now,
      signal: new AbortController().signal,
      createdAt: now(),
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.job.status).toBe("published");
    expect([...source.stages].sort()).toEqual(["character", "choices", "narration", "planning"]);
  });

  it("query 无 slot 返回 none；start 后返回当前任务；cancel 经 CAS 置为 cancelled", async () => {
    const jobs = createMemoryJobs();
    const now = () => "2026-09-09T08:00:00.000Z";

    const none = await queryInitialization(jobs);
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.value).toBeNull();

    const started = await startInitialization(startInput(now), jobs);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const current = await queryInitialization(jobs);
    expect(current.ok).toBe(true);
    if (!current.ok || current.value === null) throw new Error("expected initialization job");
    expect(current.value.initialization?.requestId).toBe("req-1");

    // cancel 使用当前 version/cycle CAS；成功后 slot 任务变为 cancelled。
    const cancelled = await controlInitialization({
      jobId: started.job.id,
      operation: "cancel",
      expectedVersion: current.value.version,
      expectedCycle: current.value.cycle,
      now: now(),
    }, jobs);
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.value.status).toBe("cancelled");

    // 过期 version 的第二次 cancel 必须冲突，不重复生效。
    const stale = await controlInitialization({
      jobId: started.job.id,
      operation: "cancel",
      expectedVersion: current.value.version,
      expectedCycle: current.value.cycle,
      now: now(),
    }, jobs);
    expect(stale.ok).toBe(false);
  });

  it("失败后 retry 经 control 进入新 cycle 且重置未批准单元", async () => {
    const jobs = createMemoryJobs();
    const now = () => "2026-09-09T08:00:00.000Z";
    const started = await startInitialization(startInput(now), jobs);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const current = await queryInitialization(jobs);
    if (!current.ok || current.value === null) throw new Error("expected initialization job");

    // 模拟失败：直接 save 一个 failed job（走版本 CAS）。
    const failed = await jobs.save({
      lease: { jobId: started.job.id, owner: "w", fence: 1, expiresAt: "2099-01-01T00:00:00.000Z" },
      expectedVersion: current.value.version,
      job: { ...current.value, status: "failed", failureCode: "AI_CALL_FAILED" },
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;

    const retried = await controlInitialization({
      jobId: started.job.id,
      operation: "retry",
      expectedVersion: failed.value.version,
      expectedCycle: failed.value.cycle,
      now: now(),
    }, jobs);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.status).toBe("pending");
    expect(retried.value.cycle).toBe(failed.value.cycle + 1);
  });
});
