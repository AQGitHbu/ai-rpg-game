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
      narrative: { currentScene: null, generation: { status: "idle" } },
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
