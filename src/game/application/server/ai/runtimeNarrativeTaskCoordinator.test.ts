import { describe, expect, it } from "vitest";
import type { NewGameInput } from "@/game/domain";
import { asGameId, type GameRecord, type GameRepository } from "../persistence/gameRepository";
import { runScenarioPipeline } from "../../applicationFixture.testutil";
import { RuntimeNarrativeTaskCoordinator } from "./runtimeNarrativeTaskCoordinator";
import wuxiaFixture from "../../../../../data/fixtures/phase1/wuxia.json";

type Phase1Fixture = { input: NewGameInput; seed: string };
const fixture = wuxiaFixture as unknown as Phase1Fixture;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function pendingRecord(): GameRecord {
  const { blueprint, state } = runScenarioPipeline(fixture.input, fixture.seed);
  return {
    gameId: asGameId("coordinator-test"),
    blueprint,
    state: {
      ...state,
      narrative: {
        currentScene: null,
        generation: { status: "pending", requestedAt: "2026-07-30T08:00:00.000Z" },
        mode: "ai",
      },
    },
    revision: 0,
    createdAt: "2026-07-30T08:00:00.000Z",
  };
}

describe("RuntimeNarrativeTaskCoordinator", () => {
  it("同一 pending 存档只启动一个后台任务；完成后可安全再次 ensure", async () => {
    let record = pendingRecord();
    const directorStarted = deferred();
    const releaseDirector = deferred();
    const writeCompleted = deferred();
    const repository: GameRepository = {
      async createInitialGame() { return { ok: true }; },
      async getCurrentGame() { return { ok: true as const, status: "active" as const, record }; },
      async applyResolvedAction(input) {
        record = {
          ...record,
          state: input.nextState,
          revision: record.revision + 1,
        };
        writeCompleted.resolve();
        return { ok: true as const, record };
      },
    };
    const coordinator = new RuntimeNarrativeTaskCoordinator({
      repository,
      newTraceId: () => "coordinator-trace",
      runtimeNarrativeSources: {
        directorSource: {
          async generate() {
            directorStarted.resolve();
            await releaseDirector.promise;
            return {
              ok: false as const,
              provenance: "unavailable" as const,
              category: "service_error" as const,
              diagnostics: {
                traceId: "test", contractVersion: "runtime-narrative-v1" as const,
                stage: "failed" as const, category: "service_error" as const,
              },
            };
          },
        },
        sceneScriptSource: { async generate() { throw new Error("not reached"); } },
        npcLineSource: { async generate() { throw new Error("not reached"); } },
      },
    }, () => {});

    expect(await coordinator.ensure()).toBe("queued");
    await directorStarted.promise;
    expect(await coordinator.ensure()).toBe("already_running");
    releaseDirector.resolve();
    await writeCompleted.promise;
    expect(record.state.narrative.generation).toEqual({ status: "idle" });
    expect(await coordinator.ensure()).toBe("not_pending");
  });
});
