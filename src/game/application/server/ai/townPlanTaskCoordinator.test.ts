import { describe, expect, it } from "vitest";
import { asLocationId, type NewGameInput } from "@/game/domain";
import { asGameId, type GameRecord, type GameRepository } from "../persistence/gameRepository";
import { runScenarioPipeline } from "../../applicationFixture.testutil";
import type { TownPlanCandidateSource } from "../../townPlanGeneration";
import { TownPlanTaskCoordinator } from "./townPlanTaskCoordinator";
import wuxiaFixture from "../../../../../data/fixtures/phase1/wuxia.json";

// ---------------------------------------------------------------------------
// TownPlanTaskCoordinator：进程内去重（镜像 RuntimeNarrativeTaskCoordinator）。
// pending 持久化在 state，重启后可经同一 ensure 恢复。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const fixture = wuxiaFixture as unknown as Phase1Fixture;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function pendingRecord(): GameRecord {
  const { blueprint, state } = runScenarioPipeline(fixture.input, fixture.seed);
  return {
    gameId: asGameId("town-coordinator-test"),
    blueprint,
    state: {
      ...state,
      townGeneration: { status: "pending", locationId: asLocationId("loc_2"), requestedAt: "2026-07-30T08:00:00.000Z" }
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
      }
    };
    const townPlanSource: TownPlanCandidateSource = {
      async generate() {
        sourceStarted.resolve();
        await releaseSource.promise;
        return {
          ok: false as const,
          contractVersion: "town-plan-v1" as const,
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
    }, () => {});

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
    const { blueprint, state } = runScenarioPipeline(fixture.input, fixture.seed);
    const repository: GameRepository = {
      async createInitialGame() { return { ok: true }; },
      async getCurrentGame() {
        return {
          ok: true as const,
          status: "active" as const,
          record: { gameId: asGameId("t"), blueprint, state, revision: 0, createdAt: "t" }
        };
      },
      async applyResolvedAction() { throw new Error("not reached"); }
    };
    const coordinator = new TownPlanTaskCoordinator({
      repository,
      newTraceId: () => "t",
      now: () => "t",
      townPlanSource: { async generate() { throw new Error("not reached"); } }
    }, () => {});

    expect(await coordinator.ensure()).toBe("not_pending");
  });
});
