/** @vitest-environment node */
import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSqliteClient } from "./sqliteClient";
import { createSqliteNarrativeMemorySummaryRepository } from "./sqliteNarrativeMemorySummaryRepository";
import { asGameId } from "./gameRepository";
import { asGenerationId, asPlayerEntityId } from "@/game/domain/worldEntity";
import type { MemorySummaryState } from "@/game/domain/narrativeMemorySummary";
import { asNarrativeJobId } from "@/game/domain/events";
import type { MemoryAttemptGuard, PreparedNarrativeMemory } from "@/game/application/narrativeMemorySummaryRepository";

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
});
