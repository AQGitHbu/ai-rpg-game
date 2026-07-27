/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { NewGameInput } from "@/game/domain";
import wuxiaFixture from "../../../../../data/fixtures/phase1/wuxia.json";
import { runScenarioPipeline } from "../../applicationFixture.testutil";
import { asGameId, type CreateInitialGameInput } from "./gameRepository";
import { createSqliteClient, type SqliteClient } from "./sqliteClient";
import {
  createSqliteGameRepository,
  GAME_RECORD_VERSION,
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
      record: input
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
      record: original
    });
    const raw = openRawClient(databasePath);
    expect(await countRows(raw, "games")).toBe(1);
    expect(await countRows(raw, "current_game")).toBe(1);
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
