import { describe, it, expect } from "vitest";
import { commitState } from "./stateCommit";
import type { GameRepositoryV2, GameRecordV2 } from "./server/persistence/gameRepositoryV2";
import { asGameId } from "./server/persistence/gameRepository";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId, asQuestId } from "@/game/domain/scenarioBlueprint";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";

function createValidJobFixture(): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId("job-1"),
    turnId: asTurnId("turn-1"),
    actionId: "act_1",
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: { kind: "talk", npcId: asNpcId("npc_1") },
    utterance: "请问矿坑里有什么？",
    resolvedEvent: {
      actionId: "act_1", status: "success", eventKind: "dialogue",
      facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: ["npc_met"], rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 1, toLedgerIndexExclusive: 2 },
    focusNpcId: asNpcId("npc_1"),
    requestedAt: "2026-01-02",
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

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

describe("commitState", () => {
  it("writes state with CAS and reconciles materialized views", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");
    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    const wsWithEvent: WorldState = {
      ...worldState,
      eventLedger: [
        ...worldState.eventLedger,
        { type: "quest_completed", questId: asQuestId("q1"), occurredAt: "2026-01-02" },
      ],
    };

    const result = await commitState(repo, { gameId, expectedRevision: 0, nextWorldState: wsWithEvent, nextStoryState: storyState });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.revision).toBe(1);
      expect(result.record.storyState.recentBeats.length).toBeGreaterThan(0);
    }
  });

  it("rejects stale revision", async () => {
    const { repo } = createInMemoryRepo();
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");
    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });
    const result = await commitState(repo, { gameId, expectedRevision: 99, nextWorldState: worldState, nextStoryState: storyState });
    expect(result).toEqual({ ok: false, code: "STALE_GAME_REVISION" });
  });

  it("pending job 随 StoryState 原样进入保存记录（物化视图归约不触碰 narrative）", async () => {
    const { repo, getRecord } = createInMemoryRepo();
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");
    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    const job = createValidJobFixture();
    const nextStoryState: StoryState = {
      ...storyState,
      turnNumber: 1,
      narrative: {
        ...storyState.narrative,
        generation: { status: "pending", job },
      },
    };

    const result = await commitState(repo, { gameId, expectedRevision: 0, nextWorldState: worldState, nextStoryState });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const saved = getRecord()!;
    const generation = saved.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    expect(generation.job).toEqual(job);
    expect(generation.job.basedOnRevision).toBe(1);
    expect(saved.storyState.narrative.currentScene).toBe(storyState.narrative.currentScene);
    expect(saved.storyState.narrative.mode).toBe(storyState.narrative.mode);
  });
});

