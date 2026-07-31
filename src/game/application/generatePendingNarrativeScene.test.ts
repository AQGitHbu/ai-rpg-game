import { describe, expect, it } from "vitest";
import type { GameState, NewGameInput } from "@/game/domain";
import {
  asGameId,
  type ApplyResolvedActionInput,
  type GameRecord,
  type GameRepository,
} from "./server/persistence/gameRepository";
import { generatePendingNarrativeScene } from "./generatePendingNarrativeScene";
import { runScenarioPipeline } from "./applicationFixture.testutil";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";

type Phase1Fixture = { input: NewGameInput; seed: string };
const fixture = wuxiaFixture as unknown as Phase1Fixture;

function pendingRecord(): GameRecord {
  const { blueprint, state } = runScenarioPipeline(fixture.input, fixture.seed);
  return {
    gameId: asGameId("pending-narrative-test"),
    blueprint,
    state: {
      ...state,
      narrative: {
        currentScene: null,
        generation: { status: "pending", requestedAt: "2026-07-30T08:00:00.000Z" },
        mode: "ai",
      },
    },
    revision: 4,
    createdAt: "2026-07-30T08:00:00.000Z",
  };
}

function unavailableSources() {
  return {
    directorSource: {
      async generate() {
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
    sceneScriptSource: {
      async generate() {
        throw new Error("scene writer must not run after director fallback");
      },
    },
    npcLineSource: {
      async generate() {
        throw new Error("npc performer must not run after director fallback");
      },
    },
  };
}

function repositoryFor(record: GameRecord, apply?: (input: ApplyResolvedActionInput) => void): GameRepository {
  let current = record;
  return {
    async createInitialGame() { return { ok: true }; },
    async getCurrentGame() { return { ok: true as const, status: "active" as const, record: current }; },
    async applyResolvedAction(input) {
      apply?.(input);
      current = { ...current, state: input.nextState, revision: current.revision + 1 };
      return { ok: true as const, record: current };
    },
  };
}

describe("generatePendingNarrativeScene", () => {
  it("持久化 pending 场景，并在 AI 不可用时保存受控 fallback", async () => {
    const writes: ApplyResolvedActionInput[] = [];
    const result = await generatePendingNarrativeScene({
      repository: repositoryFor(pendingRecord(), (input) => writes.push(input)),
      newTraceId: () => "task-trace-1",
      runtimeNarrativeSources: unavailableSources(),
    });

    expect(result).toBe("saved");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.expectedRevision).toBe(4);
    expect(writes[0]?.nextState.narrative.generation).toEqual({ status: "idle" });
    expect(writes[0]?.nextState.narrative.currentScene?.source).toBe("fallback");
  });

  it("不是 pending 时零调用 AI、零写入，允许恢复端点安全重复调用", async () => {
    const record = pendingRecord();
    const readyState: GameState = {
      ...record.state,
      narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
    };
    let writes = 0;
    const repository = repositoryFor({ ...record, state: readyState }, () => { writes += 1; });
    const result = await generatePendingNarrativeScene({
      repository,
      newTraceId: () => "unused",
      runtimeNarrativeSources: unavailableSources(),
    });

    expect(result).toBe("not_pending");
    expect(writes).toBe(0);
  });
});

describe("generatePendingNarrativeScene：Phase 11 场景提交事件与记忆原子写入", () => {
  it("ready 场景应用后：narrative_scene_presented 事件、memory、currentScene 与 cleared pending 同一次写入", async () => {
    const repository = repositoryFor(pendingRecord());
    const result = await generatePendingNarrativeScene({
      repository,
      newTraceId: () => "phase11-scene",
      runtimeNarrativeSources: unavailableSources(),
    });

    expect(result).toBe("saved");
    const record = await repository.getCurrentGame();
    if (!record.ok || record.status !== "active") throw new Error("期望 active 存档");
    // 提交事件落在 ledger 末尾，且只携带结构索引。
    const last = record.record.state.eventLedger.at(-1);
    expect(last?.type).toBe("narrative_scene_presented");
    if (last?.type === "narrative_scene_presented") {
      expect(last.sceneId).toBe(record.record.state.narrative.currentScene?.sceneId);
      expect(last.locationId).toBe(record.record.state.currentLocationId);
      expect(Object.keys(last).sort()).toEqual([
        "focusNpcId", "locationId", "occurredAt", "pacing", "revealedFactIds", "sceneId", "type"
      ]);
    }
    // memory 与 ledger 同步；场景就绪（currentScene 设置即视图 ready），pending 已清。
    expect(record.record.state.storyMemory?.reducedThroughEventCount).toBe(record.record.state.eventLedger.length);
    expect(record.record.state.narrative.currentScene).not.toBeNull();
    expect(record.record.state.narrative.generation.status).toBe("idle");
  });

  it("apply 命中 STALE 时：场景事件被丢弃、memory 与旧 state 不变", async () => {
    const pending = pendingRecord();
    const repository: GameRepository = {
      async createInitialGame() { return { ok: true }; },
      async getCurrentGame() {
        return { ok: true as const, status: "active" as const, record: pending };
      },
      async applyResolvedAction() {
        return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      },
    };
    const result = await generatePendingNarrativeScene({
      repository,
      newTraceId: () => "phase11-stale",
      runtimeNarrativeSources: unavailableSources(),
    });

    expect(result).toBe("stale");
    const record = await repository.getCurrentGame();
    if (!record.ok || record.status !== "active") throw new Error("期望 active 存档");
    // 陈旧写入被整体丢弃：事件未追加、memory 未推进。
    expect(record.record.state.eventLedger.at(-1)?.type).not.toBe("narrative_scene_presented");
    expect(record.record.state.storyMemory?.reducedThroughEventCount).toBe(0);
    expect(record.record.state.narrative.generation.status).toBe("pending");
  });
});
