import { describe, expect, it } from "vitest";
import { asLocationId, type GameState, type ScenarioBlueprint } from "@/game/domain";
import { createTownPlanFromLocation, townSeedFor } from "@/game/gameplay/rpg/town";
import {
  compileScenarioBlueprint,
  initializeGameState,
  validateScenarioBlueprintCandidate
} from "@/game/gameplay/rpg/scenario";
import {
  makeValidCandidate,
  TEST_POLICY,
  TEST_PROFILE
} from "@/game/gameplay/rpg/scenario/scenarioBlueprintFixture.testutil";
import { asGameId, type GameRecord, type GameRepository } from "../persistence/gameRepository";
import { TOWN_PLAN_CONTRACT_VERSION, type TownPlanCandidateSource } from "../../townPlanGeneration";
import { TownPlanTaskCoordinator } from "./townPlanTaskCoordinator";

// ---------------------------------------------------------------------------
// TownPlanTaskCoordinator：进程内去重（镜像 RuntimeNarrativeTaskCoordinator）。
// pending 持久化在 state，重启后可经同一 ensure 恢复。
//
// Phase 14：开场收窄后 fallback 蓝图不再含 town 地点；本文件改用
// makeValidCandidate 运行时扩展蓝图（runtime_expansion）并把 loc_b 标为
// town 层，作为协调器契约测试的基准。
// ---------------------------------------------------------------------------

function compileRuntimeBlueprint(): ScenarioBlueprint {
  const compiled = compileScenarioBlueprint(
    validateScenarioBlueprintCandidate(makeValidCandidate(), {
      profile: TEST_PROFILE,
      policy: TEST_POLICY,
      phase: "runtime_expansion"
    })
  );
  if (!compiled.ok) {
    throw new Error(`fixture 蓝图应当合法：${JSON.stringify(compiled.issues)}`);
  }
  return compiled.blueprint;
}

const RUNTIME_BLUEPRINT = compileRuntimeBlueprint();
// loc_b 已标 town（运行时蓝图中 loc_b 含 npc_b，离线规划可派生剧情建筑）。
const TOWN_BLUEPRINT: ScenarioBlueprint = {
  ...RUNTIME_BLUEPRINT,
  locations: RUNTIME_BLUEPRINT.locations.map((location) =>
    String(location.id) === "loc_b" ? { ...location, scale: "town" as const } : location
  )
};
const PIPELINE = { blueprint: TOWN_BLUEPRINT, state: initializeGameState(TOWN_BLUEPRINT) };

const TOWN_LOCATION_ID = "loc_b";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function pendingRecord(): GameRecord {
  return {
    gameId: asGameId("town-coordinator-test"),
    blueprint: PIPELINE.blueprint,
    state: {
      ...PIPELINE.state,
      townGeneration: { status: "pending", locationId: asLocationId(TOWN_LOCATION_ID), requestedAt: "2026-07-30T08:00:00.000Z" }
    },
    revision: 0,
    createdAt: "2026-07-30T08:00:00.000Z"
  };
}

describe("TownPlanTaskCoordinator", () => {
  it("同一 pending 存档只启动一个后台任务；完成后可安全再次 ensure", async () => {
    let record = pendingRecord();
    const sourceStarted = deferred();
    const releaseSource = deferred();
    const writeCompleted = deferred();
    const repository: GameRepository = {
      async createInitialGame() { return { ok: true }; },
      async getCurrentGame() { return { ok: true as const, status: "active" as const, record }; },
      async applyResolvedAction(input) {
        record = { ...record, state: input.nextState, revision: record.revision + 1 };
        writeCompleted.resolve();
        return { ok: true as const, record };
      },
      async applyBlueprintExpansion(input) {
        record = { ...record, blueprint: input.nextBlueprint, state: input.nextState, revision: record.revision + 1 };
        return { ok: true as const, record };
      }
    };
    const townPlanSource: TownPlanCandidateSource = {
      async generate() {
        sourceStarted.resolve();
        await releaseSource.promise;
        return {
          ok: false as const,
          contractVersion: TOWN_PLAN_CONTRACT_VERSION,
          origin: "unavailable" as const,
          category: "service_error" as const,
          diagnostics: []
        };
      }
    };
    const coordinator = new TownPlanTaskCoordinator({
      repository,
      newTraceId: () => "town-trace",
      now: () => "2026-07-30T08:00:01.000Z",
      townPlanSource
    });

    expect(await coordinator.ensure()).toBe("queued");
    await sourceStarted.promise;
    expect(await coordinator.ensure()).toBe("already_running");
    releaseSource.resolve();
    await writeCompleted.promise;
    // 3 次尝试全失败 ⇒ 降级 fallback 写入，pending 清为 idle。
    expect(record.state.townGeneration).toEqual({ status: "idle" });
    expect(record.state.towns).toHaveLength(1);
    expect(await coordinator.ensure()).toBe("not_pending");
  });

  it("townGeneration 非 pending ⇒ not_pending，不启动任务", async () => {
    const repository: GameRepository = {
      async createInitialGame() { return { ok: true }; },
      async getCurrentGame() {
        return {
          ok: true as const,
          status: "active" as const,
          record: { gameId: asGameId("t"), blueprint: PIPELINE.blueprint, state: PIPELINE.state, revision: 0, createdAt: "t" }
        };
      },
      async applyResolvedAction() { throw new Error("not reached"); },
      async applyBlueprintExpansion() { throw new Error("not reached"); }
    };
    const coordinator = new TownPlanTaskCoordinator({
      repository,
      newTraceId: () => "t",
      now: () => "t",
      townPlanSource: { async generate() { throw new Error("not reached"); } }
    });

    expect(await coordinator.ensure()).toBe("not_pending");
  });
});
