/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { asLocationId, asQuestId, type GameState, type NewGameInput } from "@/game/domain";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { createGame, type CreateGameDependencies } from "./createGame";
import { performAction, type PerformActionDependencies } from "./performAction";
import { runScenarioPipeline } from "./applicationFixture.testutil";
import {
  asGameId,
  type GameRecord,
  type GameRepository
} from "./server/persistence/gameRepository";
import { createSqliteClient } from "./server/persistence/sqliteClient";
import {
  createSqliteGameRepository,
  type SqliteGameRepository
} from "./server/persistence/sqliteGameRepository";

// ---------------------------------------------------------------------------
// Phase 4 Task 3：performAction × 真实 SQLite 集成测试。
// 覆盖 plan 要求：移动与 quest 事件同一次写入（revision 恰 +1）、竞争同一
// revision 仅一方成功、拒绝零写入、刷新后任务状态与当前地点一致、
// Phase 3 旧存档（无 visitedLocationIds）读取默认值后可正常移动。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;
// 独立复跑管线：与 createGame 相同 seed，得到同一蓝图作为期望基准。
const PIPELINE = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);

const FIXED_CREATED_AT = "2026-07-27T00:00:00.000Z";
const FIXED_ACTION_TIME = "2026-07-27T10:00:00.000Z";

// 与 createGameSqlite.test.ts 相同的 tmp/ 策略：每次运行独立目录，
// 先清扫上一轮残留（旧进程已退出，句柄已释放）。
const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-perform-action-";
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

function createDependencies(repository: GameRepository, gameId: string): CreateGameDependencies {
  return {
    repository,
    newGameId: () => asGameId(gameId),
    newSeed: () => "seed-unused",
    now: () => FIXED_CREATED_AT
  };
}

function performDependencies(repository: GameRepository): PerformActionDependencies {
  return { repository, now: () => FIXED_ACTION_TIME };
}

/** 用真实 adapter 建好一局武侠存档（loc_1 开场，quest_m1 active）。 */
async function seedGame(repository: SqliteGameRepository, gameId: string): Promise<void> {
  const created = await createGame(
    { input: FIXTURE.input, seed: FIXTURE.seed },
    createDependencies(repository, gameId)
  );
  expect(created.ok).toBe(true);
}

/** 从端口读回 active 记录：非 active 一律视为断言失败。 */
async function loadActiveRecord(repository: GameRepository): Promise<GameRecord> {
  const loaded = await repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") {
    throw new Error(`期望 active 存档，实际：${JSON.stringify(loaded)}`);
  }
  return loaded.record;
}

function locationName(locationId: string): string {
  const location = PIPELINE.blueprint.locations.find(
    (entry) => entry.id === asLocationId(locationId)
  );
  if (location === undefined) throw new Error(`fixture 应含地点 ${locationId}`);
  return location.name;
}

describe("performAction × 真实 SQLite：move 与 quest 事件同一次写入", () => {
  it("成功移动后 revision 恰 +1，location_visited 与任务事件在同一份已存 state", async () => {
    const databasePath = nextDbPath();
    const writer = openRepository(databasePath);
    await seedGame(writer, "game-move-write-once");
    const baseline = await loadActiveRecord(writer);

    const result = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_2") }, expectedRevision: 0 },
      performDependencies(writer)
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.revision).toBe(1);
    expect(result.view.currentLocation.name).toBe(locationName("loc_2"));
    await writer.close();

    // 全新实例重开同一文件：单次写入的完整证明只能来自持久化后的记录。
    const reader = openRepository(databasePath);
    const record = await loadActiveRecord(reader);
    expect(record.revision).toBe(1);
    expect(record.state.currentLocationId).toBe(asLocationId("loc_2"));
    const tailTypes = record.state.eventLedger
      .slice(baseline.state.eventLedger.length)
      .map((event) => event.type);
    expect(tailTypes[0]).toBe("location_visited");
    expect(tailTypes).toContain("quest_completed");
    expect(tailTypes).toContain("quest_unlocked");
    // 任务状态与移动结果一致：m1 完成、m2 解锁。
    const statusById = new Map(record.state.quests.map((quest) => [quest.questId, quest.status]));
    expect(statusById.get(asQuestId("quest_m1"))).toBe("completed");
    expect(statusById.get(asQuestId("quest_m2"))).toBe("active");
  });

  it("reload 后 getCurrentGame 端口记录与 performAction 返回 view 一致", async () => {
    const databasePath = nextDbPath();
    const writer = openRepository(databasePath);
    await seedGame(writer, "game-move-reload");

    const result = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_2") }, expectedRevision: 0 },
      performDependencies(writer)
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await writer.close();

    const reader = openRepository(databasePath);
    const record = await loadActiveRecord(reader);
    expect(record.revision).toBe(result.view.revision);
    expect(locationName(record.state.currentLocationId)).toBe(result.view.currentLocation.name);
  });
});

describe("performAction × 真实 SQLite：竞争同一 revision 仅一方成功", () => {
  it("第二个基于同一旧记录的行动命中 CAS，返回 STALE_GAME_REVISION 且不产生第二次写入", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    await seedGame(repository, "game-move-cas");
    // 竞争者读到的旧记录（revision 0）：绕过 use case 的 revision 预检，
    // 使冲突只能由 SQLite 层 CAS 裁决。
    const staleLoaded = await repository.getCurrentGame();

    const first = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_2") }, expectedRevision: 0 },
      performDependencies(repository)
    );
    expect(first.ok).toBe(true);

    const staleReader: GameRepository = {
      createInitialGame: (input) => repository.createInitialGame(input),
      getCurrentGame: async () => staleLoaded,
      applyResolvedAction: (input) => repository.applyResolvedAction(input)
    };
    const second = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_2") }, expectedRevision: 0 },
      performDependencies(staleReader)
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("STALE_GAME_REVISION");

    // 仅第一次写入生效：revision 恰为 1，当前地点是第一次移动的目标。
    const record = await loadActiveRecord(repository);
    expect(record.revision).toBe(1);
    expect(record.state.currentLocationId).toBe(asLocationId("loc_2"));
  });
});

describe("performAction × 真实 SQLite：拒绝零写入", () => {
  it("移动到未连通地点被拒绝后，state/revision/事件账本原样保留", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    await seedGame(repository, "game-move-rejected");
    const before = await loadActiveRecord(repository);

    // loc_3 与开场 loc_1 不连通：resolver 拒绝，application 不得写入。
    const result = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_3") }, expectedRevision: 0 },
      performDependencies(repository)
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");

    const after = await loadActiveRecord(repository);
    expect(after.revision).toBe(before.revision);
    expect(after.state).toEqual(before.state);
  });
});

describe("performAction × 真实 SQLite：Phase 3 旧存档兼容", () => {
  it("无 visitedLocationIds 的 stateJSON 读取默认 [currentLocationId]，并可正常移动", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    // 模拟 Phase 3 存档：序列化前剥离 visitedLocationIds 字段。
    const { visitedLocationIds: _stripped, ...legacyState } = PIPELINE.state;
    void _stripped;
    const created = await repository.createInitialGame({
      gameId: asGameId("game-legacy-save"),
      blueprint: PIPELINE.blueprint,
      state: legacyState as unknown as GameState,
      createdAt: FIXED_CREATED_AT
    });
    expect(created).toEqual({ ok: true });

    // 读取时默认值：开场地点视为已到访（与 initializeGameState 语义一致）。
    const record = await loadActiveRecord(repository);
    expect(record.state.visitedLocationIds).toEqual([record.state.currentLocationId]);

    // 旧存档可直接移动：不崩溃、正常完成 quest_m1。
    const result = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_2") }, expectedRevision: 0 },
      performDependencies(repository)
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.revision).toBe(1);

    const after = await loadActiveRecord(repository);
    expect(after.state.visitedLocationIds).toContain(asLocationId("loc_2"));
    expect(
      after.state.quests.find((quest) => quest.questId === asQuestId("quest_m1"))?.status
    ).toBe("completed");
  });
});
