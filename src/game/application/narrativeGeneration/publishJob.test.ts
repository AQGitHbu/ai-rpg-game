import { describe, expect, it } from "vitest";
import { createStagedHarness } from "@/game/application/testing/stagedNarrativeHarness.testutil";
import { publishJob } from "./publishJob";
import type { Publication } from "../server/persistence/narrativeJobRepository";

const DECISION_PUBLICATION: Publication = {
  kind: "decision",
  input: {
    gameId: "game-harness" as never,
    expectedRevision: 0,
    nextWorldState: {} as never,
    nextStoryState: {} as never,
  },
};

describe("publishJob", () => {
  it.each(["missing", "text", "candidate", "stale"])("缺失或篡改对白审核凭据禁止发布：%s", async change => {
    const h = createStagedHarness();
    await h.startDecision();
    const ready = await h.run();
    if (!ready.ok) throw Error(ready.code);
    const job = { ...ready.value, dialogueConsistencyReview: change === "missing" ? undefined : {
      ...ready.value.dialogueConsistencyReview!, ...(change === "stale" ? { cycle: 99 } : {}),
    }, units: ready.value.units.map(u => u.value !== null && "stage" in u.value && u.value.stage === "choices"
      ? { ...u, value: { ...u.value, labels: u.value.labels.map((label, i) => i !== 0 ? label : {
        ...label, ...(change === "text" ? { label: label.label + "啊" } : {}),
        ...(change === "candidate" ? { candidateId: "tampered" } : {}),
      }) } } : u) };
    expect((await publishJob({ job, lease: h.lease(), publication: DECISION_PUBLICATION, now: () => h.clock.now() }, h.jobs)).ok).toBe(false);
    expect(h.publications()).toHaveLength(0);
  });
  it("最终输出批准后到达绝对截止时间也不得发布", async () => {
    const h = createStagedHarness();
    await h.startDecision();
    expect((await h.run()).ok).toBe(true);
    h.clock.advance(600_000);
    expect(await h.publish()).toMatchObject({ ok: false, code: "job_deadline_exceeded" });
    expect(h.publications()).toHaveLength(0);
  });
  it("全部单元批准后原子发布，版本递增且状态为 published", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const ran = await harness.run();
    expect(ran.ok).toBe(true);

    const published = await harness.publish();
    expect(published.ok).toBe(true);

    const stored = await harness.jobs.get(harness.jobId());
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value.status).toBe("published");
    expect(stored.value.units.every((unit) => unit.status === "approved")).toBe(true);
  });

  it("有单元未批准时拒绝发布，不触碰仓储", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const ran = await harness.run();
    if (!ran.ok) throw new Error("run 应成功");

    const job = ran.value;
    const withPending = { ...job, units: job.units.map((unit, index) => index === 1 ? { ...unit, status: "pending" as const } : unit) };
    const result = await publishJob({ job: withPending, lease: harness.lease(), publication: DECISION_PUBLICATION, now: () => harness.clock.now() }, harness.jobs);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("job_unit_not_approved");
  });

  it("非 pending 的 job 拒绝发布", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const ran = await harness.run();
    if (!ran.ok) throw new Error("run 应成功");
    const cancelled = await harness.cancel();
    expect(cancelled.ok).toBe(true);

    const stored = await harness.jobs.get(harness.jobId());
    if (!stored.ok) throw new Error("job 应存在");
    const result = await publishJob({ job: stored.value, lease: harness.lease(), publication: DECISION_PUBLICATION, now: () => harness.clock.now() }, harness.jobs);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("job_not_pending");
  });

  it("lease 与 job 不匹配时拒绝发布", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const ran = await harness.run();
    if (!ran.ok) throw new Error("run 应成功");

    const result = await publishJob(
      { job: ran.value, lease: { ...harness.lease(), jobId: "other-job" }, publication: DECISION_PUBLICATION, now: () => harness.clock.now() },
      harness.jobs,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("job_lease_mismatch");
  });

  it("缺 planning 单元时拒绝发布", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const ran = await harness.run();
    if (!ran.ok) throw new Error("run 应成功");

    const job = ran.value;
    const withoutPlanning = { ...job, units: job.units.filter((unit) => unit.key !== "planning") };
    const result = await publishJob({ job: withoutPlanning, lease: harness.lease(), publication: DECISION_PUBLICATION, now: () => harness.clock.now() }, harness.jobs);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("job_planning_missing");
  });

  it("表达单元被移除时装配复核先拒绝发布", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const ran = await harness.run();
    if (!ran.ok) throw new Error("run 应成功");

    const job = ran.value;
    const missingNarration = {
      ...job,
      units: job.units.filter((unit) => unit.key !== "narration_current"),
    };
    const result = await publishJob({ job: missingNarration, lease: harness.lease(), publication: DECISION_PUBLICATION, now: () => harness.clock.now() }, harness.jobs);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("assemble_unit_missing");
  });
});
