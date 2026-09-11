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
  Lease,
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

type MemoryRow = {
  job: StoredJob;
  requestId: string;
  digest: string;
  lease: { owner: string; fence: number; expiresAt: string } | null;
};

/**
 * 内存 job 仓储：**镜像 sqliteNarrativeJobs 的租约语义**（owner + fence +
 * expiresAt 三元组等值匹配）。所有写入路径（save/renew/publish）都**不查过期**：
 * TTL 只是 claim 接管的触发条件，并发权威是 fence——租约被接管后 owner/fence
 * 不再匹配 row，写入才返回 LEASE_LOST。真实 smoke 的历史缺陷是「没有续租，
 * 30s TTL 一到，租约被外部接管，收尾 publish 撞新 fence 被拒，job 卡 pending」；
 * 惰性续租（leaseKeeper）保证长生成期间租约保持活跃、无人能接管。
 *
 * `now` 由调用方注入，测试可用可推进的时钟复现长生成场景。
 */
function createMemoryJobs(_now: () => string): NarrativeJobRepository {
  const rows = new Map<string, MemoryRow>();
  let slot: string | null = null;

  function leaseMatches(row: MemoryRow | undefined, lease: Lease): boolean {
    if (row === undefined || row.lease === null) return false;
    return row.lease.owner === lease.owner
      && row.lease.fence === lease.fence
      && row.lease.expiresAt === lease.expiresAt;
  }

  return {
    async start({ requestId, digest, job }) {
      for (const row of rows.values()) {
        if (row.requestId === requestId) {
          if (row.digest !== digest) return { ok: false, code: "JOB_CONFLICT" as const };
          return { ok: true, value: row.job };
        }
      }
      rows.set(job.id, { job, requestId, digest, lease: null });
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
    async claim({ id, owner, now, expiresAt }) {
      const row = rows.get(id);
      if (row === undefined) return { ok: false, code: "JOB_NOT_FOUND" as const };
      if (row.job.status === "published" || row.job.status === "cancelled") {
        return { ok: false, code: "JOB_CONFLICT" as const };
      }
      if (row.lease !== null && row.lease.expiresAt > now) {
        if (row.lease.owner === owner) {
          return { ok: true, value: { jobId: id, owner, fence: row.lease.fence, expiresAt: row.lease.expiresAt } };
        }
        return { ok: false, code: "JOB_CONFLICT" as const };
      }
      const fence = (row.lease?.fence ?? 0) + 1;
      row.lease = { owner, fence, expiresAt };
      return { ok: true, value: { jobId: id, owner, fence, expiresAt } };
    },
    async renew({ lease, now: _now, expiresAt }) {
      const row = rows.get(lease.jobId);
      if (row === undefined) return { ok: false, code: "JOB_NOT_FOUND" as const };
      // 与生产一致：不否决已过期但未被接管的租约（fence 是并发权威）。
      if (!leaseMatches(row, lease)) {
        return { ok: false, code: "LEASE_LOST" as const };
      }
      row.lease = { owner: lease.owner, fence: lease.fence, expiresAt };
      return { ok: true, value: { ...lease, expiresAt } };
    },
    async release({ lease }) {
      const row = rows.get(lease.jobId);
      if (row === undefined) return { ok: false, code: "JOB_NOT_FOUND" as const };
      if (!leaseMatches(row, lease)) return { ok: false, code: "LEASE_LOST" as const };
      row.lease = null;
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
      row.lease = null;
      return { ok: true, value: next };
    },
    async save({ lease, expectedVersion, job }) {
      const row = rows.get(lease.jobId);
      if (row === undefined) return { ok: false, code: "JOB_NOT_FOUND" as const };
      // 与生产一致：save 只做三元组等值匹配，不查过期。
      if (!leaseMatches(row, lease)) return { ok: false, code: "LEASE_LOST" as const };
      if (row.job.version !== expectedVersion) return { ok: false, code: "JOB_CONFLICT" as const };
      if (row.job.status === "published" || row.job.status === "cancelled") {
        return { ok: false, code: "JOB_CONFLICT" as const };
      }
      row.job = { ...job, version: row.job.version + 1 };
      return { ok: true, value: row.job };
    },
    async publish({ lease, expectedVersion }) {
      const row = rows.get(lease.jobId);
      if (row === undefined) return { ok: false, code: "JOB_NOT_FOUND" as const };
      // 与生产一致：三元组等值匹配，不查过期（被接管后 fence 不匹配才 LEASE_LOST）。
      if (!leaseMatches(row, lease)) {
        return { ok: false, code: "LEASE_LOST" as const };
      }
      if (row.job.version !== expectedVersion) return { ok: false, code: "JOB_CONFLICT" as const };
      if (!row.job.units.every((unit) => unit.status === "approved")) {
        return { ok: false, code: "JOB_CONFLICT" as const };
      }
      row.job = { ...row.job, status: "published", version: row.job.version + 1 };
      row.lease = null;
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
    async reviewDialogueConsistency() { return { ok: true, verdict: "pass", violations: [] }; },
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
    const now = () => "2026-09-09T08:00:00.000Z";
    const jobs = createMemoryJobs(now);
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
    const now = () => "2026-09-09T08:00:00.000Z";
    const jobs = createMemoryJobs(now);
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

  it("重发复用第一次的随机身份和种子", async () => {
    const now = () => "2026-09-09T08:00:00.000Z";
    const jobs = createMemoryJobs(now);
    const input = startInput(now);
    const first = await startInitialization(input, jobs);
    const second = await startInitialization({ ...input, gameId: "other-game" as typeof input.gameId, seed: "other",
      generation: { ...input.generation, generationId: "other-generation" as typeof input.generation.generationId } }, jobs);
    expect(first.ok && second.ok && first.job.id === second.job.id).toBe(true);
    if (first.ok && second.ok) expect(second.job.initialization).toEqual(first.job.initialization);
  });

  it("digest 绑定用户输入，不绑定服务端分配的随机种子", () => {
    const base = startInput(() => "2026-09-09T08:00:00.000Z");
    const { now: _now, ...withoutNow } = base;
    expect(initializationDigest(withoutNow)).toBe(initializationDigest({ ...withoutNow }));
    expect(initializationDigest(withoutNow)).toBe(
      initializationDigest({ ...withoutNow, seed: "other" }),
    );
  });

  it("完整 run：四段表达各一次，安装 ready 叙事并原子发布", async () => {
    const now = () => "2026-09-09T08:00:00.000Z";
    const jobs = createMemoryJobs(now);
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

  it("opening planning 静态校验失败时先重做 planning，不先调用 narration", async () => {
    const now = () => "2026-09-09T08:00:00.000Z";
    const jobs = createMemoryJobs(now);
    const plan = makeOpeningStagedPlan(await openingCandidate());
    const character = plan.units.find((unit) => unit.stage === "character");
    if (character === undefined) throw new Error("character fixture missing");
    const invalidPlan = {
      ...plan,
      observations: [{
        key: "obs_witness",
        point: { stepKey: "current", order: 1 },
        audienceIds: ["player_0", FIXTURE_NPC_A],
        fact: { factId: "branch_routes", certainty: "known" as const },
        source: { kind: "witness" as const },
      }],
      units: plan.units.map((unit) => unit.key === character.key
        ? { ...unit, requiredObservationKeys: ["obs_witness"] }
        : unit),
    };
    const source = createOpeningSource(plan);
    const generate = source.generate.bind(source);
    const repairs: (StageExecution["repair"] | undefined)[] = [];
    let firstPlanning = true;
    source.generate = async (request, execution) => {
      if (request.stage === "planning") repairs.push(execution.repair);
      const response = await generate(request, execution);
      if (!firstPlanning || request.stage !== "planning" || !response.ok || response.stage !== "planning") return response;
      firstPlanning = false;
      return { ...response, value: invalidPlan };
    };

    const started = await startInitialization(startInput(now), jobs);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const result = await runInitialization(started.job.id, "init-worker", {
      jobs, source, now, signal: new AbortController().signal, createdAt: now(),
    });

    expect(result.ok).toBe(true);
    expect(source.stages.slice(0, 3)).toEqual(["planning", "planning", "narration"]);
    expect(source.stages.filter((stage) => stage === "planning")).toHaveLength(2);
    expect(repairs[1]).toMatchObject({
      reason: "invalid_schema",
      rejectionCode: "beat_authority_conflict",
      detail: expect.stringContaining("obs_witness"),
    });
  });

  it("发布被拒后任务必须 failed，而非永远 pending", async () => {
    const now = () => "2026-09-09T08:00:00.000Z";
    const jobs = createMemoryJobs(now);
    jobs.publish = async () => ({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
    const source = createOpeningSource(makeOpeningStagedPlan(await openingCandidate()));
    const started = await startInitialization(startInput(now), jobs);
    if (!started.ok) throw new Error("start failed");
    const result = await runInitialization(started.job.id, "worker", {
      jobs, source, now, signal: new AbortController().signal, createdAt: now(),
    });
    expect(result.ok).toBe(false);
    const stored = await jobs.get(started.job.id);
    if (!stored.ok) throw new Error("job missing");
    expect(stored.value.status).toBe("failed");
    expect(stored.value.failureCode).toBe("INFRASTRUCTURE_FAILURE");
  });

  it("query 无 slot 返回 none；start 后返回当前任务；cancel 经 CAS 置为 cancelled", async () => {
    const now = () => "2026-09-09T08:00:00.000Z";
    const jobs = createMemoryJobs(now);

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
    const now = () => "2026-09-09T08:00:00.000Z";
    const jobs = createMemoryJobs(now);
    const started = await startInitialization(startInput(now), jobs);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const current = await queryInitialization(jobs);
    if (!current.ok || current.value === null) throw new Error("expected initialization job");

    // 模拟失败：先按生产语义 claim 取得租约，再 save 一个 failed job（走版本 CAS）。
    const claimed = await jobs.claim({
      id: started.job.id,
      owner: "w",
      now: now(),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    const failed = await jobs.save({
      lease: claimed.value,
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

  // -------------------------------------------------------------------------
  // 租约长跑：真实 smoke 暴露的「全部单元 approved 却卡 pending」缺陷。
  //
  // 30s TTL 内没有续租：租约过期后可被外部 claim 接管（fence 递增），持有者
  // 收尾 publish 撞新 fence 于是 LEASE_LOST，job 留在 pending 且 lease 已被
  // finally 的 release 清空——外部只看到「永久 pending」。真实观测：sci-fi 局
  // 10 单元 / 36.3s，超过 30s TTL。惰性续租让租约跨过 TTL 仍保持活跃、无人能
  // 接管，末段 publish 三元组匹配成功。
  // -------------------------------------------------------------------------

  it("生成耗时超过租约 TTL 时仍能发布：中途续租使末段 publish 不丢租约", async () => {
    const epoch = Date.parse("2026-09-09T08:00:00.000Z");
    let offsetMs = 0;
    const now = () => new Date(epoch + offsetMs).toISOString();

    const jobs = createMemoryJobs(now);
    const candidate = await openingCandidate();
    const plan = makeOpeningStagedPlan(candidate);
    const inner = createOpeningSource(plan);
    // 每个 provider 调用耗时 8s：四个表达阶段累计 32s，跨过 30s TTL。
    const source: StageSource & { readonly stages: string[] } = {
      stages: inner.stages,
      reviewDialogueConsistency: inner.reviewDialogueConsistency,
      async generate(request, execution) {
        offsetMs += 8_000;
        return inner.generate(request, execution);
      },
    };

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

    // 生成确实跨过了初始租约窗口（否则本用例没有验证到目标路径）。
    // 惰性续租对注入时钟天然成立：每次 save 前都会按 now 判定是否过半并续租；
    // 修复前此处 publish 必然 LEASE_LOST（租约在 30s 处过期）。
    expect(offsetMs).toBeGreaterThan(30_000);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.job.status).toBe("published");
  });
});
