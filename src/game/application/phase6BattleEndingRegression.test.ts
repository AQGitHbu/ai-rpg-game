/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  asLocationId,
  type EnemyId,
  type QuestDefinition,
  type ScenarioBlueprint
} from "@/game/domain";
import { type PlayerIntent } from "@/game/gameplay/rpg/actions";
import {
  compileScenarioBlueprint,
  initializeGameState,
  validateScenarioBlueprintCandidate
} from "@/game/gameplay/rpg/scenario";
import {
  makeValidCandidate,
  TEST_POLICY,
  TEST_PROFILE
} from "@/game/gameplay/rpg/scenario/scenarioBlueprintFixture.testutil";
import { getCurrentGame } from "./getCurrentGame";
import { performAction } from "./performAction";
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
// 对武侠/科幻/都市三个 pin fixture 的完整旅程（stage 1→2→3→boss→结局）曾由
// fallback 完整蓝图驱动。Phase 14 开局收窄后 createGame 只产出 1 幕起始锚点；
// 本文件改用 makeValidCandidate 的运行时扩展蓝图（runtime_expansion 阶段）直接
// 写入真实 SQLite，验证：
//   - 成功旅程：建档 → stage 1/2 → stage 3 → boss 胜利 → 成功 ending
//   - 失败旅程：同路径 → start_battle → withdraw → failed stage 3 → 失败 ending
//   - 战斗中途 reload：getCurrentGame 恢复 active battle view 与 performAction 一致
//   - 每条旅程的事件账本无重复（enemy_defeated/quest_failed/ending_reached 各一份）
//   - 内容预算在整个旅程后原封不动
//   - 结局后所有 action 安全拒绝且零写入
//
// 全程真实临时 SQLite，路径显式注入，绝不读 env。
// ---------------------------------------------------------------------------

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

/** 蓝图连通图上的最短移动路径（BFS；不含起点、含终点）。不可达 ⇒ 抛错。 */
function movePath(blueprint: ScenarioBlueprint, fromId: string, toId: string): readonly string[] {
  if (fromId === toId) return [];
  const previous = new Map<string, string>();
  const visited = new Set<string>([fromId]);
  const queue: string[] = [fromId];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const location = blueprint.locations.find((entry) => entry.id === current);
    if (location === undefined) throw new Error(`蓝图缺少地点：${current}`);
    for (const next of location.connectedLocationIds) {
      if (visited.has(next)) continue;
      visited.add(next);
      previous.set(next, current);
      if (next === toId) {
        const path: string[] = [];
        let cursor: string = toId;
        while (cursor !== fromId) {
          path.unshift(cursor);
          const step = previous.get(cursor);
          if (step === undefined) throw new Error(`路径回溯失败：${fromId} → ${toId}`);
          cursor = step;
        }
        return path;
      }
      queue.push(next);
    }
  }
  throw new Error(`蓝图地点不连通：${fromId} → ${toId}`);
}

/** 把途中每一步转成 move intent，返回终点。 */
function appendTravel(
  blueprint: ScenarioBlueprint,
  intents: PlayerIntent[],
  fromId: string,
  toId: string
): string {
  for (const step of movePath(blueprint, fromId, toId)) {
    intents.push({ type: "move", locationId: asLocationId(step) } as PlayerIntent);
  }
  return toId;
}

/** 从蓝图推导出到达 stage 3 active（boss 可战）的前置序列（stage 1/2 逐 objective）。 */
function buildStage3ReadyIntents(blueprint: ScenarioBlueprint): readonly PlayerIntent[] {
  const intents: PlayerIntent[] = [];
  let at: string = blueprint.player.startingLocationId;
  for (const stage of [1, 2] as const) {
    const quest = mainQuestOfStage(blueprint, stage);
    for (const objective of quest.objectives) {
      switch (objective.kind) {
        case "visit_location":
          at = appendTravel(blueprint, intents, at, objective.locationId);
          break;
        case "talk_to_npc": {
          const npc = blueprint.npcs.find((entry) => entry.id === objective.npcId);
          if (npc === undefined) throw new Error(`蓝图缺少 NPC：${objective.npcId}`);
          at = appendTravel(blueprint, intents, at, npc.locationId);
          intents.push({ type: "talk", npcId: objective.npcId } as PlayerIntent);
          break;
        }
        case "obtain_item": {
          const stocked = blueprint.locations.find((entry) =>
            entry.availableItemIds.includes(objective.itemId)
          );
          if (stocked === undefined) throw new Error(`没有地点预置物品：${objective.itemId}`);
          at = appendTravel(blueprint, intents, at, stocked.id);
          intents.push({ type: "take_item", itemId: objective.itemId } as PlayerIntent);
          break;
        }
        default:
          throw new Error(`stage ${stage} 出现旅程无法驱动的 objective：${objective.kind}`);
      }
    }
  }
  return intents;
}

/** 从蓝图找到 boss 敌人 ID 及其地点。 */
function findBossEnemy(blueprint: ScenarioBlueprint): { enemyId: EnemyId; locationId: string } {
  const boss = blueprint.enemies.find((e) => e.tier === "boss");
  if (boss === undefined) throw new Error("蓝图缺少 boss 敌人");
  return { enemyId: boss.id, locationId: boss.locationId };
}

describe("Phase 6 战斗与双结局回归（wuxia）", () => {
  // 独立复跑管线：makeValidCandidate 运行时扩展蓝图的确定性结果，作为期望基准。
  const baseline = PIPELINE;
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
  // 成功旅程：建档 → stage 1/2 → 移动赴 boss → start_battle → attack×5 → 胜利 ending
  // -----------------------------------------------------------------------
  it("成功：建档 → stage 1/2/3 → start_battle → attack×5 → 胜利 ending → reload", async () => {
    const databasePath = join(RUN_ROOT, "victory-wuxia.sqlite");
    const writer = openRepository(databasePath);

    // 1) 建档（loc_a 开场，m1 active）
    await seedGame(writer, "game-phase6-victory-wuxia");
    const created = await getCurrentGame({ repository: writer });
    expect(created.status).toBe("active");
    if (created.status !== "active") return;

    // 2) 推进到 stage 3 active（已完成 stage 1/2 主线）
    let revision = await performSequence(writer, stage3ReadyIntents, 0);
    expect(revision).toBe(stage3ReadyIntents.length);

    // 3) 移动到 boss 地点 loc_d
    const travelToBoss: PlayerIntent[] = [];
    const endLocationId = (() => {
      let at = baseline.blueprint.player.startingLocationId;
      for (const intent of stage3ReadyIntents) {
        if (intent.type === "move") at = intent.locationId;
      }
      return at;
    })();
    appendTravel(baseline.blueprint, travelToBoss, endLocationId, boss.locationId);
    revision = await performSequence(writer, travelToBoss, revision);
    expect(revision).toBe(stage3ReadyIntents.length + travelToBoss.length);

    // 4) start_battle
    const battleStarted = await performAction(
      { intent: { type: "start_battle", enemyId: boss.enemyId }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(battleStarted.ok).toBe(true);
    if (!battleStarted.ok) return;
    revision = battleStarted.view.revision;
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

    // 7) 验证 revision 增量：stage 序列 + 赴 boss 路程 + start_battle(1) + attacks(5)
    expect(revision).toBe(stage3ReadyIntents.length + travelToBoss.length + 1 + ATTACKS_TO_KILL);
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
  it("失败：建档 → stage 1/2 → start_battle → withdraw → 失败 ending → reload", async () => {
    const databasePath = join(RUN_ROOT, "withdraw-wuxia.sqlite");
    const writer = openRepository(databasePath);

    // 1) 建档
    await seedGame(writer, "game-phase6-withdraw-wuxia");

    // 2) 推进到 stage 3 active
    let revision = await performSequence(writer, stage3ReadyIntents, 0);
    const travelToBoss: PlayerIntent[] = [];
    let endLocationId = baseline.blueprint.player.startingLocationId;
    for (const intent of stage3ReadyIntents) {
      if (intent.type === "move") endLocationId = intent.locationId;
    }
    appendTravel(baseline.blueprint, travelToBoss, endLocationId, boss.locationId);
    revision = await performSequence(writer, travelToBoss, revision);

    // 3) start_battle
    const battleStarted = await performAction(
      { intent: { type: "start_battle", enemyId: boss.enemyId }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(battleStarted.ok).toBe(true);
    if (!battleStarted.ok) return;
    revision = battleStarted.view.revision;

    // 4) withdraw — 立即失败
    const withdrawResult = await performAction(
      { intent: { type: "battle_action", action: "withdraw" }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(withdrawResult.ok).toBe(true);
    if (!withdrawResult.ok) return;
    revision = withdrawResult.view.revision;
    expect(revision).toBe(stage3ReadyIntents.length + travelToBoss.length + 2);

    // 5) 验证失败 ending
    expect(withdrawResult.view.ending).not.toBeNull();
    if (withdrawResult.view.ending === null) return;
    expect(withdrawResult.view.ending.outcome).toBe("failure");
    expect(withdrawResult.view.battle).toBeNull();
    expect(withdrawResult.view.availableActions).toEqual([]);
    await writer.close();

    // 6) reload
    const reader = openRepository(databasePath);
    const restored = await getCurrentGame({ repository: reader });
    expect(restored.status).toBe("active");
    if (restored.status !== "active") return;
    expect(restored.view).toEqual(withdrawResult.view);

    // 7) 已存记录复核
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

    // 8) 事件账本无重复
    const questFailedEvents = record.state.eventLedger.filter((e) => e.type === "quest_failed");
    expect(questFailedEvents).toHaveLength(1);
    const endingReachedEvents = record.state.eventLedger.filter((e) => e.type === "ending_reached");
    expect(endingReachedEvents).toHaveLength(1);
    const battleResolvedEvents = record.state.eventLedger.filter((e) => e.type === "battle_resolved");
    expect(battleResolvedEvents).toHaveLength(1);
    const enemyDefeatedEvents = record.state.eventLedger.filter((e) => e.type === "enemy_defeated");
    expect(enemyDefeatedEvents).toHaveLength(0);

    // 9) 内容预算不变
    expect(record.blueprint).toEqual(baseline.blueprint);

    // 10) 结局后 action 安全拒绝且零写入
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
    const databasePath = join(RUN_ROOT, "midbattle-reload-wuxia.sqlite");
    const writer = openRepository(databasePath);

    // 建档并推进到 stage 3
    await seedGame(writer, "game-phase6-midbattle-wuxia");

    let revision = await performSequence(writer, stage3ReadyIntents, 0);
    const travelToBoss: PlayerIntent[] = [];
    let endLocationId = baseline.blueprint.player.startingLocationId;
    for (const intent of stage3ReadyIntents) {
      if (intent.type === "move") endLocationId = intent.locationId;
    }
    appendTravel(baseline.blueprint, travelToBoss, endLocationId, boss.locationId);
    revision = await performSequence(writer, travelToBoss, revision);

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