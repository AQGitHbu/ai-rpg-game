import { describe, expect, it } from "vitest";
import { asLocationId, type NewGameInput } from "@/game/domain";
import { createTownPlanFromLocation, townSeedFor } from "@/game/gameplay/rpg/town";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import {
  generatePendingTownPlan,
  TOWN_PLAN_MAX_ATTEMPTS,
  type GeneratePendingTownPlanDependencies
} from "./generatePendingTownPlan";
import { TOWN_PLAN_CONTRACT_VERSION, type TownPlanCandidateSource } from "./townPlanGeneration";
import {
  createFakeGameRepository,
  runScenarioPipeline,
  TEST_CREATED_AT,
  TEST_GAME_ID
} from "./applicationFixture.testutil";
import type { GameRecord } from "./server/persistence/gameRepository";

// ---------------------------------------------------------------------------
// Town 层：generatePendingTownPlan 契约测试——镜像 generatePendingNarrativeScene：
// pending → 有界尝试（校验 + 编译验证）→ CAS 写回；耗尽降级 baseline；
// 失效标记只清除不生成；stale/unavailable 映射稳定。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;
const PIPELINE = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);

const FIXED_TIME = "2026-07-30T09:00:00.000Z";
const TOWN_LOCATION_ID = "loc_2";
const TOWN_SEED = townSeedFor(PIPELINE.blueprint.seed, TOWN_LOCATION_ID);
const BASELINE = createTownPlanFromLocation(PIPELINE.blueprint, TOWN_LOCATION_ID, TOWN_SEED);

function pendingRecord(locationId: string = TOWN_LOCATION_ID): GameRecord {
  return {
    gameId: TEST_GAME_ID,
    blueprint: PIPELINE.blueprint,
    state: {
      ...PIPELINE.state,
      townGeneration: { status: "pending", locationId: asLocationId(locationId), requestedAt: FIXED_TIME }
    },
    revision: 3,
    createdAt: TEST_CREATED_AT
  };
}

/** 计数型假 source：按序返回配置的 attempt。 */
function sourceOf(
  attempts: readonly (ReturnType<TownPlanCandidateSource["generate"]> extends Promise<infer A> ? A : never)[]
): TownPlanCandidateSource & { calls: number } {
  const holder = {
    calls: 0,
    async generate() {
      const attempt = attempts[Math.min(holder.calls, attempts.length - 1)];
      holder.calls += 1;
      return attempt;
    }
  };
  return holder;
}

function okAttempt(candidate: unknown) {
  return {
    ok: true as const,
    contractVersion: TOWN_PLAN_CONTRACT_VERSION,
    origin: "fixture" as const,
    candidate,
    diagnostics: []
  };
}

const FAILED_ATTEMPT = {
  ok: false as const,
  contractVersion: TOWN_PLAN_CONTRACT_VERSION,
  origin: "unavailable" as const,
  category: "service_error" as const,
  diagnostics: ["TEST_SOURCE_DOWN"]
};

function buildDeps(
  repository: ReturnType<typeof createFakeGameRepository>,
  townPlanSource: TownPlanCandidateSource
): GeneratePendingTownPlanDependencies {
  return {
    repository,
    newTraceId: () => "town-trace-0001",
    now: () => FIXED_TIME,
    townPlanSource
  };
}

describe("generatePendingTownPlan：成功与降级", () => {
  it("首次尝试即通过校验 ⇒ saved，planSource=generated，事件与 idle 同一次 CAS 写回", async () => {
    const repository = createFakeGameRepository();
    const record = pendingRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 4 } });
    // 候选 = baseline 换主题：结构必然合法，覆盖检查必过。
    const source = sourceOf([okAttempt({ ...BASELINE, theme: "AI 规划的镇子" })]);

    const result = await generatePendingTownPlan(buildDeps(repository, source));

    expect(result).toBe("saved");
    expect(source.calls).toBe(1);
    expect(repository.applyCalls).toHaveLength(1);
    const { nextState, expectedRevision } = repository.applyCalls[0];
    expect(expectedRevision).toBe(3);
    expect(nextState.townGeneration).toEqual({ status: "idle" });
    expect(nextState.towns).toHaveLength(1);
    expect(nextState.towns[0]).toMatchObject({
      locationId: asLocationId(TOWN_LOCATION_ID),
      seed: TOWN_SEED,
      planSource: "generated"
    });
    expect(nextState.towns[0].plan.theme).toBe("AI 规划的镇子");
    expect(nextState.eventLedger.at(-1)).toEqual({
      type: "town_plan_generated",
      locationId: asLocationId(TOWN_LOCATION_ID),
      planSource: "generated",
      occurredAt: FIXED_TIME
    });
  });

  it("source 3 次全失败 ⇒ 降级 baseline，planSource=fallback，恰好 3 次尝试", async () => {
    const repository = createFakeGameRepository();
    const record = pendingRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 4 } });
    const source = sourceOf([FAILED_ATTEMPT]);

    const result = await generatePendingTownPlan(buildDeps(repository, source));

    expect(result).toBe("saved");
    expect(source.calls).toBe(TOWN_PLAN_MAX_ATTEMPTS);
    const { nextState } = repository.applyCalls[0];
    expect(nextState.towns[0]).toMatchObject({ planSource: "fallback" });
    expect(nextState.towns[0].plan).toEqual(BASELINE);
    expect(nextState.eventLedger.at(-1)).toMatchObject({ planSource: "fallback" });
  });

  it("候选未过校验（剧情建筑覆盖缺失）同样计一次尝试，耗尽后降级", async () => {
    const repository = createFakeGameRepository();
    const record = pendingRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 4 } });
    // requiredBuildings 为空数组：schema 合法但覆盖检查必然失败。
    const source = sourceOf([okAttempt({ ...BASELINE, requiredBuildings: [] })]);

    const result = await generatePendingTownPlan(buildDeps(repository, source));

    expect(result).toBe("saved");
    expect(source.calls).toBe(TOWN_PLAN_MAX_ATTEMPTS);
    expect(repository.applyCalls[0].nextState.towns[0]).toMatchObject({ planSource: "fallback" });
  });
});

describe("generatePendingTownPlan：非 pending 与失效标记", () => {
  it("townGeneration 非 pending ⇒ not_pending，零写入零 source 调用", async () => {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: { gameId: TEST_GAME_ID, blueprint: PIPELINE.blueprint, state: PIPELINE.state, revision: 0, createdAt: TEST_CREATED_AT }
    });
    const source = sourceOf([FAILED_ATTEMPT]);

    expect(await generatePendingTownPlan(buildDeps(repository, source))).toBe("not_pending");
    expect(repository.applyCalls).toHaveLength(0);
    expect(source.calls).toBe(0);
  });

  it("pending 指向非 town 地点 ⇒ 只清除标记（cleared），不生成不请求", async () => {
    const repository = createFakeGameRepository();
    const record = pendingRecord("loc_1");
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 4 } });
    const source = sourceOf([FAILED_ATTEMPT]);

    expect(await generatePendingTownPlan(buildDeps(repository, source))).toBe("cleared");
    expect(source.calls).toBe(0);
    const { nextState } = repository.applyCalls[0];
    expect(nextState.townGeneration).toEqual({ status: "idle" });
    expect(nextState.towns).toEqual(record.state.towns);
    expect(nextState.eventLedger).toEqual(record.state.eventLedger);
  });

  it("towns 已有该地点条目 ⇒ 只清除标记（cleared），不重复生成", async () => {
    const repository = createFakeGameRepository();
    const base = pendingRecord();
    const record: GameRecord = {
      ...base,
      state: {
        ...base.state,
        towns: [
          {
            locationId: asLocationId(TOWN_LOCATION_ID),
            seed: TOWN_SEED,
            plan: BASELINE,
            planSource: "offline",
            generatorVersion: "test"
          }
        ]
      }
    };
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: true, record: { ...record, revision: 4 } });
    const source = sourceOf([FAILED_ATTEMPT]);

    expect(await generatePendingTownPlan(buildDeps(repository, source))).toBe("cleared");
    expect(source.calls).toBe(0);
    expect(repository.applyCalls[0].nextState.towns).toHaveLength(1);
  });
});

describe("generatePendingTownPlan：CAS 冲突与不可用", () => {
  it("写回撞上陈旧 revision ⇒ stale", async () => {
    const repository = createFakeGameRepository();
    const record = pendingRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });
    repository.setApplyResult({ ok: false, code: "STALE_GAME_REVISION" });
    const source = sourceOf([okAttempt({ ...BASELINE })]);

    expect(await generatePendingTownPlan(buildDeps(repository, source))).toBe("stale");
  });

  it("无活跃存档 ⇒ unavailable", async () => {
    const repository = createFakeGameRepository();
    repository.setCurrentResult({ ok: true, status: "none" });
    const source = sourceOf([FAILED_ATTEMPT]);

    expect(await generatePendingTownPlan(buildDeps(repository, source))).toBe("unavailable");
    expect(repository.applyCalls).toHaveLength(0);
  });
});
