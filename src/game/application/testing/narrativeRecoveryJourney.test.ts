/** @vitest-environment node */
import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSqliteClient } from "@/game/application/server/persistence/sqliteClient";
import { createSqliteGameRepository } from "@/game/application/server/persistence/sqliteGameRepository";
import { asGameId } from "@/game/application/server/persistence/gameRepository";
import { createInitialStoryState } from "@/game/domain/storyState";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { createInitialWorldState } from "@/game/domain/worldState";
import { asEventId, asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { asGenerationId, asLocationId, asFactId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { GameId } from "@/game/application/server/persistence/gameRepository";
import { generatePendingNarrativeBundle } from "@/game/application/generatePendingNarrativeBundle";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { performTurn } from "@/game/application/performTurn";
import { buildChoiceMap } from "@/game/application/buildChoiceMap";
import { retryNarrativeGeneration } from "@/game/application/retryNarrativeGeneration";
import { createNarrativeMemoryPackagePreparer } from "@/game/application/prepareNarrativeMemoryPackage";
import { createSqliteNarrativeMemorySummaryRepository } from "@/game/application/server/persistence/sqliteNarrativeMemorySummaryRepository";
import type { NarrativeBundleSource } from "@/game/application/narrativeBundleSource";
import { buildNarrativeBundleDescriptors } from "@/game/gameplay/rpg/narrativeBundle";

const root = mkdtempSync(join(tmpdir(), "ai-rpg-recovery-"));
const opened: Array<ReturnType<typeof createSqliteGameRepository>> = [];
const clients: ReturnType<typeof createSqliteClient>[] = [];

function open(path: string) {
  const repo = createSqliteGameRepository({ clientFactory: () => createSqliteClient(path), logError: () => undefined });
  opened.push(repo);
  return repo;
}

function gameRecordInput() {
  const world = createInitialWorldState({
    generation: { generationId: asGenerationId("generation-recovery"), seed: "recovery", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "玩家", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: { id: asLocationId("loc_recovery"), name: "驿站", description: "测试地点", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] },
    startingItemIds: [],
  });
  const job = createPendingNarrativeJob({
    jobId: asNarrativeJobId("job-recovery"), turnId: asTurnId("turn-recovery"), actionId: "action-recovery",
    expectedRevision: 0, turnNumber: 1, actionSummary: { kind: "explore" },
    resolvedEvent: { actionId: "action-recovery", status: "success", eventKind: "observe", facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [] },
    domainEventIds: [asEventId("turn-recovery:event")], requestedAt: "2026-09-13T00:00:00.000Z",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" }, mandatoryBeats: [],
    generationKind: "npc_free_text", sceneRequestKind: "npc_response",
  });
  if (!job.ok) throw new Error("job fixture invalid");
  const story = createInitialStoryState({
    initialNarrative: {
      status: "provider_pending", mode: "ai", job: job.job, lastPresentedScene: null,
    },
    gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 1 },
  });
  return { worldState: world, storyState: { ...story, memory: rebuildEpisodicMemory(world.eventLedger) } };
}

afterAll(async () => {
  for (const repo of opened) await repo.close();
  for (const client of clients) client.close();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* SQLite may release the file handle after the test process exits. */ }
});

describe("narrative recovery journey", () => {
  it.each([false, true])("persists a changed revisit and retries B after reopening without replaying the move (recoverReady=%s)", async (recoverReady) => {
    const path = join(root, `changed-revisit-${recoverReady}.sqlite`);
    let repository = open(path);
    await repository.initializeSchema();
    const gameId = asGameId("game-changed-revisit");
    const visited = asLocationId("loc:visited");
    const outside = asLocationId("loc:outside");
    const factId = asFactId("fact:old-change");
    const now = () => "2026-09-15T00:00:00.000Z";
    const priorScene = makeCommittedEvent({ type: "narrative_scene_presented", sceneId: "scene:visited", focusNpcId: null,
      pacing: "develop", beatIds: [], revealedFactIds: [] }, { eventId: asEventId("turn:old:scene"), sequence: 0, locationId: visited });
    const change = makeCommittedEvent({ type: "fact_discovered", factId }, {
      eventId: asEventId("turn:old:change"), sequence: 1, locationId: visited, factIds: [factId], outcome: "success",
    });
    const departure = makeCommittedEvent({ type: "location_visited", locationId: outside }, {
      eventId: asEventId("turn:old:departure"), sequence: 2, locationId: outside, outcome: "success",
    });
    const worldState = createWorldStateFixture({
      generation: { generationId: asGenerationId("generation:revisit"), seed: "revisit", templateVersion: "test", inputDigest: "", gameType: "wuxia" },
      projection: { ...emptyProjection({ player: { name: "玩家", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
        locations: [visited, outside].map((id) => ({ id, name: String(id), description: "测试地点", kind: "main", scale: "scene",
          connectedLocationIds: [id === visited ? outside : visited], npcIds: [], availableItemIds: [], tags: [] })),
        currentLocationId: outside, unlockedLocationIds: [visited, outside], visitedLocationIds: [visited, outside] }),
        worldFacts: [{ factId, text: "此前取得的公开证据。", source: "generated", discovered: true, discoveryMode: "automatic", locationId: visited }],
      }, eventLedger: [priorScene, change, departure],
    });
    const narrative = createFixtureNarrativeRuntimeState();
    const story = createInitialStoryState({ initialNarrative: { ...narrative, mode: "ai",
      currentScene: { ...narrative.currentScene, source: "generated", event: { kind: "observe", locationId: outside } } },
      gameLength: "short", initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 3 } });
    const storyState = { ...story, turnNumber: 3, memory: rebuildEpisodicMemory(worldState.eventLedger) };
    expect(await repository.createInitialGame({ gameId, worldState, storyState, createdAt: now() })).toEqual({ ok: true });

    const choiceMap = buildChoiceMap(worldState, storyState, 0);
    const move = [...choiceMap].find(([, action]) => action.type === "move" && action.locationId === visited);
    expect(move).toBeDefined();
    const read = async () => {
      const result = await repository.getCurrentGame();
      if (!result.ok || result.status !== "active") throw new Error("revisit recovery record unavailable");
      return result.record;
    };
    expect(await performTurn({ gameId, actionId: "action:return", expectedRevision: 0,
      interaction: { kind: "fixed_choice", choiceToken: move![0] }, choiceMap }, { repository, now })).toMatchObject({ ok: true });
    const afterA = await read();
    if (afterA.storyState.narrative.status !== "provider_pending") throw new Error("revisit did not enter pending");
    const job = afterA.storyState.narrative.job;
    expect(job.resultBoundaryProof).toMatchObject({ kind: "changed_revisit", previousSceneEventId: priorScene.eventId, sourceEventIds: [change.eventId] });
    expect(job.domainEventIds).not.toContain(change.eventId);
    const capture: string[] = [];
    const source: NarrativeBundleSource = { generate: async (context) => {
      if (context.kind !== "decision") throw new Error("expected decision");
      expect(context.memoryContext?.observerId).toBe(PLAYER_ENTITY_ID);
      expect(context.memoryContext?.requiredEvents.map((event) => event.eventId)).toContain(change.eventId);
      capture.push(JSON.stringify(context.memoryContext));
      if (recoverReady && context.job.attempt.epoch === 1) {
        const graph = buildNarrativeBundleDescriptors({ worldState: context.worldState, storyState: context.storyState, transition: context.job.objectiveTransition });
        expect(graph.steps).toHaveLength(0);
        return { ok: true, kind: "decision", proposal: { worldDelta: null,
          currentScene: { segments: context.job.mandatoryBeats.map((beat) => ({ beatId: beat.beatId, text: "你回到此前查验过的地点，原来的记录仍在。" })),
            npcLine: null, objectiveLink: null,
            choices: graph.currentChoiceCandidates.map((candidate) => ({ candidateId: candidate.candidateId, label: "继续查验" })) },
          continuationScenes: [], terminal: graph.terminal,
        } };
      }
      return { ok: false, failure: { kind: "AI_RESPONSE_INVALID", phase: "scene" }, repairReason: "invalid_schema" };
    } };
    const openMemory = () => createSqliteNarrativeMemorySummaryRepository({ clientFactory: () => createSqliteClient(path), gameRepository: repository });
    let memory = openMemory();
    const generate = () => generatePendingNarrativeBundle({ repository, now, source, memorySummaryRepository: memory,
      prepareMemoryPackage: createNarrativeMemoryPackagePreparer({ repository: memory, summaries: "disabled",
        source: { select: async () => { throw new Error("summary disabled"); } },
        policy: { threshold: 50, batchSize: 10, rawSoftEstimatedTokens: 24_000, summarySourceMaxEstimatedTokens: 24_000, overviewMaxEstimatedTokens: 6_000, promptMaxEstimatedTokens: 64_000 },
      }),
    });
    try {
      expect(await generate()).toMatchObject({ ok: false, code: "AI_RESPONSE_INVALID" });
      const failed = await read();
      expect(failed.storyState.narrative.status).toBe("provider_failed");
      const key = { gameId, generationId: worldState.generation.generationId, jobId: job.jobId, epoch: 0 };
      // loadPrepared intentionally authorizes only the currently pending epoch.
      // Read the stored row to prove a failed epoch's frozen packet survives a
      // database reopen without pretending that it is reusable by a new epoch.
      const frozenRow = async () => {
        const client = createSqliteClient(path);
        try {
          const result = await client.execute({ sql: "SELECT prepared_json, prepared_hash FROM narrative_memory_attempts WHERE game_id = ? AND generation_id = ? AND job_id = ? AND epoch = ?",
            args: [key.gameId, key.generationId, key.jobId, key.epoch] });
          return result.rows[0];
        } finally { client.close(); }
      };
      const frozen = await frozenRow();
      expect(frozen?.prepared_hash).toEqual(expect.any(String));
      expect(JSON.parse(String(frozen?.prepared_json))).toMatchObject({ player: { observerId: PLAYER_ENTITY_ID } });
      await memory.close();
      await repository.close();
      repository = open(path);
      await repository.initializeSchema();
      memory = openMemory();
      expect(await read()).toEqual(failed);
      expect(await frozenRow()).toEqual(frozen);
      expect(await retryNarrativeGeneration(repository, gameId, now)).toMatchObject({ ok: true, result: "requeued" });
      expect(await generate()).toMatchObject(recoverReady ? { ok: true } : { ok: false, code: "AI_RESPONSE_INVALID" });
      const afterRetry = await read();
      const newSceneEvents = afterRetry.worldState.eventLedger.filter(event => !afterA.worldState.eventLedger.some(previous => previous.eventId === event.eventId));
      expect(newSceneEvents.map(event => event.kind)).toEqual(recoverReady ? ["narrative_scene_presented"] : []);
      expect({ ...afterRetry.worldState, eventLedger: afterA.worldState.eventLedger }).toEqual(afterA.worldState);
      expect(afterRetry.storyState.history.entries.filter(entry => entry.kind === "player_choice")).toEqual(afterA.storyState.history.entries.filter(entry => entry.kind === "player_choice"));
      expect(afterRetry.storyState.history.entries.filter(entry => entry.kind === "player_choice")).toHaveLength(1);
      expect(afterRetry.storyState.history.entries.length > afterA.storyState.history.entries.length).toBe(recoverReady);
      expect(afterRetry.worldState.eventLedger.filter((event) => event.payload.type === "location_visited" && event.payload.locationId === visited)).toHaveLength(1);
      expect(afterRetry.worldState.eventLedger.filter((event) => event.eventId === change.eventId)).toHaveLength(1);
      expect(afterRetry.storyState.narrative).toMatchObject(recoverReady ? { status: "ready", currentScene: { source: "generated" } } : { status: "provider_failed", job: {
        jobId: job.jobId, resultBoundaryProof: job.resultBoundaryProof, attempt: { epoch: 1 },
      } });
      expect(capture).toHaveLength(recoverReady ? 4 : 6);
      expect(new Set(capture).size).toBe(1);
      if (recoverReady) {
        expect(await generate()).toMatchObject({ ok: false, code: "NOT_PENDING" });
        expect(await read()).toEqual(afterRetry);
        expect(capture).toHaveLength(4);
      }
    } finally {
      await memory.close();
    }
  });

  it("allows one lease among concurrent ensure workers and fences the stale worker", async () => {
    const path = join(root, "concurrent.sqlite");
    const first = open(path);
    const second = open(path);
    await first.initializeSchema();
    const input = gameRecordInput();
    const gameId = asGameId("game-recovery") as GameId;
    expect(await first.createInitialGame({ ...input, gameId, createdAt: "2026-09-13T00:00:00.000Z" })).toEqual({ ok: true });

    const claims = await Promise.all([
      first.claimNarrativeJob!({ gameId, expectedRevision: 0, jobId: "job-recovery", now: "2026-09-13T00:00:01.000Z", leaseId: "lease-a", leaseExpiresAt: "2026-09-13T00:10:01.000Z" }),
      second.claimNarrativeJob!({ gameId, expectedRevision: 0, jobId: "job-recovery", now: "2026-09-13T00:00:01.000Z", leaseId: "lease-b", leaseExpiresAt: "2026-09-13T00:10:01.000Z" }),
    ]);
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.ok)).toHaveLength(1);

    const claimed = claims.find((claim) => claim.ok);
    if (claimed === undefined || !claimed.ok) throw new Error("claim fixture failed");
    const winnerIndex = claims.findIndex((claim) => claim.ok);
    const winner = winnerIndex === 0 ? first : second;
    const loser = winnerIndex === 0 ? second : first;
    const winnerLeaseId = winnerIndex === 0 ? "lease-a" : "lease-b";
    const reserved = await winner.reserveNarrativeCandidate!({
      gameId, expectedRevision: claimed.record.revision,
      expectedNarrativeJob: {
        status: "provider_pending", jobId: "job-recovery", epoch: 0, leaseId: winnerLeaseId,
        candidateVersion: 0, candidateHash: null,
      },
    });
    expect(reserved).toMatchObject({ ok: true, record: { storyState: { narrative: { job: { attempt: { candidateVersion: 1, status: "running" } } } } } });

    const expiredClaim = await loser.claimNarrativeJob!({
      gameId, expectedRevision: claimed.record.revision, jobId: "job-recovery",
      now: "2026-09-13T00:11:00.000Z", leaseId: "lease-c", leaseExpiresAt: "2026-09-13T00:21:00.000Z",
    });
    expect(expiredClaim).toMatchObject({ ok: true, record: { storyState: { narrative: { job: { attempt: { leaseId: "lease-c" } } } } } });
    const staleRelease = await winner.releaseNarrativeJob!({
      gameId, expectedRevision: claimed.record.revision, expectedNarrativeJob: {
        status: "provider_pending", jobId: "job-recovery", epoch: 0, leaseId: winnerLeaseId,
        candidateVersion: 1, candidateHash: null,
      },
    });
    expect(staleRelease).toMatchObject({ ok: false, code: "STALE_GAME_REVISION" });
  });

  it("resumes an abandoned epoch at the next candidate version without replaying version one", async () => {
    const path = join(root, "resume.sqlite");
    const repository = open(path);
    await repository.initializeSchema();
    const input = gameRecordInput();
    const gameId = asGameId("game-resume") as GameId;
    expect(await repository.createInitialGame({ ...input, gameId, createdAt: "2026-09-13T00:00:00.000Z" })).toEqual({ ok: true });

    const claimed = await repository.claimNarrativeJob!({
      gameId, expectedRevision: 0, jobId: "job-recovery",
      now: "2026-09-13T00:00:01.000Z", leaseId: "crashed-worker", leaseExpiresAt: "2026-09-13T00:10:01.000Z",
    });
    if (!claimed.ok) throw new Error("claim fixture failed");
    const reserved = await repository.reserveNarrativeCandidate!({
      gameId, expectedRevision: 0,
      expectedNarrativeJob: {
        status: "provider_pending", jobId: "job-recovery", epoch: 0, leaseId: "crashed-worker",
        candidateVersion: 0, candidateHash: null,
      },
    });
    if (!reserved.ok) throw new Error("candidate fixture failed");

    const candidateVersions: number[] = [];
    const result = await generatePendingNarrativeBundle({
      repository,
      leaseId: () => "recovery-worker",
      now: () => "2026-09-13T00:11:00.000Z",
      source: {
        async generate(context) {
          if (context.kind === "decision") {
            candidateVersions.push(context.candidateVersion ?? -1);
            expect(await context.reserveHttpAttempt?.()).toBe(true);
            expect(await context.reserveHttpAttempt?.()).toBe(true);
          }
          return { ok: false, failure: { kind: "AI_RESPONSE_INVALID", phase: "scene" }, repairReason: "invalid_schema" };
        },
      },
    });

    expect(result).toMatchObject({ ok: false, code: "AI_RESPONSE_INVALID" });
    expect(candidateVersions).toEqual([2, 3]);
    const current = await repository.getCurrentGame();
    expect(current).toMatchObject({
      ok: true,
      status: "active",
      record: { storyState: { narrative: { status: "provider_failed", job: { attempt: {
        epoch: 0, candidateVersion: 3, candidateHash: null, httpAttempts: 4, status: "failed", leaseId: null, leaseExpiresAt: null,
      } } } } },
    });
  });
});
