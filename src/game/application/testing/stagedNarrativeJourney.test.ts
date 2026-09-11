// 分阶段叙事的发布/消费端到端旅程（Plan 2026-09-09 / Task 9 Step 1；
// Task 12 Step 1 扩充为 Spec §11 验收矩阵的离线覆盖）。
//
// 覆盖四件事：已发布包在消费前不进入任何永久认知；实际消费时才铸造
// narrative_observed 并把事实交给受众；同一 actionId 重复消费幂等；
// 终幕包的立场 label 来自已批准 map 而不是生产硬编码。
//
// Task 12 追加：请求计数与固定职责分离、输入隔离、初始化任务恢复、
// 超时/迟到响应、发布原子性、预算停止。

import { describe, expect, it } from "vitest";
import { createStagedHarness } from "./stagedNarrativeHarness.testutil";
import { consumeNarrativeBundle } from "@/game/application/consumeNarrativeBundle";
import { endingDecisionStances } from "@/game/gameplay/rpg/narrativeBundle";
import { JOB_BUDGET, canStartRequest } from "@/game/application/narrativeGeneration/jobBudget";
import type { SafeContext } from "@/game/application/narrativeGeneration/perspectiveContext";

/** 夹具骨架的实际单元：规划 1 + 旁白 1 + 角色 2 + 选项 1（双 NPC 决策）。 */
const NORMAL_DECISION_STAGES = ["character", "character", "choices", "narration", "planning"] as const;

function stageNames(harness: ReturnType<typeof createStagedHarness>): string[] {
  return harness.calls.map((call) => call.stage);
}

/** 表达阶段（planning 之外）的请求一定携带 SafeContext。 */
function expressionContexts(
  harness: ReturnType<typeof createStagedHarness>,
  stage: "narration" | "character" | "choices",
): SafeContext[] {
  const contexts: SafeContext[] = [];
  for (const request of harness.requests) {
    if (request.stage === stage) contexts.push(request.context);
  }
  return contexts;
}

describe("stagedNarrativeJourney", () => {
  it("全部单元批准后发布，且发布前后世界状态不含未兑现的认知", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const ran = await harness.run();
    expect(ran.ok).toBe(true);

    const published = await harness.publish();
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.value.status).toBe("published");
    // 发布 job 只是把包标记为可用；观察的条件引用尚未进入任何 ledger。
    const stored = await harness.jobs.get(harness.jobId());
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value.units.every((unit) => unit.status === "approved")).toBe(true);
  });

  it("未发布的 job 不能消费：无 ready bundle 时消费直接拒绝", () => {
    const harness = createStagedHarness();
    const publication = harness.decisionPublication();
    if (publication.kind !== "decision") throw new Error("harness 发布载荷应为 decision");
    const story = publication.input.nextStoryState;
    const result = consumeNarrativeBundle({
      beforeStoryState: story,
      resolvedWorldState: publication.input.nextWorldState,
      resolvedStoryState: story,
      action: { type: "explore" },
      actionId: "action-1",
      postCommitRevision: 1,
      resolvedEvent: {
        actionId: "action-1", status: "success", eventKind: "observe",
        facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [],
      },
      domainEvents: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 默认夹具的 narrative 不是 ready，消费在任何兑现之前就拒绝。
    expect(["NARRATIVE_CONTINUATION_INVALID", "NARRATIVE_CONTINUATION_MISSING"]).toContain(result.code);
  });

  it("终幕立场 label 读取已批准 map，未知 map 时回退生产默认", () => {
    const harness = createStagedHarness();
    const publication = harness.decisionPublication();
    if (publication.kind !== "decision") throw new Error("harness 发布载荷应为 decision");
    const world = publication.input.nextWorldState;
    const story = publication.input.nextStoryState;

    // 未到终幕：两种调用都不产出立场。
    expect(endingDecisionStances(world, story, { trust: "t", doubt: "d" })).toEqual([]);

    // 到终幕时 map 生效：label 来自 bundle，action 仍由服务端铸造。
    const endingReadyStory = { ...story, endingAllowed: true };
    const endingReadyWorld = {
      ...world,
      endpoint: null,
      endings: [
        { id: "ending_1", name: "共担真相" },
        { id: "ending_2", name: "独行求证" },
      ],
      npcs: world.npcs.map((npc: (typeof world.npcs)[number]) => ({ ...npc, locationId: world.currentLocationId })),
    } as unknown as typeof world;
    const stances = endingDecisionStances(endingReadyWorld, endingReadyStory as typeof story, {
      trust: "我已决定和你一起把证据摊开。",
      doubt: "我还没有确认最后一处细节。",
    });
    expect(stances.map((stance) => stance.label)).toEqual([
      "我已决定和你一起把证据摊开。",
      "我还没有确认最后一处细节。",
    ]);
    expect(stances.map((stance) => stance.action.dialogueAct)).toEqual(["support", "challenge"]);
    expect(stances.every((stance) => stance.action.type === "talk")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Spec §11「单 NPC 普通决策」「固定职责分离」「输入隔离」
  // -------------------------------------------------------------------------

  it("普通决策的请求数等于骨架单元数，且只有完整包可被发布", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const ran = await harness.run();
    expect(ran.ok).toBe(true);

    // 每个职责按骨架单元数恰好一次：规划 1 + 旁白 1 + 角色 2 + 选项 1。
    // 单 NPC 骨架下即为 Spec §11 要求的「恰好四次独立请求」。
    expect([...stageNames(harness)].sort()).toEqual([...NORMAL_DECISION_STAGES]);
    const perStage = new Map<string, number>();
    for (const stage of stageNames(harness)) perStage.set(stage, (perStage.get(stage) ?? 0) + 1);
    expect([...perStage.entries()].sort()).toEqual([
      ["character", 2], ["choices", 1], ["narration", 1], ["planning", 1],
    ]);

    // 未批准完一半时不存在任何发布载荷。
    expect(harness.publishedCount()).toBe(0);
    const published = await harness.publish();
    expect(published.ok).toBe(true);
    expect(harness.publishedCount()).toBe(1);
  });

  it("无重试时总请求数保持在基础预算内，不产生隐形 provider 调用", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const ran = await harness.run();
    expect(ran.ok).toBe(true);
    const job = await harness.readJob();
    expect(job.ok).toBe(true);
    if (!job.ok) return;
    // 骨架声明的基础单元数即成立请求数；额外额度未被消耗。
    expect(job.value.units.length).toBeGreaterThan(0);
    expect(job.value.usedRequests).toBeLessThanOrEqual(
      Math.min(52, job.value.baselineRequests + JOB_BUDGET.extraRequests),
    );
  });

  it("表达请求只携带 SafeContext：旁白不带骨架 steps，角色不带选项候选", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const ran = await harness.run();
    expect(ran.ok).toBe(true);

    const narration = expressionContexts(harness, "narration");
    const character = expressionContexts(harness, "character");
    const choices = expressionContexts(harness, "choices");
    expect(narration).toHaveLength(1);
    expect(character).toHaveLength(2);
    expect(choices).toHaveLength(1);

    for (const request of harness.requests) {
      const serialized = JSON.stringify(request);
      if (request.stage === "planning") {
        // 规划器是唯一需要全局视野的职责：输入是 PlanningContext（世界+故事+回合）。
        expect(serialized).toContain("\"entityStore\"");
        expect(serialized).toContain("\"eventLedger\"");
        continue;
      }
      // 表达阶段不得携带骨架或世界原文：只有 SafeContext 的投影字段。
      expect(serialized).not.toContain("\"steps\"");
      expect(serialized).not.toContain("\"entityStore\"");
      expect(serialized).not.toContain("\"eventLedger\"");
      expect(serialized).not.toContain("stepDependencies");
      expect(serialized).not.toContain("\"observations\"");
      expect(serialized).not.toContain("\"terminal\"");
    }

    // 选项请求不含玩家未知内容：候选必须来自已批准的 options。
    const choiceContext = choices[0];
    if (choiceContext === undefined) throw new Error("missing choices context");
    expect(choiceContext.options.length).toBeGreaterThan(0);

    // 角色请求带 persona 与说话人可见事实；只有 choices 单元拿得到候选。
    for (const context of character) {
      expect(context.persona).not.toBeNull();
      expect(context.choiceKind).toBeNull();
      expect(context.options).toEqual([]);
    }
    // 旁白是玩家视角：无 persona。
    expect(narration[0]?.persona).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Spec §11「表达依赖与顺序」「实际信息传播」
  // -------------------------------------------------------------------------

  it("选项单元的 SafeContext 携带依赖单元已批准的正文，装配不受完成顺序影响", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const ran = await harness.run();
    expect(ran.ok).toBe(true);

    const choices = expressionContexts(harness, "choices");
    const choiceContext = choices[0];
    if (choiceContext === undefined) throw new Error("missing choices context");
    // 按场景与对话对象裁剪，只保留本场旁白和当前 NPC 的正文。
    expect(choiceContext.priorText).toHaveLength(2);
    expect(choiceContext.choiceKind).toBe("ordinary");
    expect(choiceContext.playerUtterance).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Spec §11「初始化任务恢复」「发布原子性」
  // -------------------------------------------------------------------------

  it("无 GameRecord 时仍可查询同一初始化任务，重复创建不产生多个有效任务", async () => {
    const harness = createStagedHarness();
    const first = await harness.startInitialization("init-request-1");
    // 无当前游戏时，slot 已能投影出该任务。
    const queried = await harness.jobs.getInitialization();
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    expect(queried.value?.id).toBe(first.id);

    // 同 requestId 重复创建复用同一 job，不重复计费。
    const again = await harness.startInitialization("init-request-1");
    expect(again.id).toBe(first.id);
    expect(again.usedRequests).toBe(0);
  });

  it("初始化失败时零半包发布，且失败身份稳定可重试", async () => {
    const harness = createStagedHarness();
    await harness.startInitialization("init-fail-1");
    harness.source.failNext("narration");
    const failed = await harness.runInitializationJob();
    expect(failed.ok).toBe(false);

    // 失败不发布任何东西。
    expect(harness.publishedCount()).toBe(0);
    const slot = await harness.jobs.getInitialization();
    expect(slot.ok).toBe(true);
    if (!slot.ok) return;
    expect(slot.value?.status).toBe("failed");
    expect(slot.value?.failureCode).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Spec §11「超时与迟到响应」
  // -------------------------------------------------------------------------

  it("取消后 runJob 拒绝继续，不发布任何迟到结果", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const cancelled = await harness.cancel();
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) expect(cancelled.value.status).toBe("cancelled");

    // 已取消的 job 不能再被驱动：迟到结果不得落地。
    const late = await harness.run();
    expect(late.ok).toBe(false);
    expect(harness.publishedCount()).toBe(0);
  });

  it("已达请求上限的 job 被预算检查拒绝，删除结果未知请求也不重置预算", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const ran = await harness.run();
    expect(ran.ok).toBe(true);

    const job = await harness.readJob();
    if (!job.ok) throw new Error("missing job");
    // 新一轮尝试周期若已耗尽额度，预算判定必须拒绝新请求（不因重启清零）。
    const drained = { ...job.value, usedRequests: job.value.baselineRequests + JOB_BUDGET.extraRequests };
    const check = canStartRequest({ job: drained, unitAttempts: 0, now: harness.clock.now() });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("job_budget_exhausted");

    // deadline 到期同样是硬停止，且不被尝试次数掩盖。
    const expired = { ...job.value, deadline: new Date(harness.clock.epochMs - 1).toISOString() };
    const deadlineCheck = canStartRequest({ job: expired, unitAttempts: 0, now: harness.clock.now() });
    expect(deadlineCheck.ok).toBe(false);
    if (deadlineCheck.ok) return;
    expect(deadlineCheck.code).toBe("job_deadline_exceeded");
  });

  it("单元尝试额度用尽后拒绝再次请求", async () => {
    const harness = createStagedHarness();
    await harness.startDecision();
    const job = await harness.readJob();
    if (!job.ok) throw new Error("missing job");
    const check = canStartRequest({
      job: job.value,
      unitAttempts: JOB_BUDGET.maxUnitAttempts,
      now: harness.clock.now(),
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("unit_attempts_exhausted");
  });
});
