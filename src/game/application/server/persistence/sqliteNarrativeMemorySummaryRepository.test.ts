/** @vitest-environment node */
import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSqliteClient } from "./sqliteClient";
import { createSqliteNarrativeMemorySummaryRepository } from "./sqliteNarrativeMemorySummaryRepository";
import { asGameId, type GameRepository } from "./gameRepository";
import { asGenerationId, asLocationId, asPlayerEntityId } from "@/game/domain/worldEntity";
import type { MemorySummaryState } from "@/game/domain/narrativeMemorySummary";
import { asNarrativeJobId } from "@/game/domain/events";
import type { MemoryAttemptGuard, PreparedNarrativeMemory } from "@/game/application/narrativeMemorySummaryRepository";
import { createSqliteGameRepository } from "./sqliteGameRepository";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { createWorldStateFixtureWith, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { narrativeMemorySourceFingerprint } from "@/game/application/narrativeMemorySourceFingerprint";

const root = mkdtempSync(join(tmpdir(), "ai-rpg-memory-summary-"));
const dbPath = join(root, "memory.sqlite");
const gameId = asGameId("game:memory");
const generationId = asGenerationId("generation:memory");
const observerId = asPlayerEntityId("player_0");

function state(revision: number, through: number, fingerprint = "fp"): MemorySummaryState {
  return { formatVersion: 1, observerId, policyVersion: "memory-p2/1", summaryRevision: revision, coveredThroughSequence: through, coveredSourceFingerprint: fingerprint, batches: [], overview: { historyIds: [], eventIds: [] } };
}

const attemptGuard: MemoryAttemptGuard = {
  key: { gameId, generationId, jobId: asNarrativeJobId("job:memory"), epoch: 1 },
  expectedRevision: 4,
  expectedNarrativeJob: {
    status: "provider_pending", jobId: "job:memory", epoch: 1, leaseId: "lease:memory",
    candidateVersion: 0, candidateHash: null,
  },
  now: "2026-09-14T00:00:00.000Z",
};

const prepared: PreparedNarrativeMemory = {
  formatVersion: 1, policyVersion: "memory-p2/1", sourceFingerprint: "source:memory",
  policy: { threshold: 50, batchSize: 10, rawSoftEstimatedTokens: 24_000, summarySourceMaxEstimatedTokens: 24_000, overviewMaxEstimatedTokens: 6_000, promptMaxEstimatedTokens: 64_000 },
  summaries: "enabled",
  player: { observerId, coveredThroughSequence: 49, overviewHistoryIds: [], overviewEventIds: [], uncovered: [], recalled: [], requiredEvents: [], referencedEntityIds: [], ambiguousEntityIds: [], manifest: [] },
};

describe("sqlite narrative memory summary repository", () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("publishes independently from gameplay state and allows only one CAS writer", async () => {
    const repo = createSqliteNarrativeMemorySummaryRepository({ clientFactory: () => createSqliteClient(dbPath) });
    const key = { gameId, generationId, observerId };
    expect(await repo.load(key)).toEqual({ state: null, summaryRevision: 0 });
    expect(await repo.publish({ key, expectedSummaryRevision: 0, next: state(1, 9) })).toEqual({ ok: true });
    expect(await repo.publish({ key, expectedSummaryRevision: 0, next: state(1, 9) })).toEqual({ ok: false, code: "STALE_SUMMARY" });
    expect(await repo.load(key)).toMatchObject({ summaryRevision: 1, state: { coveredThroughSequence: 9 } });
    await repo.close();
    const reopened = createSqliteNarrativeMemorySummaryRepository({ clientFactory: () => createSqliteClient(dbPath) });
    expect(await reopened.load(key)).toMatchObject({ summaryRevision: 1, state: { coveredThroughSequence: 9 } });
    await reopened.close();
  });

  it("rejects a same-watermark source replacement without changing the cache", async () => {
    const repo = createSqliteNarrativeMemorySummaryRepository({ clientFactory: () => createSqliteClient(dbPath + ".source") });
    const key = { gameId, generationId, observerId };
    expect(await repo.publish({ key, expectedSummaryRevision: 0, next: state(1, 9, "a") })).toEqual({ ok: true });
    expect(await repo.publish({ key, expectedSummaryRevision: 1, next: state(2, 9, "b") })).toEqual({ ok: false, code: "SOURCE_CHANGED" });
    expect(await repo.load(key)).toMatchObject({ summaryRevision: 1, state: { coveredSourceFingerprint: "a" } });
    await repo.close();
  });

  it("rejects a publication that moves the covered watermark backwards", async () => {
    const repo = createSqliteNarrativeMemorySummaryRepository({ clientFactory: () => createSqliteClient(dbPath + ".watermark") });
    const key = { gameId, generationId, observerId };
    expect(await repo.publish({ key, expectedSummaryRevision: 0, next: state(1, 100, "a") })).toEqual({ ok: true });
    expect(await repo.publish({ key, expectedSummaryRevision: 1, next: state(2, 10, "a") })).toEqual({ ok: false, code: "SOURCE_CHANGED" });
    expect(await repo.load(key)).toMatchObject({ summaryRevision: 1, state: { coveredThroughSequence: 100 } });
    await repo.close();
  });

  it("accepts only a fingerprint rebuilt from the current persisted source", async () => {
    const sourcePath = dbPath + ".canonical-source";
    const gameRepository = createSqliteGameRepository({ clientFactory: () => createSqliteClient(sourcePath), logError: () => {} });
    const generation = { generationId: asGenerationId("generation:source"), seed: "seed", templateVersion: "v1", inputDigest: "", gameType: "wuxia" as const };
    const worldState = createWorldStateFixtureWith({
      generation,
      base: emptyProjection({
        player: { name: "玩家", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
        locations: [{ id: asLocationId("loc:source"), name: "镇口", description: "镇口", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] }],
        currentLocationId: asLocationId("loc:source"),
      }),
    });
    const storyState = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
    const sourceGameId = asGameId("game:canonical-source");
    expect(await gameRepository.createInitialGame({ gameId: sourceGameId, worldState, storyState, createdAt: "2026-09-14T00:00:00.000Z" })).toEqual({ ok: true });
    const current = await gameRepository.getCurrentGame();
    if (!current.ok || current.status !== "active") throw new Error("source game missing");
    const sourceFingerprint = narrativeMemorySourceFingerprint({ worldState: current.record.worldState, storyState: current.record.storyState, observerId, throughSequence: -1 });
    const repo = createSqliteNarrativeMemorySummaryRepository({ clientFactory: () => createSqliteClient(sourcePath), gameRepository });
    const key = { gameId: sourceGameId, generationId: worldState.generation.generationId, observerId };
    expect(await repo.publish({ key, expectedSummaryRevision: 0, next: state(1, -1, sourceFingerprint) })).toEqual({ ok: true });
    expect(await repo.publish({ key, expectedSummaryRevision: 1, next: state(2, -1, "forged") })).toEqual({ ok: false, code: "SOURCE_CHANGED" });
    await repo.close();
    await gameRepository.close();
  });

  it("freezes one prepared package and persists shared memory attempt budgets", async () => {
    const repo = createSqliteNarrativeMemorySummaryRepository({ clientFactory: () => createSqliteClient(dbPath + ".attempt") });
    expect(await repo.loadPrepared!(attemptGuard.key)).toEqual({ ok: true, prepared: null, preparedHash: null });
    for (let index = 0; index < 8; index += 1) expect(await repo.reserveHttpAttempt!(attemptGuard)).toEqual({ ok: true });
    expect(await repo.reserveHttpAttempt!(attemptGuard)).toEqual({ ok: false, code: "BUDGET_EXHAUSTED" });
    expect(await repo.reserveBatchUpdate!(attemptGuard)).toEqual({ ok: true });
    expect(await repo.reserveBatchUpdate!(attemptGuard)).toEqual({ ok: true });
    expect(await repo.reserveBatchUpdate!(attemptGuard)).toEqual({ ok: false, code: "BUDGET_EXHAUSTED" });
    expect(await repo.freezePrepared!({ ...attemptGuard, next: prepared })).toMatchObject({ ok: true, preparedHash: expect.any(String) });
    const loaded = await repo.loadPrepared!(attemptGuard.key);
    expect(loaded).toMatchObject({ ok: true, prepared, preparedHash: expect.any(String) });
    expect(await repo.reserveBatchUpdate!(attemptGuard)).toEqual({ ok: false, code: "STALE_ATTEMPT" });
    await repo.close();
  });

  it("fences a stale attempt inside the same SQLite transaction before changing its budget", async () => {
    const guardedPath = dbPath + ".guard";
    const raw = createSqliteClient(guardedPath);
    await raw.batch([
      "CREATE TABLE game_records (game_id TEXT PRIMARY KEY, world_state_json TEXT NOT NULL, story_state_json TEXT NOT NULL, revision INTEGER NOT NULL)",
      "CREATE TABLE current_game (slot INTEGER PRIMARY KEY, game_id TEXT NOT NULL)",
      {
        sql: "INSERT INTO game_records (game_id, world_state_json, story_state_json, revision) VALUES (?, ?, ?, ?)",
        args: [String(gameId), "{}", JSON.stringify({ narrative: { status: "provider_pending", job: { jobId: "job:memory", attempt: { epoch: 1, leaseId: "lease:memory", candidateVersion: 0, candidateHash: null, leaseExpiresAt: "2099-01-01T00:00:00.000Z" } } } }), 5],
      },
      { sql: "INSERT INTO current_game (slot, game_id) VALUES (1, ?)", args: [String(gameId)] },
    ]);
    const gameRepository = {
      async getCurrentGame() {
        return {
          ok: true as const,
          status: "active" as const,
          record: { gameId, revision: attemptGuard.expectedRevision, storyState: { narrative: { status: "provider_pending", job: { jobId: "job:memory", attempt: { epoch: 1, leaseId: "lease:memory", candidateVersion: 0, candidateHash: null, leaseExpiresAt: "2099-01-01T00:00:00.000Z" } } } } },
        } as never;
      },
    } as unknown as GameRepository;
    const repo = createSqliteNarrativeMemorySummaryRepository({ clientFactory: () => createSqliteClient(guardedPath), gameRepository });

    expect(await repo.reserveHttpAttempt!(attemptGuard)).toEqual({ ok: false, code: "STALE_ATTEMPT" });
    const attempts = await raw.execute({ sql: "SELECT http_attempts FROM narrative_memory_attempts", args: [] });
    expect(attempts.rows).toEqual([]);
    await repo.close();
    raw.close();
  });
});
