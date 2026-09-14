/** @vitest-environment node */
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSqliteClient } from "./sqliteClient";
import { createSqliteNarrativeMemorySummaryRepository } from "./sqliteNarrativeMemorySummaryRepository";
import { asGameId, type GameRecord } from "./gameRepository";
import { asGenerationId, asLocationId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import type { MemorySummaryState } from "@/game/domain/narrativeMemorySummary";
import { asNarrativeJobId, asTurnId, asEventId, asEpisodeId, type CommittedNarrativeEvent } from "@/game/domain/events";
import type { MemoryAttemptGuard, PreparedNarrativeMemory } from "@/game/application/narrativeMemorySummaryRepository";
import { createSqliteGameRepository } from "./sqliteGameRepository";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { createWorldStateFixtureWith, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { narrativeMemorySourceFingerprint, preparedNarrativeMemorySourceFingerprint } from "@/game/application/narrativeMemorySourceFingerprint";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { projectEntityStore } from "@/game/domain/entity/entityProjection";
import type { HistoryEntry } from "@/game/domain/narrativeHistory";

const root = mkdtempSync(join(tmpdir(), "ai-rpg-memory-summary-"));
let serial = 0;
const now = "2026-09-14T00:00:00.000Z";
const observerId = PLAYER_ENTITY_ID;
const policy = { threshold: 50, batchSize: 10, rawSoftEstimatedTokens: 24_000, summarySourceMaxEstimatedTokens: 24_000, overviewMaxEstimatedTokens: 6_000, promptMaxEstimatedTokens: 64_000 };

function history(count: number): HistoryEntry[] {
  return Array.from({ length: count }, (_, sequence) => ({ id: `history:${sequence}`, segmentId: "segment:0", sequence, actionId: null, jobId: null, sceneId: "scene:0", revision: 0, turnNumber: 0, kind: "narration", text: `原文 ${sequence}`, speakerId: null, audienceIds: [observerId], entityIds: [observerId], factIds: [], eventIds: [], choiceToken: null }));
}

async function fixture(count = 20) {
  const path = join(root, `${serial++}.sqlite`);
  const gameId = asGameId(`game:${serial}`);
  const generationId = asGenerationId(`generation:${serial}`);
  const game = createSqliteGameRepository({ clientFactory: () => createSqliteClient(path), logError: () => {} });
  const worldState = createWorldStateFixtureWith({ generation: { generationId, seed: "seed", templateVersion: "v1", inputDigest: "", gameType: "wuxia" }, base: emptyProjection({ player: { name: "玩家", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } }, locations: [{ id: asLocationId("loc:source"), name: "镇口", description: "镇口", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] }], currentLocationId: asLocationId("loc:source") }) });
  const jobResult = createPendingNarrativeJob({ jobId: asNarrativeJobId("job:memory"), turnId: asTurnId("turn:memory"), actionId: "action:memory", expectedRevision: 0, turnNumber: 1, actionSummary: { kind: "explore" }, resolvedEvent: { actionId: "action:memory", status: "success", eventKind: "observe", facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [] }, domainEventIds: [asEventId("turn:memory:event")], requestedAt: now, objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" }, mandatoryBeats: [], generationKind: "npc_fixed_choice", sceneRequestKind: "npc_response" });
  if (!jobResult.ok) throw new Error("invalid fixture job");
  const job = { ...jobResult.job, attempt: { ...jobResult.job.attempt, epoch: 1, status: "running" as const, leaseId: "lease:memory", leaseExpiresAt: "2026-09-14T00:10:00.000Z" } };
  const storyState = { ...createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }), history: { entries: history(count) }, narrative: { status: "provider_pending" as const, mode: "offline" as const, job, lastPresentedScene: null } };
  expect(await game.createInitialGame({ gameId, worldState, storyState, createdAt: now })).toEqual({ ok: true });
  const read = async () => { const current = await game.getCurrentGame(); if (!current.ok || current.status !== "active") throw new Error("fixture source missing"); return current.record; };
  const record = await read();
  const repo = createSqliteNarrativeMemorySummaryRepository({ clientFactory: () => createSqliteClient(path), gameRepository: game });
  const key = { gameId, generationId, observerId };
  const guard: MemoryAttemptGuard = { key: { gameId, generationId, jobId: job.jobId, epoch: 1 }, expectedRevision: record.revision, expectedNarrativeJob: { status: "provider_pending", jobId: String(job.jobId), epoch: 1, leaseId: "lease:memory", candidateVersion: 0, candidateHash: null }, now };
  const write = async (change: (record: GameRecord) => Pick<GameRecord, "worldState" | "storyState">) => { const before = await read(); expect((await game.applyState({ gameId, expectedRevision: before.revision, nextWorldState: change(before).worldState, nextStoryState: change(before).storyState, incrementRevision: false })).ok).toBe(true); };
  return { path, game, record, repo, key, guard, read, write, close: async () => { await repo.close(); await game.close(); } };
}

function state(record: GameRecord, revision: number, through: number): MemorySummaryState {
  const fp = (sequence: number) => narrativeMemorySourceFingerprint({ worldState: record.worldState, storyState: record.storyState, observerId, throughSequence: sequence });
  const entries = record.storyState.history.entries.filter((entry) => entry.sequence <= through);
  const batches = Array.from({ length: entries.length / 10 }, (_, index) => { const source = entries.slice(index * 10, index * 10 + 10); return { id: `batch:${source.at(-1)!.sequence}`, fromSequence: source[0].sequence, throughSequence: source.at(-1)!.sequence, sourceHistoryIds: source.map((entry) => entry.id), sourceFingerprint: fp(source.at(-1)!.sequence), selection: { historyIds: [source[0].id], eventIds: [] } }; });
  return { formatVersion: 1, observerId, policyVersion: "memory-p2/1", summaryRevision: revision, coveredThroughSequence: through, coveredSourceFingerprint: fp(through), batches, overview: { historyIds: batches.slice(-8).map((batch) => batch.selection.historyIds[0]), eventIds: [] } };
}

function prepared(record: GameRecord): PreparedNarrativeMemory {
  return { formatVersion: 1, policyVersion: "memory-p2/1", sourceFingerprint: preparedNarrativeMemorySourceFingerprint({ worldState: record.worldState, storyState: record.storyState, playerObserverId: observerId }), policy, summaries: "enabled", player: { observerId, coveredThroughSequence: -1, overviewHistoryIds: [], overviewEventIds: [], uncovered: record.storyState.history.entries, recalled: [], requiredEvents: [], referencedEntityIds: [observerId], ambiguousEntityIds: [], manifest: record.storyState.history.entries.map(entry => ({ ref: entry.id, reason: "uncovered_history", mandatory: true })) } };
}

describe("sqlite narrative memory source and attempt validation", () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("publishes with CAS without changing game revision, and survives reopen", async () => {
    const f = await fixture();
    expect(await f.repo.load(f.key)).toEqual({ state: null, summaryRevision: 0 });
    expect(await f.repo.publish({ key: f.key, expectedSummaryRevision: 0, next: state(f.record, 1, 9) })).toEqual({ ok: true });
    expect(await f.repo.publish({ key: f.key, expectedSummaryRevision: 0, next: state(f.record, 1, 9) })).toEqual({ ok: false, code: "STALE_SUMMARY" });
    expect(await f.read()).toEqual(f.record);
    await f.repo.close();
    expect(await f.repo.load(f.key)).toMatchObject({ summaryRevision: 1, state: { coveredThroughSequence: 9 } });
    await f.close();
  });

  it("allows appended tails and unrelated current Entity edits during publication and reads", async () => {
    const f = await fixture();
    const next = state(f.record, 1, 9);
    await f.write((before) => { const entityStore = { ...before.worldState.entityStore, records: before.worldState.entityStore.records.map((entry) => ({ ...entry, core: { ...entry.core, name: entry.core.kind === "location" ? "新镇名" : entry.core.name } } as typeof entry)) }; return { worldState: { ...before.worldState, entityStore, ...projectEntityStore(entityStore) }, storyState: { ...before.storyState, history: { entries: history(21) } } }; });
    expect(await f.repo.publish({ key: f.key, expectedSummaryRevision: 0, next })).toEqual({ ok: true });
    expect((await f.repo.load(f.key)).state).toEqual(next);
    await f.close();
  });

  it("invalidates same-sequence rewritten History and rebuilds using the old row CAS", async () => {
    const f = await fixture();
    expect(await f.repo.publish({ key: f.key, expectedSummaryRevision: 0, next: state(f.record, 1, 19) })).toEqual({ ok: true });
    await f.write((before) => ({ ...before, storyState: { ...before.storyState, history: { entries: history(10).map((entry) => entry.sequence === 0 ? { ...entry, text: "另一条分支的原文" } : entry) } } }));
    expect(await f.repo.load(f.key)).toEqual({ state: null, summaryRevision: 1 });
    expect(await f.repo.publish({ key: f.key, expectedSummaryRevision: 1, next: state(f.record, 2, 19) })).toEqual({ ok: false, code: "SOURCE_CHANGED" });
    expect(await f.repo.publish({ key: f.key, expectedSummaryRevision: 1, next: state(await f.read(), 2, 9) })).toEqual({ ok: true });
    expect(await f.repo.publish({ key: f.key, expectedSummaryRevision: 1, next: state(f.record, 2, 19) })).toEqual({ ok: false, code: "STALE_SUMMARY" });
    await f.close();
  });

  it("rejects a backwards watermark for a still-valid source", async () => {
    const f = await fixture();
    expect(await f.repo.publish({ key: f.key, expectedSummaryRevision: 0, next: state(f.record, 1, 19) })).toEqual({ ok: true });
    expect(await f.repo.publish({ key: f.key, expectedSummaryRevision: 1, next: state(f.record, 2, 9) })).toEqual({ ok: false, code: "SOURCE_CHANGED" });
    await f.close();
  });

  it("preserves a corrupt cache row revision so reconstruction can replace it", async () => {
    const f = await fixture();
    expect(await f.repo.publish({ key: f.key, expectedSummaryRevision: 0, next: state(f.record, 1, 19) })).toEqual({ ok: true });
    const raw = createSqliteClient(f.path);
    await raw.execute("UPDATE narrative_memory_summaries SET state_json = '{broken'");
    expect(await f.repo.load(f.key)).toEqual({ state: null, summaryRevision: 1 });
    expect(await f.repo.publish({ key: f.key, expectedSummaryRevision: 1, next: state(f.record, 2, 9) })).toEqual({ ok: true });
    raw.close(); await f.close();
  });

  it("rejects unknown observers, cross-observer rows and invented covered watermarks", async () => {
    const f = await fixture();
    expect(await f.repo.publish({ key: f.key, expectedSummaryRevision: 0, next: { ...state(f.record, 1, 9), observerId: asLocationId("loc:source") } })).toEqual({ ok: false, code: "SOURCE_CHANGED" });
    expect(await f.repo.publish({ key: f.key, expectedSummaryRevision: 0, next: { ...state(f.record, 1, 19), coveredThroughSequence: 999 } })).toEqual({ ok: false, code: "SOURCE_CHANGED" });
    await f.close();
  });

  it("retains HTTP and batch budgets across process restart, and freezes one immutable packet", async () => {
    const f = await fixture();
    for (let index = 0; index < 4; index += 1) expect(await f.repo.reserveHttpAttempt!(f.guard)).toEqual({ ok: true });
    await f.repo.close();
    for (let index = 0; index < 4; index += 1) expect(await f.repo.reserveHttpAttempt!(f.guard)).toEqual({ ok: true });
    expect(await f.repo.reserveHttpAttempt!(f.guard)).toEqual({ ok: false, code: "BUDGET_EXHAUSTED" });
    for (let index = 0; index < 2; index += 1) expect(await f.repo.reserveBatchUpdate!(f.guard)).toEqual({ ok: true });
    expect(await f.repo.reserveBatchUpdate!(f.guard)).toEqual({ ok: false, code: "BUDGET_EXHAUSTED" });
    const packet = prepared(f.record);
    expect(await f.repo.freezePrepared!({ ...f.guard, next: packet })).toMatchObject({ ok: true, prepared: packet });
    expect(await f.repo.freezePrepared!({ ...f.guard, next: { ...packet, summaries: "disabled" } })).toMatchObject({ ok: true, prepared: packet });
    expect(await f.repo.loadPrepared!(f.guard.key)).toMatchObject({ ok: true, prepared: packet });
    expect(await f.repo.reserveHttpAttempt!(f.guard)).toEqual({ ok: false, code: "STALE_ATTEMPT" });
    await f.close();
  });

  it("rejects freeze against a changed source and invalidates a previously frozen same-epoch packet", async () => {
    const f = await fixture();
    const packet = prepared(f.record);
    expect(await f.repo.freezePrepared!({ ...f.guard, next: packet })).toMatchObject({ ok: true });
    await f.write((before) => ({ ...before, storyState: { ...before.storyState, history: { entries: history(20).map((entry) => entry.sequence === 0 ? { ...entry, text: "变更后的原文" } : entry) } } }));
    expect(await f.repo.loadPrepared!(f.guard.key)).toEqual({ ok: false, code: "MEMORY_PREPARATION_INVALID" });
    expect(await f.repo.freezePrepared!({ ...f.guard, next: packet })).toEqual({ ok: false, code: "MEMORY_PREPARATION_INVALID" });
    expect(await f.repo.freezePrepared!({ ...f.guard, next: prepared(await f.read()) })).toEqual({ ok: false, code: "MEMORY_PREPARATION_INVALID" });
    await f.close();
  });

  it("validates packet schema and actual observer records even when the stored hash is correct", async () => {
    const f = await fixture();
    const packet = prepared(f.record);
    expect(await f.repo.freezePrepared!({ ...f.guard, next: { ...packet, player: { ...packet.player, uncovered: [] } } })).toEqual({ ok: false, code: "MEMORY_PREPARATION_INVALID" });
    expect(await f.repo.freezePrepared!({ ...f.guard, next: packet })).toMatchObject({ ok: true });
    const invalid = { ...packet, player: { ...packet.player, uncovered: [{ ...packet.player.uncovered[0], text: "伪造内容" }] } };
    const json = JSON.stringify(invalid);
    const raw = createSqliteClient(f.path);
    await raw.execute({ sql: "UPDATE narrative_memory_attempts SET prepared_json = ?, prepared_hash = ?", args: [json, createHash("sha256").update(json).digest("hex")] });
    expect(await f.repo.loadPrepared!(f.guard.key)).toEqual({ ok: false, code: "MEMORY_PREPARATION_INVALID" });
    raw.close(); await f.close();
  });

  it("fences stale workers, mismatched key predicates, nonpending jobs and expired leases without reserving a request", async () => {
    const f = await fixture();
    const invalid = [
      { ...f.guard, key: { ...f.guard.key, generationId: asGenerationId("other:generation") } },
      { ...f.guard, key: { ...f.guard.key, epoch: 2 } },
      { ...f.guard, key: { ...f.guard.key, jobId: asNarrativeJobId("other:job") } },
      { ...f.guard, expectedNarrativeJob: { ...f.guard.expectedNarrativeJob, leaseId: "" } },
      { ...f.guard, expectedNarrativeJob: { ...f.guard.expectedNarrativeJob, status: "provider_failed" as const } },
      { ...f.guard, now: "2026-09-14T00:10:00.000Z" },
    ];
    for (const guard of invalid) expect(await f.repo.reserveHttpAttempt!(guard)).toEqual({ ok: false, code: "STALE_ATTEMPT" });
    await f.write((before) => { const narrative = before.storyState.narrative; if (narrative.status !== "provider_pending") throw new Error("not pending"); return { ...before, storyState: { ...before.storyState, narrative: { ...narrative, job: { ...narrative.job, attempt: { ...narrative.job.attempt, leaseId: "lease:new-worker" } } } } }; });
    expect(await f.repo.reserveHttpAttempt!(f.guard)).toEqual({ ok: false, code: "STALE_ATTEMPT" });
    const newGuard = { ...f.guard, expectedNarrativeJob: { ...f.guard.expectedNarrativeJob, leaseId: "lease:new-worker" } };
    expect(await f.repo.reserveHttpAttempt!(newGuard)).toEqual({ ok: true });
    await f.close();
  });

  it("hashes explicitly referenced Events independently of their sequence, and excludes unrelated Events", async () => {
    const f = await fixture();
    const event: CommittedNarrativeEvent = { eventId: asEventId("turn:source-event"), sequence: 100, turnId: asTurnId("turn:source"), turnNumber: 0, episodeId: asEpisodeId("episode:source"), kind: "location_observed", actorIds: [observerId], targetIds: [], locationId: asLocationId("loc:source"), causeEventIds: [], factIds: [], questIds: [], outcome: "neutral", salience: 10, committedAt: now, payload: { type: "location_observed", locationId: asLocationId("loc:source") } };
    const source = { worldState: { ...f.record.worldState, eventLedger: [event] }, storyState: { ...f.record.storyState, history: { entries: history(20).map((entry) => entry.sequence === 0 ? { ...entry, eventIds: [event.eventId] } : entry) } }, observerId, throughSequence: 9 };
    const hash = narrativeMemorySourceFingerprint(source);
    expect(narrativeMemorySourceFingerprint({ ...source, worldState: { ...source.worldState, eventLedger: [{ ...event, salience: 20 }] } })).not.toBe(hash);
    expect(narrativeMemorySourceFingerprint({ ...source, worldState: { ...source.worldState, eventLedger: [event, { ...event, sequence: 0, eventId: asEventId("unrelated:event") }] } })).toBe(hash);
    expect(narrativeMemorySourceFingerprint({ ...source, storyState: { ...source.storyState, history: { entries: source.storyState.history.entries.map((entry) => entry.sequence === 0 ? { ...entry, audienceIds: [] } : entry) } } })).not.toBe(hash);
    await f.close();
  });

  it("reuses the fixed package after lease takeover without treating durable attempt counters as source changes", async () => {
    const f = await fixture();
    const packet = prepared(f.record);
    expect(await f.repo.freezePrepared!({ ...f.guard, next: packet })).toMatchObject({ ok: true });
    await f.write((before) => { const narrative = before.storyState.narrative; if (narrative.status !== "provider_pending") throw new Error("not pending"); return { ...before, storyState: { ...before.storyState, narrative: { ...narrative, job: { ...narrative.job, attempt: { ...narrative.job.attempt, leaseId: "lease:replacement", httpAttempts: 2, candidateVersion: 1 } } } } }; });
    expect(await f.repo.loadPrepared!(f.guard.key)).toMatchObject({ ok: true, prepared: packet });
    expect(await f.repo.freezePrepared!({ ...f.guard, next: packet })).toEqual({ ok: false, code: "STALE_ATTEMPT" });
    await f.close();
  });
});
