import { describe, it, expect, vi } from "vitest";
import { generatePendingSceneV2 } from "./generatePendingSceneV2";
import { createDeterministicSceneSource } from "./deterministicSceneSource";
import { createInitialWorldState, appendNpc, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { GameRepositoryV2, GameRecordV2 } from "./server/persistence/gameRepositoryV2";

function makeGameRecord(pending: boolean): GameRecordV2 {
  const loc: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  let ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc,
    startingItemIds: [],
  });
  const npc: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  ws = appendNpc(ws, npc);
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } });
  const storyState = pending
    ? { ...ss, narrative: { ...ss.narrative, generation: { status: "pending" as const, requestedAt: "2026-01-01" } } }
    : ss;
  return {
    gameId: "g1" as any,
    worldState: ws,
    storyState,
    revision: 0,
    createdAt: "2026-01-01",
  };
}

function makeMockRepo(record: GameRecordV2 | null): GameRepositoryV2 {
  return {
    createInitialGame: vi.fn(),
    getCurrentGame: vi.fn(async () => {
      if (record === null) return { ok: true as const, status: "none" as const };
      return { ok: true as const, status: "active" as const, record };
    }),
    applyState: vi.fn(),
    applySceneWriteBack: vi.fn(async (input: { expectedRevision: number }) => {
      if (record === null) return { ok: false as const, code: "NO_ACTIVE_GAME" as const };
      return {
        ok: true as const,
        record: {
          ...record,
          revision: input.expectedRevision + 1,
          storyState: { ...record.storyState, narrative: { ...record.storyState.narrative, generation: { status: "idle" as const } } },
        },
      };
    }),
    clearCurrentGame: vi.fn(async () => ({ ok: true as const })),
  };
}

describe("generatePendingSceneV2", () => {
  it("returns not_pending when generation is idle", async () => {
    const record = makeGameRecord(false);
    const repo = makeMockRepo(record);
    const result = await generatePendingSceneV2({
      repository: repo,
      sceneSource: createDeterministicSceneSource(),
      now: () => "2026-01-01",
    });
    expect(result).toBe("not_pending");
  });

  it("generates and writes back scene when pending", async () => {
    const record = makeGameRecord(true);
    const repo = makeMockRepo(record);
    const result = await generatePendingSceneV2({
      repository: repo,
      sceneSource: createDeterministicSceneSource(),
      now: () => "2026-01-01",
    });
    expect(result).toBe("saved");
    expect(repo.applySceneWriteBack).toHaveBeenCalledOnce();
  });

  it("returns unavailable when no active game", async () => {
    const repo = makeMockRepo(null);
    const result = await generatePendingSceneV2({
      repository: repo,
      sceneSource: createDeterministicSceneSource(),
      now: () => "2026-01-01",
    });
    expect(result).toBe("unavailable");
  });
});

