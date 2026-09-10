// 可恢复 DAG 调度（Plan 2026-09-09 / Task 8 Step 1-4）。
//
// runJob 不 claim/release：完成生成与审批后返回待发布的 pending job。
// claim → charge/save running → generate → approve → save approved，
// 绝不先发请求后扣预算。重启时在途 unknown 请求保留 charge，等待
// lease 过期后有界重做。

import { describe, expect, it } from "vitest";
import { createStagedHarness } from "@/game/application/testing/stagedNarrativeHarness.testutil";

describe("runJob", () => {
  it("失败单元重试：planning 一次、choices 两次、narration 一次", async () => {
    const h = createStagedHarness();
    h.source.failNext("choices");
    await h.startDecision();
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.source.calls.filter((c) => c.stage === "planning")).toHaveLength(1);
    expect(h.source.calls.filter((c) => c.stage === "choices")).toHaveLength(2);
    expect(h.source.calls.filter((c) => c.stage === "narration")).toHaveLength(1);
    expect(h.source.calls.filter((c) => c.stage === "character")).toHaveLength(2);
  });

  it("全部单元 approved 后返回待发布 pending job", async () => {
    const h = createStagedHarness();
    await h.startDecision();
    const result = await h.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("pending");
    expect(result.value.units.length).toBeGreaterThan(0);
    expect(result.value.units.every((unit) => unit.status === "approved")).toBe(true);
  });

  it("单元尝试额度耗尽后任务失败并携带 failureCode", async () => {
    const h = createStagedHarness();
    for (let index = 0; index < 4; index += 1) h.source.failNext("narration");
    await h.startDecision();
    const result = await h.run();
    expect(result.ok).toBe(false);
    const job = await h.jobs.get(h.jobId());
    expect(job.ok).toBe(true);
    if (job.ok) {
      expect(job.value.status).toBe("failed");
      expect(job.value.failureCode).not.toBeNull();
    }
    expect(h.source.calls.filter((c) => c.stage === "narration")).toHaveLength(4);
  });

  it("重启恢复：running 单元标 unknown 且保留 charge", async () => {
    const h = createStagedHarness();
    await h.startDecision();
    // 模拟崩溃前状态：直接写入一个 running 单元
    const job = await h.jobs.get(h.jobId());
    if (!job.ok) throw new Error("job missing");
    const lease = h.lease();
    const withRunning = await h.jobs.save({
      lease,
      expectedVersion: job.value.version,
      job: {
        ...job.value,
        units: [{ unit: null, key: "narration_current", inputDigest: "d", attempts: 2, status: "running", value: null }],
      },
    });
    expect(withRunning.ok).toBe(true);
    const result = await h.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 旧 running 单元保留 charge（attempts ≥ 2），最终仍被有界重做并 approved
    const narrationUnits = result.value.units.filter((unit) => unit.key === "narration_current");
    expect(narrationUnits.every((unit) => unit.status === "approved")).toBe(true);
    expect(narrationUnits[0]?.attempts).toBeGreaterThanOrEqual(2);
  });

  it("持有锁且请求未返回时 cancel 立即成功；迟到输出不可写回", async () => {
    const h = createStagedHarness();
    h.source.hold("narration");
    await h.startDecision();
    const runPromise = h.run();
    const cancelled = await h.cancel();
    expect(cancelled.ok).toBe(true);
    h.source.release("narration");
    const result = await runPromise;
    expect(result.ok).toBe(false);
    const job = await h.jobs.get(h.jobId());
    if (job.ok) {
      expect(job.value.status).toBe("cancelled");
      expect(job.value.units.some((unit) => unit.status === "approved")).toBe(false);
    }
  });

  it("fake clock：deadline 过后任务失败", async () => {
    const h = createStagedHarness();
    await h.startDecision();
    h.clock.advance(600_001);
    const result = await h.run();
    expect(result.ok).toBe(false);
    const job = await h.jobs.get(h.jobId());
    if (job.ok) {
      expect(job.value.status).toBe("failed");
      expect(job.value.failureCode).toBe("job_deadline_exceeded");
    }
  });

  it("满预算时 planning 90s / expression 45s（Plan 固定决策 3 的已记录偏离）", async () => {
    const h = createStagedHarness();
    await h.startDecision();
    const result = await h.run();
    expect(result.ok).toBe(true);
    const planning = h.source.calls.find((c) => c.stage === "planning");
    expect(planning?.timeoutMs).toBe(90_000);
    const narration = h.source.calls.find((c) => c.stage === "narration");
    expect(narration?.timeoutMs).toBe(45_000);
  });

  it("表达审批失败（引用不可见事实）带修复反馈自动重试后成功", async () => {
    // Spec §205「先重试表达」：审批拒绝（provider 成功但输出不合规）在剩余
    // 额度内自动带修复反馈重试，而非直接落 failed。
    const h = createStagedHarness();
    h.source.failApprovalNext("narration");
    await h.startDecision();
    const result = await h.run();
    expect(result.ok).toBe(true);
    const narrationCalls = h.source.calls.filter((c) => c.stage === "narration");
    expect(narrationCalls).toHaveLength(2);
    expect(narrationCalls[1]?.repair?.rejectionCode).toBe("unit_output_fact_unavailable");
    expect(narrationCalls[1]?.repair?.reason).toBe("invalid_schema");
    expect(narrationCalls[1]?.repair?.attempt).toBe(1);
    if (result.ok) {
      expect(result.value.units.every((unit) => unit.status === "approved")).toBe(true);
    }
  });

  it("表达审批失败（候选 ID 未知）带修复反馈自动重试后成功", async () => {
    const h = createStagedHarness();
    h.source.failApprovalNext("choices");
    await h.startDecision();
    const result = await h.run();
    expect(result.ok).toBe(true);
    const choicesCalls = h.source.calls.filter((c) => c.stage === "choices");
    expect(choicesCalls).toHaveLength(2);
    expect(choicesCalls[1]?.repair?.rejectionCode).toBe("unit_output_candidate_unknown");
    expect(choicesCalls[1]?.repair?.attempt).toBe(1);
  });

  it("剩余时间不足默认超时时按 deadline 收缩 timeout，请求不越过周期", async () => {
    // 固定决策 3「按剩余时间缩短 timeout」：clock 前进 550s 后剩余 50s，
    // planning 默认 90s 收缩到 50s；expression 默认 45s 低于剩余时间保持不变。
    const h = createStagedHarness();
    await h.startDecision();
    h.clock.advance(550_000);
    const result = await h.run();
    expect(result.ok).toBe(true);
    const planning = h.source.calls.find((c) => c.stage === "planning");
    expect(planning?.timeoutMs).toBe(50_000);
    const narration = h.source.calls.find((c) => c.stage === "narration");
    expect(narration?.timeoutMs).toBe(45_000);
  });
});
