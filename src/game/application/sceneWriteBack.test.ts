import { describe, it, expect } from "vitest";
import { writeBackScene } from "./sceneWriteBack";
import type { GameRepositoryV2, GameRecordV2 } from "./server/persistence/gameRepositoryV2";
import { asGameId } from "./server/persistence/gameRepository";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";

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

function buildTestState(): { worldState: WorldState; storyState: StoryState } {
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

describe("writeBackScene", () => {
  it("updates only narrative + candidateEventPool, never worldState", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");
    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    const originalWorldState = getRecord()!.worldState;
    const newNarrative = { ...storyState.narrative, mode: "ai" as const };

    const result = await writeBackScene(repo, {
      gameId,
      expectedRevision: 0,
      nextNarrative: newNarrative,
      nextCandidateEventPool: storyState.candidateEventPool,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.storyState.narrative.mode).toBe("ai");
      expect(result.record.worldState).toBe(originalWorldState);
      expect(result.record.storyState.tension).toBe(storyState.tension);
    }
  });

  it("rejects stale revision", async () => {
    const { repo } = createInMemoryRepo();
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");
    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });
    const result = await writeBackScene(repo, {
      gameId,
      expectedRevision: 99,
      nextNarrative: storyState.narrative,
      nextCandidateEventPool: storyState.candidateEventPool,
    });
    expect(result).toEqual({ ok: false, code: "STALE_GAME_REVISION" });
  });
});

