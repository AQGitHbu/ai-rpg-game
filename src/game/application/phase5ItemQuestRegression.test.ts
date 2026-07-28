/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  asLocationId,
  CONTENT_BUDGET,
  type GameTypeId,
  type NewGameInput,
  type QuestDefinition,
  type ScenarioBlueprint
} from "@/game/domain";
import { loadScenarioProfiles } from "@/game/gameplay/rpg/scenario";
import scienceFictionFixture from "../../../data/fixtures/phase1/science_fiction.json";
import urbanFixture from "../../../data/fixtures/phase1/urban.json";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { createGame, type CreateGameDependencies } from "./createGame";
import { getCurrentGame } from "./getCurrentGame";
import { performAction } from "./performAction";
import { runScenarioPipeline, createUnavailableTestScenarioSource, TEST_TRACE_ID } from "./applicationFixture.testutil";
import { asGameId, type GameRecord, type GameRepository } from "./server/persistence/gameRepository";
import { createSqliteClient } from "./server/persistence/sqliteClient";
import {
  createSqliteGameRepository,
  type SqliteGameRepository
} from "./server/persistence/sqliteGameRepository";

// ---------------------------------------------------------------------------
// Phase 5 Task 5：固定 seed 物品取得 + stage 2 完成聚合回归。
// 与 phase4ExplorationRegression.test.ts 的分工：那边覆盖 create → move →
// stage 1 完成 → stage 2 解锁与"stage 2 不能被跳过"；本文件对武侠/科幻/都市
// 三个 pin fixture 各跑一遍 Plan 规定的完整取得旅程
//   创建 → 移动完成 stage 1 → 前往 key 地点 → 与目标 NPC 交谈 → 取得 key
//   → stage 2 completed / stage 3 active → reload
// 并验证：内容预算在旅程后原封不动、item_obtained 事件与背包中的物品
// 恰好一份、reload 后 state/view 与行动返回完全一致、重复取得被拒且零写入。
// 全程真实临时 SQLite，路径显式注入，绝不读 env。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };

const CASES: readonly { gameType: GameTypeId; fixture: Phase1Fixture }[] = [
  { gameType: "wuxia", fixture: wuxiaFixture as unknown as Phase1Fixture },
  { gameType: "science_fiction", fixture: scienceFictionFixture as unknown as Phase1Fixture },
  { gameType: "urban", fixture: urbanFixture as unknown as Phase1Fixture }
];

const PROFILES = loadScenarioProfiles();
const FIXED_CREATED_AT = "2026-07-27T00:00:00.000Z";
const FIXED_ACTION_TIME = "2026-07-27T10:00:00.000Z";

// 与 phase4ExplorationRegression.test.ts 相同的 tmp/ 策略：每次运行独立目录，
// 先清扫上一轮残留（旧进程已退出，句柄已释放）。
const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-phase5-regression-";
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

/** 从端口读回 active 记录：非 active 一律视为断言失败。 */
async function loadActiveRecord(repository: GameRepository): Promise<GameRecord> {
  const loaded = await repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") {
    throw new Error(`期望 active 存档，实际：${JSON.stringify(loaded)}`);
  }
  return loaded.record;
}

/** 蓝图中的 stage N 主线任务：预算固定为三阶段主线，缺失即 fixture 已损坏。 */
function mainQuestOfStage(blueprint: ScenarioBlueprint, stage: 1 | 2 | 3): QuestDefinition {
  const quest = blueprint.quests.find((entry) => entry.kind === "main" && entry.stage === stage);
  if (quest === undefined) throw new Error(`蓝图缺少 stage ${stage} 主线任务`);
  return quest;
}

describe.each(CASES)("Phase 5 物品取得回归（$gameType）", ({ gameType, fixture }) => {
  it("创建 → stage 1 → 前往 key 地点 → 交谈 → 取得 key → stage 2 完成/stage 3 解锁 → reload", async () => {
    // 独立复跑管线：同输入 + seed 的确定性蓝图，作为期望基准。
    const baseline = runScenarioPipeline(fixture.input, fixture.seed);
    const stage1 = mainQuestOfStage(baseline.blueprint, 1);
    const stage2 = mainQuestOfStage(baseline.blueprint, 2);
    const stage3 = mainQuestOfStage(baseline.blueprint, 3);
    if (stage1.onSuccess.kind !== "unlock_quests") {
      throw new Error("stage 1 主线的 onSuccess 应为 unlock_quests");
    }

    // stage 2 的两个 objective：目标 NPC 与 key 物品全部从蓝图派生，不硬编码。
    const talkObjective = stage2.objectives.find((objective) => objective.kind === "talk_to_npc");
    const obtainObjective = stage2.objectives.find((objective) => objective.kind === "obtain_item");
    if (talkObjective?.kind !== "talk_to_npc") throw new Error("stage 2 应含 talk_to_npc objective");
    if (obtainObjective?.kind !== "obtain_item") throw new Error("stage 2 应含 obtain_item objective");
    const keyItem = baseline.blueprint.items.find((item) => item.id === obtainObjective.itemId);
    if (keyItem === undefined) throw new Error("蓝图缺少 stage 2 的 key 物品定义");
    // 蓝图预置落位唯一：只有一个地点声明可取得物品，且恰为 key 物品。
    const stockedLocations = baseline.blueprint.locations.filter(
      (entry) => entry.availableItemIds.length > 0
    );
    expect(stockedLocations).toHaveLength(1);
    const keyLocation = stockedLocations[0];
    expect(keyLocation.availableItemIds).toEqual([obtainObjective.itemId]);
    expect(keyLocation.id).toBe(asLocationId("loc_3"));

    const databasePath = join(RUN_ROOT, `item-journey-${gameType}.sqlite`);
    const writer = openRepository(databasePath);

    // 1) create：开场视图属于正确类型，key 物品 ID 不泄漏（名称可能与玩家
    // 输入文本天然重合——如 urban 的 storyOpening 提及审计底稿——故只锁 ID）。
    const created = await createGame(
      { input: fixture.input, seed: fixture.seed },
      createDependencies(writer, `game-phase5-${gameType}`)
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.view.world.gameType).toBe(gameType);
    expect(created.view.world.name).toBe(PROFILES.gameTypeProfiles[gameType].label);
    expect(JSON.stringify(created.view).includes(obtainObjective.itemId)).toBe(false);

    // 2) Phase 4 序列 + Phase 5 取得：移动完成 stage 1、抵达 key 地点、
    //    与目标 NPC 交谈（talk objective），最后一步取得 key。
    const deps = { repository: writer, now: () => FIXED_ACTION_TIME };
    const journey = [
      { intent: { type: "move", locationId: asLocationId("loc_2") }, expectedRevision: 0 },
      { intent: { type: "move", locationId: keyLocation.id }, expectedRevision: 1 },
      { intent: { type: "talk", npcId: talkObjective.npcId }, expectedRevision: 2 }
    ] as const;
    for (const command of journey) {
      const result = await performAction(command, deps);
      expect(result.ok, JSON.stringify(command.intent)).toBe(true);
      if (!result.ok) return;
    }

    const taken = await performAction(
      { intent: { type: "take_item", itemId: obtainObjective.itemId }, expectedRevision: 3 },
      deps
    );
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.view.revision).toBe(4);
    expect(taken.feedback).toEqual({ ok: true, message: `你取得了${keyItem.name}。` });

    // 3) 取得后的视图：物品从地点消失、背包收录恰好一份、take 行动不再提供；
    //    stage 2 退出 active 列表，stage 3 进入且 defeat_enemy 标记为未支持。
    expect(taken.view.obtainableItems).toEqual([]);
    expect(taken.view.availableActions.filter((action) => action.type === "take_item")).toEqual([]);
    expect(
      taken.view.inventoryItems.filter((item) => item.name === keyItem.name)
    ).toEqual([{ name: keyItem.name, description: keyItem.description }]);
    const activeNames = taken.view.activeQuests.map((quest) => quest.name);
    expect(activeNames).not.toContain(stage2.name);
    expect(activeNames).toContain(stage3.name);
    const stage3View = taken.view.activeQuests.find((quest) => quest.name === stage3.name);
    expect(stage3View?.objectives).toEqual([
      { label: "战胜强敌", completed: false, supported: true }
    ]);
    await writer.close();

    // 4) reload：全新 repository 实例重开同一文件，恢复出完全相同的视图。
    const reader = openRepository(databasePath);
    const restored = await getCurrentGame({ repository: reader });
    expect(restored.status).toBe("active");
    if (restored.status !== "active") return;
    expect(restored.view).toEqual(taken.view);
    expect(JSON.stringify(restored.view)).toBe(JSON.stringify(taken.view));

    // 5) 已存记录复核：任务迁移、事件账本与物品唯一性只认持久化事实。
    const record = await loadActiveRecord(reader);
    const statusById = new Map(record.state.quests.map((quest) => [quest.questId, quest.status]));
    expect(statusById.get(stage1.id)).toBe("completed");
    expect(statusById.get(stage2.id)).toBe("completed");
    expect(statusById.get(stage3.id)).toBe("active");
    // stage 1 解锁的支线保持 active（未推进），stage 2 已完成。
    for (const unlockedId of stage1.onSuccess.questIds) {
      expect(statusById.get(unlockedId), `questId=${unlockedId}`).toBe(
        unlockedId === stage2.id ? "completed" : "active"
      );
    }
    const tailTypes = record.state.eventLedger
      .map((event) => event.type)
      .filter((type) => type !== "game_initialized");
    expect(tailTypes).toEqual([
      "location_visited", "quest_completed", "quest_unlocked",
      ...stage1.onSuccess.questIds.slice(1).map(() => "quest_unlocked"),
      "location_visited", "npc_met",
      "item_obtained", "quest_completed", "quest_unlocked"
    ]);
    // item_obtained 事件与背包中的 key 物品都恰好一份。
    const obtainedEvents = record.state.eventLedger.filter(
      (event) => event.type === "item_obtained"
    );
    expect(obtainedEvents).toEqual([
      {
        type: "item_obtained",
        itemId: obtainObjective.itemId,
        locationId: keyLocation.id,
        occurredAt: FIXED_ACTION_TIME
      }
    ]);
    expect(record.state.inventory).toEqual([...baseline.state.inventory, obtainObjective.itemId]);

    // 6) 内容预算不变：整个旅程后已存蓝图与独立复跑基准逐字节相同。
    expect(record.blueprint).toEqual(baseline.blueprint);
    expect(JSON.stringify(record.blueprint)).toBe(JSON.stringify(baseline.blueprint));
    expect(record.blueprint.contentBudget).toEqual(CONTENT_BUDGET);
    expect(record.blueprint.locations.filter((entry) => entry.kind === "main")).toHaveLength(4);
    expect(record.blueprint.quests.filter((entry) => entry.kind === "main")).toHaveLength(3);
    expect(record.blueprint.endings).toHaveLength(2);

    // 7) 重复取得被拒且零写入：ITEM_ALREADY_OWNED 走 ACTION_REJECTED，
    //    revision、事件账本与背包全部保持原样。
    const retaken = await performAction(
      { intent: { type: "take_item", itemId: obtainObjective.itemId }, expectedRevision: 4 },
      { repository: reader, now: () => FIXED_ACTION_TIME }
    );
    expect(retaken.ok).toBe(false);
    if (retaken.ok) return;
    expect(retaken.code).toBe("ACTION_REJECTED");
    if (retaken.code !== "ACTION_REJECTED") return;
    expect(retaken.feedback.ok).toBe(false);
    const recheck = await loadActiveRecord(reader);
    expect(recheck.revision).toBe(4);
    expect(recheck.state.eventLedger).toHaveLength(record.state.eventLedger.length);
    expect(recheck.state.inventory).toEqual(record.state.inventory);
  });
});
