/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { NewGameInput } from "@/game/domain";
import urbanFixture from "../../../data/fixtures/phase1/urban.json";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { createGame, type CreateGameDependencies } from "./createGame";
import { getCurrentGame } from "./getCurrentGame";
import { asGameId } from "./server/persistence/gameRepository";
import { createSqliteClient } from "./server/persistence/sqliteClient";
import {
  createSqliteGameRepository,
  type SqliteGameRepository
} from "./server/persistence/sqliteGameRepository";

// ---------------------------------------------------------------------------
// Task 3：use case × 真实 SQLite adapter 集成测试——「返回 view 与已存记录
// 一致」的最强证明：createGame 用真实 adapter 写入 tmp/ 临时文件后，
// 用全新 repository 实例重开同一文件，getCurrentGame 必须投影出完全相同的
// view。路径一律显式注入，绝不读 env。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;
const URBAN_FIXTURE = urbanFixture as unknown as Phase1Fixture;

// 与 sqliteGameRepository.test.ts 相同的 tmp/ 策略：每次运行独立目录，
// 先清扫上一轮残留（旧进程已退出，句柄已释放）。
const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-application-";
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

/** 打开真实 adapter：显式注入临时路径工厂与静默 logError（保持输出干净）。 */
function openRepository(databasePath: string): SqliteGameRepository {
  const repository = createSqliteGameRepository({
    clientFactory: () => createSqliteClient(databasePath),
    logError: () => {}
  });
  openedRepositories.push(repository);
  return repository;
}

afterAll(async () => {
  for (const repository of openedRepositories) {
    try {
      await repository.close();
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

/** 固定注入依赖：与单元测试同构，但 repository 是真实 SQLite adapter。 */
function realDependencies(
  repository: SqliteGameRepository,
  gameId: string
): CreateGameDependencies {
  return {
    repository,
    newGameId: () => asGameId(gameId),
    newSeed: () => "seed-unused",
    now: () => "2026-07-27T00:00:00.000Z"
  };
}

describe("createGame × 真实 SQLite：返回 view 与已存记录一致", () => {
  it("创建后用全新 repository 实例重开同一文件，getCurrentGame 投影相同 view", async () => {
    const databasePath = nextDbPath();
    const writer = openRepository(databasePath);
    const created = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      realDependencies(writer, "game-app-sqlite-0001")
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await writer.close();

    // 全新实例读同一文件：模拟进程重启/页面刷新后的恢复路径。
    const reader = openRepository(databasePath);
    const current = await getCurrentGame({ repository: reader });
    expect(current.status).toBe("active");
    if (current.status !== "active") return;
    // 深度相等 + 序列化相等：view 完全由已存记录复原，无一字段漂移。
    expect(current.view).toEqual(created.view);
    expect(JSON.stringify(current.view)).toBe(JSON.stringify(created.view));
  });

  it("冲突不覆盖：第二次创建返回 ACTIVE_GAME_EXISTS，当前存档仍是第一局", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    const first = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      realDependencies(repository, "game-app-sqlite-first")
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 换一份输入与 gameId 再创建：真实事务内检测指针后拒绝，不动旧记录。
    const second = await createGame(
      { input: URBAN_FIXTURE.input, seed: URBAN_FIXTURE.seed },
      realDependencies(repository, "game-app-sqlite-second")
    );
    expect(second).toEqual({ ok: false, code: "ACTIVE_GAME_EXISTS" });

    const current = await getCurrentGame({ repository });
    expect(current.status).toBe("active");
    if (current.status !== "active") return;
    expect(current.view).toEqual(first.view);
  });
});
