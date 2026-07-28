/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  asLocationId,
  CONTENT_BUDGET,
  type EnemyId,
  type GameTypeId,
  type NewGameInput,
  type QuestDefinition,
  type ScenarioBlueprint
} from "@/game/domain";
import { type PlayerIntent } from "@/game/gameplay/rpg/actions";
import scienceFictionFixture from "../../../data/fixtures/phase1/science_fiction.json";
import urbanFixture from "../../../data/fixtures/phase1/urban.json";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { createGame, type CreateGameDependencies } from "./createGame";
import { getCurrentGame } from "./getCurrentGame";
import { performAction } from "./performAction";
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
// Phase 6 Task 5b：固定 seed 战斗与双结局 SQLite 回归。
//
// 对武侠/科幻/都市三个 pin fixture 各跑两条完整旅程：
//   1) 成功：创建 → stage 1 → stage 2 → stage 3 → boss 胜利 → 成功 ending
//   2) 失败：同路径 → start_battle → withdraw → failed stage 3 → 失败 ending
//
// 验证：
//   - 每条旅程的事件账本无重复（enemy_defeated/quest_failed/ending_reached 各一份）
//   - 刷新后 getCurrentGame 与 performAction 返回 view 完全一致
//   - 内容预算在整个旅程后原封不动
//   - 结局后所有 action 安全拒绝且零写入
//
// 全程真实临时 SQLite，路径显式注入，绝不读 env。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };

const CASES: readonly { gameType: GameTypeId; fixture: Phase1Fixture }[] = [
  { gameType: "wuxia", fixture: wuxiaFixture as unknown as Phase1Fixture },
  { gameType: "science_fiction", fixture: scienceFictionFixture as unknown as Phase1Fixture },
  { gameType: "urban", fixture: urbanFixture as unknown as Phase1Fixture }
];

const FIXED_CREATED_AT = "2026-07-28T00:00:00.000Z";
const FIXED_ACTION_TIME = "2026-07-28T10:00:00.000Z";

// 与 phase5ItemQuestRegression.test.ts 相同的 tmp/ 策略。
const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-phase6-regression-";
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

function performDeps(repository: GameRepository) {
  return { repository, now: () => FIXED_ACTION_TIME };
}

/** 从端口读回 active 记录。 */
async function loadActiveRecord(repository: GameRepository): Promise<GameRecord> {
  const loaded = await repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") {
    throw new Error(`期望 active 存档，实际：${JSON.stringify(loaded)}`);
  }
  return loaded.record;
}

/** 蓝图中的 stage N 主线任务。 */
function mainQuestOfStage(blueprint: ScenarioBlueprint, stage: 1 | 2 | 3): QuestDefinition {
  const quest = blueprint.quests.find((entry) => entry.kind === "main" && entry.stage === stage);
  if (quest === undefined) throw new Error(`蓝图缺少 stage ${stage} 主线任务`);
  return quest;
}

/** 依次执行必须成功的行动。 */
async function performSequence(
  repository: GameRepository,
  intents: readonly PlayerIntent[],
  startRevision: number
): Promise<number> {
  let revision = startRevision;
  for (const intent of intents) {
    const result = await performAction(
      { intent, expectedRevision: revision },
      performDeps(repository)
    );
    if (!result.ok) throw new Error(`前置行动应当成功：${JSON.stringify(intent)} → ${JSON.stringify(result)}`);
    revision = result.view.revision;
  }
  return revision;
}

/** 从蓝图推导出到达 stage 3 active（boss 可战）的前置序列。 */
function buildStage3ReadyIntents(blueprint: ScenarioBlueprint): readonly PlayerIntent[] {
  const stage2 = mainQuestOfStage(blueprint, 2);
  const talkObjective = stage2.objectives.find((obj) => obj.kind === "talk_to_npc");
  const obtainObjective = stage2.objectives.find((obj) => obj.kind === "obtain_item");
  if (talkObjective?.kind !== "talk_to_npc") throw new Error("stage 2 应含 talk_to_npc objective");
  if (obtainObjective?.kind !== "obtain_item") throw new Error("stage 2 应含 obtain_item objective");

  const stockedLocations = blueprint.locations.filter(
    (entry) => entry.availableItemIds.length > 0
  );
  if (stockedLocations.length !== 1) throw new Error("蓝图预置落位应唯一");
  const keyLocation = stockedLocations[0];

  return [
    { type: "move", locationId: asLocationId("loc_2") } as PlayerIntent,
    { type: "move", locationId: keyLocation.id } as PlayerIntent,
    { type: "talk", npcId: talkObjective.npcId } as PlayerIntent,
    { type: "take_item", itemId: obtainObjective.itemId } as PlayerIntent
  ];
}

/** 从蓝图找到 boss 敌人 ID 及其地点。 */
function findBossEnemy(blueprint: ScenarioBlueprint): { enemyId: EnemyId; locationId: string } {
  const boss = blueprint.enemies.find((e) => e.tier === "boss");
  if (boss === undefined) throw new Error("蓝图缺少 boss 敌人");
  return { enemyId: boss.id, locationId: boss.locationId };
}

describe.each(CASES)("Phase 6 战斗与双结局回归（$gameType）", ({ gameType, fixture }) => {
  // 独立复跑管线：同输入 + seed 的确定性蓝图，作为期望基准。
  const baseline = runScenarioPipeline(fixture.input, fixture.seed);
  const stage1 = mainQuestOfStage(baseline.blueprint, 1);
  const stage2 = mainQuestOfStage(baseline.blueprint, 2);
  const stage3 = mainQuestOfStage(baseline.blueprint, 3);
  const boss = findBossEnemy(baseline.blueprint);
  const stage3ReadyIntents = buildStage3ReadyIntents(baseline.blueprint);

  // boss 数值：hp=20, attack=5, defense=2；玩家 attack=6, defense=4
  // 每回合 attack 造成 max(1,6-2)=4 伤害，需要 5 回合击杀。
  // boss 每回合反击 max(1,5-4)=1 伤害，4 回合共 4 伤害，玩家剩 26 HP。
  const BOSS_HP = 20;
  const PLAYER_DAMAGE_PER_ATTACK = 4;
  const ATTACKS_TO_KILL = Math.ceil(BOSS_HP / PLAYER_DAMAGE_PER_ATTACK); // 5

  // -----------------------------------------------------------------------
  // 成功旅程：创建 → stage 1/2/3 → boss 胜利 → 成功 ending
  // -----------------------------------------------------------------------
  it("成功：创建 → stage 1/2/3 → start_battle → attack×5 → 胜利 ending → reload", async () => {
    const databasePath = join(RUN_ROOT, `victory-${gameType}.sqlite`);
    const writer = openRepository(databasePath);

    // 1) create
    const created = await createGame(
      { input: fixture.input, seed: fixture.seed },
      createDependencies(writer, `game-phase6-victory-${gameType}`)
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // 2) 推进到 stage 3 active（loc_3，已取得 key，quest_m3 active）
    let revision = await performSequence(writer, stage3ReadyIntents, 0);
    expect(revision).toBe(4);

    // 3) 移动到 boss 地点 loc_4
    const movedToBoss = await performAction(
      { intent: { type: "move", locationId: asLocationId(boss.locationId) }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(movedToBoss.ok).toBe(true);
    if (!movedToBoss.ok) return;
    revision = movedToBoss.view.revision;
    expect(revision).toBe(5);

    // 4) start_battle
    const battleStarted = await performAction(
      { intent: { type: "start_battle", enemyId: boss.enemyId }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(battleStarted.ok).toBe(true);
    if (!battleStarted.ok) return;
    revision = battleStarted.view.revision;
    expect(revision).toBe(6);
    // battle view 应已投影
    expect(battleStarted.view.battle).not.toBeNull();
    if (battleStarted.view.battle === null) return;
    expect(battleStarted.view.battle.enemyHp).toBe(BOSS_HP);
    expect(battleStarted.view.battle.playerHp).toBe(30);
    expect(battleStarted.view.battle.round).toBe(1);

    // 5) 连续 attack 直到 boss 被击败
    let lastView = battleStarted.view;
    for (let i = 0; i < ATTACKS_TO_KILL; i += 1) {
      const attackResult = await performAction(
        { intent: { type: "battle_action", action: "attack" }, expectedRevision: revision },
        performDeps(writer)
      );
      expect(attackResult.ok, `attack round ${i + 1}`).toBe(true);
      if (!attackResult.ok) return;
      revision = attackResult.view.revision;
      lastView = attackResult.view;

      if (i < ATTACKS_TO_KILL - 1) {
        // 战斗仍在进行
        expect(attackResult.view.battle).not.toBeNull();
        if (attackResult.view.battle === null) return;
        expect(attackResult.view.battle.enemyHp).toBe(BOSS_HP - (i + 1) * PLAYER_DAMAGE_PER_ATTACK);
        expect(attackResult.view.ending).toBeNull();
      }
    }

    // 6) 最后一击应触发胜利 + 结局
    expect(lastView.ending).not.toBeNull();
    if (lastView.ending === null) return;
    expect(lastView.ending.outcome).toBe("success");
    expect(lastView.battle).toBeNull();
    // 结局后不投影任何可用行动
    expect(lastView.availableActions).toEqual([]);

    // 7) 验证 revision 增量：start_battle(6) + 5 attacks = 11
    expect(revision).toBe(11);
    await writer.close();

    // 8) reload：全新 repository 重开同一文件
    const reader = openRepository(databasePath);
    const restored = await getCurrentGame({ repository: reader });
    expect(restored.status).toBe("active");
    if (restored.status !== "active") return;
    expect(restored.view).toEqual(lastView);

    // 9) 已存记录复核
    const record = await loadActiveRecord(reader);
    // stage 3 应为 completed
    const statusById = new Map(record.state.quests.map((q) => [q.questId, q.status]));
    expect(statusById.get(stage1.id)).toBe("completed");
    expect(statusById.get(stage2.id)).toBe("completed");
    expect(statusById.get(stage3.id)).toBe("completed");
    // boss 在 defeatedEnemyIds 中
    expect(record.state.defeatedEnemyIds).toContain(boss.enemyId);
    // 结局状态
    expect(record.state.ending).not.toBeNull();
    if (record.state.ending === null) return;
    expect(record.state.ending.outcome).toBe("success");
    // battle 为 resolved
    expect(record.state.battle.status).toBe("resolved");

    // 10) 事件账本无重复
    const enemyDefeatedEvents = record.state.eventLedger.filter((e) => e.type === "enemy_defeated");
    expect(enemyDefeatedEvents).toHaveLength(1);
    const endingReachedEvents = record.state.eventLedger.filter((e) => e.type === "ending_reached");
    expect(endingReachedEvents).toHaveLength(1);
    const battleResolvedEvents = record.state.eventLedger.filter((e) => e.type === "battle_resolved");
    expect(battleResolvedEvents).toHaveLength(1);
    const questCompletedM3 = record.state.eventLedger.filter(
      (e) => e.type === "quest_completed" && "questId" in e && e.questId === stage3.id
    );
    expect(questCompletedM3).toHaveLength(1);

    // 11) 内容预算不变
    expect(record.blueprint).toEqual(baseline.blueprint);
    expect(record.blueprint.contentBudget).toEqual(CONTENT_BUDGET);

    // 12) 结局后 action 安全拒绝且零写入
    const postEndingAction = await performAction(
      { intent: { type: "battle_action", action: "attack" }, expectedRevision: revision },
      performDeps(reader)
    );
    expect(postEndingAction.ok).toBe(false);
    if (postEndingAction.ok) return;
    expect(postEndingAction.code).toBe("ACTION_REJECTED");
    const afterReject = await loadActiveRecord(reader);
    expect(afterReject.revision).toBe(revision);
  });

  // -----------------------------------------------------------------------
  // 失败旅程：同路径 → start_battle → withdraw → 失败 ending
  // -----------------------------------------------------------------------
  it("失败：创建 → stage 1/2/3 → start_battle → withdraw → 失败 ending → reload", async () => {
    const databasePath = join(RUN_ROOT, `withdraw-${gameType}.sqlite`);
    const writer = openRepository(databasePath);

    // 1) create
    const created = await createGame(
      { input: fixture.input, seed: fixture.seed },
      createDependencies(writer, `game-phase6-withdraw-${gameType}`)
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // 2) 推进到 stage 3 active
    let revision = await performSequence(writer, stage3ReadyIntents, 0);
    expect(revision).toBe(4);

    // 3) 移动到 boss 地点
    const movedToBoss = await performAction(
      { intent: { type: "move", locationId: asLocationId(boss.locationId) }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(movedToBoss.ok).toBe(true);
    if (!movedToBoss.ok) return;
    revision = movedToBoss.view.revision;
    expect(revision).toBe(5);

    // 4) start_battle
    const battleStarted = await performAction(
      { intent: { type: "start_battle", enemyId: boss.enemyId }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(battleStarted.ok).toBe(true);
    if (!battleStarted.ok) return;
    revision = battleStarted.view.revision;
    expect(revision).toBe(6);

    // 5) withdraw — 立即失败
    const withdrawResult = await performAction(
      { intent: { type: "battle_action", action: "withdraw" }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(withdrawResult.ok).toBe(true);
    if (!withdrawResult.ok) return;
    revision = withdrawResult.view.revision;
    expect(revision).toBe(7);

    // 6) 验证失败 ending
    expect(withdrawResult.view.ending).not.toBeNull();
    if (withdrawResult.view.ending === null) return;
    expect(withdrawResult.view.ending.outcome).toBe("failure");
    expect(withdrawResult.view.battle).toBeNull();
    expect(withdrawResult.view.availableActions).toEqual([]);
    await writer.close();

    // 7) reload
    const reader = openRepository(databasePath);
    const restored = await getCurrentGame({ repository: reader });
    expect(restored.status).toBe("active");
    if (restored.status !== "active") return;
    expect(restored.view).toEqual(withdrawResult.view);

    // 8) 已存记录复核
    const record = await loadActiveRecord(reader);
    const statusById = new Map(record.state.quests.map((q) => [q.questId, q.status]));
    expect(statusById.get(stage1.id)).toBe("completed");
    expect(statusById.get(stage2.id)).toBe("completed");
    expect(statusById.get(stage3.id)).toBe("failed");
    // boss 不在 defeatedEnemyIds 中
    expect(record.state.defeatedEnemyIds).not.toContain(boss.enemyId);
    expect(record.state.defeatedEnemyIds).toEqual([]);
    // 结局状态
    expect(record.state.ending).not.toBeNull();
    if (record.state.ending === null) return;
    expect(record.state.ending.outcome).toBe("failure");
    // battle 为 resolved（withdraw）
    expect(record.state.battle.status).toBe("resolved");

    // 9) 事件账本无重复
    const questFailedEvents = record.state.eventLedger.filter((e) => e.type === "quest_failed");
    expect(questFailedEvents).toHaveLength(1);
    const endingReachedEvents = record.state.eventLedger.filter((e) => e.type === "ending_reached");
    expect(endingReachedEvents).toHaveLength(1);
    const battleResolvedEvents = record.state.eventLedger.filter((e) => e.type === "battle_resolved");
    expect(battleResolvedEvents).toHaveLength(1);
    const enemyDefeatedEvents = record.state.eventLedger.filter((e) => e.type === "enemy_defeated");
    expect(enemyDefeatedEvents).toHaveLength(0);

    // 10) 内容预算不变
    expect(record.blueprint).toEqual(baseline.blueprint);
    expect(record.blueprint.contentBudget).toEqual(CONTENT_BUDGET);

    // 11) 结局后 action 安全拒绝且零写入
    const postEndingAction = await performAction(
      { intent: { type: "battle_action", action: "withdraw" }, expectedRevision: revision },
      performDeps(reader)
    );
    expect(postEndingAction.ok).toBe(false);
    if (postEndingAction.ok) return;
    expect(postEndingAction.code).toBe("ACTION_REJECTED");
    const afterReject = await loadActiveRecord(reader);
    expect(afterReject.revision).toBe(revision);
  });

  // -----------------------------------------------------------------------
  // 战斗中途 reload 一致性
  // -----------------------------------------------------------------------
  it("战斗中途 reload：getCurrentGame 恢复 active battle view 与 performAction 返回一致", async () => {
    const databasePath = join(RUN_ROOT, `midbattle-reload-${gameType}.sqlite`);
    const writer = openRepository(databasePath);

    // 创建并推进到 stage 3
    const created = await createGame(
      { input: fixture.input, seed: fixture.seed },
      createDependencies(writer, `game-phase6-midbattle-${gameType}`)
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    let revision = await performSequence(writer, stage3ReadyIntents, 0);
    expect(revision).toBe(4);

    // 移动到 boss 地点
    const movedToBoss = await performAction(
      { intent: { type: "move", locationId: asLocationId(boss.locationId) }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(movedToBoss.ok).toBe(true);
    if (!movedToBoss.ok) return;
    revision = movedToBoss.view.revision;

    // start_battle
    const battleStarted = await performAction(
      { intent: { type: "start_battle", enemyId: boss.enemyId }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(battleStarted.ok).toBe(true);
    if (!battleStarted.ok) return;
    revision = battleStarted.view.revision;

    // 执行一轮 attack（战斗仍在进行中）
    const attackResult = await performAction(
      { intent: { type: "battle_action", action: "attack" }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(attackResult.ok).toBe(true);
    if (!attackResult.ok) return;
    expect(attackResult.view.battle).not.toBeNull();
    expect(attackResult.view.ending).toBeNull();
    await writer.close();

    // reload：战斗中途的状态必须完整恢复
    const reader = openRepository(databasePath);
    const restored = await getCurrentGame({ repository: reader });
    expect(restored.status).toBe("active");
    if (restored.status !== "active") return;
    expect(restored.view).toEqual(attackResult.view);
    expect(restored.view.battle).not.toBeNull();
    if (restored.view.battle === null) return;
    // boss hp 应为 20-4=16，player hp 应为 30-1=29
    expect(restored.view.battle.enemyHp).toBe(16);
    expect(restored.view.battle.playerHp).toBe(29);
    expect(restored.view.battle.round).toBe(2);

    // 已存记录的 battle 运行时状态也应一致
    const record = await loadActiveRecord(reader);
    expect(record.state.battle.status).toBe("active");
    if (record.state.battle.status !== "active") return;
    expect(record.state.battle.enemyHp).toBe(16);
    expect(record.state.battle.playerHp).toBe(29);
    expect(record.state.battle.round).toBe(2);
  });
});
