import { createClient, type Client, type InStatement } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// sqliteClient（Task 2）：整个代码库中唯一允许 import @libsql/client 与感知
// 数据库路径配置的文件。application/UI 一律通过 GameRepository 端口访问持久化，
// 客户端代码绝不建连。
// server-only 说明：仓库尚未安装 server-only 包（见 Task 2 报告 concern），
// 暂以下方运行时守卫达到同等效果；后续任务会补静态测试禁止客户端导入。
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  throw new Error("sqliteClient 只允许在 server 端加载，禁止进入客户端 bundle");
}

/** adapter 层唯一允许使用的 libsql 客户端类型别名：其余文件不得直接 import @libsql/client。 */
export type SqliteClient = Client;

/** 参数化语句别名：adapter 只能用 args 传值，禁止拼接 SQL 字符串值。 */
export type SqliteStatement = InStatement;

/** 惰性客户端工厂：repository 首次使用时才建连，建连失败统一映射为基础设施失败。 */
export type SqliteClientFactory = () => SqliteClient;

/** 数据库路径环境变量：沿用 .env.example 既有的 GAME_DB_PATH 约定，仅本层读取。 */
export const GAME_DB_PATH_ENV = "GAME_DB_PATH";

/** 默认数据库文件：位于被 .gitignore 忽略的 db/ 目录。 */
export const DEFAULT_SQLITE_DATABASE_PATH = "db/rpg.sqlite";

/** 解析 server 运行时数据库路径：注入的 env 记录优先，空白回退默认；测试必须显式传路径。 */
export function resolveSqliteDatabasePath(
  env: Record<string, string | undefined> = process.env
): string {
  const overridden = env[GAME_DB_PATH_ENV]?.trim();
  return overridden ? overridden : DEFAULT_SQLITE_DATABASE_PATH;
}

// 本地路径 → libsql file: URL：Windows 反斜杠归一为正斜杠，
// 并转义 libsql URI 解析器敏感的 % / ? / # 字符（解析时会做 percent-decode）。
function toFileUrl(databasePath: string): string {
  const absolute = resolve(databasePath).replace(/\\/g, "/");
  const escaped = absolute
    .replace(/%/g, "%25")
    .replace(/\?/g, "%3F")
    .replace(/#/g, "%23");
  return `file:${escaped}`;
}

/** 创建本地 SQLite 客户端：路径无法打开时同步抛错（由 repository 统一映射失败代码）。 */
export function createSqliteClient(databasePath: string): SqliteClient {
  return createClient({ url: toFileUrl(databasePath) });
}

/** 生产组合根（Task 3）用的工厂：读 env/默认路径并确保父目录（db/）存在。 */
export function createServerSqliteClientFactory(
  env: Record<string, string | undefined> = process.env
): SqliteClientFactory {
  return () => {
    const databasePath = resolve(resolveSqliteDatabasePath(env));
    mkdirSync(dirname(databasePath), { recursive: true });
    return createSqliteClient(databasePath);
  };
}
