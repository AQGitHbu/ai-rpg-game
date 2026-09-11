// @vitest-environment node
import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServerGameEntryPoints } from "./compositionRoot";
import { createSqliteClient } from "./persistence/sqliteClient";

it("全新数据库首次开局即创建发布所需存档表，不依赖此前读取存档", async () => {
  const temporaryRoot = join(process.cwd(), "tmp");
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, "rpg-first-initialization-"));
  const path = join(directory, "game.sqlite");
  const entry = createServerGameEntryPoints({ NODE_ENV: "test", GAME_DB_PATH: path });
  const client = createSqliteClient(path);
  try {
    await entry.createGame({ requestId: "first-init", gameType: "wuxia", gameLength: "short" });
    const result = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type = 'table'", args: [] });
    expect(result.rows.map(row => row["name"])).toEqual(expect.arrayContaining(["game_records", "current_game", "opening_history"]));
  } finally {
    await entry.close();
    await client.close();
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      // Windows/libsql 可能延迟释放文件；仅保留本测试独立临时目录，不掩盖断言失败。
      if (!['EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      console.warn("initialization_test_temp_retained", directory);
    }
  }
});
