import { describe, it, expect } from "vitest";
import type { GameRepository, GameRecord, CreateInitialGameInput, ApplyStateInput, ApplySceneWriteBackInput } from "./gameRepository";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { asGameId } from "./gameRepository";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asGenerationId } from "@/game/domain/worldEntity";
import { createApprovedChoice } from "@/game/domain/approvedChoice";

function createInMemoryGameRepository(): GameRepository {
  let record: GameRecord | null = null;
  return {
    async createInitialGame(input: CreateInitialGameInput) {
      if (record !== null) return { ok: false, code: "ACTIVE_GAME_EXISTS" as const };
      record = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
      return { ok: true as const };
    },
    async replaceCurrentGame(input) {
      if (record === null) return { ok: false as const, code: "NO_ACTIVE_GAME" as const };
      if (record.gameId !== input.expectedCurrentGameId || record.revision !== input.expectedRevision) {
        return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      }
      record = {
        gameId: input.gameId,
        worldState: input.worldState,
        storyState: input.storyState,
        revision: 0,
        createdAt: input.createdAt,
      };
      return { ok: true as const };
    },
    async getCurrentGame() {
      if (record === null) return { ok: true as const, status: "none" as const };
      return { ok: true as const, status: "active" as const, record };
    },
    async applyState(input: ApplyStateInput) {
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
        worldState: input.nextWorldState,
        storyState: input.nextStoryState,
        revision: record.revision + 1,
      };
      return { ok: true as const, record };
    },
    async clearCurrentGame() { record = null; return { ok: true as const }; },
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

describe("GameRepository in-memory", () => {
  it("createInitialGame + getCurrentGame roundtrip", async () => {
    const repo = createInMemoryGameRepository();
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
    const repo = createInMemoryGameRepository();
    const { worldState, storyState } = buildTestRecord();
    const gameId = asGameId("game_1");
    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });
    const r1 = await repo.applyState({ gameId, expectedRevision: 0, nextWorldState: worldState, nextStoryState: storyState });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.record.revision).toBe(1);
    const r2 = await repo.applyState({ gameId, expectedRevision: 0, nextWorldState: worldState, nextStoryState: storyState });
    expect(r2).toEqual({ ok: false, code: "STALE_GAME_REVISION" });
  });

  it("applySceneWriteBack persists full world + story state through one CAS", async () => {
    const repo = createInMemoryGameRepository();
    const { worldState, storyState } = buildTestRecord();
    const gameId = asGameId("game_1");
    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });
    const approved = createApprovedChoice({
      sceneId: "scene-1", basedOnRevision: 1, label: "探索", action: { type: "explore" },
    });
    if (!approved.ok) throw new Error("fixture approval failed");
    const nextNarrative = { ...storyState.narrative, mode: "ai" as const, choiceRegistry: [approved.choice] };
    const nextWorldState = { ...worldState, currentLocationId: asLocationId("loc_1") };
    const nextStoryState = { ...storyState, narrative: nextNarrative, candidateEventPool: storyState.candidateEventPool };
    const r = await repo.applySceneWriteBack({ gameId, expectedRevision: 0, nextWorldState, nextStoryState });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.revision).toBe(1);
      expect(r.record.storyState.narrative.mode).toBe("ai");
      expect(r.record.storyState.narrative.choiceRegistry).toEqual([approved.choice]);
      expect(r.record.storyState.candidateEventPool).toEqual(storyState.candidateEventPool);
      expect(r.record.storyState.tension).toBe(storyState.tension);
      expect(r.record.worldState.currentLocationId).toBe(asLocationId("loc_1"));
    }
  });
});
