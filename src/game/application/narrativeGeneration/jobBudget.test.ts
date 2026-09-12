import { describe, expect, it } from "vitest";
import { baselineRequestsForPlan, canStartRequest, JOB_BUDGET } from "./jobBudget";
import { dialogueReviewHarness } from "./dialogueConsistencyFixture.testutil";
import { approvePlanningContext } from "./approvePlanningContext";
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
  it("decision、ending/null待答与无需审核的baseline含前置与最终审核；extra与unit上限不变", async () => {
    const { h, plan } = await dialogueReviewHarness();
    const stored = await h.readJob();
    if (!stored.ok) throw Error(stored.code);
    const checked = approvePlanningContext(stored.value.input, plan);
    if (!checked.ok) throw Error(checked.code);
    expect(baselineRequestsForPlan(checked.value)).toBe(1 + plan.units.length + 1);
    for (const kind of ["ending", "null"] as const) {
      const withoutCandidates = { ...checked.value, proposal: { ...plan, decision: null,
        ...(kind === "ending" ? { terminal: { kind: "ending" as const } } : {}) },
        choiceExpression: null, units: checked.value.units.filter(unit => unit.stage !== "choices") };
      expect(baselineRequestsForPlan(withoutCandidates)).toBe(1 + withoutCandidates.units.length + 1);
      expect(baselineRequestsForPlan({ ...withoutCandidates, currentUtterance: undefined })).toBe(2 + withoutCandidates.units.length);
    }
    expect(JOB_BUDGET).toEqual({ extraRequests: 12, maxUnitAttempts: 4 });
  });
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
