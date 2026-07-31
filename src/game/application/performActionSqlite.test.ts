/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
  type GameState,
  type NewGameInput,
  type ScenarioBlueprint
} from "@/game/domain";
import { type PlayerIntent } from "@/game/gameplay/rpg/actions";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { createGame, type CreateGameDependencies } from "./createGame";
import { getCurrentGame } from "./getCurrentGame";
import { performAction, type PerformActionDependencies } from "./performAction";
import { runScenarioPipeline, createUnavailableTestScenarioSource, TEST_TRACE_ID } from "./applicationFixture.testutil";
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
const PIPELINE = runScenarioPipeline({ ...FIXTURE.input, gameLength: "short" }, FIXTURE.seed);

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
    now: () => FIXED_CREATED_AT,
    scenarioCandidateSource: createUnavailableTestScenarioSource(),
    newTraceId: () => TEST_TRACE_ID
  };
}

function performDependencies(repository: GameRepository): PerformActionDependencies {
  return { repository, now: () => FIXED_ACTION_TIME };
}

/** 用真实 adapter 建好一局武侠存档（loc_1 开场，quest_main_1 active）。 */
async function seedGame(repository: SqliteGameRepository, gameId: string): Promise<void> {
  const created = await createGame(
    { input: { ...FIXTURE.input, gameLength: "short" }, seed: FIXTURE.seed },
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

// Phase 5 Task 3：stage-2 就绪序列（未取物品）与 take key 意图。
const STAGE_TWO_INTENTS: readonly PlayerIntent[] = [
  { type: "move", locationId: asLocationId("loc_2") },
  { type: "move", locationId: asLocationId("loc_3") },
  { type: "talk", npcId: asNpcId("npc_3") }
];
const TAKE_KEY_INTENT: PlayerIntent = { type: "take_item", itemId: asItemId("item_key") };

/** 依次执行必须成功的行动：revision 从 startRevision 逐次递增。 */
async function performSequence(
  repository: GameRepository,
  intents: readonly PlayerIntent[],
  startRevision: number
): Promise<number> {
  let revision = startRevision;
  for (const intent of intents) {
    const result = await performAction(
      { intent, expectedRevision: revision },
      performDependencies(repository)
    );
    if (!result.ok) throw new Error(`前置行动应当成功：${JSON.stringify(result)}`);
    revision = result.view.revision;
  }
  return revision;
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
    expect(statusById.get(asQuestId("quest_main_1"))).toBe("completed");
    expect(statusById.get(asQuestId("quest_main_2"))).toBe("active");
    // Phase 11：重载后 storyMemory 已持久化并追齐 ledger（真实 SQLite 回读证明）。
    expect(record.state.storyMemory?.reducedThroughEventCount).toBe(record.state.eventLedger.length);
    expect(record.state.storyMemory?.recent.some((entry) => entry.kind === "location")).toBe(true);
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
      applyResolvedAction: (input) => repository.applyResolvedAction(input),
      applyBlueprintExpansion: (input) => repository.applyBlueprintExpansion(input)
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
    // Phase 11：陈旧第二次行动零写入——storyMemory 只反映第一次成功保存。
    expect(record.state.storyMemory?.reducedThroughEventCount).toBe(record.state.eventLedger.length);
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

    // 旧存档可直接移动：不崩溃、正常完成 quest_main_1。
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
      after.state.quests.find((quest) => quest.questId === asQuestId("quest_main_1"))?.status
    ).toBe("completed");
  });
});

describe("performAction × 真实 SQLite：take_item 单次写入与 read model 恢复（Phase 5 Task 3）", () => {
  it("stage-2 talk 后取 key：item_obtained/quest_completed/quest_unlocked 与 revision 一次持久化", async () => {
    const databasePath = nextDbPath();
    const writer = openRepository(databasePath);
    await seedGame(writer, "game-take-write-once");
    const readyRevision = await performSequence(writer, STAGE_TWO_INTENTS, 0);
    expect(readyRevision).toBe(3);
    const baseline = await loadActiveRecord(writer);

    const result = await performAction(
      { intent: TAKE_KEY_INTENT, expectedRevision: readyRevision },
      performDependencies(writer)
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.revision).toBe(4);
    await writer.close();

    // 全新实例重开同一文件：单次写入的完整证明只能来自持久化后的记录。
    const reader = openRepository(databasePath);
    const record = await loadActiveRecord(reader);
    expect(record.revision).toBe(4);
    expect(record.state.inventory).toContain(asItemId("item_key"));
    const tailTypes = record.state.eventLedger
      .slice(baseline.state.eventLedger.length)
      .map((event) => event.type);
    expect(tailTypes).toEqual(["item_obtained", "quest_completed", "quest_unlocked"]);
    const statusById = new Map(record.state.quests.map((quest) => [quest.questId, quest.status]));
    expect(statusById.get(asQuestId("quest_main_2"))).toBe("completed");
    expect(statusById.get(asQuestId("quest_main_3"))).toBe("active");
  });

  it("reload 后 getCurrentGame 的 read model 与 performAction 返回 view 完全一致", async () => {
    const databasePath = nextDbPath();
    const writer = openRepository(databasePath);
    await seedGame(writer, "game-take-reload");
    const readyRevision = await performSequence(writer, STAGE_TWO_INTENTS, 0);

    const result = await performAction(
      { intent: TAKE_KEY_INTENT, expectedRevision: readyRevision },
      performDependencies(writer)
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await writer.close();

    const reader = openRepository(databasePath);
    const restored = await getCurrentGame({ repository: reader });
    expect(restored.status).toBe("active");
    if (restored.status !== "active") return;
    expect(restored.view).toEqual(result.view);
  });
});

describe("performAction × 真实 SQLite：take_item 竞争同一 revision 仅一方成功", () => {
  it("基于同一旧记录的第二次 take 命中 CAS：item_obtained 与背包均只有一份", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    await seedGame(repository, "game-take-cas");
    const readyRevision = await performSequence(repository, STAGE_TWO_INTENTS, 0);
    // 竞争者读到的旧记录（revision 3）：绕过 use case 的 revision 预检，
    // 使冲突只能由 SQLite 层 CAS 裁决。
    const staleLoaded = await repository.getCurrentGame();

    const first = await performAction(
      { intent: TAKE_KEY_INTENT, expectedRevision: readyRevision },
      performDependencies(repository)
    );
    expect(first.ok).toBe(true);

    const staleReader: GameRepository = {
      createInitialGame: (input) => repository.createInitialGame(input),
      getCurrentGame: async () => staleLoaded,
      applyResolvedAction: (input) => repository.applyResolvedAction(input),
      applyBlueprintExpansion: (input) => repository.applyBlueprintExpansion(input)
    };
    const second = await performAction(
      { intent: TAKE_KEY_INTENT, expectedRevision: readyRevision },
      performDependencies(staleReader)
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("STALE_GAME_REVISION");

    // 仅第一次写入生效：事件与背包都不重复。
    const record = await loadActiveRecord(repository);
    expect(record.revision).toBe(4);
    expect(
      record.state.eventLedger.filter((event) => event.type === "item_obtained")
    ).toHaveLength(1);
    expect(
      record.state.inventory.filter((itemId) => itemId === asItemId("item_key"))
    ).toHaveLength(1);
  });
});

describe("performAction × 真实 SQLite：take 拒绝与故障注入零写入", () => {
  it("在 loc_1 取 loc_3 预置的物品被拒绝：state/revision/事件账本原样保留", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    await seedGame(repository, "game-take-rejected");
    const before = await loadActiveRecord(repository);

    const result = await performAction(
      { intent: TAKE_KEY_INTENT, expectedRevision: 0 },
      performDependencies(repository)
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");

    const after = await loadActiveRecord(repository);
    expect(after.revision).toBe(before.revision);
    expect(after.state).toEqual(before.state);
  });

  it("applyResolvedAction 故障注入：INFRASTRUCTURE_FAILURE 且 state/revision/账本不变", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    await seedGame(repository, "game-take-fault");
    const readyRevision = await performSequence(repository, STAGE_TWO_INTENTS, 0);
    const before = await loadActiveRecord(repository);

    const faultyRepository: GameRepository = {
      createInitialGame: (input) => repository.createInitialGame(input),
      getCurrentGame: () => repository.getCurrentGame(),
      applyResolvedAction: async () => {
        throw new Error("injected sqlite fault");
      },
      applyBlueprintExpansion: async () => {
        throw new Error("injected sqlite fault");
      }
    };
    const result = await performAction(
      { intent: TAKE_KEY_INTENT, expectedRevision: readyRevision },
      performDependencies(faultyRepository)
    );
    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });

    const after = await loadActiveRecord(repository);
    expect(after.revision).toBe(before.revision);
    expect(after.state).toEqual(before.state);
  });
});

describe("performAction × 真实 SQLite：Phase 4 旧存档兼容（无 availableItemIds / item_obtained）", () => {
  it("旧蓝图地点无 availableItemIds：读取补默认 []，伪造 take 被拒且零写入，可继续推进", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    // 模拟 Phase 4 存档：序列化前剔除每个地点的 availableItemIds 字段。
    const legacyBlueprint = {
      ...PIPELINE.blueprint,
      locations: PIPELINE.blueprint.locations.map((location) => {
        const { availableItemIds: _stripped, ...rest } = location;
        void _stripped;
        return rest;
      })
    } as unknown as ScenarioBlueprint;
    const created = await repository.createInitialGame({
      gameId: asGameId("game-legacy-blueprint"),
      blueprint: legacyBlueprint,
      state: PIPELINE.state,
      createdAt: FIXED_CREATED_AT
    });
    expect(created).toEqual({ ok: true });

    // 读取时补默认值：旧蓝图没有任何地点预置物品；旧存档无 item_obtained、
    // 背包仅含初始物品——无需 schema 升级或回写。
    const record = await loadActiveRecord(repository);
    for (const location of record.blueprint.locations) {
      expect(location.availableItemIds).toEqual([]);
    }
    expect(record.state.inventory).toEqual([asItemId("item_start")]);
    expect(record.state.eventLedger.some((event) => event.type === "item_obtained")).toBe(false);

    // 伪造的 take 意图被规则拒绝（而非基础设施失败），且零写入。
    const forged = await performAction(
      { intent: TAKE_KEY_INTENT, expectedRevision: 0 },
      performDependencies(repository)
    );
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect(forged.code).toBe("ACTION_REJECTED");
    const afterForged = await loadActiveRecord(repository);
    expect(afterForged.revision).toBe(0);
    expect(afterForged.state).toEqual(record.state);

    // 旧存档可正常继续：移动完成 quest_main_1，会话视图投影不崩溃。
    const moved = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_2") }, expectedRevision: 0 },
      performDependencies(repository)
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.view.revision).toBe(1);
    expect(moved.view.obtainableItems).toEqual([]);
    const after = await loadActiveRecord(repository);
    expect(
      after.state.quests.find((quest) => quest.questId === asQuestId("quest_main_1"))?.status
    ).toBe("completed");
  });

  it("旧档成功行动后 applyResolvedAction read-back 蓝图每个地点 availableItemIds 均为数组", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    // 与上一用例相同的 Phase 4 旧档构造：序列化前剔除每个地点的 availableItemIds。
    const legacyBlueprint = {
      ...PIPELINE.blueprint,
      locations: PIPELINE.blueprint.locations.map((location) => {
        const { availableItemIds: _stripped, ...rest } = location;
        void _stripped;
        return rest;
      })
    } as unknown as ScenarioBlueprint;
    const created = await repository.createInitialGame({
      gameId: asGameId("game-legacy-readback"),
      blueprint: legacyBlueprint,
      state: PIPELINE.state,
      createdAt: FIXED_CREATED_AT
    });
    expect(created).toEqual({ ok: true });

    // 包装 repository 捕获 applyResolvedAction 的 read-back 记录：
    // 类型契约声明 availableItemIds 必有，read-back 路径也必须补默认值。
    let readBack: GameRecord | undefined;
    const capturingRepository: GameRepository = {
      createInitialGame: (input) => repository.createInitialGame(input),
      getCurrentGame: () => repository.getCurrentGame(),
      applyResolvedAction: async (input) => {
        const applied = await repository.applyResolvedAction(input);
        if (applied.ok) readBack = applied.record;
        return applied;
      },
      applyBlueprintExpansion: (input) => repository.applyBlueprintExpansion(input)
    };
    const moved = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_2") }, expectedRevision: 0 },
      performDependencies(capturingRepository)
    );
    expect(moved.ok).toBe(true);
    expect(readBack).toBeDefined();
    if (readBack === undefined) return;
    expect(readBack.blueprint.locations.length).toBeGreaterThan(0);
    for (const location of readBack.blueprint.locations) {
      expect(Array.isArray(location.availableItemIds)).toBe(true);
    }
  });
});

describe("performAction × 真实 SQLite：Phase 6 旧存档兼容（无 defeatedEnemyIds / battle / ending / enemy locationId）", () => {
  it("无 Phase 6 state 字段的旧存档读取默认值，并可正常移动", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    // 模拟 Phase 5 存档：序列化前剥离 defeatedEnemyIds / battle / ending 字段。
    const { defeatedEnemyIds: _1, battle: _2, ending: _3, ...legacyState } = PIPELINE.state;
    void _1; void _2; void _3;
    // 模拟 Phase 5 蓝图：剥离每个敌人的 locationId 字段。
    const legacyBlueprint = {
      ...PIPELINE.blueprint,
      enemies: PIPELINE.blueprint.enemies.map((enemy) => {
        const { locationId: _stripped, ...rest } = enemy;
        void _stripped;
        return rest;
      })
    } as unknown as ScenarioBlueprint;
    const created = await repository.createInitialGame({
      gameId: asGameId("game-legacy-phase6"),
      blueprint: legacyBlueprint,
      state: legacyState as unknown as GameState,
      createdAt: FIXED_CREATED_AT
    });
    expect(created).toEqual({ ok: true });

    // 读取时补默认值：state 有 Phase 6 默认值，blueprint 敌人有 locationId。
    const record = await loadActiveRecord(repository);
    expect(record.state.defeatedEnemyIds).toEqual([]);
    expect(record.state.battle).toEqual({ status: "idle" });
    expect(record.state.ending).toBeNull();
    for (const enemy of record.blueprint.enemies) {
      expect(typeof enemy.locationId).toBe("string");
      expect(enemy.locationId.length).toBeGreaterThan(0);
    }

    // 旧存档可直接移动：不崩溃、正常完成 quest_main_1。
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
      after.state.quests.find((quest) => quest.questId === asQuestId("quest_main_1"))?.status
    ).toBe("completed");
  });

  it("applyResolvedAction read-back 也补 Phase 6 蓝图 enemy locationId 默认值", async () => {
    const databasePath = nextDbPath();
    const repository = openRepository(databasePath);
    // 与上一用例相同的 Phase 5 旧档构造。
    const { defeatedEnemyIds: _1, battle: _2, ending: _3, ...legacyState } = PIPELINE.state;
    void _1; void _2; void _3;
    const legacyBlueprint = {
      ...PIPELINE.blueprint,
      enemies: PIPELINE.blueprint.enemies.map((enemy) => {
        const { locationId: _stripped, ...rest } = enemy;
        void _stripped;
        return rest;
      })
    } as unknown as ScenarioBlueprint;
    const created = await repository.createInitialGame({
      gameId: asGameId("game-legacy-readback-phase6"),
      blueprint: legacyBlueprint,
      state: legacyState as unknown as GameState,
      createdAt: FIXED_CREATED_AT
    });
    expect(created).toEqual({ ok: true });

    // 捕获 applyResolvedAction 的 read-back 记录。
    let readBack: GameRecord | undefined;
    const capturingRepository: GameRepository = {
      createInitialGame: (input) => repository.createInitialGame(input),
      getCurrentGame: () => repository.getCurrentGame(),
      applyResolvedAction: async (input) => {
        const result = await repository.applyResolvedAction(input);
        if (result.ok) readBack = result.record;
        return result;
      },
      applyBlueprintExpansion: (input) => repository.applyBlueprintExpansion(input)
    };

    const moved = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_2") }, expectedRevision: 0 },
      performDependencies(capturingRepository)
    );
    expect(moved.ok).toBe(true);
    expect(readBack).toBeDefined();
    if (readBack === undefined) return;
    expect(readBack.blueprint.enemies.length).toBeGreaterThan(0);
    for (const enemy of readBack.blueprint.enemies) {
      expect(typeof enemy.locationId).toBe("string");
      expect(enemy.locationId.length).toBeGreaterThan(0);
    }
  });
});
