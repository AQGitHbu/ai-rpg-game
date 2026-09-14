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
import type { SqliteClient, SqliteClientFactory } from "./sqliteClient";

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

function isPrepared(value: unknown): value is PreparedNarrativeMemory {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const policy = candidate.policy;
  return candidate.formatVersion === 1
    && candidate.policyVersion === POLICY_VERSION
    && typeof candidate.sourceFingerprint === "string"
    && (candidate.summaries === "enabled" || candidate.summaries === "disabled")
    && typeof policy === "object" && policy !== null && !Array.isArray(policy)
    && candidate.player !== undefined;
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
  async function guardIsCurrent(input: MemoryAttemptGuard): Promise<boolean> {
    if (options.gameRepository === undefined) return true;
    const current = await options.gameRepository.getCurrentGame();
    if (!current.ok || current.status !== "active") return false;
    const narrative = current.record.storyState.narrative;
    if (current.record.gameId !== input.key.gameId || current.record.revision !== input.expectedRevision
      || narrative.status !== "provider_pending") return false;
    const attempt = narrative.job.attempt;
    const expected = input.expectedNarrativeJob;
    const now = Date.parse(input.now);
    return String(narrative.job.jobId) === expected.jobId
      && attempt.epoch === expected.epoch
      && attempt.leaseId === expected.leaseId
      && attempt.candidateVersion === expected.candidateVersion
      && attempt.candidateHash === expected.candidateHash
      && attempt.leaseExpiresAt !== null
      && !Number.isNaN(now)
      && Date.parse(attempt.leaseExpiresAt) > now;
  }
  async function reserveAttempt(input: MemoryAttemptGuard, column: "batch_updates" | "http_attempts", limit: number) {
    if (!(await guardIsCurrent(input))) return { ok: false as const, code: "STALE_ATTEMPT" as const };
    try {
      await initializeSchema();
      const tx = await getClient().transaction("write");
      try {
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
        const result = await getClient().execute({ sql: `SELECT summary_revision, state_json FROM narrative_memory_summaries WHERE game_id = ? AND generation_id = ? AND observer_id = ? AND policy_version = ?`, args: keyArgs(key) });
        const row = result.rows[0];
        if (row === undefined) return { state: null, summaryRevision: 0 };
        const summaryRevision = typeof row.summary_revision === "number" ? row.summary_revision : Number(row.summary_revision ?? 0);
        const state = parseState(row.state_json);
        return { state: state !== null && state.summaryRevision === summaryRevision ? state : null, summaryRevision };
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
          if (row !== undefined && Number(row.covered_through_sequence) === input.next.coveredThroughSequence
            && String(row.source_fingerprint) !== input.next.coveredSourceFingerprint) {
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
        const result = await getClient().execute({ sql: `SELECT prepared_json, prepared_hash FROM narrative_memory_attempts WHERE game_id = ? AND generation_id = ? AND job_id = ? AND epoch = ?`, args: attemptArgs(key) });
        const row = result.rows[0];
        if (row === undefined || row.prepared_json === null) return { ok: true, prepared: null, preparedHash: null };
        const prepared = parsePrepared(row.prepared_json);
        const hash = typeof row.prepared_hash === "string" ? row.prepared_hash : null;
        if (prepared === null || hash === null || preparedHash(prepared) !== hash) return { ok: false, code: "MEMORY_PREPARATION_INVALID" };
        return { ok: true, prepared, preparedHash: hash };
      } catch {
        return { ok: false, code: "UNAVAILABLE" };
      }
    },
    async freezePrepared(input) {
      if (!isPrepared(input.next)) return { ok: false, code: "MEMORY_PREPARATION_INVALID" };
      if (!(await guardIsCurrent(input))) return { ok: false, code: "STALE_ATTEMPT" };
      try {
        await initializeSchema();
        const tx = await getClient().transaction("write");
        try {
          const args = attemptArgs(input.key);
          const current = await tx.execute({ sql: `SELECT prepared_json, prepared_hash FROM narrative_memory_attempts WHERE game_id = ? AND generation_id = ? AND job_id = ? AND epoch = ?`, args });
          const row = current.rows[0];
          if (row !== undefined && row.prepared_json !== null) {
            const existing = parsePrepared(row.prepared_json);
            const existingHash = typeof row.prepared_hash === "string" ? row.prepared_hash : null;
            if (existing === null || existingHash === null || preparedHash(existing) !== existingHash) { await tx.rollback(); return { ok: false, code: "MEMORY_PREPARATION_INVALID" }; }
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
