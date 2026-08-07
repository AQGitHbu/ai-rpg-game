import { describe, it, expect } from "vitest";
import { createGameV2, createFixtureWorldSource } from "./createGameV2";
import type { GameRepositoryV2, GameRecordV2 } from "./server/persistence/gameRepositoryV2";
import { asGameId } from "./server/persistence/gameRepository";

function createInMemoryRepo(): { repo: GameRepositoryV2; getRecord: () => GameRecordV2 | null } {
  let record: GameRecordV2 | null = null;
  return {
    repo: {
      async createInitialGame(input) {
        if (record !== null) return { ok: false, code: "ACTIVE_GAME_EXISTS" as const };
        record = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
        return { ok: true as const };
      },
      async getCurrentGame() {
        if (record === null) return { ok: true as const, status: "none" as const };
        return { ok: true as const, status: "active" as const, record };
      },
      async applyState(input) {
        if (record === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== record.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
        return { ok: true as const, record };
      },
      async applySceneWriteBack(input) {
        if (record === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== record.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        record = { ...record, storyState: { ...record.storyState, narrative: input.nextNarrative, candidateEventPool: input.nextCandidateEventPool }, revision: record.revision + 1 };
        return { ok: true as const, record };
      },
      async clearCurrentGame() { return { ok: true as const }; },
    },
    getRecord: () => record,
  };
}

describe("createGameV2", () => {
  it("creates a game with fixture source", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const result = await createGameV2(
      { gameId: asGameId("g1"), gameType: "wuxia", gameLength: "short", seed: "test-seed" },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revision).toBe(0);
      const record = getRecord();
      expect(record).not.toBeNull();
      expect(record!.worldState.locations.length).toBe(2);
      expect(record!.worldState.npcs.length).toBe(1);
      expect(record!.storyState.currentAct).toBe(1);
    }
  });

  it("rejects when active game exists", async () => {
    const { repo } = createInMemoryRepo();
    await createGameV2(
      { gameId: asGameId("g1"), gameType: "wuxia", gameLength: "short", seed: "s1" },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-01" },
    );
    const result = await createGameV2(
      { gameId: asGameId("g2"), gameType: "wuxia", gameLength: "short", seed: "s2" },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ACTIVE_GAME_EXISTS");
  });
});

