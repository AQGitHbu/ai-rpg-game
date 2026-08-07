import { describe, expect, it } from "vitest";
import { asNpcId, type NewGameInput } from "@/game/domain";
import { asGameId, type GameRecord, type GameRepository } from "../persistence/gameRepository";
import { runScenarioPipeline } from "../../applicationFixture.testutil";
import { NARRATIVE_CONTRACT_VERSION } from "../../runtimeNarrative";
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
      async applyBlueprintExpansion(input) {
        record = { ...record, blueprint: input.nextBlueprint, state: input.nextState, revision: record.revision + 1 };
        return { ok: true as const, record };
      },
    };
    const coordinator = new RuntimeNarrativeTaskCoordinator({
      repository,
      newTraceId: () => "coordinator-trace",
      now: () => "2026-07-31T01:02:03.000Z",
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
                traceId: "test", contractVersion: NARRATIVE_CONTRACT_VERSION,
                stage: "failed" as const, category: "service_error" as const,
              },
            };
          },
        },
        sceneScriptSource: { async generate() { throw new Error("not reached"); } },
        npcLineSource: { async generate() { throw new Error("not reached"); } },
      },
    });

    expect(await coordinator.ensure()).toBe("queued");
    await directorStarted.promise;
    expect(await coordinator.ensure()).toBe("already_running");
    releaseDirector.resolve();
    await writeCompleted.promise;
    expect(record.state.narrative.generation).toEqual({ status: "idle" });
    expect(await coordinator.ensure()).toBe("not_pending");
  });

  it("STALE_GAME_REVISION 会在同一后台任务内最多重试两次，避免一次冲突永久丢任务", async () => {
    const record = pendingRecord();
    let applyAttempts = 0;
    const completed = deferred();
    const unavailable = () => ({
      async generate() {
        return {
          ok: false as const,
          provenance: "unavailable" as const,
          category: "service_error" as const,
          diagnostics: {
            traceId: "test", contractVersion: NARRATIVE_CONTRACT_VERSION,
            stage: "failed" as const, category: "service_error" as const,
          },
        };
      },
    });
    const repository: GameRepository = {
      async createInitialGame() { return { ok: true }; },
      async getCurrentGame() { return { ok: true as const, status: "active" as const, record }; },
      async applyResolvedAction() {
        applyAttempts += 1;
        if (applyAttempts === 3) completed.resolve();
        return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      },
      async applyBlueprintExpansion() {
        return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      },
    };
    const coordinator = new RuntimeNarrativeTaskCoordinator({
      repository,
      newTraceId: () => "stale-coordinator",
      now: () => "2026-07-31T01:02:03.000Z",
      runtimeNarrativeSources: {
        directorSource: unavailable(),
        sceneScriptSource: unavailable(),
        npcLineSource: unavailable(),
      },
    });

    expect(await coordinator.ensure()).toBe("queued");
    await completed.promise;
    expect(applyAttempts).toBe(3);
    expect(record.state.narrative.generation.status).toBe("pending");
  });

  it("对话回应 followup 桥接：pending 携带 dialogue_response 触发且 currentScene 为 followup 时启动后台任务", async () => {
    let record = pendingRecord();
    const directorStarted = deferred();
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
      },
    };
    const coordinator = new RuntimeNarrativeTaskCoordinator({
      repository,
      newTraceId: () => "bridge-coordinator",
      now: () => "2026-07-31T01:02:03.000Z",
      runtimeNarrativeSources: {
        directorSource: {
          async generate() {
            directorStarted.resolve();
            return {
              ok: false as const,
              provenance: "unavailable" as const,
              category: "service_error" as const,
              diagnostics: {
                traceId: "test", contractVersion: NARRATIVE_CONTRACT_VERSION,
                stage: "failed" as const, category: "service_error" as const,
              },
            };
          },
        },
        sceneScriptSource: { async generate() { throw new Error("not reached"); } },
        npcLineSource: { async generate() { throw new Error("not reached"); } },
      },
    });
    record = {
      ...record,
      state: {
        ...record.state,
        narrative: {
          currentScene: {
            sceneId: "followup-scene",
            turn: 1,
            narration: "对方似乎还有话没有说完。",
            usedFactIds: [],
            npcLine: { npcId: asNpcId("npc_1"), text: "事情并不像表面那么简单。", emotion: "guarded", usedFactIds: [] },
            choices: [
              { choiceToken: "f1", label: "继续追问", choiceKind: "dialogue_response", dialogueIntent: "ask_more", actionKey: "dialogue:f1" },
              { choiceToken: "f2", label: "暂且告辞", choiceKind: "dialogue_response", dialogueIntent: "leave", actionKey: "dialogue:f2" },
            ],
            source: "generated",
          },
          generation: {
            status: "pending",
            requestedAt: "2026-07-30T08:00:00.000Z",
            triggerContext: { kind: "dialogue_response", npcId: asNpcId("npc_1"), dialogueIntent: "ask_more", playerText: "哦？" },
          },
          mode: "ai",
        },
      },
    };
    expect(await coordinator.ensure()).toBe("queued");
    await directorStarted.promise;
    await writeCompleted.promise;
    expect(record.state.narrative.generation.status).toBe("idle");
    expect(record.state.narrative.currentScene?.source).toBe("fallback");
  });
});
