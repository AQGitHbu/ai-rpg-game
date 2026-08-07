import type { GameState, ScenarioBlueprint } from "@/game/domain";
import { NOOP_GAME_LOGGER } from "@/game/logging";
import {
  asGameId,
  type ApplyBlueprintExpansionInput,
  type ApplyResolvedActionInput,
  type ApplyResolvedActionResult,
  type ClearCurrentGameResult,
  type DevelopmentGameRepository,
  type CorruptGameReason,
  type CreateInitialGameInput,
  type CreateInitialGameResult,
  type GameRecord,
  type GameRepository,
  type GetCurrentGameRecordResult
} from "./gameRepository";
import type { SqliteClient, SqliteClientFactory, SqliteStatement } from "./sqliteClient";

// ---------------------------------------------------------------------------
// SQLite adapter（Phase 2 + Phase 3）：GameRepository 端口的 libsql 实现。
//   - schema 版本化且可重复初始化（CREATE TABLE IF NOT EXISTS + schema_meta）；
//   - Phase 3: schema v1→v2 migration 追加 revision 列，旧记录补 revision 0；
//   - createInitialGame 在单个写事务内写入存档行与 current_game 指针，
//     任一步失败整体回滚，「蓝图成功、状态失败」不可能发生；
//   - applyResolvedAction 以 compare-and-swap 原子更新 state + revision；
//   - 读取防御性 JSON 解析并校验记录版本 / generationId 一致性，坏数据只标记
//     corrupt，绝不自动重置或覆盖；
//   - 所有失败只返回端口定义的稳定代码，SQL/libsql 细节仅进注入的 logError。
// ---------------------------------------------------------------------------

/** 整库 schema 版本：v2 新增 revision 列。 */
export const GAME_SCHEMA_VERSION = 2;

/** 存档行的记录格式版本：读取时不匹配即 corrupt(VERSION_MISMATCH)。 */
export const GAME_RECORD_VERSION = 1;

/** 初始 revision：新存档与 v1 迁移后的旧记录均为 0。 */
export const INITIAL_REVISION = 0;

// 幂等建表语句（v2 schema）：fresh DB 直接建含 revision 列的表。
const SCHEMA_STATEMENTS: readonly SqliteStatement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS schema_meta (
            meta_key TEXT PRIMARY KEY,
            meta_value TEXT NOT NULL
          )`
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS games (
            game_id TEXT PRIMARY KEY,
            record_version INTEGER NOT NULL,
            generation_id TEXT NOT NULL,
            blueprint_json TEXT NOT NULL,
            state_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT ${INITIAL_REVISION}
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

export type SqliteGameRepository = GameRepository & DevelopmentGameRepository & {
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

// Phase 4 Task 3：Phase 3 旧存档的 stateJSON 无 visitedLocationIds 字段。
// 读取时补默认值 [currentLocationId]（与 initializeGameState 的开场语义一致），
// 不升 schema 版本也不回写；连 currentLocationId 都缺失则无法补齐，由调用方标记 corrupt。
function withVisitedLocationDefault(state: JsonObject): JsonObject | null {
  if (state["visitedLocationIds"] !== undefined) {
    return state;
  }
  const currentLocationId = state["currentLocationId"];
  if (typeof currentLocationId !== "string" || currentLocationId.length === 0) {
    return null;
  }
  return { ...state, visitedLocationIds: [currentLocationId] };
}

// Phase 5 Task 3：Phase 4 旧存档的蓝图地点无 availableItemIds 字段。
// 读取时补默认 []（旧地点无预置物品），不升 schema 版本也不回写；
// 保证 validateIntent 的 availableItemIds 读取不会在旧档上抛错。
function withAvailableItemsDefault(blueprint: JsonObject): JsonObject {
  const locations = blueprint["locations"];
  if (!Array.isArray(locations)) {
    return blueprint;
  }
  let changed = false;
  const patched = locations.map((entry) => {
    if (isPlainObject(entry) && entry["availableItemIds"] === undefined) {
      changed = true;
      return { ...entry, availableItemIds: [] };
    }
    return entry;
  });
  return changed ? { ...blueprint, locations: patched } : blueprint;
}

// Phase 6 Task 1：Phase 1–5 旧存档的蓝图敌人无 locationId 字段。
// 读取时补默认值：取第一个地点 ID 作为 locationId（旧敌人不自动暴露为 battle 行动，
// start_battle 校验会检查全部前置条件）。不升 schema 版本也不回写。
function withEnemyLocationIdDefault(blueprint: JsonObject): JsonObject {
  const enemies = blueprint["enemies"];
  if (!Array.isArray(enemies)) {
    return blueprint;
  }
  const locations = blueprint["locations"];
  let fallbackLocationId: string | undefined;
  if (Array.isArray(locations)) {
    const firstLocation = locations.find((entry) => isPlainObject(entry) && typeof entry["id"] === "string");
    fallbackLocationId = isPlainObject(firstLocation ?? null) ? (firstLocation as JsonObject)["id"] as string : undefined;
  }
  if (fallbackLocationId === undefined) {
    return blueprint;
  }
  let changed = false;
  const patched = enemies.map((entry) => {
    if (isPlainObject(entry) && entry["locationId"] === undefined) {
      changed = true;
      return { ...entry, locationId: fallbackLocationId };
    }
    return entry;
  });
  return changed ? { ...blueprint, enemies: patched } : blueprint;
}

// Phase 6 Task 1：Phase 1–5 旧存档的 stateJSON 无 defeatedEnemyIds / battle / ending 字段。
// 读取时补默认值（与 initializeGameState 的初始语义一致），不升 schema 版本也不回写。
function withPhase6StateDefaults(state: JsonObject): JsonObject {
  let patched = state;
  if (patched["defeatedEnemyIds"] === undefined) {
    patched = { ...patched, defeatedEnemyIds: [] };
  }
  if (patched["battle"] === undefined) {
    patched = { ...patched, battle: { status: "idle" } };
  }
  if (patched["ending"] === undefined) {
    patched = { ...patched, ending: null };
  }
  return patched;
}

// Town 层：Phase 1–10 旧存档的 stateJSON 无 towns / townGeneration 字段。
// 读取时补默认值（与 initializeGameState 的初始语义一致），不升 schema
// 版本也不回写——复刻 withNarrativeDefault 的零迁移模式。
function withTownDefaults(state: JsonObject): JsonObject {
  let patched = state;
  if (patched["towns"] === undefined) {
    patched = { ...patched, towns: [] };
  }
  if (patched["townGeneration"] === undefined) {
    patched = { ...patched, townGeneration: { status: "idle" } };
  }
  return patched;
}

// Phase 10：旧存档无 narrative / generation 字段时补 idle 默认值，
// 不升 schema 版本也不回写。
function withNarrativeDefault(state: JsonObject): JsonObject {
  const narrative = state["narrative"];
  if (!isPlainObject(narrative)) {
    return { ...state, narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" } };
  }
  if (isPlainObject(narrative["generation"]) && narrative["mode"] !== undefined) return state;
  return {
    ...state,
    narrative: {
      ...narrative,
      generation: isPlainObject(narrative["generation"]) ? narrative["generation"] : { status: "idle" },
      mode: narrative["mode"] ?? "ai",
    },
  };
}

// Phase 14：旧存档（无 startAnchor 字段）补默认值——从 locations[0]/npcs[0]/quests[0] 推导。
// 任一数组缺失则回退到 "loc_1"/"npc_1"/"quest_main_1"，不升 schema 版本也不回写。
function withStartAnchorDefault(blueprint: JsonObject): JsonObject {
  if (blueprint["startAnchor"] !== undefined) return blueprint;
  const locations = blueprint["locations"] as readonly JsonObject[] | undefined;
  const npcs = blueprint["npcs"] as readonly JsonObject[] | undefined;
  const quests = blueprint["quests"] as readonly JsonObject[] | undefined;
  const firstLocationId = locations?.[0]?.["id"] ?? "loc_1";
  const firstNpcId = npcs?.[0]?.["id"] ?? "npc_1";
  const firstQuestId = quests?.[0]?.["id"] ?? "quest_main_1";
  return { ...blueprint, startAnchor: { locationId: firstLocationId, npcId: firstNpcId, startQuestId: firstQuestId } };
}

// Phase 14：旧存档（无 endingDirection 字段）补默认值——lockedAt 从 budgetPolicy.mainActs 推导。
// mainActs 缺失时回退 3，lockedAt = Math.ceil(mainActs / 2)；theme 从 world.themes[0] 取，缺失回退 "未定"。
function withEndingDirectionDefault(blueprint: JsonObject): JsonObject {
  if (blueprint["endingDirection"] !== undefined) return blueprint;
  const budgetPolicy = blueprint["budgetPolicy"] as JsonObject | undefined;
  const mainActs = (budgetPolicy?.["mainActs"] as number | undefined) ?? 3;
  const world = blueprint["world"] as JsonObject | undefined;
  const themes = (world?.["themes"] as readonly string[] | undefined) ?? [];
  const theme = themes[0] ?? "未定";
  return {
    ...blueprint,
    endingDirection: {
      theme,
      possibleTones: ["triumph", "tragedy", "bittersweet", "ambiguous"],
      lockedAt: Math.ceil(mainActs / 2),
    },
  };
}

// Phase 14：旧存档 state 无 prologueShown 字段时补 true（已过开场）。
// 旧档默认已完成序幕播放，不升 schema 版本也不回写。
function withPrologueDefault(state: JsonObject): JsonObject {
  if (state["prologueShown"] !== undefined) return state;
  return { ...state, prologueShown: true };
}

// Phase 14：旧存档 state 无 mainStoryProgress 字段时补默认值。
// currentAct 根据 eventLedger 中已完成的主线任务数量推导（与 reconcileMainStoryProgress
// 语义一致：仅统计 blueprint.quests.kind==="main" 的 questId）；endingProposed 恒为 false。
function withMainStoryProgressDefault(
  state: JsonObject,
  blueprint: JsonObject,
): JsonObject {
  if (state["mainStoryProgress"] !== undefined) return state;
  const mainQuestIds = new Set<string>();
  const quests = blueprint["quests"];
  if (Array.isArray(quests)) {
    for (const q of quests) {
      if (isPlainObject(q) && q["kind"] === "main" && typeof q["id"] === "string") {
        mainQuestIds.add(q["id"]);
      }
    }
  }
  const eventLedger = (state["eventLedger"] as readonly JsonObject[] | undefined) ?? [];
  const completedMainQuests = eventLedger.filter(
    (e) =>
      e["type"] === "quest_completed" &&
      typeof e["questId"] === "string" &&
      mainQuestIds.has(e["questId"]),
  ).length;
  return {
    ...state,
    mainStoryProgress: {
      currentAct: completedMainQuests,
      endingProposed: false,
    },
  };
}

// ---------------------------------------------------------------------------
// 单一迁移出口：所有读取路径共用同一组 with*Default 链。
//   - migrateBlueprint：availableItems → enemyLocationId → startAnchor → endingDirection
//   - migrateStateOrNull：visited（可能失败）→ narrative → town → phase14 → phase6
// 集中管理后新增字段的迁移只需在此文件修改一次，避免 interpretGameRow 与
// applyResolvedAction/applyBlueprintExpansion 三处漂移（fc71150 正是此类漏改修复）。
// ---------------------------------------------------------------------------

function migrateBlueprint(blueprint: JsonObject): JsonObject {
  return withEndingDirectionDefault(
    withStartAnchorDefault(withEnemyLocationIdDefault(withAvailableItemsDefault(blueprint))),
  );
}

function migrateStateOrNull(state: JsonObject, blueprint: JsonObject): JsonObject | null {
  const visited = withVisitedLocationDefault(state);
  if (visited === null) return null;
  const narrative = withTownDefaults(withNarrativeDefault(visited));
  const phase14 = withMainStoryProgressDefault(withPrologueDefault(narrative), blueprint);
  return withPhase6StateDefaults(phase14);
}

// 单行 → 结构化结果：只做端口要求的版本 / generationId 校验与形状检查，
// 不做蓝图内部引用完整性校验（Task 1 评审确认由上游编译器保证）。
// Phase 14：导出供 sqliteGameRepository.test.ts 直接做 v1→2 迁移单元测试。
export function interpretGameRow(row: Record<string, unknown>): GetCurrentGameRecordResult {
  const gameId = row["game_id"];
  const recordVersion = row["record_version"];
  const blueprintJson = row["blueprint_json"];
  const stateJson = row["state_json"];
  const createdAt = row["created_at"];
  const revision = row["revision"];
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
  // revision 必须是非负整数（v1 迁移后 DEFAULT 0，正常写入 ≥ 0）。
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    return corrupt("UNPARSEABLE_RECORD");
  }

  const blueprint = parseJsonObject(blueprintJson);
  const state = parseJsonObject(stateJson);
  if (blueprint === null || state === null) {
    return corrupt("UNPARSEABLE_RECORD");
  }
  // 域内版本字段：Phase 14 接受 schemaVersion 1（旧档）或 2（新档）；stateVersion 仍为 1。
  const blueprintVersion = blueprint["schemaVersion"];
  if ((blueprintVersion !== 1 && blueprintVersion !== 2) || state["stateVersion"] !== 1) {
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
  // 单一迁移出口：blueprint 链 + state 链集中管理（见 migrateBlueprint/migrateStateOrNull）。
  const migratedState = migrateStateOrNull(state, blueprint);
  if (migratedState === null) {
    return corrupt("UNPARSEABLE_RECORD");
  }
  const migratedBlueprint = migrateBlueprint(blueprint);

  return {
    ok: true,
    status: "active",
    record: {
      gameId: asGameId(gameId),
      // 通过全部防御性检查后按端口契约还原类型；深度结构由写入侧的编译器保证。
      blueprint: migratedBlueprint as unknown as ScenarioBlueprint,
      state: migratedState as unknown as GameState,
      revision,
      createdAt
    }
  };
}

export function createSqliteGameRepository(
  options: SqliteGameRepositoryOptions
): SqliteGameRepository {
  const logError =
    options.logError ??
    ((context: string, _error: unknown) => {
      // production composition root 注入真正的脱敏 server logger；默认不输出。
      NOOP_GAME_LOGGER.error("sqlite_repository_failure", { operation: context });
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

    // Step 1: 幂等建表（fresh DB 直接建含 revision 列的 v2 表）。
    await db.batch([...SCHEMA_STATEMENTS], "write");

    // Step 2: 读取当前 schema 版本。
    const meta = await db.execute({
      sql: "SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'",
      args: []
    });
    const stored = meta.rows[0]?.["meta_value"];

    if (stored === undefined) {
      // Fresh DB：schema_meta 行尚不存在（CREATE TABLE IF NOT EXISTS 不插入数据）。
      // 写入当前版本号。
      await db.execute({
        sql: "INSERT INTO schema_meta (meta_key, meta_value) VALUES ('schema_version', ?)",
        args: [String(GAME_SCHEMA_VERSION)]
      });
    } else if (stored === "1") {
      // v1 → v2 migration：追加 revision 列，旧记录 DEFAULT 0。
      // ALTER TABLE 在事务中执行，保证幂等且原子。
      const tx = await db.transaction("write");
      try {
        await tx.execute({
          sql: `ALTER TABLE games ADD COLUMN revision INTEGER NOT NULL DEFAULT ${INITIAL_REVISION}`,
          args: []
        });
        await tx.execute({
          sql: "UPDATE schema_meta SET meta_value = ? WHERE meta_key = 'schema_version'",
          args: [String(GAME_SCHEMA_VERSION)]
        });
        await tx.commit();
      } finally {
        tx.close();
      }
    } else if (stored !== String(GAME_SCHEMA_VERSION)) {
      // 未知未来版本：安全失败，绝不重置玩家存档。
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
          sql: `INSERT INTO games (game_id, record_version, generation_id, blueprint_json, state_json, created_at, revision)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            input.gameId,
            GAME_RECORD_VERSION,
            input.blueprint.generationId,
            blueprintJson,
            stateJson,
            input.createdAt,
            INITIAL_REVISION
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
        sql: `SELECT g.game_id, g.record_version, g.blueprint_json, g.state_json, g.created_at, g.revision
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

  async function applyResolvedAction(
    input: ApplyResolvedActionInput
  ): Promise<ApplyResolvedActionResult> {
    let stateJson: string;
    try {
      await ensureSchema();
      stateJson = JSON.stringify(input.nextState);
    } catch (error) {
      logError("applyResolvedAction 准备阶段失败", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }

    try {
      const tx = await getClient().transaction("write");
      try {
        // 检查 current_game 指针：无 active game 时返回稳定代码。
        const pointer = await tx.execute({
          sql: "SELECT game_id FROM current_game WHERE slot = 1",
          args: []
        });
        if (pointer.rows.length === 0) {
          return { ok: false, code: "NO_ACTIVE_GAME" };
        }
        const activeGameId = pointer.rows[0]?.["game_id"];
        if (activeGameId !== input.gameId) {
          return { ok: false, code: "NO_ACTIVE_GAME" };
        }

        // Compare-and-swap：条件更新 state + revision。
        // WHERE game_id = ? AND revision = ? 确保只有期望版本才更新。
        const updateResult = await tx.execute({
          sql: `UPDATE games SET state_json = ?, revision = revision + 1
                WHERE game_id = ? AND revision = ?`,
          args: [stateJson, input.gameId, input.expectedRevision]
        });
        const rowsAffected = Number(updateResult.rowsAffected ?? 0);
        if (rowsAffected === 0) {
          // revision 不匹配：并发写入或客户端使用旧 revision。
          return { ok: false, code: "STALE_GAME_REVISION" };
        }

        // 读回完整记录以返回给 application 层投影 view。
        const readBack = await tx.execute({
          sql: `SELECT game_id, record_version, blueprint_json, state_json, created_at, revision
                FROM games WHERE game_id = ?`,
          args: [input.gameId]
        });
        const row = readBack.rows[0];
        if (row === undefined) {
          // 理论不可达（刚更新成功），但防御性处理。
          return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        }

        const blueprint = parseJsonObject(row["blueprint_json"] as string);
        const state = parseJsonObject(row["state_json"] as string);
        if (blueprint === null || state === null) {
          return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        }

        const migratedBlueprint = migrateBlueprint(blueprint);
        const migratedState = migrateStateOrNull(state, migratedBlueprint) ?? state;
        const record: GameRecord = {
          gameId: asGameId(row["game_id"] as string),
          // 单一迁移出口：与 interpretGameRow 完全一致的链路（见 migrateBlueprint/migrateStateOrNull）。
          blueprint: migratedBlueprint as unknown as ScenarioBlueprint,
          state: migratedState as unknown as GameState,
          revision: row["revision"] as number,
          createdAt: row["created_at"] as string
        };

        await tx.commit();
        return { ok: true, record };
      } finally {
        // 未 commit 时 close 即 ROLLBACK：旧 state/revision 完整保留。
        tx.close();
      }
    } catch (error) {
      logError("applyResolvedAction 事务失败，已回滚", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  async function applyBlueprintExpansion(
    input: ApplyBlueprintExpansionInput
  ): Promise<ApplyResolvedActionResult> {
    let blueprintJson: string;
    let stateJson: string;
    try {
      await ensureSchema();
      blueprintJson = JSON.stringify(input.nextBlueprint);
      stateJson = JSON.stringify(input.nextState);
    } catch (error) {
      logError("applyBlueprintExpansion 准备阶段失败", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }

    try {
      const tx = await getClient().transaction("write");
      try {
        const pointer = await tx.execute({
          sql: "SELECT game_id FROM current_game WHERE slot = 1",
          args: []
        });
        if (pointer.rows.length === 0) {
          return { ok: false, code: "NO_ACTIVE_GAME" };
        }
        const activeGameId = pointer.rows[0]?.["game_id"];
        if (activeGameId !== input.gameId) {
          return { ok: false, code: "NO_ACTIVE_GAME" };
        }

        const updateResult = await tx.execute({
          sql: `UPDATE games SET blueprint_json = ?, state_json = ?, revision = revision + 1
                WHERE game_id = ? AND revision = ?`,
          args: [blueprintJson, stateJson, input.gameId, input.expectedRevision]
        });
        const rowsAffected = Number(updateResult.rowsAffected ?? 0);
        if (rowsAffected === 0) {
          return { ok: false, code: "STALE_GAME_REVISION" };
        }

        const readBack = await tx.execute({
          sql: `SELECT game_id, record_version, blueprint_json, state_json, created_at, revision
                FROM games WHERE game_id = ?`,
          args: [input.gameId]
        });
        const row = readBack.rows[0];
        if (row === undefined) {
          return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        }

        const blueprint = parseJsonObject(row["blueprint_json"] as string);
        const state = parseJsonObject(row["state_json"] as string);
        if (blueprint === null || state === null) {
          return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        }

        const migratedBlueprint = migrateBlueprint(blueprint);
        const migratedState = migrateStateOrNull(state, migratedBlueprint) ?? state;
        const record: GameRecord = {
          gameId: asGameId(row["game_id"] as string),
          // 单一迁移出口：与 interpretGameRow 完全一致的链路（见 migrateBlueprint/migrateStateOrNull）。
          blueprint: migratedBlueprint as unknown as ScenarioBlueprint,
          state: migratedState as unknown as GameState,
          revision: row["revision"] as number,
          createdAt: row["created_at"] as string
        };

        await tx.commit();
        return { ok: true, record };
      } finally {
        tx.close();
      }
    } catch (error) {
      logError("applyBlueprintExpansion 事务失败，已回滚", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  async function clearCurrentGame(): Promise<ClearCurrentGameResult> {
    try {
      await ensureSchema();
      const tx = await getClient().transaction("write");
      try {
        const pointer = await tx.execute({
          sql: "SELECT game_id FROM current_game WHERE slot = 1",
          args: []
        });
        if (pointer.rows.length === 0) {
          await tx.commit();
          return { ok: true, status: "none" };
        }
        const gameId = pointer.rows[0]?.["game_id"];
        if (typeof gameId !== "string") {
          return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        }
        // 顺序不可交换：先删除指针，再只删除它指向的那一行，绝不触碰 schema/其它表。
        await tx.execute({ sql: "DELETE FROM current_game WHERE slot = 1", args: [] });
        await tx.execute({ sql: "DELETE FROM games WHERE game_id = ?", args: [gameId] });
        await tx.commit();
        return { ok: true, status: "cleared" };
      } finally {
        tx.close();
      }
    } catch (error) {
      logError("clearCurrentGame 事务失败，已回滚", error);
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
  }

  return {
    createInitialGame,
    getCurrentGame,
    applyResolvedAction,
    applyBlueprintExpansion,
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
    }
  };
}
