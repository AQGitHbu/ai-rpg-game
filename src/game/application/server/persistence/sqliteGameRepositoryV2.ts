import { NOOP_GAME_LOGGER } from "@/game/logging";
import {
  asGameId,
  type CorruptGameReason,
} from "./gameRepository";
import type {
  ApplySceneWriteBackInput,
  ApplySceneWriteBackResult,
  ApplyStateV2Input,
  ApplyStateV2Result,
  CreateInitialGameV2Input,
  CreateInitialGameV2Result,
  GameRecordV2,
  GameRepositoryV2,
  GetCurrentGameV2Result,
} from "./gameRepositoryV2";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { SqliteClient, SqliteClientFactory, SqliteStatement } from "./sqliteClient";

// ---------------------------------------------------------------------------
// SQLite adapter（P1 V2）：GameRepositoryV2 端口的 libsql 实现。
//   - 独立新表 game_records_v2 / current_game_v2，与 V1 表互不干扰；
//   - 旧存档不迁移（spec：新架构重开新局）；
//   - createInitialGame 单事务写入存档行 + 指针，失败整体回滚；
//   - applyState / applySceneWriteBack 以 CAS 原子更新 + revision + 1；
//   - applySceneWriteBack 只重组 storyState.narrative + candidateEventPool，
//     类型层面排除触碰 worldState 的可能；
//   - 读取防御性 JSON 解析，坏数据标记 corrupt，绝不自动重置；
//   - 所有失败只返回端口定义的稳定代码。
// ---------------------------------------------------------------------------

const GAME_RECORD_VERSION_V2 = 1;
/** 旧 v2 存档的表级 record_version：明确识别为 legacy，不迁移不伪装。 */
const LEGACY_V2_RECORD_VERSION = 0;
const INITIAL_REVISION = 0;

const SCHEMA_STATEMENTS_V2: readonly SqliteStatement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS game_records_v2 (
            game_id TEXT PRIMARY KEY,
            record_version INTEGER NOT NULL,
            world_state_json TEXT NOT NULL,
            story_state_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT ${INITIAL_REVISION}
          )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS current_game_v2 (
            slot INTEGER PRIMARY KEY CHECK (slot = 1),
            game_id TEXT NOT NULL
          )`,
  },
];

export type SqliteGameRepositoryV2Options = {
  readonly clientFactory: SqliteClientFactory;
  readonly logError?: (context: string, error: unknown) => void;
};

export type SqliteGameRepositoryV2 = GameRepositoryV2 & {
  initializeSchema(): Promise<void>;
  close(): Promise<void>;
};

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function corruptV2(reason: CorruptGameReason): GetCurrentGameV2Result {
  return { ok: true, status: "corrupt", reason };
}

function interpretGameRowV2(row: Record<string, unknown>): GetCurrentGameV2Result {
  const gameId = row["game_id"];
  const recordVersion = row["record_version"];
  const worldStateJson = row["world_state_json"];
  const storyStateJson = row["story_state_json"];
  const createdAt = row["created_at"];
  const revision = row["revision"];

  if (
    typeof gameId !== "string" ||
    typeof worldStateJson !== "string" ||
    typeof storyStateJson !== "string" ||
    typeof createdAt !== "string"
  ) {
    return corruptV2("UNPARSEABLE_RECORD");
  }
  // Step 3：明确识别旧 v2 schema（LEGACY_V2_RECORD），不伪装成新状态。
  // 旧 v2 存档：表级 record_version 为 LEGACY_V2_RECORD_VERSION，或 JSON 内部
  // version 为 1（v2.0）。这些因缺失 v2.1 因果字段而被判定不兼容，返回
  // LEGACY_V2_RECORD；开发清档可恢复，绝不填充 optional default 伪装。
  if (recordVersion === LEGACY_V2_RECORD_VERSION) {
    return corruptV2("LEGACY_V2_RECORD");
  }
  if (recordVersion !== GAME_RECORD_VERSION_V2) {
    return corruptV2("VERSION_MISMATCH");
  }
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    return corruptV2("UNPARSEABLE_RECORD");
  }

  const worldState = parseJsonObject(worldStateJson);
  const storyState = parseJsonObject(storyStateJson);
  if (worldState === null || storyState === null) {
    return corruptV2("UNPARSEABLE_RECORD");
  }

  if (worldState["version"] === 1 || storyState["version"] === 1) {
    return corruptV2("LEGACY_V2_RECORD");
  }
  if (worldState["version"] !== 2 || storyState["version"] !== 2) {
    return corruptV2("VERSION_MISMATCH");
  }

  return {
    ok: true,
    status: "active",
    record: {
      gameId: asGameId(gameId),
      worldState: worldState as unknown as WorldState,
      storyState: storyState as unknown as StoryState,
      revision,
      createdAt,
    },
  };
}

export function createSqliteGameRepositoryV2(
  options: SqliteGameRepositoryV2Options,
): SqliteGameRepositoryV2 {
  const logError =
    options.logError ??
    ((context: string, _error: unknown) => {
      NOOP_GAME_LOGGER.error("sqlite_repository_v2_failure", { operation: context });
    });

  let client: SqliteClient | null = null;
  let schemaReady = false;

  function getClient(): SqliteClient {
    if (client === null) {
      client = options.clientFactory();
    }
    return client;
  }

  async function ensureSchema(): Promise<void> {
    if (schemaReady) return;
    const db = getClient();
    await db.batch([...SCHEMA_STATEMENTS_V2], "write");
    schemaReady = true;
  }

  async function createInitialGame(
    input: CreateInitialGameV2Input,
  ): Promise<CreateInitialGameV2Result> {
    let worldStateJson: string;
    let storyStateJson: string;
    try {
      await ensureSchema();
      worldStateJson = JSON.stringify(input.worldState);
      storyStateJson = JSON.stringify(input.storyState);
    } catch (error) {
      logError("createInitialGameV2 prepare failed", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }

    try {
      const tx = await getClient().transaction("write");
      try {
        const existing = await tx.execute({
          sql: "SELECT game_id FROM current_game_v2 WHERE slot = 1",
          args: [],
        });
        if (existing.rows.length > 0) {
          return { ok: false, code: "ACTIVE_GAME_EXISTS" };
        }
        await tx.execute({
          sql: `INSERT INTO game_records_v2 (game_id, record_version, world_state_json, story_state_json, created_at, revision)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            input.gameId,
            GAME_RECORD_VERSION_V2,
            worldStateJson,
            storyStateJson,
            input.createdAt,
            INITIAL_REVISION,
          ],
        });
        await tx.execute({
          sql: "INSERT INTO current_game_v2 (slot, game_id) VALUES (1, ?)",
          args: [input.gameId],
        });
        await tx.commit();
        return { ok: true };
      } finally {
        tx.close();
      }
    } catch (error) {
      logError("createInitialGameV2 transaction failed, rolled back", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  async function getCurrentGame(): Promise<GetCurrentGameV2Result> {
    try {
      await ensureSchema();
      const result = await getClient().execute({
        sql: `SELECT g.game_id, g.record_version, g.world_state_json, g.story_state_json, g.created_at, g.revision
              FROM current_game_v2 c LEFT JOIN game_records_v2 g ON g.game_id = c.game_id
              WHERE c.slot = 1`,
        args: [],
      });
      if (result.rows.length === 0) {
        return { ok: true, status: "none" };
      }
      return interpretGameRowV2(result.rows[0]!);
    } catch (error) {
      logError("getCurrentGameV2 read failed", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  async function applyState(input: ApplyStateV2Input): Promise<ApplyStateV2Result> {
    let worldStateJson: string;
    let storyStateJson: string;
    try {
      await ensureSchema();
      worldStateJson = JSON.stringify(input.nextWorldState);
      storyStateJson = JSON.stringify(input.nextStoryState);
    } catch (error) {
      logError("applyStateV2 prepare failed", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }

    try {
      const tx = await getClient().transaction("write");
      try {
        const pointer = await tx.execute({
          sql: "SELECT game_id FROM current_game_v2 WHERE slot = 1",
          args: [],
        });
        if (pointer.rows.length === 0) {
          return { ok: false, code: "NO_ACTIVE_GAME" };
        }
        const activeGameId = pointer.rows[0]?.["game_id"];
        if (activeGameId !== input.gameId) {
          return { ok: false, code: "NO_ACTIVE_GAME" };
        }

        const updateResult = await tx.execute({
          sql: `UPDATE game_records_v2 SET world_state_json = ?, story_state_json = ?, revision = revision + 1
                WHERE game_id = ? AND revision = ?`,
          args: [worldStateJson, storyStateJson, input.gameId, input.expectedRevision],
        });
        const rowsAffected = Number(updateResult.rowsAffected ?? 0);
        if (rowsAffected === 0) {
          return { ok: false, code: "STALE_GAME_REVISION" };
        }

        const readBack = await tx.execute({
          sql: `SELECT game_id, record_version, world_state_json, story_state_json, created_at, revision
                FROM game_records_v2 WHERE game_id = ?`,
          args: [input.gameId],
        });
        const row = readBack.rows[0];
        if (row === undefined) {
          return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        }

        const worldState = parseJsonObject(row["world_state_json"] as string);
        const storyState = parseJsonObject(row["story_state_json"] as string);
        if (worldState === null || storyState === null) {
          return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        }

        const record: GameRecordV2 = {
          gameId: asGameId(row["game_id"] as string),
          worldState: worldState as unknown as WorldState,
          storyState: storyState as unknown as StoryState,
          revision: row["revision"] as number,
          createdAt: row["created_at"] as string,
        };

        await tx.commit();
        return { ok: true, record };
      } finally {
        tx.close();
      }
    } catch (error) {
      logError("applyStateV2 transaction failed, rolled back", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  async function applySceneWriteBack(input: ApplySceneWriteBackInput): Promise<ApplySceneWriteBackResult> {
    let nextNarrativeJson: string;
    let nextCandidatePoolJson: string;
    try {
      await ensureSchema();
      nextNarrativeJson = JSON.stringify(input.nextNarrative);
      nextCandidatePoolJson = JSON.stringify(input.nextCandidateEventPool);
    } catch (error) {
      logError("applySceneWriteBackV2 prepare failed", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }

    try {
      const tx = await getClient().transaction("write");
      try {
        const pointer = await tx.execute({
          sql: "SELECT game_id FROM current_game_v2 WHERE slot = 1",
          args: [],
        });
        if (pointer.rows.length === 0) {
          return { ok: false, code: "NO_ACTIVE_GAME" };
        }
        const activeGameId = pointer.rows[0]?.["game_id"];
        if (activeGameId !== input.gameId) {
          return { ok: false, code: "NO_ACTIVE_GAME" };
        }

        // Read current story state, patch only narrative + candidateEventPool, write back.
        const readResult = await tx.execute({
          sql: `SELECT story_state_json, world_state_json, game_id, record_version, created_at, revision
                FROM game_records_v2 WHERE game_id = ? AND revision = ?`,
          args: [input.gameId, input.expectedRevision],
        });
        const row = readResult.rows[0];
        if (row === undefined) {
          return { ok: false, code: "STALE_GAME_REVISION" };
        }

        const storyState = parseJsonObject(row["story_state_json"] as string);
        if (storyState === null) {
          return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        }

        // One CAS persists the ready scene, its ApprovedChoice registry (both inside
        // narrative), and candidateEventPool; everything else stays unchanged.
        const patchedStoryState = {
          ...storyState,
          narrative: JSON.parse(nextNarrativeJson),
          candidateEventPool: JSON.parse(nextCandidatePoolJson),
        };

        const updateResult = await tx.execute({
          sql: `UPDATE game_records_v2 SET story_state_json = ?, revision = revision + 1
                WHERE game_id = ? AND revision = ?`,
          args: [JSON.stringify(patchedStoryState), input.gameId, input.expectedRevision],
        });
        const rowsAffected = Number(updateResult.rowsAffected ?? 0);
        if (rowsAffected === 0) {
          return { ok: false, code: "STALE_GAME_REVISION" };
        }

        const readBack = await tx.execute({
          sql: `SELECT game_id, record_version, world_state_json, story_state_json, created_at, revision
                FROM game_records_v2 WHERE game_id = ?`,
          args: [input.gameId],
        });
        const readBackRow = readBack.rows[0];
        if (readBackRow === undefined) {
          return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        }

        const worldState = parseJsonObject(readBackRow["world_state_json"] as string);
        const patchedState = parseJsonObject(readBackRow["story_state_json"] as string);
        if (worldState === null || patchedState === null) {
          return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        }

        const record: GameRecordV2 = {
          gameId: asGameId(readBackRow["game_id"] as string),
          worldState: worldState as unknown as WorldState,
          storyState: patchedState as unknown as StoryState,
          revision: readBackRow["revision"] as number,
          createdAt: readBackRow["created_at"] as string,
        };

        await tx.commit();
        return { ok: true, record };
      } finally {
        tx.close();
      }
    } catch (error) {
      logError("applySceneWriteBackV2 transaction failed, rolled back", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  async function clearCurrentGame(): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" }> {
    try {
      await ensureSchema();
      const tx = await getClient().transaction("write");
      try {
        await tx.execute({
          sql: "DELETE FROM current_game_v2 WHERE slot = 1",
          args: [],
        });
        await tx.execute({
          sql: "DELETE FROM game_records_v2",
          args: [],
        });
        await tx.commit();
        return { ok: true };
      } finally {
        tx.close();
      }
    } catch (error) {
      logError("clearCurrentGameV2 failed", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  return {
    createInitialGame,
    getCurrentGame,
    applyState,
    applySceneWriteBack,
    clearCurrentGame,
    async initializeSchema() {
      await ensureSchema();
    },
    async close() {
      if (client !== null) {
        try {
          client.close();
        } finally {
          client = null;
          schemaReady = false;
        }
      }
    },
  };
}
