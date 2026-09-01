import { NOOP_GAME_LOGGER } from "@/game/logging";
import {
  asGameId,
  type CorruptGameReason,
} from "./gameRepository";
import type {
  ApplySceneWriteBackInput,
  ApplySceneWriteBackResult,
  ApplyStateInput,
  ApplyStateResult,
  CreateInitialGameInput,
  CreateInitialGameResult,
  ReplaceCurrentGameInput,
  ReplaceCurrentGameResult,
  GameRecord,
  GameRepository,
  GetCurrentGameResult,
} from "./gameRepository";
import { STORY_STATE_SCHEMA_VERSION, type StoryState } from "@/game/domain/storyState";
import { parseNarrativeRuntimeState } from "@/game/domain/narrative";
import { parseOpeningVariationProfile, type OpeningNoveltyRecord } from "@/game/domain/openingNovelty";
import { validatePersistableWorldState } from "./worldStatePersistenceValidation";
import type { GameTypeId } from "@/game/domain/newGame";
import type { SqliteClient, SqliteClientFactory, SqliteStatement } from "./sqliteClient";

// ---------------------------------------------------------------------------
// SQLite adapter：GameRepository 端口的 libsql 实现。
//   - 使用 game_records / current_game 保存当前存档，使用 opening_history 保存
//     已用过的开局指纹；清档只移除当前存档，不清除去重历史；
//   - 旧存档不迁移（spec：新架构重开新局）；
//   - createInitialGame 单事务写入存档行 + 指针，失败整体回滚；
//   - applyState / applySceneWriteBack 以 CAS 原子更新 + revision + 1；
//   - applySceneWriteBack 与 applyState 同构：一次原子更新世界 JSON 两列，
//     场景写回（含世界演化预览状态）在同一 CAS 落盘；
//   - 读取防御性 JSON 解析，坏数据标记 corrupt，绝不自动重置；
//   - 所有失败只返回端口定义的稳定代码。
// ---------------------------------------------------------------------------

const GAME_RECORD_VERSION = 1;
/** 旧 v2 存档的表级 record_version：明确识别为 legacy，不迁移不伪装。 */
const UNSUPPORTED_RECORD_VERSION = 0;
const INITIAL_REVISION = 0;

const SCHEMA_STATEMENTS: readonly SqliteStatement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS game_records (
            game_id TEXT PRIMARY KEY,
            record_version INTEGER NOT NULL,
            world_state_json TEXT NOT NULL,
            story_state_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT ${INITIAL_REVISION}
          )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS current_game (
            slot INTEGER PRIMARY KEY CHECK (slot = 1),
            game_id TEXT NOT NULL
          )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS opening_history (
            history_id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_type TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            semantic_fingerprint TEXT NOT NULL,
            semantic_text TEXT NOT NULL,
            summary TEXT NOT NULL,
            profile_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          )`,
  },
  {
    sql: "CREATE INDEX IF NOT EXISTS opening_history_game_type_created ON opening_history (game_type, history_id DESC)",
  },
];

export type SqliteGameRepositoryOptions = {
  readonly clientFactory: SqliteClientFactory;
  readonly logError?: (context: string, error: unknown) => void;
};

export type SqliteGameRepository = GameRepository & {
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

const GAME_TYPES: ReadonlySet<string> = new Set([
  "wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse",
]);

function parseOpeningHistoryRow(row: Record<string, unknown>): OpeningNoveltyRecord | null {
  const gameType = row["game_type"];
  const fingerprint = row["fingerprint"];
  const semanticFingerprint = row["semantic_fingerprint"];
  const semanticText = row["semantic_text"];
  const summary = row["summary"];
  const profileJson = row["profile_json"];
  const createdAt = row["created_at"];
  if (
    typeof gameType !== "string" || !GAME_TYPES.has(gameType)
    || typeof fingerprint !== "string"
    || typeof semanticFingerprint !== "string"
    || typeof semanticText !== "string"
    || typeof summary !== "string"
    || typeof profileJson !== "string"
    || typeof createdAt !== "string"
  ) return null;
  const profile = parseJsonObject(profileJson);
  const parsedProfile = profile === null ? null : parseOpeningVariationProfile(profile);
  if (parsedProfile === null) return null;
  return {
    gameType: gameType as GameTypeId,
    fingerprint,
    semanticFingerprint,
    semanticText,
    summary,
    profile: parsedProfile,
    createdAt,
  };
}

function corrupt(reason: CorruptGameReason): GetCurrentGameResult {
  return { ok: true, status: "corrupt", reason };
}

function serializeValidatedWorldState(value: unknown): string | null {
  const validated = validatePersistableWorldState(value);
  return validated.ok ? JSON.stringify(validated.value) : null;
}

function interpretGameRow(row: Record<string, unknown>): GetCurrentGameResult {
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
    return corrupt("UNPARSEABLE_RECORD");
  }
  // 旧 record schema 不迁移、不填充默认值，统一归类为 UNSUPPORTED_RECORD。
  if (recordVersion === UNSUPPORTED_RECORD_VERSION) {
    return corrupt("UNSUPPORTED_RECORD");
  }
  if (recordVersion !== GAME_RECORD_VERSION) {
    return corrupt("VERSION_MISMATCH");
  }
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    return corrupt("UNPARSEABLE_RECORD");
  }

  const worldState = parseJsonObject(worldStateJson);
  const storyState = parseJsonObject(storyStateJson);
  if (worldState === null || storyState === null) {
    return corrupt("UNPARSEABLE_RECORD");
  }

  if (worldState["version"] === 1
    || worldState["version"] === 2
    || storyState["version"] === 1
    || storyState["version"] === 2
    || storyState["version"] === 3
    || storyState["version"] === 4
    || storyState["version"] === 5) {
    return corrupt("UNSUPPORTED_RECORD");
  }
  if (worldState["version"] !== 3 || storyState["version"] !== STORY_STATE_SCHEMA_VERSION) {
    return corrupt("VERSION_MISMATCH");
  }
  const parsedWorldState = validatePersistableWorldState(worldState);
  if (!parsedWorldState.ok) return corrupt("ENTITY_STATE_INVALID");
  const parsedNarrative = parseNarrativeRuntimeState(storyState["narrative"]);
  if (!parsedNarrative.ok) return corrupt("UNPARSEABLE_RECORD");
  const parsedStoryState = {
    ...storyState,
    narrative: parsedNarrative.value,
  } as unknown as StoryState;

  return {
    ok: true,
    status: "active",
    record: {
      gameId: asGameId(gameId),
      worldState: parsedWorldState.value,
      storyState: parsedStoryState,
      revision,
      createdAt,
    },
  };
}

export function createSqliteGameRepository(
  options: SqliteGameRepositoryOptions,
): SqliteGameRepository {
  const logError =
    options.logError ??
    ((context: string, _error: unknown) => {
      NOOP_GAME_LOGGER.error("sqlite_repository_failure", { operation: context });
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
    await db.batch([...SCHEMA_STATEMENTS], "write");
    schemaReady = true;
  }

  async function createInitialGame(
    input: CreateInitialGameInput,
  ): Promise<CreateInitialGameResult> {
    try {
      await ensureSchema();
    } catch (error) {
      logError("createInitialGame prepare failed", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }

    try {
      const tx = await getClient().transaction("write");
      try {
        const existing = await tx.execute({
          sql: "SELECT game_id FROM current_game WHERE slot = 1",
          args: [],
        });
        if (existing.rows.length > 0) {
          return { ok: false, code: "ACTIVE_GAME_EXISTS" };
        }
        const worldStateJson = serializeValidatedWorldState(input.worldState);
        if (worldStateJson === null) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        const storyStateJson = JSON.stringify(input.storyState);
        await tx.execute({
          sql: `INSERT INTO game_records (game_id, record_version, world_state_json, story_state_json, created_at, revision)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            input.gameId,
            GAME_RECORD_VERSION,
            worldStateJson,
            storyStateJson,
            input.createdAt,
            INITIAL_REVISION,
          ],
        });
        await tx.execute({
          sql: "INSERT INTO current_game (slot, game_id) VALUES (1, ?)",
          args: [input.gameId],
        });
        if (input.openingHistory !== undefined) {
          await tx.execute({
            sql: `INSERT INTO opening_history
                  (game_type, fingerprint, semantic_fingerprint, semantic_text, summary, profile_json, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [
              input.openingHistory.gameType,
              input.openingHistory.fingerprint,
              input.openingHistory.semanticFingerprint,
              input.openingHistory.semanticText,
              input.openingHistory.summary,
              JSON.stringify(input.openingHistory.profile),
              input.openingHistory.createdAt,
            ],
          });
        }
        await tx.commit();
        return { ok: true };
      } finally {
        tx.close();
      }
    } catch (error) {
      logError("createInitialGame transaction failed, rolled back", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  async function getCurrentGame(): Promise<GetCurrentGameResult> {
    try {
      await ensureSchema();
      const result = await getClient().execute({
        sql: `SELECT g.game_id, g.record_version, g.world_state_json, g.story_state_json, g.created_at, g.revision
              FROM current_game c LEFT JOIN game_records g ON g.game_id = c.game_id
              WHERE c.slot = 1`,
        args: [],
      });
      if (result.rows.length === 0) {
        return { ok: true, status: "none" };
      }
      return interpretGameRow(result.rows[0]!);
    } catch (error) {
      logError("getCurrentGame read failed", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  async function replaceCurrentGame(
    input: ReplaceCurrentGameInput,
  ): Promise<ReplaceCurrentGameResult> {
    try {
      await ensureSchema();
    } catch (error) {
      logError("replaceCurrentGame prepare failed", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }

    try {
      const tx = await getClient().transaction("write");
      try {
        const pointer = await tx.execute({
          sql: "SELECT game_id FROM current_game WHERE slot = 1",
          args: [],
        });
        if (pointer.rows.length === 0) {
          return { ok: false, code: "NO_ACTIVE_GAME" };
        }
        if (pointer.rows[0]?.["game_id"] !== input.expectedCurrentGameId) {
          return { ok: false, code: "STALE_GAME_REVISION" };
        }

        const expected = await tx.execute({
          sql: "SELECT revision FROM game_records WHERE game_id = ?",
          args: [input.expectedCurrentGameId],
        });
        if (expected.rows.length === 0) {
          return { ok: false, code: "NO_ACTIVE_GAME" };
        }
        if (expected.rows[0]?.["revision"] !== input.expectedRevision) {
          return { ok: false, code: "STALE_GAME_REVISION" };
        }
        const worldStateJson = serializeValidatedWorldState(input.worldState);
        if (worldStateJson === null) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        const storyStateJson = JSON.stringify(input.storyState);

        await tx.execute({
          sql: `INSERT INTO game_records (game_id, record_version, world_state_json, story_state_json, created_at, revision)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            input.gameId,
            GAME_RECORD_VERSION,
            worldStateJson,
            storyStateJson,
            input.createdAt,
            INITIAL_REVISION,
          ],
        });
        const replaced = await tx.execute({
          sql: "UPDATE current_game SET game_id = ? WHERE slot = 1 AND game_id = ?",
          args: [input.gameId, input.expectedCurrentGameId],
        });
        if (Number(replaced.rowsAffected ?? 0) !== 1) {
          return { ok: false, code: "STALE_GAME_REVISION" };
        }

        if (input.openingHistory !== undefined) {
          await tx.execute({
            sql: `INSERT INTO opening_history
                  (game_type, fingerprint, semantic_fingerprint, semantic_text, summary, profile_json, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [
              input.openingHistory.gameType,
              input.openingHistory.fingerprint,
              input.openingHistory.semanticFingerprint,
              input.openingHistory.semanticText,
              input.openingHistory.summary,
              JSON.stringify(input.openingHistory.profile),
              input.openingHistory.createdAt,
            ],
          });
        }

        await tx.commit();
        return { ok: true };
      } finally {
        tx.close();
      }
    } catch (error) {
      logError("replaceCurrentGame transaction failed, rolled back", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  async function applyState(
    input: ApplyStateInput,
    options: { readonly preserveAcknowledgedPrologue?: boolean } = {},
  ): Promise<ApplyStateResult> {
    try {
      await ensureSchema();
    } catch (error) {
      logError("applyState prepare failed", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }

    try {
      const tx = await getClient().transaction("write");
      try {
        const pointer = await tx.execute({
          sql: "SELECT game_id FROM current_game WHERE slot = 1",
          args: [],
        });
        if (pointer.rows.length === 0) {
          return { ok: false, code: "NO_ACTIVE_GAME" };
        }
        const activeGameId = pointer.rows[0]?.["game_id"];
        if (activeGameId !== input.gameId) {
          return { ok: false, code: "NO_ACTIVE_GAME" };
        }

        const currentRecord = await tx.execute({
          sql: "SELECT revision, story_state_json FROM game_records WHERE game_id = ?",
          args: [input.gameId],
        });
        if (currentRecord.rows.length === 0) return { ok: false, code: "NO_ACTIVE_GAME" };
        if (currentRecord.rows[0]?.["revision"] !== input.expectedRevision) return { ok: false, code: "STALE_GAME_REVISION" };
        if (input.expectedNarrativeJob !== undefined) {
          const currentStory = parseJsonObject(currentRecord.rows[0]?.["story_state_json"] as string);
          const narrative = currentStory?.["narrative"];
          if (!isPlainObject(narrative) || narrative["status"] !== input.expectedNarrativeJob.status || !isPlainObject(narrative["job"]) || narrative["job"]["jobId"] !== input.expectedNarrativeJob.jobId) {
            return { ok: false, code: "STALE_GAME_REVISION" };
          }
        }
        const worldStateJson = serializeValidatedWorldState(input.nextWorldState);
        if (worldStateJson === null) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        let storyStateJson: string | null = options.preserveAcknowledgedPrologue === true ? null : JSON.stringify(input.nextStoryState);

        // prologueShown 是只会从 false → true 的展示元数据。场景生成可能在
        // 序幕确认前读取旧快照，因此必须在同一个 write transaction 内读取
        // 当前值并做单调合并，不能让完整 StoryState 写回把确认状态覆盖回去。
        if (options.preserveAcknowledgedPrologue === true) {
          const currentStoryJson = currentRecord.rows[0]?.["story_state_json"];
          if (typeof currentStoryJson !== "string") {
            return { ok: false, code: "NO_ACTIVE_GAME" };
          }
          const currentStory = parseJsonObject(currentStoryJson);
          if (currentStory === null) {
            return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
          }
          storyStateJson = JSON.stringify({
            ...input.nextStoryState,
            prologueShown: currentStory["prologueShown"] === true || input.nextStoryState.prologueShown,
          });
        }
        if (storyStateJson === null) {
          return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        }

        const incrementRevision = input.incrementRevision ?? true;
        const narrativePredicate = input.expectedNarrativeJob === undefined
          ? ""
          : ` AND json_extract(story_state_json, '$.narrative.status') = ?
              AND json_extract(story_state_json, '$.narrative.job.jobId') = ?`;
        const updateResult = await tx.execute({
          sql: `UPDATE game_records SET world_state_json = ?, story_state_json = ?,
                revision = CASE WHEN ? THEN revision + 1 ELSE revision END
                WHERE game_id = ? AND revision = ?${narrativePredicate}`,
          args: [
            worldStateJson,
            storyStateJson,
            incrementRevision ? 1 : 0,
            input.gameId,
            input.expectedRevision,
            ...(input.expectedNarrativeJob === undefined
              ? []
              : [input.expectedNarrativeJob.status, input.expectedNarrativeJob.jobId]),
          ],
        });
        const rowsAffected = Number(updateResult.rowsAffected ?? 0);
        if (rowsAffected === 0) {
          return { ok: false, code: "STALE_GAME_REVISION" };
        }

        const readBack = await tx.execute({
          sql: `SELECT game_id, record_version, world_state_json, story_state_json, created_at, revision
                FROM game_records WHERE game_id = ?`,
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
        const parsedWorldState = validatePersistableWorldState(worldState);
        if (!parsedWorldState.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };

        const record: GameRecord = {
          gameId: asGameId(row["game_id"] as string),
          worldState: parsedWorldState.value,
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
      logError("applyState transaction failed, rolled back", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  async function applySceneWriteBack(input: ApplySceneWriteBackInput): Promise<ApplySceneWriteBackResult> {
    // 场景写回 = 一次原子更新两列 JSON + revision + 1（CAS 走 WHERE game_id AND revision）。
    // 世界演化预览状态与场景包在此同一 CAS 落盘；同时在事务内单调保留
    // 可能与生成并发写入的 prologueShown 元数据。
    return applyState({
      gameId: input.gameId,
      expectedRevision: input.expectedRevision,
      nextWorldState: input.nextWorldState,
      nextStoryState: input.nextStoryState,
    }, { preserveAcknowledgedPrologue: true });
  }

  async function clearCurrentGame(): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" }> {
    try {
      await ensureSchema();
      const tx = await getClient().transaction("write");
      try {
        await tx.execute({
          sql: "DELETE FROM current_game WHERE slot = 1",
          args: [],
        });
        await tx.execute({
          sql: "DELETE FROM game_records",
          args: [],
        });
        await tx.commit();
        return { ok: true };
      } finally {
        tx.close();
      }
    } catch (error) {
      logError("clearCurrentGame failed", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  async function listOpeningHistory(input: {
    readonly gameType: GameTypeId;
    readonly limit: number;
  }): Promise<{ readonly ok: true; readonly records: readonly OpeningNoveltyRecord[] } | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" }> {
    try {
      await ensureSchema();
      const result = await getClient().execute({
        sql: `SELECT game_type, fingerprint, semantic_fingerprint, semantic_text, summary, profile_json, created_at
              FROM opening_history WHERE game_type = ? ORDER BY history_id DESC LIMIT ?`,
        args: [input.gameType, Math.max(0, Math.floor(input.limit))],
      });
      const records = result.rows
        .map((row) => parseOpeningHistoryRow(row))
        .filter((record): record is OpeningNoveltyRecord => record !== null);
      return { ok: true, records };
    } catch (error) {
      logError("listOpeningHistory read failed", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  return {
    createInitialGame,
    replaceCurrentGame,
    getCurrentGame,
    applyState,
    applySceneWriteBack,
    clearCurrentGame,
    listOpeningHistory,
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
