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
import { asGenerationId, asLocationId } from "@/game/domain/worldEntity";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { GameId } from "@/game/application/server/persistence/gameRepository";
import { generatePendingNarrativeBundle } from "@/game/application/generatePendingNarrativeBundle";

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
