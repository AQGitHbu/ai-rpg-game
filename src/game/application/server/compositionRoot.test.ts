/** @vitest-environment node */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { NewGameInput } from "@/game/domain";
import wuxiaFixture from "../../../../data/fixtures/phase1/wuxia.json";
import {
  createServerGameEntryPoints,
  type ServerGameEntryPoints
} from "./compositionRoot";

// ---------------------------------------------------------------------------
// Task 3：production composition root 测试——真实 SQLite 临时文件 + 注入 env
// 记录，不 mock libsql。验证：env 记录经 sqliteClient 配置助手解析出数据库
// 路径（测试自身绝不读写 process.env）、真实 UUID gameId / 随机 seed / 时钟
// 生效、公开入口只接受 NewGameInput、无效输入零写入（连数据库文件都不建）。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;

// 与 sqliteGameRepository.test.ts 相同的 tmp/ 策略：每次运行独立目录，
// 先清扫上一轮残留（旧进程已退出，句柄已释放）。
const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-composition-root-";
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

const openedEntryPoints: ServerGameEntryPoints[] = [];

/** 打开生产组合根：只注入 env 记录（GAME_DB_PATH → 临时文件），其余全走真实实现。 */
function openEntryPoints(databasePath: string): ServerGameEntryPoints {
  const entryPoints = createServerGameEntryPoints({ GAME_DB_PATH: databasePath });
  openedEntryPoints.push(entryPoints);
  return entryPoints;
}

afterAll(async () => {
  for (const entryPoints of openedEntryPoints) {
    try {
      await entryPoints.close();
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("compositionRoot：注入 env 记录接通真实持久化", () => {
  it("createGame 成功写入 GAME_DB_PATH 指定的文件，getCurrentGame 恢复同一 view", async () => {
    const databasePath = nextDbPath();
    const entryPoints = openEntryPoints(databasePath);

    // 公开入口只接受 NewGameInput：seed/gameId/路径均无从传入（类型即契约）。
    const created = await entryPoints.createGame(FIXTURE.input);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.source).toBe("fallback");
    // 生产 gameId 来自真实 UUID provider。
    expect(created.gameId).toMatch(UUID_PATTERN);
    // 数据库文件确实建在注入 env 解析出的路径上。
    expect(existsSync(databasePath)).toBe(true);

    // 同一入口读回：与创建返回的 view 完全一致（返回 view 与已存记录一致）。
    const current = await entryPoints.getCurrentGame();
    expect(current).toEqual({ status: "active", view: created.view });
  });

  it("已有当前存档时再次创建 ⇒ ACTIVE_GAME_EXISTS，原存档不被覆盖", async () => {
    const databasePath = nextDbPath();
    const entryPoints = openEntryPoints(databasePath);
    const first = await entryPoints.createGame(FIXTURE.input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await entryPoints.createGame(FIXTURE.input);
    expect(second).toEqual({ ok: false, code: "ACTIVE_GAME_EXISTS" });
    // 冲突后当前存档仍是第一局。
    const current = await entryPoints.getCurrentGame();
    expect(current).toEqual({ status: "active", view: first.view });
  });

  it("生产 seed/gameId 来自真实随机源：两局（各自数据库）互不相同", async () => {
    const entryA = openEntryPoints(nextDbPath());
    const entryB = openEntryPoints(nextDbPath());
    const resultA = await entryA.createGame(FIXTURE.input);
    const resultB = await entryB.createGame(FIXTURE.input);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;
    // gameId 与 seed 派生的 generationId 都必须不同：证明不是常量桩。
    expect(resultB.gameId).not.toBe(resultA.gameId);
    expect(resultB.view.generation.generationId).not.toBe(
      resultA.view.generation.generationId
    );
  });

  it("无效输入零写入：立即返回字段错误，连数据库文件都不创建", async () => {
    const databasePath = nextDbPath();
    const entryPoints = openEntryPoints(databasePath);
    const invalidInput: NewGameInput = { ...FIXTURE.input, characterName: "" };

    const result = await entryPoints.createGame(invalidInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_INPUT");
    // repository 未被触及 ⇒ 惰性客户端从未建连 ⇒ 文件不存在。
    expect(existsSync(databasePath)).toBe(false);
  });
});
