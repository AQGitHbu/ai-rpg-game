import { createHash } from "node:crypto";
import type { MemorySummaryState } from "@/game/domain/narrativeMemorySummary";
import { parseMemorySummaryState } from "@/game/domain/narrativeMemorySummary";
import type {
  MemoryAttemptGuard,
  MemorySummaryKey,
  NarrativeMemorySummaryRepository,
  PreparedNarrativeMemory,
} from "@/game/application/narrativeMemorySummaryRepository";
import type { GameRepository } from "./gameRepository";
import { parsePersistableStoryState } from "./storyStatePersistenceValidation";
import { validatePersistableWorldState } from "./worldStatePersistenceValidation";
import type { SqliteClient, SqliteClientFactory, SqliteTransaction } from "./sqliteClient";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { NarrativeMemoryContext } from "@/game/domain/narrativeMemoryContext";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { projectObserverEvidence } from "@/game/gameplay/rpg/narrativeMemory";
import { canonicalMemoryJson, narrativeMemorySourceFingerprint, preparedNarrativeMemorySourceFingerprint } from "@/game/application/narrativeMemorySourceFingerprint";
import { selectNpcDeliberationTarget } from "@/game/application/prepareNpcNarrativeContext";

const POLICY_VERSION = "memory-p2/1";

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS narrative_memory_summaries (
  game_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  observer_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  summary_revision INTEGER NOT NULL,
  covered_through_sequence INTEGER NOT NULL,
  source_fingerprint TEXT NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (game_id, generation_id, observer_id, policy_version)
)`;

const ATTEMPT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS narrative_memory_attempts (
  game_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  expected_revision INTEGER NOT NULL,
  expected_narrative_job_json TEXT NOT NULL,
  http_attempts INTEGER NOT NULL DEFAULT 0,
  batch_updates INTEGER NOT NULL DEFAULT 0,
  prepared_json TEXT,
  prepared_hash TEXT,
  PRIMARY KEY (game_id, generation_id, job_id, epoch)
)`;

function keyArgs(key: MemorySummaryKey): readonly string[] {
  return [String(key.gameId), String(key.generationId), String(key.observerId), POLICY_VERSION];
}

function attemptArgs(key: MemoryAttemptGuard["key"]): readonly string[] {
  return [String(key.gameId), String(key.generationId), String(key.jobId), key.epoch.toString()];
}

function parseState(value: unknown): MemorySummaryState | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = parseMemorySummaryState(JSON.parse(value));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function uniqueStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "") && new Set(value).size === value.length;
}

function isContext(value: unknown): value is NarrativeMemoryContext {
  if (!record(value) || !exactKeys(value, ["observerId", "coveredThroughSequence", "overviewHistoryIds", "overviewEventIds", "uncovered", "recalled", "requiredEvents", "referencedEntityIds", "ambiguousEntityIds", "manifest"], ["overviewEvents"])) return false;
  return typeof value.observerId === "string" && value.observerId.trim() !== ""
    && typeof value.coveredThroughSequence === "number" && Number.isInteger(value.coveredThroughSequence) && value.coveredThroughSequence >= -1
    && [value.overviewHistoryIds, value.overviewEventIds, value.referencedEntityIds, value.ambiguousEntityIds].every(uniqueStrings)
    && [value.uncovered, value.recalled, value.requiredEvents, value.overviewEvents ?? []].every((entries) => Array.isArray(entries) && entries.every(record))
    && Array.isArray(value.manifest) && value.manifest.every((entry) => record(entry) && exactKeys(entry, ["ref", "reason", "mandatory"])
      && typeof entry.ref === "string" && typeof entry.reason === "string" && entry.reason.trim() !== "" && typeof entry.mandatory === "boolean");
}

function isPrepared(value: unknown): value is PreparedNarrativeMemory {
  if (!record(value) || !exactKeys(value, ["formatVersion", "policyVersion", "sourceFingerprint", "policy", "summaries", "player"], ["npc"])) return false;
  const policy = value.policy;
  return value.formatVersion === 1 && value.policyVersion === POLICY_VERSION
    && typeof value.sourceFingerprint === "string" && /^[a-f0-9]{64}$/.test(value.sourceFingerprint)
    && (value.summaries === "enabled" || value.summaries === "disabled")
    && record(policy) && exactKeys(policy, ["threshold", "batchSize", "rawSoftEstimatedTokens", "summarySourceMaxEstimatedTokens", "overviewMaxEstimatedTokens", "promptMaxEstimatedTokens"])
    && Object.values(policy).every((number) => typeof number === "number" && Number.isSafeInteger(number) && number > 0)
    && isContext(value.player) && (value.npc === undefined || isContext(value.npc));
}

function parsePrepared(value: unknown): PreparedNarrativeMemory | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isPrepared(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function preparedHash(value: PreparedNarrativeMemory): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type CurrentSource = Readonly<{ worldState: WorldState; storyState: StoryState }>;

async function currentSource(
  tx: SqliteTransaction,
  key: Pick<MemorySummaryKey, "gameId" | "generationId">,
): Promise<CurrentSource | null> {
  const result = await tx.execute({
    sql: `SELECT g.world_state_json, g.story_state_json
          FROM current_game c JOIN game_records g ON g.game_id = c.game_id
          WHERE c.slot = 1 AND g.game_id = ?`,
    args: [String(key.gameId)],
  });
  const row = result.rows[0];
  if (row === undefined || typeof row.world_state_json !== "string" || typeof row.story_state_json !== "string") return null;
  let rawWorld: unknown;
  let rawStory: unknown;
  try {
    rawWorld = JSON.parse(row.world_state_json);
    rawStory = JSON.parse(row.story_state_json);
  } catch {
    return null;
  }
  const world = validatePersistableWorldState(rawWorld);
  if (!world.ok) return null;
  if (String(world.value.generation.generationId) !== String(key.generationId)) return null;
  const story = parsePersistableStoryState(rawStory, world.value.eventLedger, world.value.entityStore);
  if (!story.ok) return null;
  return { worldState: world.value, storyState: story.value };
}

function validSummary(state: MemorySummaryState, key: MemorySummaryKey, source: CurrentSource): boolean {
  if (state.observerId !== key.observerId || !source.worldState.entityStore.records.some((entry) => entry.core.id === key.observerId && (entry.core.kind === "npc" || entry.core.kind === "player_character"))) return false;
  const evidence = projectObserverEvidence({ ...source, observerId: key.observerId });
  const prefix = evidence.history.filter((entry) => entry.sequence <= state.coveredThroughSequence);
  if (state.coveredThroughSequence !== -1 && prefix.at(-1)?.sequence !== state.coveredThroughSequence) return false;
  if (state.coveredSourceFingerprint !== narrativeMemorySourceFingerprint({ ...source, observerId: key.observerId, throughSequence: state.coveredThroughSequence })) return false;
  const coveredIds: string[] = [];
  const leafHistory = new Set<string>();
  const leafEvents = new Set<string>();
  for (const batch of state.batches) {
    const history = prefix.filter((entry) => entry.sequence >= batch.fromSequence && entry.sequence <= batch.throughSequence);
    if (history.length !== 10 || history[0]?.sequence !== batch.fromSequence || history.at(-1)?.sequence !== batch.throughSequence
      || canonicalMemoryJson(history.map((entry) => entry.id)) !== canonicalMemoryJson(batch.sourceHistoryIds)
      || batch.sourceFingerprint !== narrativeMemorySourceFingerprint({ ...source, observerId: key.observerId, throughSequence: batch.throughSequence })) return false;
    const eventIds = new Set(history.flatMap((entry) => entry.eventIds.map(String)));
    const visibleEventIds = new Set(evidence.events.filter((entry) => eventIds.has(String(entry.eventId))).map((entry) => String(entry.eventId)));
    if (batch.selection.eventIds.some((id) => !visibleEventIds.has(String(id)))) return false;
    coveredIds.push(...batch.sourceHistoryIds);
    batch.selection.historyIds.forEach((id) => leafHistory.add(id));
    batch.selection.eventIds.forEach((id) => leafEvents.add(String(id)));
  }
  return canonicalMemoryJson(coveredIds) === canonicalMemoryJson(prefix.map((entry) => entry.id))
    && state.overview.historyIds.length <= 8 && state.overview.eventIds.length <= 8
    && (prefix.length === 0 || state.overview.historyIds.length + state.overview.eventIds.length > 0)
    && state.overview.historyIds.every((id) => leafHistory.has(id)) && state.overview.eventIds.every((id) => leafEvents.has(String(id)));
}

function validContext(context: NarrativeMemoryContext, source: CurrentSource): boolean {
  const evidence = projectObserverEvidence({ ...source, observerId: context.observerId });
  const history = new Map(evidence.history.map((entry) => [entry.id, entry]));
  const events = new Map(evidence.events.map((entry) => [String(entry.eventId), entry]));
  const sourceEqual = (left: unknown, right: unknown) => right !== undefined && canonicalMemoryJson(left) === canonicalMemoryJson(right);
  const allHistory = [...context.uncovered, ...context.recalled];
  const overviewEvents = context.overviewEvents ?? [];
  if (new Set(allHistory.map((entry) => entry.id)).size !== allHistory.length || allHistory.some((entry) => !sourceEqual(entry, history.get(entry.id)))) return false;
  if (!sourceEqual(context.uncovered, evidence.history.filter((entry) => entry.sequence > context.coveredThroughSequence))) return false;
  if (context.recalled.some((entry) => entry.sequence > context.coveredThroughSequence)
    || context.coveredThroughSequence >= 0 && !evidence.history.some((entry) => entry.sequence === context.coveredThroughSequence)) return false;
  if (context.overviewHistoryIds.some((id) => !context.recalled.some((entry) => entry.id === id))
    || context.overviewEventIds.some((id) => !events.has(String(id)))) return false;
  for (const selected of [context.requiredEvents, overviewEvents]) {
    if (new Set(selected.map((entry) => entry.eventId)).size !== selected.length || selected.some((entry) => !sourceEqual(entry, events.get(String(entry.eventId))))) return false;
  }
  if (context.overviewEventIds.some((id) => ![...overviewEvents, ...context.requiredEvents].some((entry) => entry.eventId === id))) return false;
  if (overviewEvents.some((event) => !context.overviewEventIds.includes(event.eventId))) return false;
  if (context.coveredThroughSequence >= 0 && context.overviewHistoryIds.length + context.overviewEventIds.length === 0) return false;
  const known = new Set(evidence.knownEntityIds.map(String));
  if ([...context.referencedEntityIds, ...context.ambiguousEntityIds].some((id) => !known.has(String(id)))) return false;
  const referenced = new Set([
    ...allHistory.flatMap((entry) => [...entry.entityIds, ...(entry.speakerId === null ? [] : [entry.speakerId])].map(String)),
    ...[...context.requiredEvents, ...overviewEvents].flatMap((event) => [...event.actorIds, ...event.targetIds, ...(event.locationId === null ? [] : [event.locationId])].map(String)),
  ].filter((id) => known.has(id)));
  if (referenced.size !== context.referencedEntityIds.length || context.referencedEntityIds.some((id) => !referenced.has(String(id)))) return false;
  const used = new Set([...allHistory.map((entry) => entry.id), ...allHistory.flatMap((entry) => entry.eventIds.map(String)), ...context.requiredEvents.map((entry) => String(entry.eventId)), ...context.overviewEventIds.map(String)]);
  const mandatory = new Set(context.manifest.filter((entry) => entry.mandatory).map((entry) => entry.ref));
  if ([...context.uncovered.map((entry) => entry.id), ...context.overviewHistoryIds, ...context.overviewEventIds.map(String), ...context.requiredEvents.map((entry) => String(entry.eventId))].some((ref) => !mandatory.has(ref))) return false;
  const narrative = source.storyState.narrative;
  if (narrative.status === "provider_pending" && narrative.job.domainEventIds.some((id) => events.has(String(id)) && !context.requiredEvents.some((event) => event.eventId === id))) return false;
  return new Set(context.manifest.map((entry) => entry.ref)).size === context.manifest.length
    && context.manifest.every((entry) => used.has(entry.ref) && (history.has(entry.ref) || events.has(entry.ref)));
}

function validPrepared(prepared: PreparedNarrativeMemory, key: MemoryAttemptGuard["key"], source: CurrentSource): boolean {
  const narrative = source.storyState.narrative;
  if (narrative.status !== "provider_pending" || narrative.job.jobId !== key.jobId || narrative.job.attempt.epoch !== key.epoch) return false;
  const expectedNpcId = selectNpcDeliberationTarget({ kind: "decision", ...source, job: narrative.job });
  if (prepared.npc?.observerId !== expectedNpcId) return false;
  if (prepared.player.observerId !== PLAYER_ENTITY_ID || !validContext(prepared.player, source)) return false;
  if (prepared.npc !== undefined && (!source.worldState.entityStore.records.some((entry) => entry.core.id === prepared.npc!.observerId && entry.core.kind === "npc") || !validContext(prepared.npc, source))) return false;
  return prepared.sourceFingerprint === preparedNarrativeMemorySourceFingerprint({ ...source, playerObserverId: prepared.player.observerId, ...(prepared.npc === undefined ? {} : { npcObserverId: prepared.npc.observerId }) });
}

export function createSqliteNarrativeMemorySummaryRepository(options: Readonly<{
  readonly clientFactory: SqliteClientFactory;
  readonly gameRepository?: GameRepository;
}>): NarrativeMemorySummaryRepository & { initializeSchema(): Promise<void>; close(): Promise<void> } {
  let client: SqliteClient | null = null;
  let ready = false;
  function getClient(): SqliteClient {
    if (client === null) client = options.clientFactory();
    return client;
  }
  async function initializeSchema(): Promise<void> {
    if (ready) return;
    await getClient().batch([TABLE_SQL, ATTEMPT_TABLE_SQL]);
    ready = true;
  }
  async function guardMatchesTransaction(tx: SqliteTransaction, input: MemoryAttemptGuard): Promise<boolean> {
    const result = await tx.execute({
      sql: `SELECT g.revision,
                   json_extract(g.world_state_json, '$.generation.generationId') AS generation_id,
                   json_extract(g.story_state_json, '$.narrative.status') AS narrative_status,
                   json_extract(g.story_state_json, '$.narrative.job.jobId') AS job_id,
                   json_extract(g.story_state_json, '$.narrative.job.attempt.epoch') AS attempt_epoch,
                   json_extract(g.story_state_json, '$.narrative.job.attempt.leaseId') AS lease_id,
                   json_extract(g.story_state_json, '$.narrative.job.attempt.candidateVersion') AS candidate_version,
                   json_extract(g.story_state_json, '$.narrative.job.attempt.candidateHash') AS candidate_hash,
                   json_extract(g.story_state_json, '$.narrative.job.attempt.leaseExpiresAt') AS lease_expires_at
            FROM current_game c JOIN game_records g ON g.game_id = c.game_id
            WHERE c.slot = 1 AND g.game_id = ?`,
      args: [String(input.key.gameId)],
    });
    const row = result.rows[0];
    if (row === undefined) return false;
    const expected = input.expectedNarrativeJob;
    const now = Date.parse(input.now);
    const leaseExpiresAt = typeof row.lease_expires_at === "string" ? Date.parse(row.lease_expires_at) : Number.NaN;
    return Number(row.revision) === input.expectedRevision
      && row.generation_id === input.key.generationId
      && expected.status === "provider_pending" && row.narrative_status === "provider_pending"
      && expected.jobId === input.key.jobId && String(row.job_id) === input.key.jobId
      && expected.epoch === input.key.epoch && Number(row.attempt_epoch) === input.key.epoch
      && typeof expected.leaseId === "string" && expected.leaseId.trim() !== ""
      && (row.lease_id === null ? null : String(row.lease_id)) === expected.leaseId
      && Number(row.candidate_version) === expected.candidateVersion
      && (row.candidate_hash === null ? null : String(row.candidate_hash)) === expected.candidateHash
      && !Number.isNaN(now)
      && !Number.isNaN(leaseExpiresAt)
      && leaseExpiresAt > now;
  }
  async function reserveAttempt(input: MemoryAttemptGuard, column: "batch_updates" | "http_attempts", limit: number) {
    try {
      await initializeSchema();
      const tx = await getClient().transaction("write");
      try {
        if (!(await guardMatchesTransaction(tx, input))) {
          await tx.rollback();
          return { ok: false as const, code: "STALE_ATTEMPT" as const };
        }
        const args = attemptArgs(input.key);
        const current = await tx.execute({ sql: `SELECT ${column}, prepared_json FROM narrative_memory_attempts WHERE game_id = ? AND generation_id = ? AND job_id = ? AND epoch = ?`, args });
        const row = current.rows[0];
        if (row !== undefined && row.prepared_json !== null) { await tx.rollback(); return { ok: false as const, code: "STALE_ATTEMPT" as const }; }
        const count = row === undefined ? 0 : Number(row[column] ?? 0);
        if (!Number.isInteger(count) || count >= limit) { await tx.rollback(); return { ok: false as const, code: "BUDGET_EXHAUSTED" as const }; }
        const result = row === undefined
          ? await tx.execute({ sql: `INSERT INTO narrative_memory_attempts (game_id, generation_id, job_id, epoch, expected_revision, expected_narrative_job_json, ${column}) VALUES (?, ?, ?, ?, ?, ?, 1)`, args: [...args, input.expectedRevision, JSON.stringify(input.expectedNarrativeJob)] })
          : await tx.execute({ sql: `UPDATE narrative_memory_attempts SET ${column} = ${column} + 1 WHERE game_id = ? AND generation_id = ? AND job_id = ? AND epoch = ? AND ${column} = ? AND prepared_json IS NULL`, args: [...args, count] });
        if (result.rowsAffected !== 1) { await tx.rollback(); return { ok: false as const, code: "STALE_ATTEMPT" as const }; }
        await tx.commit();
        return { ok: true as const };
      } finally { tx.close(); }
    } catch {
      return { ok: false as const, code: "UNAVAILABLE" as const };
    }
  }
  return {
    async initializeSchema() { await initializeSchema(); },
    async load(key) {
      try {
        await initializeSchema();
        const tx = await getClient().transaction("read");
        try {
          const result = await tx.execute({ sql: `SELECT summary_revision, state_json FROM narrative_memory_summaries WHERE game_id = ? AND generation_id = ? AND observer_id = ? AND policy_version = ?`, args: keyArgs(key) });
          const row = result.rows[0];
          const summaryRevision = row === undefined ? 0 : Number(row.summary_revision ?? 0);
          const state = parseState(row?.state_json);
          const source = state === null ? null : await currentSource(tx, key);
          const valid = state !== null && state.summaryRevision === summaryRevision && source !== null && validSummary(state, key, source);
          await tx.commit();
          return { state: valid ? state : null, summaryRevision };
        } finally { tx.close(); }
      } catch {
        return { state: null, summaryRevision: 0 };
      }
    },
    async publish(input) {
      try {
        await initializeSchema();
        const parsed = parseMemorySummaryState(input.next);
        if (!parsed.ok) return { ok: false, code: "UNAVAILABLE" };
        const tx = await getClient().transaction("write");
        try {
          const args = keyArgs(input.key);
          const current = await tx.execute({ sql: `SELECT summary_revision, covered_through_sequence, source_fingerprint, state_json FROM narrative_memory_summaries WHERE game_id = ? AND generation_id = ? AND observer_id = ? AND policy_version = ?`, args });
          const row = current.rows[0];
          const currentRevision = row === undefined ? 0 : Number(row.summary_revision ?? 0);
          if (currentRevision !== input.expectedSummaryRevision || input.next.summaryRevision !== currentRevision + 1) {
            await tx.rollback();
            return { ok: false, code: "STALE_SUMMARY" };
          }
          const source = await currentSource(tx, input.key);
          if (source === null || !validSummary(parsed.value, input.key, source)) {
            await tx.rollback();
            return { ok: false, code: "SOURCE_CHANGED" };
          }
          const oldState = parseState(row?.state_json);
          // An invalid derived cache may be replaced at a lower watermark,
          // while its row revision still fences every late writer.
          if (oldState !== null && oldState.summaryRevision === currentRevision && validSummary(oldState, input.key, source)
            && oldState.coveredThroughSequence > input.next.coveredThroughSequence) {
            await tx.rollback();
            return { ok: false, code: "SOURCE_CHANGED" };
          }
          const stateJson = JSON.stringify(input.next);
          const result = row === undefined
            ? await tx.execute({ sql: `INSERT INTO narrative_memory_summaries (game_id, generation_id, observer_id, policy_version, format_version, summary_revision, covered_through_sequence, source_fingerprint, state_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: [...args, 1, input.next.summaryRevision, input.next.coveredThroughSequence, input.next.coveredSourceFingerprint, stateJson] })
            : await tx.execute({ sql: `UPDATE narrative_memory_summaries SET format_version = ?, summary_revision = ?, covered_through_sequence = ?, source_fingerprint = ?, state_json = ? WHERE game_id = ? AND generation_id = ? AND observer_id = ? AND policy_version = ? AND summary_revision = ?`, args: [1, input.next.summaryRevision, input.next.coveredThroughSequence, input.next.coveredSourceFingerprint, stateJson, ...args, currentRevision] });
          if (result.rowsAffected !== 1) {
            await tx.rollback();
            return { ok: false, code: "STALE_SUMMARY" };
          }
          await tx.commit();
          return { ok: true };
        } finally { tx.close(); }
      } catch {
        return { ok: false, code: "UNAVAILABLE" };
      }
    },
    async loadPrepared(key) {
      try {
        await initializeSchema();
        const tx = await getClient().transaction("read");
        try {
          const result = await tx.execute({ sql: `SELECT prepared_json, prepared_hash FROM narrative_memory_attempts WHERE game_id = ? AND generation_id = ? AND job_id = ? AND epoch = ?`, args: attemptArgs(key) });
          const row = result.rows[0];
          if (row === undefined || row.prepared_json === null) { await tx.commit(); return { ok: true, prepared: null, preparedHash: null }; }
          const prepared = parsePrepared(row.prepared_json);
          const hash = typeof row.prepared_hash === "string" ? row.prepared_hash : null;
          const source = await currentSource(tx, key);
          const valid = prepared !== null && hash !== null && preparedHash(prepared) === hash && source !== null && validPrepared(prepared, key, source);
          await tx.commit();
          return valid ? { ok: true, prepared, preparedHash: hash } : { ok: false, code: "MEMORY_PREPARATION_INVALID" };
        } finally { tx.close(); }
      } catch {
        return { ok: false, code: "UNAVAILABLE" };
      }
    },
    async freezePrepared(input) {
      if (!isPrepared(input.next)) return { ok: false, code: "MEMORY_PREPARATION_INVALID" };
      try {
        await initializeSchema();
        const tx = await getClient().transaction("write");
        try {
          if (!(await guardMatchesTransaction(tx, input))) {
            await tx.rollback();
            return { ok: false, code: "STALE_ATTEMPT" };
          }
          const source = await currentSource(tx, input.key);
          if (source === null || !validPrepared(input.next, input.key, source)) {
            await tx.rollback();
            return { ok: false, code: "MEMORY_PREPARATION_INVALID" };
          }
          const args = attemptArgs(input.key);
          const current = await tx.execute({ sql: `SELECT prepared_json, prepared_hash FROM narrative_memory_attempts WHERE game_id = ? AND generation_id = ? AND job_id = ? AND epoch = ?`, args });
          const row = current.rows[0];
          if (row !== undefined && row.prepared_json !== null) {
            const existing = parsePrepared(row.prepared_json);
            const existingHash = typeof row.prepared_hash === "string" ? row.prepared_hash : null;
            if (existing === null || existingHash === null || preparedHash(existing) !== existingHash || !validPrepared(existing, input.key, source)) { await tx.rollback(); return { ok: false, code: "MEMORY_PREPARATION_INVALID" }; }
            await tx.commit();
            return { ok: true, prepared: existing, preparedHash: existingHash };
          }
          const nextJson = JSON.stringify(input.next);
          const hash = preparedHash(input.next);
          const result = row === undefined
            ? await tx.execute({ sql: `INSERT INTO narrative_memory_attempts (game_id, generation_id, job_id, epoch, expected_revision, expected_narrative_job_json, prepared_json, prepared_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: [...args, input.expectedRevision, JSON.stringify(input.expectedNarrativeJob), nextJson, hash] })
            : await tx.execute({ sql: `UPDATE narrative_memory_attempts SET expected_revision = ?, expected_narrative_job_json = ?, prepared_json = ?, prepared_hash = ? WHERE game_id = ? AND generation_id = ? AND job_id = ? AND epoch = ? AND prepared_json IS NULL`, args: [input.expectedRevision, JSON.stringify(input.expectedNarrativeJob), nextJson, hash, ...args] });
          if (result.rowsAffected !== 1) { await tx.rollback(); return { ok: false, code: "STALE_ATTEMPT" }; }
          await tx.commit();
          return { ok: true, prepared: input.next, preparedHash: hash };
        } finally { tx.close(); }
      } catch {
        return { ok: false, code: "UNAVAILABLE" };
      }
    },
    async reserveBatchUpdate(input) { return reserveAttempt(input, "batch_updates", 2); },
    async reserveHttpAttempt(input) { return reserveAttempt(input, "http_attempts", 8); },
    async close() {
      client?.close();
      client = null;
      ready = false;
    },
  };
}
