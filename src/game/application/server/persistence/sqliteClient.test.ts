/** @vitest-environment node */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createServerSqliteClientFactory,
  createSqliteClient,
  DEFAULT_SQLITE_DATABASE_PATH,
  GAME_DB_PATH_ENV,
  resolveSqliteDatabasePath,
  type SqliteClient
} from "./sqliteClient";

// ---------------------------------------------------------------------------
// Task 2：sqliteClient 单元测试。
// 路径解析只发生在本层：测试一律显式注入 env 记录或临时路径，绝不读真实
// process.env；真实 libsql 客户端跑在 tmp/ 下的一次性文件上。
// ---------------------------------------------------------------------------

// 每次运行独立目录：Windows 下 libsql 可能延迟释放句柄，清理尽力而为。
const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-client-";
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

const openedClients: SqliteClient[] = [];

afterAll(() => {
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

describe("resolveSqliteDatabasePath：数据库路径只在本层解析", () => {
  it("未设置环境变量时使用默认的 db/rpg.sqlite（位于被 .gitignore 忽略的 db/）", () => {
    expect(resolveSqliteDatabasePath({})).toBe(DEFAULT_SQLITE_DATABASE_PATH);
    expect(DEFAULT_SQLITE_DATABASE_PATH).toBe("db/rpg.sqlite");
  });

  it("显式注入的 env 记录可覆盖路径（沿用 .env.example 的 GAME_DB_PATH 约定）", () => {
    expect(GAME_DB_PATH_ENV).toBe("GAME_DB_PATH");
    expect(
      resolveSqliteDatabasePath({ [GAME_DB_PATH_ENV]: "tmp/override.sqlite" })
    ).toBe("tmp/override.sqlite");
  });

  it("空白覆盖值回退到默认路径", () => {
    expect(resolveSqliteDatabasePath({ [GAME_DB_PATH_ENV]: "   " })).toBe(
      DEFAULT_SQLITE_DATABASE_PATH
    );
  });
});

describe("createSqliteClient：真实本地文件客户端", () => {
  it("可对 tmp/ 下的临时文件执行查询（Windows 路径正确转为 file: URL）", async () => {
    const client = createSqliteClient(join(RUN_ROOT, "smoke.sqlite"));
    openedClients.push(client);
    const result = await client.execute("SELECT 1 AS one");
    expect(result.rows[0]?.["one"]).toBe(1);
  });

  it("父目录不存在时同步抛错（repository 将其映射为基础设施失败）", () => {
    expect(() =>
      createSqliteClient(join(RUN_ROOT, "missing", "nested", "broken.sqlite"))
    ).toThrow();
  });

  it("参数绑定保留特殊文本，特殊文件名可重开读取", async () => {
    const path = join(RUN_ROOT, "save #% 汉字.sqlite");
    const client = createSqliteClient(path);
    openedClients.push(client);
    await client.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const value = "quote ' % # ? \\ newline\n汉字";
    await client.execute({ sql: "INSERT INTO sample (value) VALUES (?)", args: [value] });
    client.close();
    const reopened = createSqliteClient(path);
    openedClients.push(reopened);
    expect((await reopened.execute("SELECT value FROM sample")).rows[0]?.["value"]).toBe(value);
  });

  it("未提交 close 回滚，重复 close 安全", async () => {
    const client = createSqliteClient(join(RUN_ROOT, "rollback.sqlite"));
    openedClients.push(client);
    await client.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY)");
    const tx = await client.transaction("write");
    await tx.execute("INSERT INTO sample (id) VALUES (1)");
    tx.close();
    tx.close();
    expect((await client.execute("SELECT * FROM sample")).rows).toHaveLength(0);
    client.close();
    client.close();
  });

  it("失败事务回滚后 client 可继续使用", async () => {
    const client = createSqliteClient(join(RUN_ROOT, "reuse.sqlite"));
    openedClients.push(client);
    await client.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY)");
    const tx = await client.transaction();
    await tx.execute("INSERT INTO sample (id) VALUES (1)");
    await expect(tx.execute("INSERT INTO sample (id) VALUES (1)")).rejects.toThrow();
    tx.close();
    await client.execute("INSERT INTO sample (id) VALUES (2)");
    expect((await client.execute("SELECT id FROM sample")).rows.map((row) => row["id"])).toEqual([2]);
  });

  it("同文件双 client 写事务异步排队并保持 CAS", async () => {
    const path = join(RUN_ROOT, "cas.sqlite");
    const firstClient = createSqliteClient(path);
    const secondClient = createSqliteClient(path);
    openedClients.push(firstClient, secondClient);
    await firstClient.execute("CREATE TABLE state (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)");
    await firstClient.execute("INSERT INTO state VALUES (1, 0)");
    const first = await firstClient.transaction("write");
    expect((await first.execute("UPDATE state SET revision = 1 WHERE id = 1 AND revision = 0")).rowsAffected).toBe(1);
    const secondPending = secondClient.transaction("write");
    await Promise.resolve();
    await first.commit();
    const second = await secondPending;
    expect((await second.execute("UPDATE state SET revision = 2 WHERE id = 1 AND revision = 0")).rowsAffected).toBe(0);
    await second.commit();
    expect((await firstClient.execute("SELECT revision FROM state")).rows[0]?.["revision"]).toBe(1);
  });
});

describe("createServerSqliteClientFactory：生产组合根用的工厂", () => {
  it("按注入 env 解析路径并自动创建父目录", async () => {
    const databasePath = join(RUN_ROOT, "made-by-factory", "env.sqlite");
    const factory = createServerSqliteClientFactory({ [GAME_DB_PATH_ENV]: databasePath });
    const client = factory();
    openedClients.push(client);
    const result = await client.execute("SELECT 1 AS one");
    expect(result.rows[0]?.["one"]).toBe(1);
    expect(existsSync(databasePath)).toBe(true);
  });
});
