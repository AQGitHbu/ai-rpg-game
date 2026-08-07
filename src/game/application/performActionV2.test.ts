import { describe, it, expect } from "vitest";
import { performActionV2 } from "./performActionV2";
import type { GameRepositoryV2, GameRecordV2 } from "./server/persistence/gameRepositoryV2";
import { asGameId } from "./server/persistence/gameRepository";
import { createInitialWorldState, appendLocation, appendNpc, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";

function createInMemoryRepoWithRecord(ws: WorldState, ss: StoryState): GameRepositoryV2 {
  let record: GameRecordV2 = { gameId: asGameId("g1"), worldState: ws, storyState: ss, revision: 0, createdAt: "2026-01-01" };
  return {
    async createInitialGame(input) {
      if (record !== null) return { ok: false, code: "ACTIVE_GAME_EXISTS" as const };
      record = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
      return { ok: true as const };
    },
    async getCurrentGame() {
      return { ok: true as const, status: "active" as const, record };
    },
    async applyState(input) {
      if (input.expectedRevision !== record.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
      record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
      return { ok: true as const, record };
    },
    async applySceneWriteBack(input) {
      if (input.expectedRevision !== record.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
      record = { ...record, storyState: { ...record.storyState, narrative: input.nextNarrative, candidateEventPool: input.nextCandidateEventPool }, revision: record.revision + 1 };
      return { ok: true as const, record };
    },
  };
}

describe("performActionV2", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const npc1: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };

  function buildWorldState(): WorldState {
    const base = createInitialWorldState({
      generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: loc1,
      startingItemIds: [],
    });
    return { ...appendNpc(appendLocation(base, loc2), npc1), unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
  }

  it("performs a valid talk action end-to-end", async () => {
    const ws = buildWorldState();
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });
    const repo = createInMemoryRepoWithRecord(ws, ss);
    const talkAction: Action = { type: "talk", npcId: asNpcId("npc_1") };
    const choiceMap = new Map([["tok_talk", talkAction]]);

    const result = await performActionV2(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_talk" }, expectedRevision: 0, choiceMap },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revision).toBe(1);
      expect(result.resolvedEvent.status).toBe("success");
      expect(result.resolvedEvent.eventKind).toBe("dialogue");
    }
  });

  it("rejects stale revision", async () => {
    const ws = buildWorldState();
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });
    const repo = createInMemoryRepoWithRecord(ws, ss);

    const result = await performActionV2(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_talk" }, expectedRevision: 99, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("STALE_GAME_REVISION");
  });

  it("rejects unknown choice token", async () => {
    const ws = buildWorldState();
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });
    const repo = createInMemoryRepoWithRecord(ws, ss);

    const result = await performActionV2(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "nope" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNKNOWN_CHOICE");
  });
});
