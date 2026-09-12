import { isStoredPlanningDialogueReviews } from "../../narrativeGeneration/planningDialogueReview";
import { isStoredPlanningSemanticRepair } from "../../narrativeGeneration/planningSemanticRepair";
import { isStoredDialogueReview, validateJobDialogueConsistencyReview } from "../../narrativeGeneration/dialogueConsistencyReview";
import { approvePlanningContext } from "../../narrativeGeneration/approvePlanningContext";
import type {
  ApplyStateInput,
  CreateInitialGameInput,
  ReplaceCurrentGameInput,
} from "./gameRepository";
import { validatePersistableWorldState } from "./worldStatePersistenceValidation";
import { parsePersistableStoryState } from "./storyStatePersistenceValidation";
import type { CommittedNarrativeEvent } from "@/game/domain/events";
import { parseUnit, parseUnitOutput } from "@/game/domain/narrativeUnit";
import { parsePlanProposal } from "@/game/domain/narrativePlan";
import type {
  ClaimJobInput,
  ControlJobInput,
  JobCheck,
  Lease,
  NarrativeJobRepository,
  PublishJobInput,
  RenewJobInput,
  SaveJobInput,
  StartJobInput,
  StoredJob,
  StoredJobStatus,
  StoredUnit,
} from "./narrativeJobRepository";
import type { SqliteClient, SqliteStatement } from "./sqliteClient";

// ---------------------------------------------------------------------------
// SQLite adapter：NarrativeJobRepository 端口的 libsql 实现（Task 7）。
// 与 SqliteGameRepository 共享同一 client：publish 在同一 write transaction
// 内写游戏状态并标记 published，杜绝「先 applyState 再标记」的半发布。
// lease 语义：owner+fence+expiresAt 三元组一致性；fence 在 claim 接管与
// control 时递增。lease 过期判定依赖调用方提供的 now（clock 注入）。
// ---------------------------------------------------------------------------

const NARRATIVE_JOB_SCHEMA_VERSION = 1;

const JOB_STATUSES: readonly StoredJobStatus[] = ["pending", "failed", "published", "cancelled"];

const SCHEMA_STATEMENTS: readonly SqliteStatement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS narrative_jobs (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL UNIQUE,
            digest TEXT NOT NULL,
            scope TEXT NOT NULL,
            status TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 0,
            cycle INTEGER NOT NULL DEFAULT 0,
            game_id TEXT,
            base_revision INTEGER,
            used_requests INTEGER NOT NULL DEFAULT 0,
            baseline_requests INTEGER NOT NULL DEFAULT 0,
            deadline TEXT NOT NULL DEFAULT '',
            failure_code TEXT,
            lease_owner TEXT,
            fence INTEGER NOT NULL DEFAULT 0,
            lease_expires_at TEXT,
            payload_json TEXT NOT NULL
          )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS initialization_slot (
            slot INTEGER PRIMARY KEY CHECK (slot = 1),
            job_id TEXT NOT NULL
          )`,
  },
];

export type SqliteNarrativeJobsOptions = {
  readonly client: SqliteClient;
  readonly logError?: (context: string, error: unknown) => void;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayloadJob(text: string, expectedId: string): JobCheck<StoredJob> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "UNSUPPORTED_JOB" };
  }
  if (!isPlainObject(parsed)) return { ok: false, code: "UNSUPPORTED_JOB" };
  if (parsed["schemaVersion"] !== NARRATIVE_JOB_SCHEMA_VERSION) {
    return { ok: false, code: "UNSUPPORTED_JOB" };
  }
  if (parsed["id"] !== expectedId) return { ok: false, code: "UNSUPPORTED_JOB" };
  if (!Array.isArray(parsed["units"])) return { ok: false, code: "UNSUPPORTED_JOB" };

  const units: StoredUnit[] = [];
  for (const raw of parsed["units"]) {
    if (!isPlainObject(raw) || typeof raw["key"] !== "string" || raw["key"] === "") {
      return { ok: false, code: "UNSUPPORTED_JOB" };
    }
    if (typeof raw["inputDigest"] !== "string" || typeof raw["attempts"] !== "number") {
      return { ok: false, code: "UNSUPPORTED_JOB" };
    }
    if (
      raw["status"] !== "pending" && raw["status"] !== "running"
      && raw["status"] !== "approved" && raw["status"] !== "failed" && raw["status"] !== "unknown"
    ) {
      return { ok: false, code: "UNSUPPORTED_JOB" };
    }
    let unit: StoredUnit["unit"] = null;
    if (raw["unit"] !== null) {
      const parsedUnit = parseUnit(raw["unit"]);
      if (parsedUnit === null) return { ok: false, code: "UNSUPPORTED_JOB" };
      unit = parsedUnit;
    }
    let value: StoredUnit["value"] = null;
    if (raw["value"] !== null) {
      if (!isPlainObject(raw["value"])) return { ok: false, code: "UNSUPPORTED_JOB" };
      // planning 单元的 value 是 PlanProposal；表达单元是 UnitOutput。
      if ("steps" in raw["value"] && "units" in raw["value"]) {
        const parsedPlan = parsePlanProposal(raw["value"]);
        if (!parsedPlan.ok) return { ok: false, code: "UNSUPPORTED_JOB" };
        value = parsedPlan.value;
      } else {
        const parsedOutput = parseUnitOutput(raw["value"]);
        if (!parsedOutput.ok) return { ok: false, code: "UNSUPPORTED_JOB" };
        value = parsedOutput.value;
      }
    }
    if (raw["disclosureReviewDigest"] !== undefined
      && (typeof raw["disclosureReviewDigest"] !== "string" || !/^[a-f0-9]{64}$/.test(raw["disclosureReviewDigest"]))) {
      return { ok: false, code: "UNSUPPORTED_JOB" };
    }
    units.push({
      unit,
      key: raw["key"],
      inputDigest: raw["inputDigest"],
      attempts: raw["attempts"],
      status: raw["status"] as StoredUnit["status"],
      value,
      ...(typeof raw["disclosureReviewDigest"] === "string" ? { disclosureReviewDigest: raw["disclosureReviewDigest"] } : {}),
    });
  }

  if (!isStoredPlanningDialogueReviews(parsed["planningDialogueReviews"])) return { ok: false, code: "UNSUPPORTED_JOB" };
  if (!isStoredPlanningSemanticRepair(parsed["planningSemanticRepair"])) return { ok: false, code: "UNSUPPORTED_JOB" };
  if (!isStoredDialogueReview(parsed["dialogueConsistencyReview"])) return { ok: false, code: "UNSUPPORTED_JOB" };
  const job = { ...(parsed as unknown as StoredJob), units };
  if (job.planningSemanticRepair !== undefined && (job.planningSemanticRepair.cycle !== job.cycle
    || job.planningSemanticRepair.inputDigest !== job.inputDigest
    || !approvePlanningContext(job.input, job.planningSemanticRepair.anchor).ok)) return { ok: false, code: "UNSUPPORTED_JOB" };
  return { ok: true, value: job };
}

function leaseMatches(
  row: Record<string, unknown>,
  lease: Lease,
): boolean {
  return (
    row["lease_owner"] === lease.owner
    && row["fence"] === lease.fence
    && row["lease_expires_at"] === lease.expiresAt
  );
}

export function createSqliteNarrativeJobs(
  options: SqliteNarrativeJobsOptions,
): NarrativeJobRepository & { initializeSchema(): Promise<void>; close(): Promise<void> } {
  const client = options.client;
  const logError = options.logError ?? (() => {});
  let schemaReady = false;

  async function ensureSchema(): Promise<void> {
    if (schemaReady) return;
    await client.batch([...SCHEMA_STATEMENTS], "write");
    schemaReady = true;
  }

  function rowToJob(row: Record<string, unknown>): JobCheck<StoredJob> {
    const payload = row["payload_json"];
    const id = row["id"];
    if (typeof payload !== "string" || typeof id !== "string") {
      return { ok: false, code: "UNSUPPORTED_JOB" };
    }
    const parsed = parsePayloadJob(payload, id);
    if (!parsed.ok) return parsed;
    const status = row["status"];
    if (typeof status !== "string" || !JOB_STATUSES.includes(status as StoredJobStatus)) {
      return { ok: false, code: "UNSUPPORTED_JOB" };
    }
    return {
      ok: true,
      value: {
        ...parsed.value,
        version: Number(row["version"] ?? 0),
        cycle: Number(row["cycle"] ?? 0),
        status: status as StoredJobStatus,
      },
    };
  }

  async function readJobRow(
    tx: { readonly execute: SqliteClient["execute"] } | null,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const executor = tx ?? client;
    const result = await executor.execute({
      sql: "SELECT id, request_id, digest, scope, status, version, cycle, game_id, lease_owner, fence, lease_expires_at, payload_json FROM narrative_jobs WHERE id = ?",
      args: [id],
    });
    return result.rows.length > 0 ? result.rows[0]! as Record<string, unknown> : null;
  }

  function serializeJobPayload(job: StoredJob): string {
    return JSON.stringify(job);
  }

  function serializeGameStates(
    worldState: unknown,
    storyState: unknown,
  ): { ok: true; worldJson: string; storyJson: string } | { ok: false } {
    const world = validatePersistableWorldState(worldState);
    if (!world.ok) return { ok: false };
    const ledger: readonly CommittedNarrativeEvent[] =
      (worldState as { eventLedger?: readonly CommittedNarrativeEvent[] }).eventLedger ?? [];
    const story = parsePersistableStoryState(storyState, ledger);
    if (!story.ok) return { ok: false };
    return { ok: true, worldJson: JSON.stringify(world.value), storyJson: JSON.stringify(story.value) };
  }

  return {
    async initializeSchema(): Promise<void> {
      await ensureSchema();
    },

    async close(): Promise<void> {
      await client.close();
    },

    async start(input: StartJobInput): Promise<JobCheck<StoredJob>> {
      try {
        await ensureSchema();
        const job = input.job;
        if (job.schemaVersion !== NARRATIVE_JOB_SCHEMA_VERSION) {
          return { ok: false, code: "UNSUPPORTED_JOB" };
        }
        if (job.scope === "initialization" && job.initialization === null) {
          return { ok: false, code: "JOB_CONFLICT" };
        }
        if (job.scope === "decision" && job.initialization !== null) {
          return { ok: false, code: "JOB_CONFLICT" };
        }
        const tx = await client.transaction("write");
        try {
          const existing = await tx.execute({
            sql: "SELECT id, digest, payload_json, version, cycle, status FROM narrative_jobs WHERE request_id = ?",
            args: [input.requestId],
          });
          if (existing.rows.length > 0) {
            const row = existing.rows[0]! as Record<string, unknown>;
            if (row["digest"] !== input.digest) {
              return { ok: false, code: "JOB_CONFLICT" };
            }
            const parsed = rowToJob(row);
            return parsed;
          }
          if (job.scope === "initialization") {
            const activeSlot = await tx.execute({
              sql: "SELECT j.id FROM initialization_slot s JOIN narrative_jobs j ON j.id = s.job_id WHERE s.slot = 1 AND j.status IN ('pending', 'failed')",
              args: [],
            });
            if (activeSlot.rows.length > 0) return { ok: false, code: "JOB_CONFLICT" };
          }
          if (job.scope === "decision" && job.gameId !== null) {
            const pendingSameGame = await tx.execute({
              sql: "SELECT id FROM narrative_jobs WHERE scope = 'decision' AND game_id = ? AND status = 'pending'",
              args: [job.gameId],
            });
            if (pendingSameGame.rows.length > 0) {
              return { ok: false, code: "JOB_CONFLICT" };
            }
          }
          await tx.execute({
            sql: `INSERT INTO narrative_jobs
                  (id, request_id, digest, scope, status, version, cycle, game_id,
                   base_revision, used_requests, baseline_requests, deadline, failure_code, payload_json)
                  VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              job.id, input.requestId, input.digest, job.scope, job.status, job.cycle,
              job.gameId, job.baseRevision, job.usedRequests, job.baselineRequests,
              job.deadline, job.failureCode, serializeJobPayload(job),
            ],
          });
          if (job.scope === "initialization") {
            await tx.execute({
              sql: `INSERT INTO initialization_slot (slot, job_id) VALUES (1, ?)
                    ON CONFLICT (slot) DO UPDATE SET job_id = excluded.job_id`,
              args: [job.id],
            });
          }
          await tx.commit();
          return { ok: true, value: job };
        } finally {
          tx.close();
        }
      } catch (error) {
        logError("narrativeJobs.start failed", error);
        return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      }
    },

    async get(id: string): Promise<JobCheck<StoredJob>> {
      try {
        await ensureSchema();
        const row = await readJobRow(null, id);
        if (row === null) return { ok: false, code: "JOB_NOT_FOUND" };
        return rowToJob(row);
      } catch (error) {
        logError("narrativeJobs.get failed", error);
        return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      }
    },

    async getRecentDialogueJobs({ gameId, npcId, beforeRevision }) {
      try {
        await ensureSchema();
        const result = await client.execute({
          sql: `SELECT id, request_id, digest, scope, status, version, cycle, game_id,
                       lease_owner, fence, lease_expires_at, payload_json
                FROM narrative_jobs
                WHERE scope = 'decision' AND status = 'published' AND game_id = ?
                  AND base_revision < ?
                  AND json_extract(payload_json, '$.input.kind') = 'decision'
                  AND json_extract(payload_json, '$.input.job.focusNpcId') = ?
                ORDER BY base_revision DESC, id DESC
                LIMIT 6`,
          args: [gameId, beforeRevision, npcId],
        });
        const jobs: StoredJob[] = [];
        for (const row of result.rows) {
          const parsed = rowToJob(row as unknown as Record<string, unknown>);
          if (!parsed.ok) return parsed;
          jobs.push(parsed.value);
        }
        return { ok: true, value: jobs };
      } catch (error) {
        logError("narrativeJobs.getRecentDialogueJobs failed", error);
        return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      }
    },

    async getInitialization(): Promise<JobCheck<StoredJob | null>> {
      try {
        await ensureSchema();
        // slot 无行 = 从未发起过初始化，返回 null（不是错误）。
        const slot = await client.execute({
          sql: "SELECT job_id FROM initialization_slot WHERE slot = 1",
          args: [],
        });
        if (slot.rows.length === 0) return { ok: true, value: null };
        const jobId = slot.rows[0]!["job_id"];
        if (typeof jobId !== "string") return { ok: false, code: "UNSUPPORTED_JOB" };
        const row = await readJobRow(null, jobId);
        // slot 指向的任务被清理（不应发生）时按「无初始化」处理，
        // 而不是抛 JOB_NOT_FOUND——恢复入口必须始终可回答。
        if (row === null) return { ok: true, value: null };
        return rowToJob(row);
      } catch (error) {
        logError("narrativeJobs.getInitialization failed", error);
        return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      }
    },

    async claim(input: ClaimJobInput): Promise<JobCheck<Lease>> {
      try {
        await ensureSchema();
        const tx = await client.transaction("write");
        try {
          const row = await readJobRow(tx, input.id);
          if (row === null) {
            return { ok: false, code: "JOB_NOT_FOUND" };
          }
          if (row["status"] === "published" || row["status"] === "cancelled") {
            return { ok: false, code: "JOB_CONFLICT" };
          }
          const currentOwner = row["lease_owner"];
          const currentExpiresAt = row["lease_expires_at"];
          if (
            typeof currentOwner === "string" && typeof currentExpiresAt === "string"
            && currentExpiresAt > input.now
          ) {
            // 同 owner 重复 claim 返回现有租约；他人活跃租约拒绝。
            if (currentOwner === input.owner) {
              return {
                ok: true,
                value: {
                  jobId: input.id, owner: currentOwner,
                  fence: Number(row["fence"]), expiresAt: currentExpiresAt,
                },
              };
            }
            return { ok: false, code: "JOB_CONFLICT" };
          }
          const nextFence = Number(row["fence"] ?? 0) + 1;
          await tx.execute({
            sql: "UPDATE narrative_jobs SET lease_owner = ?, fence = ?, lease_expires_at = ? WHERE id = ?",
            args: [input.owner, nextFence, input.expiresAt, input.id],
          });
          await tx.commit();
          return {
            ok: true,
            value: { jobId: input.id, owner: input.owner, fence: nextFence, expiresAt: input.expiresAt },
          };
        } finally {
          tx.close();
        }
      } catch (error) {
        logError("narrativeJobs.claim failed", error);
        return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      }
    },

    async renew(input: RenewJobInput): Promise<JobCheck<Lease>> {
      try {
        await ensureSchema();
        const tx = await client.transaction("write");
        try {
          const row = await readJobRow(tx, input.lease.jobId);
          if (row === null) return { ok: false, code: "JOB_NOT_FOUND" };
          // renew 不否决「已过期但未被接管」的租约：TTL 只是 claim 接管的触发
          // 条件，不是续租的失效条件。provider 单次调用可跑 45-90s，超过 30s
          // TTL 时持有者仍在工作；真正的并发权威是 fence——租约一旦被新执行者
          // 接管（claim/control 递增 fence），旧 lease 的 owner+fence 不再匹配
          // row，这里返回 LEASE_LOST，持有者立即停止。
          if (!leaseMatches(row, input.lease)) {
            return { ok: false, code: "LEASE_LOST" };
          }
          await tx.execute({
            sql: "UPDATE narrative_jobs SET lease_expires_at = ? WHERE id = ?",
            args: [input.expiresAt, input.lease.jobId],
          });
          await tx.commit();
          return {
            ok: true,
            value: { ...input.lease, expiresAt: input.expiresAt },
          };
        } finally {
          tx.close();
        }
      } catch (error) {
        logError("narrativeJobs.renew failed", error);
        return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      }
    },

    async release(input: { readonly lease: Lease }): Promise<JobCheck<true>> {
      try {
        await ensureSchema();
        const tx = await client.transaction("write");
        try {
          const row = await readJobRow(tx, input.lease.jobId);
          if (row === null) return { ok: false, code: "JOB_NOT_FOUND" };
          if (!leaseMatches(row, input.lease)) {
            return { ok: false, code: "LEASE_LOST" };
          }
          await tx.execute({
            sql: "UPDATE narrative_jobs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?",
            args: [input.lease.jobId],
          });
          await tx.commit();
          return { ok: true, value: true };
        } finally {
          tx.close();
        }
      } catch (error) {
        logError("narrativeJobs.release failed", error);
        return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      }
    },

    async control(input: ControlJobInput): Promise<JobCheck<StoredJob>> {
      try {
        await ensureSchema();
        const tx = await client.transaction("write");
        try {
          const row = await readJobRow(tx, input.id);
          if (row === null) return { ok: false, code: "JOB_NOT_FOUND" };
          if (
            Number(row["version"] ?? 0) !== input.expectedVersion
            || Number(row["cycle"] ?? 0) !== input.expectedCycle
          ) {
            return { ok: false, code: "JOB_CONFLICT" };
          }
          const status = row["status"];
          if (input.operation === "cancel") {
            if (status !== "pending" && status !== "failed") {
              return { ok: false, code: "JOB_CONFLICT" };
            }
          } else if (status !== "failed") {
            return { ok: false, code: "JOB_CONFLICT" };
          }
          const parsed = rowToJob(row);
          if (!parsed.ok) return parsed;
          const nextFence = Number(row["fence"] ?? 0) + 1;
          const nextVersion = Number(row["version"] ?? 0) + 1;
          const nextCycle = input.operation === "retry"
            ? Number(row["cycle"] ?? 0) + 1
            : Number(row["cycle"] ?? 0);
          const nextStatus: StoredJobStatus = input.operation === "cancel" ? "cancelled" : "pending";
          // 取消保持原 deadline；重试重置为 now + 600s 周期。
          const nextDeadline = input.operation === "retry"
            ? new Date(Date.parse(input.now) + 600_000).toISOString()
            : parsed.value.deadline;
          const nextUnits = input.operation === "retry"
            ? parsed.value.units.map((unit) => unit.status === "approved"
              ? unit
              : { ...unit, status: "pending" as const, attempts: 0 })
            : parsed.value.units;
          const nextJob: StoredJob = {
            ...parsed.value,
            status: nextStatus,
            version: nextVersion,
            cycle: nextCycle,
            deadline: nextDeadline,
            usedRequests: input.operation === "retry" ? 0 : parsed.value.usedRequests,
            units: nextUnits,
            planningDialogueReviews: input.operation === "retry" ? undefined : parsed.value.planningDialogueReviews,
            planningSemanticRepair: input.operation === "retry" ? undefined : parsed.value.planningSemanticRepair,
            dialogueConsistencyReview: input.operation === "retry" ? undefined : parsed.value.dialogueConsistencyReview,
          };
          await tx.execute({
            sql: `UPDATE narrative_jobs
                  SET status = ?, version = ?, cycle = ?, fence = ?, lease_owner = NULL,
                      lease_expires_at = NULL, payload_json = ?
                  WHERE id = ?`,
            args: [nextStatus, nextVersion, nextCycle, nextFence, serializeJobPayload(nextJob), input.id],
          });
          await tx.commit();
          return { ok: true, value: nextJob };
        } finally {
          tx.close();
        }
      } catch (error) {
        logError("narrativeJobs.control failed", error);
        return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      }
    },

    async save(input: SaveJobInput): Promise<JobCheck<StoredJob>> {
      try {
        await ensureSchema();
        const tx = await client.transaction("write");
        try {
          const row = await readJobRow(tx, input.lease.jobId);
          if (row === null) return { ok: false, code: "JOB_NOT_FOUND" };
          if (!leaseMatches(row, input.lease)) {
            return { ok: false, code: "LEASE_LOST" };
          }
          if (Number(row["version"] ?? 0) !== input.expectedVersion) {
            return { ok: false, code: "JOB_CONFLICT" };
          }
          if (row["status"] === "published" || row["status"] === "cancelled") {
            return { ok: false, code: "JOB_CONFLICT" };
          }
          const nextVersion = Number(row["version"] ?? 0) + 1;
          const nextJob: StoredJob = { ...input.job, version: nextVersion };
          await tx.execute({
            sql: `UPDATE narrative_jobs
                  SET version = ?, status = ?, cycle = ?, used_requests = ?, baseline_requests = ?,
                      deadline = ?, failure_code = ?, payload_json = ?
                  WHERE id = ?`,
            args: [
              nextVersion,
              nextJob.status,
              nextJob.cycle,
              nextJob.usedRequests,
              nextJob.baselineRequests,
              nextJob.deadline,
              nextJob.failureCode,
              serializeJobPayload(nextJob),
              input.lease.jobId,
            ],
          });
          await tx.commit();
          return { ok: true, value: nextJob };
        } finally {
          tx.close();
        }
      } catch (error) {
        logError("narrativeJobs.save failed", error);
        return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      }
    },

    async publish(input: PublishJobInput): Promise<JobCheck<StoredJob>> {
      try {
        await ensureSchema();
        const tx = await client.transaction("write");
        try {
          const row = await readJobRow(tx, input.lease.jobId);
          if (row === null) return { ok: false, code: "JOB_NOT_FOUND" };
          if (!leaseMatches(row, input.lease)) {
            return { ok: false, code: "LEASE_LOST" };
          }
          if (Number(row["version"] ?? 0) !== input.expectedVersion) {
            return { ok: false, code: "JOB_CONFLICT" };
          }
          if (row["status"] !== "pending") {
            return { ok: false, code: "JOB_CONFLICT" };
          }
          const parsed = rowToJob(row);
          if (!parsed.ok) return parsed;
          const job = parsed.value;
          // ready coverage：全部单元 approved 才允许发布。
          if (!job.units.every((unit) => unit.status === "approved")) {
            return { ok: false, code: "JOB_CONFLICT" };
          }

          const planning = job.units.find(unit => unit.key === "planning")?.value;
          if (planning === undefined || planning === null || !("steps" in planning)) return { ok: false, code: "JOB_CONFLICT" };
          const plan = approvePlanningContext(job.input, planning);
          if (!plan.ok || !validateJobDialogueConsistencyReview(job, plan.value).ok) return { ok: false, code: "JOB_CONFLICT" };
          const nextVersion = Number(row["version"] ?? 0) + 1;
          if (input.publication.kind === "decision") {
            const decisionInput: ApplyStateInput = input.publication.input;
            const pointer = await tx.execute({
              sql: "SELECT game_id FROM current_game WHERE slot = 1",
              args: [],
            });
            if (pointer.rows.length === 0 || pointer.rows[0]?.["game_id"] !== decisionInput.gameId) {
              return { ok: false, code: "STALE_GAME_REVISION" };
            }
            const expected = await tx.execute({
              sql: "SELECT revision FROM game_records WHERE game_id = ?",
              args: [decisionInput.gameId],
            });
            if (expected.rows.length === 0) {
              return { ok: false, code: "STALE_GAME_REVISION" };
            }
            if (Number(expected.rows[0]?.["revision"]) !== decisionInput.expectedRevision) {
              return { ok: false, code: "STALE_GAME_REVISION" };
            }
            const states = serializeGameStates(decisionInput.nextWorldState, decisionInput.nextStoryState);
            if (!states.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
            await tx.execute({
              sql: `UPDATE game_records
                    SET world_state_json = ?, story_state_json = ?, revision = revision + 1
                    WHERE game_id = ? AND revision = ?`,
              args: [states.worldJson, states.storyJson, decisionInput.gameId, decisionInput.expectedRevision],
            });
          } else {
            const openingInput: CreateInitialGameInput = input.publication.input;
            const slot = await tx.execute({ sql: "SELECT job_id FROM initialization_slot WHERE slot = 1", args: [] });
            if (slot.rows[0]?.["job_id"] !== job.id) return { ok: false, code: "JOB_CONFLICT" };
            const envelope = job.initialization;
            if (envelope === null || openingInput.gameId !== envelope.newGameId) {
              return { ok: false, code: "JOB_CONFLICT" };
            }
            const states = serializeGameStates(openingInput.worldState, openingInput.storyState);
            if (!states.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
            const replace: ReplaceCurrentGameInput | undefined = input.publication.replace;
            if (replace === undefined) {
              if (envelope.target.kind !== "create") return { ok: false, code: "JOB_CONFLICT" };
              const existing = await tx.execute({
                sql: "SELECT game_id FROM current_game WHERE slot = 1",
                args: [],
              });
              if (existing.rows.length > 0) {
                return { ok: false, code: "ACTIVE_GAME_EXISTS" };
              }
              await tx.execute({
                sql: `INSERT INTO game_records (game_id, record_version, world_state_json, story_state_json, created_at, revision)
                      VALUES (?, 1, ?, ?, ?, 0)`,
                args: [openingInput.gameId, states.worldJson, states.storyJson, openingInput.createdAt],
              });
              await tx.execute({
                sql: "INSERT INTO current_game (slot, game_id) VALUES (1, ?)",
                args: [openingInput.gameId],
              });
            } else {
              if (envelope.target.kind !== "replace"
                || replace.expectedCurrentGameId !== envelope.target.expectedGameId
                || replace.expectedRevision !== envelope.target.expectedRevision) {
                return { ok: false, code: "JOB_CONFLICT" };
              }
              const pointer = await tx.execute({
                sql: "SELECT game_id FROM current_game WHERE slot = 1",
                args: [],
              });
              if (pointer.rows.length === 0 || pointer.rows[0]?.["game_id"] !== replace.expectedCurrentGameId) {
                return { ok: false, code: "STALE_GAME_REVISION" };
              }
              const expected = await tx.execute({
                sql: "SELECT revision FROM game_records WHERE game_id = ?",
                args: [replace.expectedCurrentGameId],
              });
              if (expected.rows.length === 0 || Number(expected.rows[0]?.["revision"]) !== replace.expectedRevision) {
                return { ok: false, code: "STALE_GAME_REVISION" };
              }
              await tx.execute({
                sql: `INSERT INTO game_records (game_id, record_version, world_state_json, story_state_json, created_at, revision)
                      VALUES (?, 1, ?, ?, ?, 0)`,
                args: [openingInput.gameId, states.worldJson, states.storyJson, openingInput.createdAt],
              });
              await tx.execute({
                sql: "UPDATE current_game SET game_id = ? WHERE slot = 1",
                args: [openingInput.gameId],
              });
            }
          }

          const publishedJob: StoredJob = { ...job, status: "published", version: nextVersion };
          await tx.execute({
            sql: `UPDATE narrative_jobs
                  SET status = 'published', version = ?, lease_owner = NULL, lease_expires_at = NULL, payload_json = ?
                  WHERE id = ?`,
            args: [nextVersion, serializeJobPayload(publishedJob), input.lease.jobId],
          });
          await tx.commit();
          return { ok: true, value: publishedJob };
        } finally {
          tx.close();
        }
      } catch (error) {
        logError("narrativeJobs.publish failed", error);
        return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      }
    },
  };
}
