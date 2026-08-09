import { describe, it, expect } from "vitest";
import { createGame, createFixtureWorldSource } from "./createGame";
import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import { asGameId } from "./server/persistence/gameRepository";

function createInMemoryRepo(): { repo: GameRepository; getRecord: () => GameRecord | null } {
  let record: GameRecord | null = null;
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

describe("createGame", () => {
  it("persists byte-equivalent compiled state for one seed and structural differences for another", async () => {
    const createAndRead = async (seed: string): Promise<GameRecord> => {
      const { repo, getRecord } = createInMemoryRepo();
      const result = await createGame(
        { gameId: asGameId("seed-proof"), gameType: "wuxia", gameLength: "short", seed },
        { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-01" },
      );
      expect(result.ok).toBe(true);
      const record = getRecord();
      expect(record).not.toBeNull();
      return record!;
    };

    const first = await createAndRead("branching-seed-alpha");
    const replay = await createAndRead("branching-seed-alpha");
    const other = await createAndRead("branching-seed-beta");

    expect(JSON.stringify({ worldState: replay.worldState, storyState: replay.storyState }))
      .toBe(JSON.stringify({ worldState: first.worldState, storyState: first.storyState }));
    const signatures = (record: GameRecord) => ({
      npcIdentity: record.worldState.npcs.map((npc) => [npc.id, npc.name, npc.role]),
      questGraph: record.worldState.quests.map((quest) => [quest.id, quest.name, quest.objectives, quest.onSuccess]),
      facts: record.worldState.worldFacts.map((fact) => [fact.factId, fact.text]),
      locations: record.worldState.locations.map((location) => [location.id, location.name, location.connectedLocationIds]),
      endingPredicates: record.worldState.endings.map((ending) => ending.requirements),
    });
    const a = signatures(first);
    const b = signatures(other);
    const changedDimensions = (Object.keys(a) as (keyof typeof a)[])
      .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
    expect(changedDimensions.length).toBeGreaterThanOrEqual(2);
  });

  it("creates a game with fixture source", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const result = await createGame(
      { gameId: asGameId("g1"), gameType: "wuxia", gameLength: "short", seed: "test-seed" },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revision).toBe(0);
      const record = getRecord();
      expect(record).not.toBeNull();
      expect(record!.worldState.locations.length).toBe(3);
      expect(record!.worldState.npcs.length).toBe(1);
      expect(record!.storyState.currentAct).toBe(1);
    }
  });

  it("rejects when active game exists", async () => {
    const { repo } = createInMemoryRepo();
    await createGame(
      { gameId: asGameId("g1"), gameType: "wuxia", gameLength: "short", seed: "s1" },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-01" },
    );
    const result = await createGame(
      { gameId: asGameId("g2"), gameType: "wuxia", gameLength: "short", seed: "s2" },
      { repository: repo, source: createFixtureWorldSource(), now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ACTIVE_GAME_EXISTS");
  });
});
