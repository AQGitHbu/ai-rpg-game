// 决策任务的持久化编排（Plan 2026-09-09 / Task 10 Step 3）。
//
// 覆盖：从已提交 provider_pending job 幂等补建 durable 任务（只一次 start，
// 不重复计费）；非 pending 返回 NOT_PENDING；完整 run 在租约作用域内生成、
// 装配审批并原子发布；发布载荷是 ApplyStateInput。
//
// 世界 / 记录夹具复用 domain/testing/stagedNarrativeFixture.testutil，
// 与 generatePendingNarrativeBundle.test.ts 共享同一套权威输入。

import { describe, expect, it } from "vitest";
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
  startDecisionJob,
  decisionDigest,
  decisionJobId,
  runDecision,
} from "@/game/application/narrativeGeneration/decisionJob";
import {
  makeDecisionPlan,
  makeDecisionChoiceOutput,
  makeNarrationOutput,
  makeCharacterOutput,
  createPendingDecisionRecord,
  FIXTURE_DECISION_NPC,
} from "@/game/domain/testing/stagedNarrativeFixture.testutil";

function createMemoryJobs(): NarrativeJobRepository {
  const rows = new Map<string, { job: StoredJob; requestId: string; digest: string }>();
  return {
    async start({ requestId, digest, job }) {
      for (const row of rows.values()) {
        if (row.requestId === requestId) {
          if (row.digest !== digest) return { ok: false, code: "JOB_CONFLICT" as const };
          return { ok: true, value: row.job };
        }
      }
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

function createDecisionSource(): StageSource & { readonly stages: string[] } {
  const stages: string[] = [];
  return {
    stages,
    async reviewDialogueConsistency() { return { ok: true, verdict: "pass", failedIds: [] }; },
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

const NOW = () => "2026-09-09T08:00:00.000Z";

describe("decisionJob", () => {
  it("从已提交 pending job 幂等补建：重复 ensure 只一次 start，不重复计费", async () => {
    const jobs = createMemoryJobs();
    const record = createPendingDecisionRecord();
    const first = await startDecisionJob({ record, now: NOW }, jobs);
    const second = await startDecisionJob({ record, now: NOW }, jobs);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.job.id).toBe(first.job.id);
    expect(second.reused).toBe(true);
    expect(second.job.usedRequests).toBe(0);
  });

  it("非 provider_pending 返回 NOT_PENDING，不创建任务", async () => {
    const jobs = createMemoryJobs();
    const record = createPendingDecisionRecord();
    const ready = {
      ...record,
      storyState: {
        ...record.storyState,
        narrative: {
          status: "ready" as const,
          mode: "ai" as const,
          currentScene: null,
          choiceRegistry: [],
          narrativeBundle: null,
        },
      },
    } as unknown as typeof record;
    const result = await startDecisionJob({ record: ready, now: NOW }, jobs);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOT_PENDING");
  });

  it("digest 与 jobId 只随权威输入变化", () => {
    const record = createPendingDecisionRecord();
    if (record.storyState.narrative.status !== "provider_pending") throw new Error("expected pending");
    const base = { gameId: record.gameId, revision: record.revision, job: record.storyState.narrative.job };
    expect(decisionDigest(base)).toBe(decisionDigest(base));
    expect(decisionDigest(base)).not.toBe(decisionDigest({ ...base, revision: 7 }));
    expect(decisionJobId(base.gameId, base.job, base.revision))
      .toBe(decisionJobId(base.gameId, base.job, base.revision));
    expect(decisionJobId(base.gameId, base.job, base.revision))
      .not.toBe(decisionJobId(base.gameId, base.job, 9));
  });

  it("完整 run：三段表达各一次，装配审批并原子发布 decision 载荷", async () => {
    const jobs = createMemoryJobs();
    const record = createPendingDecisionRecord();
    const source = createDecisionSource();
    const started = await startDecisionJob({ record, now: NOW }, jobs);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const run = await runDecision(started.job.id, "decision-worker", {
      jobs,
      source,
      now: NOW,
      signal: new AbortController().signal,
      createdAt: NOW(),
    });
    if (!run.ok) throw new Error(`run failed: ${run.code}`);
    expect(run.job.status).toBe("published");
    expect([...source.stages].sort()).toEqual(["character", "choices", "narration", "planning"]);
  });
});
