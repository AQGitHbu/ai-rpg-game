import { describe, it, expect, vi } from "vitest";
import { generatePendingNarrativeBundle } from "./generatePendingNarrativeBundle";
import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { NarrativeBundleSource, NarrativeBundleSourceResult } from "./narrativeBundleSource";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { asNpcId, asLocationId } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";

function createMinimalWorldState(): WorldState {
  return createInitialWorldState({
    generation: {
      generationId: "gen_test" as never,
      seed: "test",
      templateVersion: "v2",
      inputDigest: "",
      gameType: "wuxia",
    },
    player: { name: "测试玩家", identity: "测试身份", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_0"),
      name: "测试地点",
      description: "一个测试地点",
      kind: "main",
      connectedLocationIds: [],
      npcIds: [asNpcId("npc_0")],
      availableItemIds: [],
      tags: [],
    },
    startingItemIds: [],
  });
}

function createMinimalStoryState(narrative: StoryState["narrative"]): StoryState {
  return {
    ...createInitialStoryState({
      gameLength: "short",
      initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 },
      initialNarrative: narrative,
    }),
  };
}

function createPendingJob(): PendingNarrativeJob {
  return {
    jobId: asNarrativeJobId("job_test_0"),
    turnId: asTurnId("turn_test_0"),
    actionId: "action_test",
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: { kind: "talk", npcId: asNpcId("npc_0") },
    resolvedEvent: {
      actionId: "action_test",
      status: "success",
      eventKind: "dialogue",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
    focusNpcId: asNpcId("npc_0"),
    requestedAt: "2026-01-01T00:00:00.000Z",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
    generationKind: "narrative_choice",
    sceneRequestKind: "npc_fixed_choice",
  } as unknown as PendingNarrativeJob;
}

function createInMemoryRepo(record: GameRecord | null): { repo: GameRepository; getRecord: () => GameRecord | null; getApplyCount: () => number } {
  let current: GameRecord | null = record;
  let applyCount = 0;
  return {
    repo: {
      async createInitialGame() { return { ok: true as const }; },
      async getCurrentGame() {
        if (current === null) return { ok: true as const, status: "none" as const };
        return { ok: true as const, status: "active" as const, record: current };
      },
      async applyState(input) {
        applyCount++;
        if (current === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== current.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        current = { ...current, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: current.revision + 1 };
        return { ok: true as const, record: current };
      },
      async applySceneWriteBack(input) {
        if (current === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== current.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        current = { ...current, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: current.revision + 1 };
        return { ok: true as const, record: current };
      },
      async clearCurrentGame() { return { ok: true as const }; },
      async replaceCurrentGame() { return { ok: true as const }; },
    } as GameRepository,
    getRecord: () => current,
    getApplyCount: () => applyCount,
  };
}

describe("generatePendingNarrativeBundle", () => {
  it("returns NOT_PENDING when narrative is not provider_pending", async () => {
    const worldState = createMinimalWorldState();
    const storyState = createMinimalStoryState({
      status: "ready",
      mode: "ai",
      currentScene: {
        sceneId: "scene-1",
        turn: 0,
        narration: "测试",
        usedFactIds: [],
        npcLine: null,
        choices: [],
        source: "generated",
      },
      choiceRegistry: [],
    });

    const { repo } = createInMemoryRepo({
      gameId: "g1" as never,
      worldState,
      storyState,
      revision: 0,
      createdAt: "2026-01-01",
    });

    const source: NarrativeBundleSource = { generate: vi.fn() };
    const result = await generatePendingNarrativeBundle({
      repository: repo,
      source,
      now: () => "2026-01-01",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_PENDING");
    expect(source.generate).not.toHaveBeenCalled();
  });

  it("returns NO_ACTIVE_GAME when no active game exists", async () => {
    const { repo } = createInMemoryRepo(null);
    const source: NarrativeBundleSource = { generate: vi.fn() };
    const result = await generatePendingNarrativeBundle({
      repository: repo,
      source,
      now: () => "2026-01-01",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_ACTIVE_GAME");
  });

  it("records provider_failed when source returns failure", async () => {
    const worldState = createMinimalWorldState();
    const job = createPendingJob();
    const storyState = createMinimalStoryState({
      status: "provider_pending",
      mode: "ai",
      job,
      lastPresentedScene: null,
    });

    const { repo, getRecord, getApplyCount } = createInMemoryRepo({
      gameId: "g1" as never,
      worldState,
      storyState,
      revision: 0,
      createdAt: "2026-01-01",
    });

    const source: NarrativeBundleSource = {
      generate: vi.fn().mockResolvedValue({
        ok: false,
        failure: { kind: "AI_CALL_FAILED", phase: "scene", failedAt: "2026-01-01" },
      } as NarrativeBundleSourceResult),
    };

    const result = await generatePendingNarrativeBundle({
      repository: repo,
      source,
      now: () => "2026-01-01",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AI_RESPONSE_INVALID");
    // Should have written provider_failed state
    expect(getApplyCount()).toBeGreaterThan(0);
    const record = getRecord();
    if (record) {
      expect(record.storyState.narrative.status).toBe("provider_failed");
    }
  });

  it("calls source.generate exactly once per attempt", async () => {
    const worldState = createMinimalWorldState();
    const job = createPendingJob();
    const storyState = createMinimalStoryState({
      status: "provider_pending",
      mode: "ai",
      job,
      lastPresentedScene: null,
    });

    const { repo } = createInMemoryRepo({
      gameId: "g1" as never,
      worldState,
      storyState,
      revision: 0,
      createdAt: "2026-01-01",
    });

    const generateMock = vi.fn().mockResolvedValue({
      ok: false,
      failure: { kind: "AI_CALL_FAILED", phase: "scene", failedAt: "2026-01-01" },
    } as NarrativeBundleSourceResult);

    const source: NarrativeBundleSource = { generate: generateMock };

    await generatePendingNarrativeBundle({
      repository: repo,
      source,
      now: () => "2026-01-01",
    });

    // With 2 max attempts, source should be called twice
    expect(generateMock).toHaveBeenCalledTimes(2);
  });
});
