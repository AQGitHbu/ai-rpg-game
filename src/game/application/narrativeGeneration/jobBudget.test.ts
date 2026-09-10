import { describe, expect, it } from "vitest";
import { canStartRequest, JOB_BUDGET } from "./jobBudget";
import type { StoredJob } from "@/game/application/server/persistence/narrativeJobRepository";

function job(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    schemaVersion: 1,
    id: "job-1",
    scope: "decision",
    version: 0,
    cycle: 0,
    status: "pending",
    input: { kind: "decision", world: {} as never, story: {} as never, job: {} as never },
    inputDigest: "d",
    baseRevision: 0,
    gameId: "game-1",
    units: [],
    usedRequests: 0,
    baselineRequests: 1,
    deadline: "2026-09-09T08:10:00.000Z",
    failureCode: null,
    initialization: null,
    ...overrides,
  };
}

const NOW = "2026-09-09T08:00:00.000Z";

describe("canStartRequest", () => {
  it("新鲜任务放行", () => {
    expect(canStartRequest({ job: job(), unitAttempts: 0, now: NOW }).ok).toBe(true);
  });

  it("deadline 已过拒绝", () => {
    expect(canStartRequest({ job: job(), unitAttempts: 0, now: "2026-09-09T08:10:01.000Z" }))
      .toEqual({ ok: false, code: "job_deadline_exceeded" });
  });

  it("超过 baseline + 12 次额度拒绝", () => {
    expect(canStartRequest({
      job: job({ usedRequests: 1 + JOB_BUDGET.extraRequests }), unitAttempts: 0, now: NOW,
    })).toEqual({ ok: false, code: "job_budget_exhausted" });
  });

  it("单元第 4 次尝试后拒绝", () => {
    expect(canStartRequest({ job: job(), unitAttempts: JOB_BUDGET.maxUnitAttempts, now: NOW }))
      .toEqual({ ok: false, code: "unit_attempts_exhausted" });
  });
});
