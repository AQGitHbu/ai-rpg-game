import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, expect, it } from "vitest";
import { markNarrativeGenerationFailed } from "./markNarrativeGenerationFailed";
import { asGameId } from "./server/persistence/gameRepository";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asGenerationId, asLocationId } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import type { GameRecord, GameRepository } from "./server/persistence/gameRepository";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";

const gameId = asGameId("failed-game");

function fixture(): { record: GameRecord; repository: GameRepository } {
  const startingLocation = {
    id: asLocationId("loc_failed"), name: "客栈", description: "测试地点。", kind: "main" as const,
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const worldState = createInitialWorldState({
    generation: { generationId: asGenerationId("generation_failed"), seed: "failed", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "玩家", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } }, startingLocation, startingItemIds: [],
  });
  const story = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  const job: PendingNarrativeJob = {
    jobId: asNarrativeJobId("job_failed"), turnId: asTurnId("turn_failed"), actionId: "action_failed", basedOnRevision: 1, turnNumber: 1,
    actionSummary: { kind: "explore" }, resolvedEvent: { actionId: "action_failed", status: "success", eventKind: "observe", facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [] },
    domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 0 }, requestedAt: "now", objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" }, mandatoryBeats: [],
    generationKind: "npc_fixed_choice", sceneRequestKind: "npc_response",
  };
  const record: GameRecord = {
    gameId,
    worldState,
    storyState: {
      ...story,
      narrative: {
        status: "provider_pending",
        mode: "offline",
        job,
        lastPresentedScene: story.narrative.status === "ready" ? story.narrative.currentScene : null,
      },
    },
    revision: 1,
    createdAt: "now",
  };
  let current = record;
  const repository: GameRepository = {
    createInitialGame: async () => ({ ok: false, code: "ACTIVE_GAME_EXISTS" }), replaceCurrentGame: async () => ({ ok: false, code: "NO_ACTIVE_GAME" }),
    getCurrentGame: async () => ({ ok: true, status: "active", record: current }),
    applyState: async (input) => {
      const expected = input.expectedNarrativeJob;
      const narrative = current.storyState.narrative;
      if (input.expectedRevision !== current.revision || expected === undefined || narrative.status === "ready") {
        return { ok: false, code: "STALE_GAME_REVISION" };
      }
      if (narrative.status !== expected.status || String(narrative.job.jobId) !== expected.jobId) {
        return { ok: false, code: "STALE_GAME_REVISION" };
      }
      current = { ...current, storyState: input.nextStoryState, worldState: input.nextWorldState };
      return { ok: true, record: current };
    },
    applySceneWriteBack: async () => ({ ok: false, code: "INFRASTRUCTURE_FAILURE" }), clearCurrentGame: async () => ({ ok: true }),
  };
  return { record, repository };
}

describe("markNarrativeGenerationFailed", () => {
  it("persists only the stable scene failure and keeps revision/world state", async () => {
    const { record, repository } = fixture();
    const result = await markNarrativeGenerationFailed(repository, record, { kind: "AI_RESPONSE_INVALID", phase: "scene", failedAt: "now" });
    expect(result).toEqual({ ok: true, result: "failed" });
    const current = await repository.getCurrentGame();
    expect(current.ok && current.status === "active" ? current.record.revision : -1).toBe(record.revision);
    expect(current.ok && current.status === "active" ? current.record.worldState : null).toEqual(record.worldState);
    expect(current.ok && current.status === "active" ? current.record.storyState.narrative : null).toMatchObject({
      status: "provider_failed", job: { jobId: "job_failed" }, failure: { kind: "AI_RESPONSE_INVALID", phase: "scene" },
    });
  });
});
