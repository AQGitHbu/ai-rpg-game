/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  asLocationId,
  type QuestDefinition,
  type ScenarioBlueprint
} from "@/game/domain";
import {
  compileScenarioBlueprint,
  initializeGameState,
  loadScenarioProfiles,
  validateScenarioBlueprintCandidate
} from "@/game/gameplay/rpg/scenario";
import {
  makeValidCandidate,
  TEST_POLICY,
  TEST_PROFILE
} from "@/game/gameplay/rpg/scenario/scenarioBlueprintFixture.testutil";
import { getCurrentGame } from "./getCurrentGame";
import { performAction } from "./performAction";
import type { GameSessionView } from "./gameSessionView";
import { asGameId, type GameRecord, type GameRepository } from "./server/persistence/gameRepository";
import { createSqliteClient } from "./server/persistence/sqliteClient";
import {
  createSqliteGameRepository,
  type SqliteGameRepository
} from "./server/persistence/sqliteGameRepository";

// ---------------------------------------------------------------------------
// Phase 4 Task 5：固定 seed 探索聚合回归。
// 与 performActionSqlite.test.ts 的分工：那边用武侠 fixture 深挖单点保证
// （单次写入、CAS 竞争、拒绝零写入、旧存档兼容）；本文件对武侠/科幻/都市
// 三个 pin fixture 各跑一遍完整探索旅程
//   create → move（loc_1 → loc_2）→ stage 1 完成 → stage 2 解锁 → reload
// 并验证：视图内容与该类型独立复跑管线的蓝图一致（类型一致性）、
// 内容预算在整个旅程后原封不动、刷新后恢复出与行动返回完全相同的视图。
// 全程真实临时 SQLite，路径显式注入，绝不读 env。
// ---------------------------------------------------------------------------

// Phase 14 开局收窄后 createGame 只产出 1 幕起始锚点蓝图；本文件的完整探索
// 旅程（move loc_b 完成 stage 1 → stage 2 解锁 → reload）需要"运行时扩展后"
// 的完整蓝图。以 makeValidCandidate 为基座编译（wuxia 题材），直接写入真实
// SQLite 存档后走 performAction 真实管线。
function compileRuntimeBlueprint(): ScenarioBlueprint {
  const compiled = compileScenarioBlueprint(
    validateScenarioBlueprintCandidate(makeValidCandidate(), {
      profile: TEST_PROFILE,
      policy: TEST_POLICY,
      phase: "runtime_expansion"
    })
  );
  if (!compiled.ok) {
    throw new Error(`fixture 蓝图应当合法：${JSON.stringify(compiled.issues)}`);
  }
  return compiled.blueprint;
}

const RUNTIME_BLUEPRINT = compileRuntimeBlueprint();
const PIPELINE = { blueprint: RUNTIME_BLUEPRINT, state: initializeGameState(RUNTIME_BLUEPRINT) };

const PROFILES = loadScenarioProfiles();
const FIXED_CREATED_AT = "2026-07-27T00:00:00.000Z";
const FIXED_ACTION_TIME = "2026-07-27T10:00:00.000Z";

// 与 createGameSqlite.test.ts 相同的 tmp/ 策略：每次运行独立目录，
// 先清扫上一轮残留（旧进程已退出，句柄已释放）。
const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-phase4-regression-";
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

/** 用真实 adapter 写入完整蓝图存档（loc_a 开场，m1 active）。 */
async function seedGame(repository: SqliteGameRepository, gameId: string): Promise<void> {
  const created = await repository.createInitialGame({
    gameId: asGameId(gameId),
    blueprint: PIPELINE.blueprint,
    state: PIPELINE.state,
    createdAt: FIXED_CREATED_AT
  });
  expect(created).toEqual({ ok: true });
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

describe("Phase 4 探索回归（wuxia）", () => {
  // 独立复跑管线：makeValidCandidate 完整蓝图的确定性结果，作为期望基准。
  const baseline = PIPELINE;
  const stage1 = mainQuestOfStage(baseline.blueprint, 1);
  const stage2 = mainQuestOfStage(baseline.blueprint, 2);

  it("create → move → stage 1 完成 → stage 2 解锁 → reload，类型内容与预算不变", async () => {
    const loc2 = baseline.blueprint.locations.find((entry) => entry.id === asLocationId("loc_b"));
    if (loc2 === undefined) throw new Error("蓝图缺少 loc_b");

    const databasePath = join(RUN_ROOT, "journey-wuxia.sqlite");
    const writer = openRepository(databasePath);

    // 1) 建档：开场视图属于正确类型，stage 1 是唯一 active 任务。
    await seedGame(writer, "game-phase4-wuxia");
    const created = await getCurrentGame({ repository: writer });
    expect(created.status).toBe("active");
    if (created.status !== "active") return;
    expect(created.view.world.gameType).toBe("wuxia");
    expect(created.view.world.name).toBe(PROFILES.gameTypeProfiles.wuxia.label);
    expect(created.view.activeQuests.map((quest) => quest.name)).toEqual([stage1.name]);

    // 2) move loc_a → loc_b：stage 1 的 visit_location objective 由此满足。
    const moved = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_b") }, expectedRevision: 0 },
      { repository: writer, now: () => FIXED_ACTION_TIME }
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.view.revision).toBe(1);
    expect(moved.view.currentLocation.name).toBe(loc2.name);
    expect(moved.feedback).toEqual({ ok: true, message: `你来到了${loc2.name}。` });

    // 3) stage 1 完成、stage 2 解锁：active 列表换成 stage 2 与被解锁的支线。
    const activeNames = moved.view.activeQuests.map((quest) => quest.name);
    expect(activeNames).not.toContain(stage1.name);
    expect(activeNames).toContain(stage2.name);

    // Phase 7：地图/地点/对话 read model 保持封闭可见范围——首节点是当前地点，
    // 且地图/地点/对话投影 JSON 不泄漏隐藏地点真实名称、seed 或 inputDigest。
    //（activeQuests 描述等叙事文案由现有内容决策控制，不属本任务新增面。）
    expect(moved.view.worldMap.nodes[0]?.state).toBe("current");
    expect(moved.view.locationScene.title).toBe(loc2.name);
    const adventureJson = JSON.stringify({
      worldMap: moved.view.worldMap,
      locationScene: moved.view.locationScene,
      dialogues: moved.view.dialogues
    });
    for (const hidden of baseline.blueprint.locations.filter((entry) => entry.kind === "hidden")) {
      expect(adventureJson.includes(hidden.name), `hidden=${hidden.name}`).toBe(false);
    }
    expect(adventureJson.includes(baseline.blueprint.seed)).toBe(false);
    expect(adventureJson.includes(baseline.blueprint.inputDigest)).toBe(false);
    await writer.close();

    // 4) reload：全新 repository 实例重开同一文件，恢复出完全相同的视图。
    const reader = openRepository(databasePath);
    const restored = await getCurrentGame({ repository: reader });
    expect(restored.status).toBe("active");
    if (restored.status !== "active") return;
    expect(restored.view).toEqual(moved.view);
    expect(JSON.stringify(restored.view)).toBe(JSON.stringify(moved.view));

    // 5) 已存记录复核：任务迁移、事件账本与蓝图不可变性只认持久化事实。
    const record = await loadActiveRecord(reader);
    const statusById = new Map(record.state.quests.map((quest) => [quest.questId, quest.status]));
    expect(statusById.get(stage1.id)).toBe("completed");
    expect(statusById.get(stage2.id)).toBe("active");
    expect(statusById.get(mainQuestOfStage(baseline.blueprint, 3).id)).toBe("locked");
    // stage 1 的 unlock_quests 目标（stage 2 + 支线）全部转为 active。
    if (stage1.onSuccess.kind !== "unlock_quests") {
      throw new Error("stage 1 主线的 onSuccess 应为 unlock_quests");
    }
    for (const unlockedId of stage1.onSuccess.questIds) {
      expect(statusById.get(unlockedId), `questId=${unlockedId}`).toBe("active");
    }
    const tailTypes = record.state.eventLedger
      .map((event) => event.type)
      .filter((type) => type !== "game_initialized");
    expect(tailTypes).toEqual(["location_visited", "quest_completed", "quest_unlocked",
      ...stage1.onSuccess.questIds.slice(1).map(() => "quest_unlocked")]);

    // 6) 内容预算不变：整个旅程后已存蓝图与独立复跑基准逐字节相同。
    expect(record.blueprint).toEqual(baseline.blueprint);
    expect(JSON.stringify(record.blueprint)).toBe(JSON.stringify(baseline.blueprint));
    expect(record.blueprint.locations.filter((entry) => entry.kind === "main")).toHaveLength(4);
    expect(record.blueprint.quests.filter((entry) => entry.kind === "main")).toHaveLength(3);
    expect(record.blueprint.endings).toHaveLength(2);
  });

  it("stage 2 不能被跳过：obtain_item objective 未满足前任务保持 active", async () => {
    // 前提确认：stage 2 含 obtain_item objective（Phase 5 已支持，但未取得前不满足）。
    expect(stage2.objectives.some((objective) => objective.kind === "obtain_item")).toBe(true);

    const databasePath = join(RUN_ROOT, "no-skip-wuxia.sqlite");
    const repository = openRepository(databasePath);
    await seedGame(repository, "game-phase4-noskip-wuxia");

    // 解锁 stage 2 后只做交谈：移动到 npc_3 所在的 loc_3 并与其交谈，
    // 满足 talk_to_npc objective——但 obtain_item 尚未满足（未拾取），任务必须
    // 保持 active，不得产生 stage 2 的 quest_completed。
    const talkObjective = stage2.objectives.find(
      (objective) => objective.kind === "talk_to_npc"
    );
    if (talkObjective?.kind !== "talk_to_npc") {
      throw new Error("stage 2 应含 talk_to_npc objective");
    }
    const deps = { repository, now: () => FIXED_ACTION_TIME };
    const journey = [
      { intent: { type: "move", locationId: asLocationId("loc_b") }, expectedRevision: 0 },
      { intent: { type: "move", locationId: asLocationId("loc_c") }, expectedRevision: 1 },
      { intent: { type: "talk", npcId: talkObjective.npcId }, expectedRevision: 2 }
    ] as const;
    let lastView: GameSessionView | undefined;
    for (const command of journey) {
      const result = await performAction(command, deps);
      expect(result.ok, JSON.stringify(command.intent)).toBe(true);
      if (!result.ok) return;
      lastView = result.view;
    }

    const stage2View = lastView?.activeQuests.find((quest) => quest.name === stage2.name);
    expect(stage2View).toBeDefined();
    // talk objective 已完成；obtain_item objective（Phase 5 起 supported: true）
    // 在未拾取前保持 completed: false，任务因此不可被 talk 单独完成。
    expect(stage2View?.objectives.some((o) => o.supported && o.completed)).toBe(true);
    const pending = stage2View?.objectives.filter((objective) => !objective.completed) ?? [];
    expect(pending.length).toBeGreaterThanOrEqual(1);

    // 持久化事实复核：stage 2 仍 active，整本账只有 stage 1 的 quest_completed。
    const record = await loadActiveRecord(repository);
    expect(
      record.state.quests.find((quest) => quest.questId === stage2.id)?.status
    ).toBe("active");
    const completedIds = record.state.eventLedger.flatMap((event) =>
      event.type === "quest_completed" ? [event.questId] : []
    );
    expect(completedIds).toEqual([mainQuestOfStage(baseline.blueprint, 1).id]);
  });
});
