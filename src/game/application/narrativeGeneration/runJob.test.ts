// 可恢复 DAG 调度（Plan 2026-09-09 / Task 8 Step 1-4）。
//
// runJob 不 claim/release：完成生成与审批后返回待发布的 pending job。
// claim → charge/save running → generate → approve → save approved，
// 绝不先发请求后扣预算。重启时在途 unknown 请求保留 charge，等待
// lease 过期后有界重做。

import { describe, expect, it, vi } from "vitest";
import * as perspectiveContext from "./perspectiveContext";
import { createStagedHarness } from "@/game/application/testing/stagedNarrativeHarness.testutil";
import { createAiSourceFailure } from "@/game/application/aiGenerationRetry";

import type { UnitOutput } from "@/game/domain/narrativeUnit";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import { approvePlanningContext } from "./approvePlanningContext";
import { assembleBundle } from "./assembleBundle";
import { expressionProjectionDigest, runJob } from "./runJob";

function twoBeatHarness(ambiguousAttempts = 1) {
  const h = createStagedHarness();
  const generate = h.source.generate.bind(h.source);
  let narrationAttempts = 0;
  h.source.generate = async (request, execution) => {
    const response = await generate(request, execution);
    if (!response.ok) return response;
    if (response.stage === "planning") return { ...response, value: {
      ...response.value,
      units: response.value.units.map(unit => unit.stage === "narration"
        ? { ...unit, point: { ...unit.point, order: 2 }, requiredBeats: ["beat_a", "beat_b"].map(beatId => ({
          beatId, kind: "atmosphere" as const, factIds: [], evidence: [], instruction: "描写现场",
        })) }
        : unit.key === "character_npc_0" ? { ...unit, point: { ...unit.point, order: 3 }, dependencies: ["narration_current"] }
          : unit.key === "character_npc_1" ? { ...unit, point: { ...unit.point, order: 1 } } : unit),
    } };
    if (response.stage !== "narration") return response;
    narrationAttempts += 1;
    return { ...response, value: { ...response.value, parts: narrationAttempts <= ambiguousAttempts
      ? [{ text: "灯火明暗，窗外风起。", facts: [], evidence: [], beatIds: ["beat_a", "beat_b"] }]
      : [
        { text: "灯火明暗。", facts: [], evidence: [], beatIds: ["beat_a"] },
        { text: "窗外风起。", facts: [], evidence: [], beatIds: ["beat_b"] },
      ],
    } };
  };
  const startDecision = h.startDecision.bind(h);
  h.startDecision = async (...args) => {
    await startDecision(...args);
    const loaded = await h.readJob();
    if (!loaded.ok) throw Error(loaded.code);
    const started = loaded.value;
    if (started.input.kind !== "decision") throw Error("decision fixture");
    const saved = await h.jobs.save({ lease: h.lease(), expectedVersion: started.version,
      job: { ...started, input: { ...started.input, job: { ...started.input.job,
        mandatoryBeats: ["beat_a", "beat_b"].map(beatId => ({
          beatId, kind: "atmosphere" as const, subjectIds: [], instruction: "描写现场",
        })),
      } } },
    });
    if (!saved.ok) throw Error(saved.code);
  };
  return h;
}

describe("runJob", () => {
  it("同投影版本下风格变化仍改变表达缓存摘要", async () => {
    const h = createStagedHarness();
    await h.startDecision();
    if (!(await h.run()).ok) throw new Error("fixture run failed");
    const request = h.requests.find((candidate) => candidate.stage === "choices");
    if (request?.stage !== "choices") throw new Error("choice request missing");
    const concise = { ...request.context, stylePolicy: { ...request.context.stylePolicy!, narration: "concise" as const } };
    const cinematic = { ...request.context, stylePolicy: { ...request.context.stylePolicy!, narration: "cinematic" as const } };
    expect(expressionProjectionDigest(concise)).not.toBe(expressionProjectionDigest(cinematic));
  });
  it("完整兼容的 approved 投影恢复时不重复调用 source", async () => {
    const h = createStagedHarness();
    await h.startDecision();
    const initial = await h.run();
    if (!initial.ok) throw new Error(initial.code);
    const callsBefore = h.calls.length;
    const resumed = await h.run();
    expect(resumed.ok).toBe(true);
    expect(h.calls).toHaveLength(callsBefore);
    if (resumed.ok) expect(resumed.value.usedRequests).toBe(initial.value.usedRequests);
  });
  it("晚到的最终选项不批准、不发布，并持久记录截止失败", async () => {
    const h = createStagedHarness();
    const generate = h.source.generate.bind(h.source);
    h.source.generate = async (request, execution) => {
      const result = await generate(request, execution);
      if (request.stage === "choices") h.clock.advance(600_000);
      return result;
    };
    await h.startDecision();
    expect(await h.run()).toMatchObject({ ok: false, code: "job_deadline_exceeded" });
    expect(await h.readJob()).toMatchObject({ ok: true, value: { status: "failed", failureCode: "job_deadline_exceeded" } });
    expect(h.publications()).toHaveLength(0);
  });
  it("多节拍旁白在单元内带反馈重试，规划不重跑且完整装配保留两个段落", async () => {
    const h = twoBeatHarness();
    await h.startDecision();
    const result = await h.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const calls = h.calls.filter(call => call.stage === "narration");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.repair?.rejectionCode).toBe("unit_output_beat_ambiguous");
    expect(h.calls.filter(call => call.stage === "planning")).toHaveLength(1);
    expect(h.calls.filter(call => call.stage === "character")).toHaveLength(2);
    expect(h.calls.filter(call => call.stage === "choices")).toHaveLength(1);
    expect(result.value.usedRequests).toBe(8);
    const proposal = result.value.units.find(unit => unit.key === "planning")?.value as PlanProposal;
    const plan = approvePlanningContext(result.value.input, proposal);
    if (!plan.ok) throw new Error(plan.code);
    const outputs = new Map<string, UnitOutput>();
    for (const unit of result.value.units) {
      if (unit.key !== "planning" && unit.value !== null) outputs.set(unit.key, unit.value as UnitOutput);
    }
    const assembled = assembleBundle({ plan: plan.value, approved: outputs });
    expect(assembled.ok).toBe(true);
    if (assembled.ok) expect(assembled.value.currentScene.segments).toEqual([
      { beatId: "beat_a", text: "灯火明暗。" }, { beatId: "beat_b", text: "窗外风起。" },
    ]);
  });

  it("持续多节拍歧义耗尽四次后显式失败，不发布半包", async () => {
    const h = twoBeatHarness(10);
    await h.startDecision();
    expect(await h.run()).toEqual({ ok: false, code: "unit_output_beat_ambiguous" });
    expect(h.calls.filter(call => call.stage === "narration")).toHaveLength(4);
    expect(h.publications()).toHaveLength(0);
  });

  it.each(["ambiguous", "layout"])("重试旧装配失败任务：只失效违规旁白与传递依赖，保留尝试额度（%s）", async violation => {
    const h = twoBeatHarness(0);
    await h.startDecision();
    const initial = await h.run();
    if (!initial.ok) throw new Error(initial.code);
    const saved = await h.jobs.save({
      lease: h.lease(), expectedVersion: initial.value.version,
      job: { ...initial.value, status: "failed", failureCode: "assemble_segment_ambiguous_beat",
        units: initial.value.units.map(unit => unit.value !== null && "stage" in unit.value
          && unit.value.stage === "narration" ? { ...unit, value: { ...unit.value,
            parts: violation === "ambiguous"
              ? [{ text: "旧版本合段。", facts: [], evidence: [], beatIds: ["beat_a", "beat_b"] }]
              : ["beat_a", "beat_b", "beat_a"].map(beatId => ({ text: "旧重复段。", facts: [], evidence: [], beatIds: [beatId] })),
          } } : unit),
      },
    });
    expect(saved.ok).toBe(true);
    expect((await h.retry()).ok).toBe(true);
    const claimed = await h.jobs.claim({
      id: h.jobId(), owner: "retry-worker", now: h.clock.now(),
      expiresAt: new Date(Date.parse(h.clock.now()) + 30_000).toISOString(),
    });
    if (!claimed.ok) throw new Error(claimed.code);
    const callsBefore = h.calls.length;
    const result = await runJob({ id: h.jobId(), lease: claimed.value }, {
      jobs: h.jobs, source: h.source, now: () => h.clock.now(), signal: h.controller.signal,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(h.calls.slice(callsBefore).map(call => call.stage)).toEqual(["narration", "character", "choices"]);
    expect(h.calls.slice(callsBefore).every(call => call.auditContext.retry?.origin === "manual_failed_job"
      && call.auditContext.retry.mechanism === "initial" && call.auditContext.retry.attempt === 0)).toBe(true);
    expect(result.value.usedRequests).toBe(5);
    for (const key of ["narration_current", "character_npc_0", "choices_current"]) {
      expect(result.value.units.find(unit => unit.key === key)?.attempts).toBe(2);
    }
    expect(result.value.units.find(unit => unit.key === "planning")?.value)
      .toEqual(initial.value.units.find(unit => unit.key === "planning")?.value);
    expect(result.value.units.find(unit => unit.key === "character_npc_1"))
      .toEqual(initial.value.units.find(unit => unit.key === "character_npc_1"));
  });

  it("旧歧义旁白已用尽尝试时恢复不偷重置额度，也不发布旧依赖", async () => {
    const h = twoBeatHarness(0);
    await h.startDecision();
    const initial = await h.run();
    if (!initial.ok) throw new Error(initial.code);
    expect((await h.jobs.save({
      lease: h.lease(), expectedVersion: initial.value.version,
      job: { ...initial.value, units: initial.value.units.map(unit =>
        unit.value !== null && "stage" in unit.value && unit.value.stage === "narration"
          ? { ...unit, attempts: 4, value: { ...unit.value,
            parts: [{ text: "旧合段。", facts: [], evidence: [], beatIds: ["beat_a", "beat_b"] }],
          } } : unit),
      },
    })).ok).toBe(true);
    const callsBefore = h.calls.length;
    expect(await h.run()).toEqual({ ok: false, code: "unit_attempts_exhausted" });
    expect(h.calls).toHaveLength(callsBefore);
    const stored = await h.readJob();
    if (!stored.ok) throw new Error(stored.code);
    expect(stored.value.usedRequests).toBe(initial.value.usedRequests);
    expect(stored.value.units.find(unit => unit.key === "narration_current"))
      .toMatchObject({ attempts: 4, status: "pending", value: null });
    expect(stored.value.units.find(unit => unit.key === "choices_current")?.value).toBeNull();
    expect(h.publications()).toHaveLength(0);
  });

  it("旧 approved 表达摘要失效后重算真实安全投影，保留已扣预算与 attempts", async () => {
    const h = createStagedHarness();
    await h.startDecision();
    const initial = await h.run();
    if (!initial.ok) throw new Error(initial.code);
    const choice = initial.value.units.find(unit => unit.key === "choices_current");
    if (choice === undefined) throw new Error("choice fixture missing");
    const saved = await h.jobs.save({ lease: h.lease(), expectedVersion: initial.value.version,
      job: { ...initial.value, status: "pending", failureCode: null,
        units: initial.value.units.map(unit => unit.key === choice.key
          ? { ...unit, inputDigest: initial.value.inputDigest } : unit) },
    });
    if (!saved.ok) throw new Error(saved.code);
    const callsBefore = h.calls.length;
    const result = await h.run();
    if (!result.ok) throw new Error(result.code);
    expect(h.calls.slice(callsBefore).map(call => call.stage)).toEqual(["choices"]);
    expect(result.value.usedRequests).toBe(initial.value.usedRequests + 2);
    expect(result.value.units.find(unit => unit.key === choice.key)).toMatchObject({ attempts: choice.attempts + 1, status: "approved" });
    expect(result.value.units.find(unit => unit.key === choice.key)?.inputDigest).not.toBe(initial.value.inputDigest);
  });

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
    if (result.ok) expect(result.value.usedRequests).toBe(h.source.calls.length + 2);
  });

  it("planning schema 失败把稳定 code 和安全 detail 传给下一次请求", async () => {
    const h = createStagedHarness();
    const generate = h.source.generate.bind(h.source);
    let firstPlanningFailure = true;
    h.source.generate = async (request, execution) => {
      const response = await generate(request, execution);
      if (request.stage === "planning" && firstPlanningFailure) {
        firstPlanningFailure = false;
        return createAiSourceFailure("scene", "invalid_schema", "unit_output_label_invalid",
          "labels[1]: 106 Unicode code points; maximum 80");
      }
      return response;
    };

    await h.startDecision();
    const result = await h.run();
    expect(result.ok).toBe(true);
    const planningCalls = h.calls.filter((call) => call.stage === "planning");
    expect(planningCalls).toHaveLength(2);
    expect(planningCalls[1]?.repair).toMatchObject({
      reason: "unit_output_label_invalid",
      detail: "labels[1]: 106 Unicode code points; maximum 80",
    });
  });

  it.each(["planning", "narration"] as const)("%s 的 AI_CALL_FAILED 立即终止，不进入内容修复", async stage => {
    const h = createStagedHarness();
    const generate = h.source.generate.bind(h.source);
    let calls = 0;
    h.source.generate = async (request, execution) => request.stage === stage
      ? (calls += 1, createAiSourceFailure("scene", "transport", "provider_failure", "code=http_error"))
      : generate(request, execution);
    await h.startDecision();
    expect(await h.run()).toEqual({ ok: false, code: "AI_CALL_FAILED" });
    expect(calls).toBe(1);
  });

  it("真实 empty_response 只失败一次，不把思考耗尽说明当内容修复", async () => {
    const h = createStagedHarness();
    let calls = 0;
    h.source.generate = async () => {
      calls += 1;
      return createAiSourceFailure("scene", "empty_response", "empty_response",
        "provider 未返回最终 JSON：finishReason=length；reasoningTokens=6000");
    };
    await h.startDecision();
    expect(await h.run()).toEqual({ ok: false, code: "AI_CALL_FAILED" });
    expect(calls).toBe(1);
  });

  it("连续 source schema 失败逐轮替换 repair detail，不重用旧详情", async () => {
    const h = createStagedHarness();
    const generate = h.source.generate.bind(h.source);
    let failures = 0;
    const repairs: Array<Parameters<typeof generate>[1]["repair"]> = [];
    h.source.generate = async (request, execution) => {
      if (request.stage === "choices") repairs.push(execution.repair);
      if (request.stage === "choices" && failures < 2) {
        failures += 1;
        return createAiSourceFailure("scene", "invalid_schema", "invalid_schema",
          failures === 1 ? "labels[1]: 106 Unicode code points; maximum 80" : "stage: expected choices; received narration");
      }
      return generate(request, execution);
    };
    await h.startDecision();
    expect((await h.run()).ok).toBe(true);
    expect(repairs[1]?.detail).toContain("labels[1]");
    expect(repairs[2]?.detail).toBe("stage: expected choices; received narration");
  });

  it("planning 静态校验失败时先重做 planning，不先调用 narration", async () => {
    const h = createStagedHarness();
    const generate = h.source.generate.bind(h.source);
    let firstPlanning = true;
    h.source.generate = async (request, execution) => {
      const response = await generate(request, execution);
      if (request.stage !== "planning" || !firstPlanning || !response.ok || response.stage !== "planning") return response;
      firstPlanning = false;
      const character = response.value.units.find((unit) => unit.stage === "character");
      if (character === undefined) throw new Error("character fixture missing");
      return { ...response, value: {
        ...response.value,
        observations: [{
          key: "obs_witness",
          point: { stepKey: "current", order: 1 },
          audienceIds: ["player_0", "npc_0"],
          fact: { factId: "fact_routes", certainty: "known" as const },
          source: { kind: "witness" as const },
        }],
        units: response.value.units.map((unit) => unit.key === character.key
          ? { ...unit, requiredObservationKeys: ["obs_witness"] }
          : unit),
      } };
    };

    await h.startDecision();
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.map((call) => call.stage).slice(0, 3)).toEqual(["planning", "planning", "narration"]);
    expect(h.calls.filter((call) => call.stage === "planning")).toHaveLength(2);
    expect(h.calls[1]?.repair).toMatchObject({
      reason: "invalid_schema",
      rejectionCode: "beat_authority_conflict",
      detail: expect.stringContaining("obs_witness"),
    });
  });

  it("source 抛错也持久化为失败，不能留下永久 pending", async () => {
    const h = createStagedHarness();
    h.source.generate = async () => { throw new Error("private provider detail"); };
    await h.startDecision();
    const result = await h.run();
    expect(result.ok).toBe(false);
    const stored = await h.jobs.get(h.jobId());
    if (!stored.ok) throw new Error("job missing");
    expect(stored.value.status).toBe("failed");
    expect(stored.value.failureCode).not.toContain("private");
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

  it("满预算时 planning 240s / expression 45s", async () => {
    const h = createStagedHarness();
    await h.startDecision();
    const result = await h.run();
    expect(result.ok).toBe(true);
    const planning = h.source.calls.find((c) => c.stage === "planning");
    expect(planning?.timeoutMs).toBe(240_000);
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
    expect(narrationCalls[1]?.repair?.detail).toMatch(/^parts\[\d+\]\.facts:/);
    expect(narrationCalls[1]?.repair?.reason).toBe("invalid_schema");
    expect(narrationCalls[1]?.repair?.attempt).toBe(1);
    if (result.ok) {
      expect(result.value.units.every((unit) => unit.status === "approved")).toBe(true);
    }
  });

  it("certainty升级被拒后真实重试收到正确字段路径和上限，不产生负索引", async () => {
    const project = perspectiveContext.projectUnitContext;
    const spy = vi.spyOn(perspectiveContext, "projectUnitContext").mockImplementation(input => {
      const result = project(input);
      if (!result.ok || input.unit.stage !== "narration") return result;
      return { ok: true, value: { ...result.value, visibleFacts: [...result.value.visibleFacts,
        { id: "fact_suspected", text: "受控传闻。", certainty: "suspected", sources: [] }],
      } };
    });
    try {
      const h = createStagedHarness();
      const generate = h.source.generate.bind(h.source);
      let attempts = 0;
      h.source.generate = async (request, execution) => {
        const response = await generate(request, execution);
        if (!response.ok || response.stage !== "narration" || response.value.stage !== "narration" || ++attempts !== 1) return response;
        return { ...response, value: { ...response.value, parts: response.value.parts.map(part => ({
          ...part, facts: [{ factId: "fact_suspected", certainty: "known" as const }],
        })) } };
      };
      await h.startDecision();
      expect((await h.run()).ok).toBe(true);
      const calls = h.source.calls.filter(call => call.stage === "narration");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.repair).toMatchObject({ rejectionCode: "unit_output_fact_unavailable", attempt: 1,
        detail: "parts[0].facts[0].certainty: expected suspected; received known" });
      expect(calls[1]?.repair?.detail).not.toContain("受控传闻");
    } finally { spy.mockRestore(); }
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
    expect(choicesCalls[1]?.repair?.detail).toBe("labels[0].candidateId: not approved");
    expect(choicesCalls[1]?.repair?.attempt).toBe(1);
  });

  it("剩余时间不足默认超时时按 deadline 收缩 timeout，请求不越过周期", async () => {
    // 固定决策 3「按剩余时间缩短 timeout」：clock 前进 550s 后剩余 50s，
    // planning 外层 240s 收缩到 50s；expression 默认 45s 低于剩余时间保持不变。
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
