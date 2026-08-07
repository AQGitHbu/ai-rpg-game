import { describe, it, expect } from "vitest";
import type { GameRepositoryV2, GameRecordV2, CreateInitialGameV2Input, ApplyStateV2Input, ApplySceneWriteBackInput } from "./gameRepositoryV2";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { asGameId } from "./gameRepository";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asGenerationId } from "@/game/domain/scenarioBlueprint";

function createInMemoryGameRepositoryV2(): GameRepositoryV2 {
  let record: GameRecordV2 | null = null;
  return {
    async createInitialGame(input: CreateInitialGameV2Input) {
      if (record !== null) return { ok: false, code: "ACTIVE_GAME_EXISTS" as const };
      record = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
      return { ok: true as const };
    },
    async getCurrentGame() {
      if (record === null) return { ok: true as const, status: "none" as const };
      return { ok: true as const, status: "active" as const, record };
    },
    async applyState(input: ApplyStateV2Input) {
      if (record === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
      if (input.expectedRevision !== record.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
      record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
      return { ok: true as const, record };
    },
    async applySceneWriteBack(input: ApplySceneWriteBackInput) {
      if (record === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
      if (input.expectedRevision !== record.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
      record = {
        ...record,
        storyState: { ...record.storyState, narrative: input.nextNarrative, candidateEventPool: input.nextCandidateEventPool },
        revision: record.revision + 1,
      };
      return { ok: true as const, record };
    },
  };
}

function buildTestRecord(): { worldState: WorldState; storyState: StoryState } {
  const loc: LocationEntry = {
    id: asLocationId("loc_1"), name: "t", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const worldState = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc,
    startingItemIds: [],
  });
  const storyState = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  return { worldState, storyState };
}

describe("GameRepositoryV2 in-memory", () => {
  it("createInitialGame + getCurrentGame roundtrip", async () => {
    const repo = createInMemoryGameRepositoryV2();
    const { worldState, storyState } = buildTestRecord();
    const gameId = asGameId("game_1");
    expect(await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" })).toEqual({ ok: true });
    const current = await repo.getCurrentGame();
    expect(current.ok).toBe(true);
    if (current.ok && current.status === "active") {
      expect(current.record.gameId).toBe(gameId);
      expect(current.record.revision).toBe(0);
    }
  });

  it("applyState CAS success and stale rejection", async () => {
    const repo = createInMemoryGameRepositoryV2();
    const { worldState, storyState } = buildTestRecord();
    const gameId = asGameId("game_1");
    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });
    const r1 = await repo.applyState({ gameId, expectedRevision: 0, nextWorldState: worldState, nextStoryState: storyState });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.record.revision).toBe(1);
    const r2 = await repo.applyState({ gameId, expectedRevision: 0, nextWorldState: worldState, nextStoryState: storyState });
    expect(r2).toEqual({ ok: false, code: "STALE_GAME_REVISION" });
  });

  it("applySceneWriteBack only updates narrative + candidateEventPool", async () => {
    const repo = createInMemoryGameRepositoryV2();
    const { worldState, storyState } = buildTestRecord();
    const gameId = asGameId("game_1");
    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });
    const newNarrative = { ...storyState.narrative, mode: "ai" as const };
    const r = await repo.applySceneWriteBack({ gameId, expectedRevision: 0, nextNarrative: newNarrative, nextCandidateEventPool: storyState.candidateEventPool });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.storyState.narrative.mode).toBe("ai");
      expect(r.record.storyState.tension).toBe(storyState.tension);
      expect(r.record.worldState).toBe(worldState);
    }
  });
});
