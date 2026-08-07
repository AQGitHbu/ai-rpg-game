/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GameState, NewGameInput, ScenarioBlueprint } from "@/game/domain";
import wuxiaFixture from "../../../../../data/fixtures/phase1/wuxia.json";
import { runScenarioPipeline } from "../../applicationFixture.testutil";
import { asGameId, type ApplyBlueprintExpansionInput, type ApplyResolvedActionInput, type CreateInitialGameInput } from "./gameRepository";
import { createSqliteClient, type SqliteClient } from "./sqliteClient";
import {
  createSqliteGameRepository,
  GAME_RECORD_VERSION,
  GAME_SCHEMA_VERSION,
  INITIAL_REVISION,
  interpretGameRow,
  type SqliteGameRepository
} from "./sqliteGameRepository";

// ---------------------------------------------------------------------------
// Task 2：SQLite adapter 集成测试——真实 libsql 客户端 + tmp/ 下的一次性文件，
// 不 mock adapter 本身。覆盖 plan 要求：初始化幂等、round-trip、重复创建不
// 覆盖、事务中注入故障整体回滚、损坏 JSON / 版本不兼容 / generationId 不一致
// 的 corrupt 响应、基础设施失败的稳定结果（不泄漏 SQL/libsql 异常文本）。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;

// 每次运行独立目录 + 每用例独立文件：Windows 下 libsql 可能延迟释放句柄，
// 清理只能尽力而为，残留文件不影响后续运行。
const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-game-repository-";
// 先清扫上一轮运行的残留：旧进程已退出，句柄已释放，此时删除必然安全。
try {
  for (const entry of readdirSync(TMP_ROOT)) {
    if (entry.startsWith(RUN_PREFIX)) {
      try {
        rmSync(join(TMP_ROOT, entry), { recursive: true, force: true });
      } catch {
        /* 仍被占用：忽略 */
      }
    }
  }
} catch {
  /* tmp/ 尚不存在 */
}
const RUN_ROOT = join(TMP_ROOT, `${RUN_PREFIX}${Date.now()}-${process.pid}`);
mkdirSync(RUN_ROOT, { recursive: true });

let fileCounter = 0;
function nextDbPath(): string {
  fileCounter += 1;
  return join(RUN_ROOT, `case-${fileCounter}.sqlite`);
}

const openedRepositories: SqliteGameRepository[] = [];
const openedClients: SqliteClient[] = [];

/** 打开真实 adapter：测试一律显式注入临时路径工厂与静默 logError（保持输出干净）。 */
function openRepository(
  databasePath: string,
  clientFactory: () => SqliteClient = () => createSqliteClient(databasePath)
): SqliteGameRepository {
  const repository = createSqliteGameRepository({ clientFactory, logError: () => {} });
  openedRepositories.push(repository);
  return repository;
}

/** 原始客户端：用于直接写坏行或核对底层行数，不经过 adapter。 */
function openRawClient(databasePath: string): SqliteClient {
  const client = createSqliteClient(databasePath);
  openedClients.push(client);
  return client;
}

afterAll(async () => {
  for (const repository of openedRepositories) {
    try {
      await repository.close();
    } catch {
      /* 已关闭 */
    }
  }
  for (const client of openedClients) {
    try {
      client.close();
    } catch {
      /* 已关闭 */
    }
  }
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* Windows 句柄未释放时留待下次运行清理 */
  }
});

// 管线较贵：整份测试共享同一份不可变载荷，各用例写入各自的数据库文件。
const PIPELINE = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);

function buildCreateInput(gameId = "game-sqlite-0001"): CreateInitialGameInput {
  return {
    gameId: asGameId(gameId),
    blueprint: PIPELINE.blueprint,
    state: PIPELINE.state,
    createdAt: "2026-07-27T00:00:00.000Z"
  };
}

/**
 * Phase 14 测试辅助：对期望蓝图应用与 sqliteGameRepository.with*Defaults 相同的默认值。
 * getCurrentGame 经 interpretGameRow 读取时会补 startAnchor/endingDirection 默认值，
 * 旧测试的 toEqual 比较需在期望值上应用同样默认值才能匹配。
 */
function withExpectedPhase14BlueprintDefaults(blueprint: ScenarioBlueprint): ScenarioBlueprint {
  const bp = blueprint as unknown as Record<string, unknown>;
  if (bp["startAnchor"] !== undefined && bp["endingDirection"] !== undefined) {
    return blueprint;
  }
  const locations = bp["locations"] as readonly { readonly id: string }[] | undefined;
  const npcs = bp["npcs"] as readonly { readonly id: string }[] | undefined;
  const quests = bp["quests"] as readonly { readonly id: string }[] | undefined;
  const world = bp["world"] as { readonly themes?: readonly string[] } | undefined;
  const budgetPolicy = bp["budgetPolicy"] as { readonly mainActs?: number } | undefined;
  return {
    ...blueprint,
    startAnchor: bp["startAnchor"] ?? {
      locationId: locations?.[0]?.id ?? "loc_1",
      npcId: npcs?.[0]?.id ?? "npc_1",
      startQuestId: quests?.[0]?.id ?? "quest_main_1"
    },
    endingDirection: bp["endingDirection"] ?? {
      theme: (world?.themes ?? [])[0] ?? "未定",
      possibleTones: ["triumph", "tragedy", "bittersweet"],
      lockedAt: Math.ceil((budgetPolicy?.mainActs ?? 3) / 2)
    }
  } as ScenarioBlueprint;
}

/**
 * Phase 14 测试辅助：对期望状态应用与 sqliteGameRepository.with*Defaults 相同的默认值。
 * getCurrentGame 经 interpretGameRow 读取时会补 prologueShown/mainStoryProgress 默认值。
 */
function withExpectedPhase14StateDefaults(state: GameState): GameState {
  const st = state as unknown as Record<string, unknown>;
  if (st["prologueShown"] !== undefined && st["mainStoryProgress"] !== undefined) {
    return state;
  }
  const eventLedger = (st["eventLedger"] as readonly { readonly type?: string }[] | undefined) ?? [];
  const completedMainQuests = eventLedger.filter((e) => e.type === "quest_completed").length;
  return {
    ...state,
    prologueShown: (st["prologueShown"] as boolean | undefined) ?? true,
    mainStoryProgress: st["mainStoryProgress"] ?? {
      currentAct: completedMainQuests,
      endingProposed: false
    }
  } as GameState;
}

const COUNT_SQL = {
  games: "SELECT COUNT(*) AS total FROM games",
  current_game: "SELECT COUNT(*) AS total FROM current_game"
} as const;

async function countRows(client: SqliteClient, table: keyof typeof COUNT_SQL): Promise<number> {
  const result = await client.execute(COUNT_SQL[table]);
  return Number(result.rows[0]?.["total"] ?? -1);
}

/** 先写入一份合法存档并关闭 writer，供损坏用例用原始客户端改坏后重读。 */
async function seedValidSave(databasePath: string): Promise<CreateInitialGameInput> {
  const input = buildCreateInput();
  const writer = openRepository(databasePath);
  expect(await writer.createInitialGame(input)).toEqual({ ok: true });
  await writer.close();
  return input;
}

describe("sqliteGameRepository：schema 初始化", () => {
  it("跨实例重复初始化幂等，且不破坏已有存档", async () => {
    const databasePath = nextDbPath();
    const first = openRepository(databasePath);
    await first.initializeSchema();
    await first.initializeSchema();
    expect(await first.getCurrentGame()).toEqual({ ok: true, status: "none" });

    expect(await first.createInitialGame(buildCreateInput())).toEqual({ ok: true });
    await first.close();

    // 新实例对同一文件再次初始化：既有存档必须原样保留。
    const second = openRepository(databasePath);
    await second.initializeSchema();
    const loaded = await second.getCurrentGame();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.status).toBe("active");
  });
});

describe("sqliteGameRepository：round-trip", () => {
  it("创建后用全新 repository 实例重开同一文件，读回同一存档", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    const writer = openRepository(databasePath);
    expect(await writer.createInitialGame(input)).toEqual({ ok: true });
    await writer.close();

    const reader = openRepository(databasePath);
    expect(await reader.getCurrentGame()).toEqual({
      ok: true,
      status: "active",
      record: {
        ...input,
        blueprint: withExpectedPhase14BlueprintDefaults(input.blueprint),
        state: withExpectedPhase14StateDefaults(input.state),
        revision: 0
      }
    });
  });
});

describe("sqliteGameRepository：重复创建", () => {
  it("已有 active game 时返回 ACTIVE_GAME_EXISTS，不覆盖任何记录", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    const original = buildCreateInput("game-sqlite-first");
    expect(await repository.createInitialGame(original)).toEqual({ ok: true });

    const second: CreateInitialGameInput = {
      ...buildCreateInput("game-sqlite-second"),
      createdAt: "2026-07-28T00:00:00.000Z"
    };
    expect(await repository.createInitialGame(second)).toEqual({
      ok: false,
      code: "ACTIVE_GAME_EXISTS"
    });

    // 原记录原样保留，且没有写入第二行。
    expect(await repository.getCurrentGame()).toEqual({
      ok: true,
      status: "active",
      record: {
        ...original,
        blueprint: withExpectedPhase14BlueprintDefaults(original.blueprint),
        state: withExpectedPhase14StateDefaults(original.state),
        revision: 0
      }
    });
    const raw = openRawClient(databasePath);
    expect(await countRows(raw, "games")).toBe(1);
    expect(await countRows(raw, "current_game")).toBe(1);
  });
});

describe("sqliteGameRepository：开发环境当前存档清除", () => {
  it("只原子清除当前槽位及其指向的游戏，随后可重新创建", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    const input = buildCreateInput("game-clear-current");
    expect(await repository.createInitialGame(input)).toEqual({ ok: true });

    expect(await repository.clearCurrentGame()).toEqual({ ok: true, status: "cleared" });
    expect(await repository.getCurrentGame()).toEqual({ ok: true, status: "none" });
    const raw = openRawClient(databasePath);
    expect(await countRows(raw, "current_game")).toBe(0);
    expect(await countRows(raw, "games")).toBe(0);

    expect(await repository.clearCurrentGame()).toEqual({ ok: true, status: "none" });
    expect(await repository.createInitialGame(buildCreateInput("game-clear-recreated"))).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// 事务原子性：包一层真实客户端，仅让事务内的 current_game 指针写入失败，
// 其余语句全部走真实 libsql——「蓝图成功、状态失败」必须整体回滚。
// ---------------------------------------------------------------------------

type SqliteTransaction = Awaited<ReturnType<SqliteClient["transaction"]>>;

function wrapTransactionWithPointerFault(tx: SqliteTransaction): SqliteTransaction {
  return new Proxy(tx, {
    get(target, property) {
      if (property === "execute") {
        return (async (stmtOrSql: unknown, args?: unknown) => {
          const sql =
            typeof stmtOrSql === "string" ? stmtOrSql : (stmtOrSql as { sql: string }).sql;
          if (/insert\s+into\s+current_game/i.test(sql)) {
            throw new Error("注入故障：指针写入失败");
          }
          return (target.execute as (a: unknown, b?: unknown) => Promise<unknown>)(
            stmtOrSql,
            args
          );
        }) as SqliteTransaction["execute"];
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function"
        ? (value as (...callArgs: unknown[]) => unknown).bind(target)
        : value;
    }
  });
}

function createPointerFaultClient(real: SqliteClient): SqliteClient {
  openedClients.push(real);
  return new Proxy(real, {
    get(target, property) {
      if (property === "transaction") {
        return (async (mode?: "write" | "read" | "deferred") => {
          const tx = mode === undefined ? await target.transaction() : await target.transaction(mode);
          return wrapTransactionWithPointerFault(tx);
        }) as SqliteClient["transaction"];
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function"
        ? (value as (...callArgs: unknown[]) => unknown).bind(target)
        : value;
    }
  });
}

describe("sqliteGameRepository：事务原子性", () => {
  it("指针写入注入故障时整体回滚：无 current game，也无部分行", async () => {
    const databasePath = nextDbPath();
    const faulty = openRepository(databasePath, () =>
      createPointerFaultClient(createSqliteClient(databasePath))
    );

    expect(await faulty.createInitialGame(buildCreateInput())).toEqual({
      ok: false,
      code: "INFRASTRUCTURE_FAILURE"
    });
    await faulty.close();

    const raw = openRawClient(databasePath);
    expect(await countRows(raw, "games")).toBe(0);
    expect(await countRows(raw, "current_game")).toBe(0);
    // 干净实例读取同一文件：仍是无存档，而不是半成品。
    const reader = openRepository(databasePath);
    expect(await reader.getCurrentGame()).toEqual({ ok: true, status: "none" });
  });
});

describe("sqliteGameRepository：损坏数据只标记 corrupt，绝不自动重置", () => {
  it("blueprint JSON 无法解析 ⇒ UNPARSEABLE_RECORD，坏行原样保留", async () => {
    const databasePath = nextDbPath();
    await seedValidSave(databasePath);
    const raw = openRawClient(databasePath);
    await raw.execute({ sql: "UPDATE games SET blueprint_json = ?", args: ["{broken json"] });

    const reader = openRepository(databasePath);
    expect(await reader.getCurrentGame()).toEqual({
      ok: true,
      status: "corrupt",
      reason: "UNPARSEABLE_RECORD"
    });
    // 不得被自动清理或覆盖。
    expect(await countRows(raw, "games")).toBe(1);
    expect(await countRows(raw, "current_game")).toBe(1);
  });

  it("记录版本不兼容 ⇒ VERSION_MISMATCH", async () => {
    const databasePath = nextDbPath();
    await seedValidSave(databasePath);
    const raw = openRawClient(databasePath);
    await raw.execute({
      sql: "UPDATE games SET record_version = ?",
      args: [GAME_RECORD_VERSION + 999]
    });

    const reader = openRepository(databasePath);
    expect(await reader.getCurrentGame()).toEqual({
      ok: true,
      status: "corrupt",
      reason: "VERSION_MISMATCH"
    });
  });

  it("state 与 blueprint 的 generationId 不一致 ⇒ GENERATION_MISMATCH", async () => {
    const databasePath = nextDbPath();
    const input = await seedValidSave(databasePath);
    const tampered = JSON.parse(JSON.stringify(input.state)) as {
      generation: { generationId: string };
    };
    tampered.generation.generationId = "gen-另一局";
    const raw = openRawClient(databasePath);
    await raw.execute({
      sql: "UPDATE games SET state_json = ?",
      args: [JSON.stringify(tampered)]
    });

    const reader = openRepository(databasePath);
    expect(await reader.getCurrentGame()).toEqual({
      ok: true,
      status: "corrupt",
      reason: "GENERATION_MISMATCH"
    });
  });

  it("指针指向不存在的存档行 ⇒ UNPARSEABLE_RECORD", async () => {
    const databasePath = nextDbPath();
    await seedValidSave(databasePath);
    const raw = openRawClient(databasePath);
    await raw.execute("DELETE FROM games");

    const reader = openRepository(databasePath);
    expect(await reader.getCurrentGame()).toEqual({
      ok: true,
      status: "corrupt",
      reason: "UNPARSEABLE_RECORD"
    });
  });
});

describe("sqliteGameRepository：基础设施失败", () => {
  it("数据库路径不可达 ⇒ 稳定 INFRASTRUCTURE_FAILURE，细节只进注入的 logError", async () => {
    const unreachable = join(RUN_ROOT, "missing-dir", "nested", "broken.sqlite");
    const loggedErrors: unknown[] = [];
    const repository = createSqliteGameRepository({
      clientFactory: () => createSqliteClient(unreachable),
      logError: (_context, error) => {
        loggedErrors.push(error);
      }
    });
    openedRepositories.push(repository);

    // toEqual 精确匹配：结果对象只含稳定代码，绝无 SQL/libsql 异常文本字段。
    expect(await repository.createInitialGame(buildCreateInput())).toEqual({
      ok: false,
      code: "INFRASTRUCTURE_FAILURE"
    });
    expect(await repository.getCurrentGame()).toEqual({
      ok: false,
      code: "INFRASTRUCTURE_FAILURE"
    });
    expect(loggedErrors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 Task 3：v1→v2 schema migration 测试。
// 以可控方式构造真实 v1 SQLite 临时文件（无 revision 列），验证升级到 v2 后
// 状态、蓝图、指针、generationId 都保留且 revision 为 0；重复初始化不改变数据。
// ---------------------------------------------------------------------------

/** 手工构造 v1 schema + 数据（不经过 v2 adapter），模拟 Phase 2 遗留数据库。 */
async function seedV1Database(databasePath: string, input: CreateInitialGameInput): Promise<void> {
  const raw = openRawClient(databasePath);
  await raw.batch([
    { sql: `CREATE TABLE IF NOT EXISTS schema_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL)` },
    { sql: `INSERT INTO schema_meta (meta_key, meta_value) VALUES ('schema_version', '1')` },
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
      sql: `CREATE TABLE IF NOT EXISTS current_game (
              slot INTEGER PRIMARY KEY CHECK (slot = 1),
              game_id TEXT NOT NULL
            )`
    }
  ], "write");
  await raw.execute({
    sql: `INSERT INTO games (game_id, record_version, generation_id, blueprint_json, state_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      input.gameId,
      GAME_RECORD_VERSION,
      input.blueprint.generationId,
      JSON.stringify(input.blueprint),
      JSON.stringify(input.state),
      input.createdAt
    ]
  });
  await raw.execute({
    sql: "INSERT INTO current_game (slot, game_id) VALUES (1, ?)",
    args: [input.gameId]
  });
}

describe("sqliteGameRepository：Phase 10 narrative 旧存档默认值", () => {
  it("state_json 不含 narrative 时补齐 idle generation", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    await seedV1Database(databasePath, input);
    // 从 v1 数据库读取：stateJSON 不含 narrative 字段。
    const reader = openRepository(databasePath);
    const result = await reader.getCurrentGame();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("active");
    if (result.status === "active") {
      expect(result.record.state.narrative).toEqual({ currentScene: null, generation: { status: "idle" }, mode: "ai" });
    }
  });
});

describe("sqliteGameRepository：Town 旧存档默认值", () => {
  it("state_json 不含 towns / townGeneration 时补齐空数组与 idle", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    // 剥离 Town 字段，模拟 Phase 1–10 旧存档。
    const legacyState = { ...(input.state as unknown as Record<string, unknown>) };
    delete legacyState["towns"];
    delete legacyState["townGeneration"];
    const legacyInput: CreateInitialGameInput = {
      ...input,
      state: legacyState as unknown as GameState
    };
    await seedV1Database(databasePath, legacyInput);

    const reader = openRepository(databasePath);
    const result = await reader.getCurrentGame();
    expect(result.ok).toBe(true);
    if (!result.ok || result.status !== "active") return;
    expect(result.record.state.towns).toEqual([]);
    expect(result.record.state.townGeneration).toEqual({ status: "idle" });
  });
});

describe("sqliteGameRepository：v1→v2 schema migration", () => {
  it("v1 数据库升级后保留状态、蓝图、指针、generationId，revision 为 0", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    await seedV1Database(databasePath, input);

    // v2 adapter 首次读取触发 migration。
    const reader = openRepository(databasePath);
    const result = await reader.getCurrentGame();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("active");
    if (result.status !== "active") return;
    expect(result.record.gameId).toBe(input.gameId);
    expect(result.record.blueprint).toEqual(withExpectedPhase14BlueprintDefaults(input.blueprint));
    expect(result.record.state).toEqual(withExpectedPhase14StateDefaults(input.state));
    expect(result.record.revision).toBe(INITIAL_REVISION);
    expect(result.record.createdAt).toBe(input.createdAt);

    // schema_meta 已更新为 v2。
    const raw = openRawClient(databasePath);
    const meta = await raw.execute({
      sql: "SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'",
      args: []
    });
    expect(meta.rows[0]?.["meta_value"]).toBe(String(GAME_SCHEMA_VERSION));
  });

  it("重复初始化不改变数据（迁移幂等）", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    await seedV1Database(databasePath, input);

    // 第一次迁移。
    const first = openRepository(databasePath);
    await first.initializeSchema();
    await first.close();

    // 第二次打开同一文件：不应再次尝试迁移，数据不变。
    const second = openRepository(databasePath);
    await second.initializeSchema();
    const result = await second.getCurrentGame();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("active");
    if (result.status !== "active") return;
    expect(result.record.revision).toBe(INITIAL_REVISION);
    expect(result.record.state).toEqual(withExpectedPhase14StateDefaults(input.state));
  });

  it("未知未来 schema 版本安全失败，绝不重置玩家存档", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    await seedV1Database(databasePath, input);

    // 篡改 schema_meta 为未来版本。
    const raw = openRawClient(databasePath);
    await raw.execute({
      sql: "UPDATE schema_meta SET meta_value = '999' WHERE meta_key = 'schema_version'",
      args: []
    });

    const reader = openRepository(databasePath);
    // ensureSchema 抛错 → getCurrentGame 捕获为 INFRASTRUCTURE_FAILURE。
    const result = await reader.getCurrentGame();
    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });

    // 存档行原样保留，不被清理或重置。
    expect(await countRows(raw, "games")).toBe(1);
    expect(await countRows(raw, "current_game")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 Task 3：applyResolvedAction (compare-and-swap) 测试。
// 用真实临时 SQLite 验证：成功 action 只递增一次 revision、写入完整下一 state；
// 模拟事务故障时旧 state/revision 完整保留；并发相同 expectedRevision 时仅一个成功。
// ---------------------------------------------------------------------------

/** 构造一份修改后的 GameState：在事件账本末尾追加一条 location_observed 事件。 */
function buildNextState(): GameState {
  return {
    ...PIPELINE.state,
    eventLedger: [
      ...PIPELINE.state.eventLedger,
      {
        type: "location_observed" as const,
        locationId: PIPELINE.state.currentLocationId,
        occurredAt: "2026-07-27T10:00:00Z"
      }
    ]
  };
}

describe("sqliteGameRepository：applyResolvedAction (compare-and-swap)", () => {
  it("成功行动：revision 递增一次，state 更新，返回完整 record", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    const writer = openRepository(databasePath);
    expect(await writer.createInitialGame(input)).toEqual({ ok: true });

    const nextState = buildNextState();
    const actionInput: ApplyResolvedActionInput = {
      gameId: input.gameId,
      expectedRevision: INITIAL_REVISION,
      nextState
    };
    const result = await writer.applyResolvedAction(actionInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.gameId).toBe(input.gameId);
    expect(result.record.revision).toBe(1);
    expect(result.record.state).toEqual(nextState);
    expect(result.record.blueprint).toEqual(input.blueprint);
    expect(result.record.createdAt).toBe(input.createdAt);
  });

  it("陈旧 revision 返回 STALE_GAME_REVISION，不修改状态", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    const writer = openRepository(databasePath);
    expect(await writer.createInitialGame(input)).toEqual({ ok: true });

    const nextState = buildNextState();

    // 第一次成功：revision 0 → 1。
    const first = await writer.applyResolvedAction({
      gameId: input.gameId,
      expectedRevision: INITIAL_REVISION,
      nextState
    });
    expect(first.ok).toBe(true);

    // 第二次用旧 revision 0：必须拒绝。
    const second = await writer.applyResolvedAction({
      gameId: input.gameId,
      expectedRevision: INITIAL_REVISION,
      nextState
    });
    expect(second).toEqual({ ok: false, code: "STALE_GAME_REVISION" });

    // 当前存档的 revision 仍为 1，state 为第一次写入的 nextState。
    const current = await writer.getCurrentGame();
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(current.status).toBe("active");
    if (current.status !== "active") return;
    expect(current.record.revision).toBe(1);
    expect(current.record.state).toEqual(withExpectedPhase14StateDefaults(nextState));
  });

  it("连续成功行动：revision 单调递增", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    const writer = openRepository(databasePath);
    expect(await writer.createInitialGame(input)).toEqual({ ok: true });

    // 第一次行动：revision 0 → 1。
    const state1 = buildNextState();
    const r1 = await writer.applyResolvedAction({
      gameId: input.gameId,
      expectedRevision: 0,
      nextState: state1
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.record.revision).toBe(1);

    // 第二次行动：revision 1 → 2。
    const state2: GameState = {
      ...state1,
      eventLedger: [
        ...state1.eventLedger,
        {
          type: "location_observed" as const,
          locationId: state1.currentLocationId,
          occurredAt: "2026-07-27T11:00:00Z"
        }
      ]
    };
    const r2 = await writer.applyResolvedAction({
      gameId: input.gameId,
      expectedRevision: 1,
      nextState: state2
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.record.revision).toBe(2);
    expect(r2.record.state).toEqual(state2);
  });

  it("无 active game 时返回 NO_ACTIVE_GAME", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    await repository.initializeSchema();

    const result = await repository.applyResolvedAction({
      gameId: asGameId("game-nonexistent"),
      expectedRevision: 0,
      nextState: buildNextState()
    });
    expect(result).toEqual({ ok: false, code: "NO_ACTIVE_GAME" });
  });

  it("gameId 不匹配时返回 NO_ACTIVE_GAME", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    const writer = openRepository(databasePath);
    expect(await writer.createInitialGame(input)).toEqual({ ok: true });

    const result = await writer.applyResolvedAction({
      gameId: asGameId("game-wrong-id"),
      expectedRevision: 0,
      nextState: buildNextState()
    });
    expect(result).toEqual({ ok: false, code: "NO_ACTIVE_GAME" });
  });

  it("并发相同 expectedRevision 时仅一个成功", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    const writer = openRepository(databasePath);
    expect(await writer.createInitialGame(input)).toEqual({ ok: true });
    await writer.close();

    // 两个独立 repository 实例（各自有独立 client）同时发起 compare-and-swap。
    // SQLite 写锁串行化：先获得锁的那个 UPDATE 命中，后到的 revision 已变，
    // 要么 STALE_GAME_REVISION（锁等到 commit 后再读），要么 INFRASTRUCTURE_FAILURE（BUSY）。
    // 关键不变量：只有一个成功，最终 revision 只递增一次。
    const repoA = openRepository(databasePath);
    const repoB = openRepository(databasePath);
    const nextState = buildNextState();

    const [r1, r2] = await Promise.all([
      repoA.applyResolvedAction({ gameId: input.gameId, expectedRevision: 0, nextState }),
      repoB.applyResolvedAction({ gameId: input.gameId, expectedRevision: 0, nextState })
    ]);

    const successCount = [r1, r2].filter((r) => r.ok).length;
    expect(successCount).toBe(1);

    // 最终 revision 只递增一次。
    const reader = openRepository(databasePath);
    const current = await reader.getCurrentGame();
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(current.status).toBe("active");
    if (current.status !== "active") return;
    expect(current.record.revision).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// applyResolvedAction 事务故障：注入 UPDATE 故障，验证旧 state/revision 完整保留。
// ---------------------------------------------------------------------------

function wrapTransactionWithUpdateFault(tx: SqliteTransaction): SqliteTransaction {
  return new Proxy(tx, {
    get(target, property) {
      if (property === "execute") {
        return (async (stmtOrSql: unknown, args?: unknown) => {
          const sql =
            typeof stmtOrSql === "string" ? stmtOrSql : (stmtOrSql as { sql: string }).sql;
          if (/update\s+games\s+set/i.test(sql)) {
            throw new Error("注入故障：UPDATE games 失败");
          }
          return (target.execute as (a: unknown, b?: unknown) => Promise<unknown>)(
            stmtOrSql,
            args
          );
        }) as SqliteTransaction["execute"];
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function"
        ? (value as (...callArgs: unknown[]) => unknown).bind(target)
        : value;
    }
  });
}

function createUpdateFaultClient(real: SqliteClient): SqliteClient {
  openedClients.push(real);
  return new Proxy(real, {
    get(target, property) {
      if (property === "transaction") {
        return (async (mode?: "write" | "read" | "deferred") => {
          const tx = mode === undefined ? await target.transaction() : await target.transaction(mode);
          return wrapTransactionWithUpdateFault(tx);
        }) as SqliteClient["transaction"];
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function"
        ? (value as (...callArgs: unknown[]) => unknown).bind(target)
        : value;
    }
  });
}

describe("sqliteGameRepository：applyResolvedAction 事务故障", () => {
  it("UPDATE 故障时旧 state/revision 完整保留", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    // 先用正常 adapter 创建存档。
    const writer = openRepository(databasePath);
    expect(await writer.createInitialGame(input)).toEqual({ ok: true });
    await writer.close();

    // 用注入故障的 adapter 尝试行动。
    const faulty = openRepository(databasePath, () =>
      createUpdateFaultClient(createSqliteClient(databasePath))
    );
    const result = await faulty.applyResolvedAction({
      gameId: input.gameId,
      expectedRevision: 0,
      nextState: buildNextState()
    });
    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
    await faulty.close();

    // 干净实例读取：旧 state 和 revision 0 完整保留。
    const reader = openRepository(databasePath);
    const current = await reader.getCurrentGame();
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(current.status).toBe("active");
    if (current.status !== "active") return;
    expect(current.record.revision).toBe(0);
    expect(current.record.state).toEqual(withExpectedPhase14StateDefaults(input.state));
  });
});

// ---------------------------------------------------------------------------
// 蓝图动态化 Task 14：applyBlueprintExpansion (CAS + blueprint 列同步更新)。
// ---------------------------------------------------------------------------

function buildExpandedBlueprint(): ScenarioBlueprint {
  const base = PIPELINE.blueprint;
  const newLocation = {
    id: "loc_dyn_1",
    name: "迷雾深谷",
    description: "一处被浓雾笼罩的隐秘山谷。",
    kind: "main" as const,
    connectedLocationIds: [base.locations[0].id],
    availableItemIds: [] as readonly string[]
  };
  const patchedLocations = base.locations.map((loc, i) =>
    i === 0
      ? { ...loc, connectedLocationIds: [...loc.connectedLocationIds, "loc_dyn_1"] }
      : loc
  );
  return {
    ...base,
    locations: [...patchedLocations, newLocation]
  } as ScenarioBlueprint;
}

function buildExpandedState(): GameState {
  return {
    ...PIPELINE.state,
    unlockedLocationIds: [...PIPELINE.state.unlockedLocationIds, "loc_dyn_1"],
    eventLedger: [
      ...PIPELINE.state.eventLedger,
      {
        type: "blueprint_expanded" as const,
        newLocationIds: ["loc_dyn_1"],
        newNpcIds: [],
        occurredAt: "2026-07-31T00:00:00Z"
      }
    ]
  } as unknown as GameState;
}

describe("sqliteGameRepository：applyBlueprintExpansion (CAS + blueprint 更新)", () => {
  it("成功路径：blueprint 与 state 同步更新，revision + 1", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    const writer = openRepository(databasePath);
    expect(await writer.createInitialGame(input)).toEqual({ ok: true });

    const nextBlueprint = buildExpandedBlueprint();
    const nextState = buildExpandedState();
    const expansionInput: ApplyBlueprintExpansionInput = {
      gameId: input.gameId,
      expectedRevision: INITIAL_REVISION,
      nextBlueprint,
      nextState
    };
    const result = await writer.applyBlueprintExpansion(expansionInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.revision).toBe(1);
    expect(result.record.blueprint).toEqual(nextBlueprint);
    expect(result.record.state).toEqual(nextState);

    // 用全新实例读回验证持久化。
    await writer.close();
    const reader = openRepository(databasePath);
    const current = await reader.getCurrentGame();
    expect(current.ok).toBe(true);
    if (!current.ok || current.status !== "active") return;
    expect(current.record.revision).toBe(1);
    expect(current.record.blueprint).toEqual(withExpectedPhase14BlueprintDefaults(nextBlueprint));
    expect(current.record.state).toEqual(withExpectedPhase14StateDefaults(nextState));
  });

  it("CAS 冲突：过期 revision 返回 STALE_GAME_REVISION，库中数据不变", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    const writer = openRepository(databasePath);
    expect(await writer.createInitialGame(input)).toEqual({ ok: true });

    // 先成功一次把 revision 推到 1。
    const first = await writer.applyBlueprintExpansion({
      gameId: input.gameId,
      expectedRevision: INITIAL_REVISION,
      nextBlueprint: buildExpandedBlueprint(),
      nextState: buildExpandedState()
    });
    expect(first.ok).toBe(true);

    // 用旧 revision 0 再次调用：必须拒绝。
    const stale = await writer.applyBlueprintExpansion({
      gameId: input.gameId,
      expectedRevision: INITIAL_REVISION,
      nextBlueprint: buildExpandedBlueprint(),
      nextState: buildExpandedState()
    });
    expect(stale).toEqual({ ok: false, code: "STALE_GAME_REVISION" });

    // 库中 blueprint/state/revision 均为第一次写入的值。
    const current = await writer.getCurrentGame();
    expect(current.ok).toBe(true);
    if (!current.ok || current.status !== "active") return;
    expect(current.record.revision).toBe(1);
    expect(current.record.blueprint).toEqual(withExpectedPhase14BlueprintDefaults(buildExpandedBlueprint()));
    expect(current.record.state).toEqual(withExpectedPhase14StateDefaults(buildExpandedState()));
  });

  it("与 applyResolvedAction 交错：expansion 后 action 携带新 revision 成功", async () => {
    const databasePath = nextDbPath();
    const input = buildCreateInput();
    const writer = openRepository(databasePath);
    expect(await writer.createInitialGame(input)).toEqual({ ok: true });

    // expansion：revision 0 → 1。
    const nextBlueprint = buildExpandedBlueprint();
    const nextState = buildExpandedState();
    const expansion = await writer.applyBlueprintExpansion({
      gameId: input.gameId,
      expectedRevision: INITIAL_REVISION,
      nextBlueprint,
      nextState
    });
    expect(expansion.ok).toBe(true);

    // applyResolvedAction 携带 revision 1：revision 1 → 2。
    const actionState: GameState = {
      ...nextState,
      eventLedger: [
        ...nextState.eventLedger,
        {
          type: "location_observed" as const,
          locationId: nextState.currentLocationId,
          occurredAt: "2026-07-31T01:00:00Z"
        }
      ]
    };
    const action = await writer.applyResolvedAction({
      gameId: input.gameId,
      expectedRevision: 1,
      nextState: actionState
    });
    expect(action.ok).toBe(true);
    if (!action.ok) return;
    expect(action.record.revision).toBe(2);
    expect(action.record.state).toEqual(actionState);
    // blueprint 保持 expansion 后的版本。
    expect(action.record.blueprint).toEqual(nextBlueprint);
  });
});

// ---------------------------------------------------------------------------
// Phase 14 Task 2：schemaVersion 1→2 迁移单元测试。
// 直接对 interpretGameRow 喂入构造的行对象，验证旧档（v1）读取时补齐
// startAnchor/endingDirection/prologueShown/mainStoryProgress 默认值，
// 以及新档（v2）读取通过版本检查。零迁移模式：只在内存补默认值，不写回 DB。
// ---------------------------------------------------------------------------

/**
 * 构造一份旧存档行（schemaVersion 1，无 Phase 14 新字段）。
 * 蓝图不含 locations/npcs/quests 数组，触发 fallback "loc_1"/"npc_1"/"quest_main_1"；
 * state 不含 prologueShown/mainStoryProgress/eventLedger，触发 prologueShown=true、currentAct=0。
 */
function buildLegacyV1Row(): Record<string, unknown> {
  const generationId = "gen-legacy-v1";
  const blueprint = {
    schemaVersion: 1,
    generationId
    // 无 startAnchor / endingDirection（Phase 14 新字段）
    // 无 locations / npcs / quests → 触发 fallback 默认值
  };
  const state = {
    stateVersion: 1,
    generation: { generationId },
    currentLocationId: "loc_start"
    // 无 prologueShown / mainStoryProgress / eventLedger（Phase 14 新字段）
  };
  return {
    game_id: "game-legacy-v1",
    record_version: GAME_RECORD_VERSION,
    blueprint_json: JSON.stringify(blueprint),
    state_json: JSON.stringify(state),
    created_at: "2026-07-27T00:00:00.000Z",
    revision: INITIAL_REVISION
  };
}

/**
 * 构造一份新存档行（schemaVersion 2，含 Phase 14 全部新字段）。
 * 用于验证版本检查接受 v2 且新字段原样保留（不触发 with*Defaults 补默认值分支）。
 */
function buildNewV2Row(): Record<string, unknown> {
  const generationId = "gen-new-v2";
  const blueprint = {
    schemaVersion: 2,
    generationId,
    startAnchor: { locationId: "loc_start", npcId: "npc_start", startQuestId: "quest_start" },
    endingDirection: { theme: "测试主题", possibleTones: ["triumph"], lockedAt: 2 }
  };
  const state = {
    stateVersion: 1,
    generation: { generationId },
    currentLocationId: "loc_start",
    prologueShown: true,
    mainStoryProgress: { currentAct: 1, endingProposed: false }
  };
  return {
    game_id: "game-new-v2",
    record_version: GAME_RECORD_VERSION,
    blueprint_json: JSON.stringify(blueprint),
    state_json: JSON.stringify(state),
    created_at: "2026-07-27T00:00:00.000Z",
    revision: INITIAL_REVISION
  };
}

describe("Phase 14 schemaVersion 1→2 迁移", () => {
  it("旧存档（schemaVersion 1）读取后含 startAnchor 默认值", () => {
    const row = buildLegacyV1Row();
    const result = interpretGameRow(row);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("active");
    if (result.status !== "active") return;
    expect(result.record.blueprint.startAnchor).toBeDefined();
    expect(result.record.blueprint.startAnchor.locationId).toBe("loc_1");
    expect(result.record.blueprint.startAnchor.npcId).toBe("npc_1");
  });

  it("旧存档读取后含 endingDirection 默认值", () => {
    const row = buildLegacyV1Row();
    const result = interpretGameRow(row);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("active");
    if (result.status !== "active") return;
    expect(result.record.blueprint.endingDirection).toBeDefined();
    expect(result.record.blueprint.endingDirection.lockedAt).toBeGreaterThanOrEqual(1);
  });

  it("旧存档读取后 prologueShown 为 true（已过开场）", () => {
    const row = buildLegacyV1Row();
    const result = interpretGameRow(row);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("active");
    if (result.status !== "active") return;
    expect(result.record.state.prologueShown).toBe(true);
  });

  it("旧存档读取后 mainStoryProgress 含 currentAct 和 endingProposed", () => {
    const row = buildLegacyV1Row();
    const result = interpretGameRow(row);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("active");
    if (result.status !== "active") return;
    expect(result.record.state.mainStoryProgress).toBeDefined();
    expect(typeof result.record.state.mainStoryProgress.currentAct).toBe("number");
    expect(result.record.state.mainStoryProgress.endingProposed).toBe(false);
  });

  it("新存档（schemaVersion 2）读取通过", () => {
    const row = buildNewV2Row();
    const result = interpretGameRow(row);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("active");
  });
});
