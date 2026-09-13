import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, expect, it, vi } from "vitest";
import { retryNarrativeGeneration } from "./retryNarrativeGeneration";
import type { GameRecord, GameRepository } from "./server/persistence/gameRepository";
import { asGameId } from "./server/persistence/gameRepository";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asGenerationId, asLocationId, asQuestId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { asEventId, asNarrativeJobId, asTurnId } from "@/game/domain/events";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { createNarrativeGenerationAttempt } from "@/game/domain/narrativeGenerationAttempt";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";

const gameId = asGameId("retry-game");

function makeJob(): PendingNarrativeJob {
  return {
    jobId: asNarrativeJobId("job_retry"),
    turnId: asTurnId("turn_retry"),
    actionId: "action_retry",
    basedOnRevision: 3,
    turnNumber: 1,
    actionSummary: { kind: "explore" },
    resolvedEvent: {
      actionId: "action_retry",
      status: "success",
      eventKind: "observe",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventIds: [asEventId("turn_retry:event")],
    requestedAt: "2026-08-21T00:00:00.000Z",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
    generationKind: "npc_fixed_choice",
    sceneRequestKind: "npc_response",
    attempt: createNarrativeGenerationAttempt(),
  };
}

function makeRecord(
  status: "pending" | "failed" | "idle",
  failureReason: "provider_failure" | "segment_unknown_beat" | null = "provider_failure",
  failureKind: "AI_CALL_FAILED" | "AI_RESPONSE_INVALID" = "AI_CALL_FAILED",
): GameRecord {
  const startingLocation = {
    id: asLocationId("loc_retry"),
    name: "客栈",
    description: "一处测试地点。",
    kind: "main" as const,
    connectedLocationIds: [],
    npcIds: [],
    availableItemIds: [],
    tags: [],
  };
  const worldState = createInitialWorldState({
    generation: { generationId: asGenerationId("generation_retry"), seed: "retry", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "玩家", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation,
    startingItemIds: [],
  });
  const job = makeJob();
  const story = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  return {
    gameId,
    worldState,
    storyState: {
      ...story,
      narrative: status === "idle"
        ? createFixtureNarrativeRuntimeState()
        : status === "pending"
          ? {
              status: "provider_pending",
              mode: "offline",
              job,
              lastPresentedScene: story.narrative.status === "ready" ? story.narrative.currentScene : null,
            }
          : {
              status: "provider_failed",
              mode: "offline",
              job,
              lastPresentedScene: story.narrative.status === "ready" ? story.narrative.currentScene : null,
              failure: {
                kind: failureKind,
                phase: "scene",
                failedAt: "2026-08-21T00:00:00.000Z",
                ...(failureReason === null ? {} : { reason: failureReason }),
              },
            },
    },
    revision: 3,
    createdAt: "2026-08-21T00:00:00.000Z",
  };
}

function makeRepository(initial: GameRecord): { repository: GameRepository; record: () => GameRecord } {
  let current = initial;
  const repository: GameRepository = {
    createInitialGame: vi.fn(),
    replaceCurrentGame: vi.fn(),
    getCurrentGame: vi.fn(async () => ({ ok: true as const, status: "active" as const, record: current })),
    applyState: vi.fn(async (input) => {
      const expected = input.expectedNarrativeJob;
      const narrative = current.storyState.narrative;
      if (input.expectedRevision !== current.revision
        || (expected !== undefined
          && (narrative.status !== expected.status
            || narrative.status === "ready"
            || String(narrative.job.jobId) !== expected.jobId))) {
        return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      }
      current = {
        ...current,
        worldState: input.nextWorldState,
        storyState: input.nextStoryState,
        revision: input.incrementRevision === false ? current.revision : current.revision + 1,
      };
      return { ok: true as const, record: current };
    }),
    applySceneWriteBack: vi.fn(),
    clearCurrentGame: vi.fn(),
  };
  return { repository, record: () => current };
}

describe("retryNarrativeGeneration", () => {
  it("CAS restores the same failed job without changing the rule revision", async () => {
    const fixture = makeRepository(makeRecord("failed"));
    const before = fixture.record();
    const result = await retryNarrativeGeneration(fixture.repository, gameId, () => "2026-08-21T00:00:00.000Z");

    expect(result).toEqual({ ok: true, result: "requeued", jobId: "job_retry" });
    expect(fixture.record().revision).toBe(before.revision);
    expect(fixture.record().worldState).toEqual(before.worldState);
    expect(fixture.record().storyState.narrative).toMatchObject({
      status: "provider_pending",
      job: { jobId: "job_retry" },
      retryContext: { attempt: 1, reason: "provider_failure" },
    });
    expect(fixture.record().storyState.narrative).toMatchObject({
      job: { attempt: { epoch: 1, candidateVersion: 0, candidateHash: null, httpAttempts: 0, leaseId: null, leaseExpiresAt: null, status: "idle" } },
    });
    expect(vi.mocked(fixture.repository.applyState).mock.calls[0]?.[0]).toMatchObject({
      incrementRevision: false,
      expectedNarrativeJob: { status: "provider_failed", jobId: "job_retry" },
    });
  });

  it("reconciles committed quest-bound threads on the same failed job before requeueing", async () => {
    const base = makeRecord("failed", "segment_unknown_beat", "AI_RESPONSE_INVALID");
    if (base.storyState.narrative.status !== "provider_failed") throw new Error("failed fixture missing");
    const beforeJob = base.storyState.narrative.job;
    const questId = asQuestId("quest_final");
    const outcome = makeCommittedEvent({ type: "quest_completed", questId }, {
      eventId: asEventId("turn_final:quest_completed"), questIds: [questId], actorIds: [PLAYER_ENTITY_ID],
    });
    const thread = { ...base.storyState.threads[0]!, id: "thread:final", questIds: [questId], status: "advanced" as const };
    const record: GameRecord = {
      ...base,
      worldState: {
        ...base.worldState,
        quests: [{ id: questId, name: "终幕", description: "", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "main", stage: 3, status: "completed" }],
        endings: [
          { id: "ending_trust", name: "信任", description: "", theme: "trust", requirements: [] },
          { id: "ending_doubt", name: "存疑", description: "", theme: "doubt", requirements: [] },
        ] as never,
        eventLedger: [...base.worldState.eventLedger, outcome],
      },
      storyState: {
        ...base.storyState,
        currentAct: 3,
        targetActs: 3,
        storyProgress: 100,
        threads: [thread],
        unresolvedThreads: [thread.id],
        evolution: { ...base.storyState.evolution, status: "needs_ending_pair" },
      },
    };
    const fixture = makeRepository(record);

    expect(await retryNarrativeGeneration(fixture.repository, gameId, () => "now"))
      .toMatchObject({ ok: true, result: "requeued", jobId: String(beforeJob.jobId) });
    const saved = fixture.record();
    expect(saved.worldState).toEqual(record.worldState);
    expect(saved.revision).toBe(record.revision);
    expect(saved.storyState).toMatchObject({
      endingAllowed: true,
      unresolvedThreads: [],
      evolution: { status: "stable" },
      narrative: { status: "provider_pending", job: { jobId: beforeJob.jobId, actionId: beforeJob.actionId } },
    });
    expect(saved.storyState.threads[0]).toMatchObject({ status: "resolved", evidenceEventIds: [outcome.eventId] });
  });

  it("two concurrent retries only requeue once", async () => {
    const fixture = makeRepository(makeRecord("failed"));
    const results = await Promise.all([
      retryNarrativeGeneration(fixture.repository, gameId, () => "now"),
      retryNarrativeGeneration(fixture.repository, gameId, () => "now"),
    ]);

    expect(results.filter((result) => result.ok && result.result === "requeued")).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "STALE_GAME_REVISION")).toHaveLength(1);
    expect(fixture.record().storyState.narrative.status).toBe("provider_pending");
  });

  it("旧 failed 存档没有 reason 时使用安全兼容原因", async () => {
    const fixture = makeRepository(makeRecord("failed", null, "AI_RESPONSE_INVALID"));
    await retryNarrativeGeneration(fixture.repository, gameId, () => "now");

    expect(fixture.record().storyState.narrative).toMatchObject({
      status: "provider_pending",
      retryContext: { attempt: 1, reason: "invalid_schema" },
    });
  });

  it("does not rewrite pending or idle generation", async () => {
    const pending = makeRepository(makeRecord("pending"));
    expect(await retryNarrativeGeneration(pending.repository, gameId, () => "now"))
      .toMatchObject({ ok: true, result: "already_pending", jobId: "job_retry" });
    expect(pending.repository.applyState).not.toHaveBeenCalled();

    const idle = makeRepository(makeRecord("idle"));
    expect(await retryNarrativeGeneration(idle.repository, gameId, () => "now"))
      .toEqual({ ok: true, result: "not_failed" });
    expect(idle.repository.applyState).not.toHaveBeenCalled();
  });

  it("rejects a malformed failed job outside the provider whitelist without a CAS", async () => {
    const failed = makeRecord("failed");
    if (failed.storyState.narrative.status !== "provider_failed") throw new Error("failed fixture missing");
    const forged: GameRecord = {
      ...failed,
      storyState: {
        ...failed.storyState,
        narrative: {
          ...failed.storyState.narrative,
          job: { ...failed.storyState.narrative.job, generationKind: "prepared_action" } as never,
        },
      },
    };
    const fixture = makeRepository(forged);

    expect(await retryNarrativeGeneration(fixture.repository, gameId, () => "now"))
      .toEqual({ ok: false, code: "AI_RESPONSE_INVALID" });
    expect(fixture.repository.applyState).not.toHaveBeenCalled();
  });
});
