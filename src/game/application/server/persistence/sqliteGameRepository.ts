import type { GameState, ScenarioBlueprint } from "@/game/domain";
import {
  asGameId,
  type CorruptGameReason,
  type CreateInitialGameInput,
  type CreateInitialGameResult,
  type GameRepository,
  type GetCurrentGameRecordResult
} from "./gameRepository";
import type { SqliteClient, SqliteClientFactory, SqliteStatement } from "./sqliteClient";

// ---------------------------------------------------------------------------
// SQLite adapter（Task 2）：GameRepository 端口的 libsql 实现。
//   - schema 版本化且可重复初始化（CREATE TABLE IF NOT EXISTS + schema_meta）；
//   - createInitialGame 在单个写事务内写入存档行与 current_game 指针，
//     任一步失败整体回滚，「蓝图成功、状态失败」不可能发生；
//   - 读取防御性 JSON 解析并校验记录版本 / generationId 一致性，坏数据只标记
//     corrupt，绝不自动重置或覆盖；
//   - 所有失败只返回端口定义的稳定代码，SQL/libsql 细节仅进注入的 logError。
// ---------------------------------------------------------------------------

/** 整库 schema 版本：写入 schema_meta，供后续迁移识别；不匹配视为基础设施问题。 */
export const GAME_SCHEMA_VERSION = 1;

/** 存档行的记录格式版本：读取时不匹配即 corrupt(VERSION_MISMATCH)。 */
export const GAME_RECORD_VERSION = 1;

// 幂等建表语句：值一律走 args 参数化，禁止拼接 SQL 字符串。
const SCHEMA_STATEMENTS: readonly SqliteStatement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS schema_meta (
            meta_key TEXT PRIMARY KEY,
            meta_value TEXT NOT NULL
          )`
  },
  {
    sql: `INSERT INTO schema_meta (meta_key, meta_value) VALUES ('schema_version', ?)
          ON CONFLICT(meta_key) DO NOTHING`,
    args: [String(GAME_SCHEMA_VERSION)]
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS games (
            game_id TEXT PRIMARY KEY,
            record_version INTEGER NOT NULL,
            generation_id TEXT NOT NULL,
            blueprint_json TEXT NOT NULL,
            state_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          )`
  },
  {
    // 单槽指针：CHECK(slot = 1) 从 schema 层面保证同时最多一个 active game。
    sql: `CREATE TABLE IF NOT EXISTS current_game (
            slot INTEGER PRIMARY KEY CHECK (slot = 1),
            game_id TEXT NOT NULL
          )`
  }
];

export type SqliteGameRepositoryOptions = {
  readonly clientFactory: SqliteClientFactory;
  /** 基础设施异常细节的唯一出口：默认写 server 端 console，测试注入静默 spy。 */
  readonly logError?: (context: string, error: unknown) => void;
};

export type SqliteGameRepository = GameRepository & {
  /** 幂等初始化 schema：各方法首次使用时也会自动执行；失败直接抛错（非端口方法）。 */
  initializeSchema(): Promise<void>;
  /** 释放底层客户端：Windows 下便于测试删除临时文件；重复调用安全。 */
  close(): Promise<void>;
};

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 防御性解析：任何异常/非对象结果都归为 null，由调用方标记 corrupt。
function parseJsonObject(text: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function corrupt(reason: CorruptGameReason): GetCurrentGameRecordResult {
  return { ok: true, status: "corrupt", reason };
}

// 单行 → 结构化结果：只做端口要求的版本 / generationId 校验与形状检查，
// 不做蓝图内部引用完整性校验（Task 1 评审确认由上游编译器保证）。
function interpretGameRow(row: Record<string, unknown>): GetCurrentGameRecordResult {
  const gameId = row["game_id"];
  const recordVersion = row["record_version"];
  const blueprintJson = row["blueprint_json"];
  const stateJson = row["state_json"];
  const createdAt = row["created_at"];
  // LEFT JOIN 下指针悬空（games 行缺失）或列类型不对：记录无法成形。
  if (
    typeof gameId !== "string" ||
    typeof blueprintJson !== "string" ||
    typeof stateJson !== "string" ||
    typeof createdAt !== "string"
  ) {
    return corrupt("UNPARSEABLE_RECORD");
  }
  if (recordVersion !== GAME_RECORD_VERSION) {
    return corrupt("VERSION_MISMATCH");
  }

  const blueprint = parseJsonObject(blueprintJson);
  const state = parseJsonObject(stateJson);
  if (blueprint === null || state === null) {
    return corrupt("UNPARSEABLE_RECORD");
  }
  // 域内版本字段：蓝图 schemaVersion 与状态 stateVersion 都必须是当前支持的 1。
  if (blueprint["schemaVersion"] !== 1 || state["stateVersion"] !== 1) {
    return corrupt("VERSION_MISMATCH");
  }
  const blueprintGenerationId = blueprint["generationId"];
  if (typeof blueprintGenerationId !== "string" || blueprintGenerationId.length === 0) {
    return corrupt("UNPARSEABLE_RECORD");
  }
  const generation = state["generation"];
  const stateGenerationId = isPlainObject(generation) ? generation["generationId"] : undefined;
  if (stateGenerationId !== blueprintGenerationId) {
    return corrupt("GENERATION_MISMATCH");
  }

  return {
    ok: true,
    status: "active",
    record: {
      gameId: asGameId(gameId),
      // 通过全部防御性检查后按端口契约还原类型；深度结构由写入侧的编译器保证。
      blueprint: blueprint as unknown as ScenarioBlueprint,
      state: state as unknown as GameState,
      createdAt
    }
  };
}

export function createSqliteGameRepository(
  options: SqliteGameRepositoryOptions
): SqliteGameRepository {
  const logError =
    options.logError ??
    ((context: string, error: unknown) => {
      // 默认只进 server 端日志：绝不把异常文本放进返回结果。
      console.error(`[sqliteGameRepository] ${context}`, error);
    });

  let client: SqliteClient | null = null;
  // 同实例内的快捷缓存；语句本身幂等，跨实例对同一文件重复执行安全。
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
    const meta = await db.execute({
      sql: "SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'",
      args: []
    });
    const stored = meta.rows[0]?.["meta_value"];
    if (stored !== String(GAME_SCHEMA_VERSION)) {
      // 整库版本不认识属于部署/迁移问题：交由调用方映射为基础设施失败。
      throw new Error(`不支持的 schema_version：${String(stored)}`);
    }
    schemaReady = true;
  }

  async function createInitialGame(
    input: CreateInitialGameInput
  ): Promise<CreateInitialGameResult> {
    let blueprintJson: string;
    let stateJson: string;
    try {
      await ensureSchema();
      // 序列化放在事务外：载荷无法序列化时事务根本不必开启。
      blueprintJson = JSON.stringify(input.blueprint);
      stateJson = JSON.stringify(input.state);
    } catch (error) {
      logError("createInitialGame 准备阶段失败", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }

    try {
      const tx = await getClient().transaction("write");
      try {
        // 写事务内检查指针：已有 active game 一律不覆盖、不删除。
        const existing = await tx.execute({
          sql: "SELECT game_id FROM current_game WHERE slot = 1",
          args: []
        });
        if (existing.rows.length > 0) {
          return { ok: false, code: "ACTIVE_GAME_EXISTS" };
        }
        await tx.execute({
          sql: `INSERT INTO games (game_id, record_version, generation_id, blueprint_json, state_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            input.gameId,
            GAME_RECORD_VERSION,
            input.blueprint.generationId,
            blueprintJson,
            stateJson,
            input.createdAt
          ]
        });
        await tx.execute({
          sql: "INSERT INTO current_game (slot, game_id) VALUES (1, ?)",
          args: [input.gameId]
        });
        await tx.commit();
        return { ok: true };
      } finally {
        // 未 commit 时 close 即 ROLLBACK：存档行与指针要么全有、要么全无。
        tx.close();
      }
    } catch (error) {
      logError("createInitialGame 事务失败，已回滚", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  async function getCurrentGame(): Promise<GetCurrentGameRecordResult> {
    try {
      await ensureSchema();
      const result = await getClient().execute({
        sql: `SELECT g.game_id, g.record_version, g.blueprint_json, g.state_json, g.created_at
              FROM current_game c LEFT JOIN games g ON g.game_id = c.game_id
              WHERE c.slot = 1`,
        args: []
      });
      if (result.rows.length === 0) {
        return { ok: true, status: "none" };
      }
      return interpretGameRow(result.rows[0]);
    } catch (error) {
      logError("getCurrentGame 读取失败", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  return {
    createInitialGame,
    getCurrentGame,
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
    }
  };
}
