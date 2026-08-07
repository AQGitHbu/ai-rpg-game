/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  asLocationId,
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
// Phase 4C Task 5：完整游戏离线旅程回归（运行时扩展蓝图）。
//
// Phase 14 开局收窄后，createGame/fixture source 只产出 1 幕起始锚点（1 地点/
// 1 NPC/1 主线 stage 1，无敌人/结局）——fixture 集合与事件契约由
// phase4cStructuredOutputRegression 覆盖。本文件验证"已存完整蓝图"驱动的
// 旅程闭环：stage 1/2 主线目标逐 objective 映射为 intent（BFS 求地点路径）、
// 战斗回合数由玩家/boss 数值推导、成功与失败结局各自完整存档并可 reload——
// 与 phase6 同构，但地点路径/物品落位/任务图全部从蓝图派生，不硬编码。
//
// 全程真实临时 SQLite，路径显式注入，零网络、零 .env.local。
// ---------------------------------------------------------------------------

// 以 makeValidCandidate 为基座编译（wuxia 题材，runtime_expansion 阶段），
// 直接写入真实 SQLite 存档后走 performAction 真实管线。
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

const FIXED_CREATED_AT = "2026-07-29T00:00:00.000Z";
const FIXED_ACTION_TIME = "2026-07-29T10:00:00.000Z";

// 与其他 SQLite 测试相同的 tmp/ 策略：每次运行独立目录，先清扫上一轮残留。
const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-phase4c-journey-";
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

/**
 * 从蓝图推导出到达 stage 3 active（boss 可战）的前置序列。
 * stage 1/2 的 objective 逐类映射为 intent（visit → move 路径、talk → 移动
 * 到 NPC 所在地点后 talk、obtain → 移动到预置地点后 take_item），不假设固定
 * 落位结构。
 */
function buildStage3ReadyJourney(blueprint: ScenarioBlueprint): {
  intents: readonly PlayerIntent[];
  endLocationId: string;
} {
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
  return { intents, endLocationId: at };
}

/** 从蓝图找到 boss 敌人完整定义（含 stats，用于推导战斗回合数）。 */
function findBossEnemy(blueprint: ScenarioBlueprint): ScenarioBlueprint["enemies"][number] {
  const boss = blueprint.enemies.find((entry) => entry.tier === "boss");
  if (boss === undefined) throw new Error("蓝图缺少 boss 敌人");
  return boss;
}

describe("Phase 4C 离线旅程：完整蓝图跑通完整闭环（wuxia）", () => {
  it("成功：建档 → stage 1/2 主线 → boss 胜利 → 成功结局 → reload", async () => {
    const baseline = PIPELINE;
    const blueprint = baseline.blueprint;
    const stage1 = mainQuestOfStage(blueprint, 1);
    const stage2 = mainQuestOfStage(blueprint, 2);
    const stage3 = mainQuestOfStage(blueprint, 3);
    const boss = findBossEnemy(blueprint);

    const databasePath = join(RUN_ROOT, "victory-wuxia.sqlite");
    const writer = openRepository(databasePath);

    // 1) 建档
    await seedGame(writer, "game-phase4c-victory-wuxia");
    const created = await getCurrentGame({ repository: writer });
    expect(created.status).toBe("active");
    if (created.status !== "active") return;

    // 2) stage 1/2 主线：objective 逐类映射为 intent
    const journey = buildStage3ReadyJourney(blueprint);
    let revision = await performSequence(writer, journey.intents, 0);
    expect(revision).toBe(journey.intents.length);

    // 3) 移动到 boss 所在地点
    const travelToBoss: PlayerIntent[] = [];
    appendTravel(blueprint, travelToBoss, journey.endLocationId, boss.locationId);
    revision = await performSequence(writer, travelToBoss, revision);

    // 4) start_battle：battle view 初值来自蓝图数值
    const battleStarted = await performAction(
      { intent: { type: "start_battle", enemyId: boss.id }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(battleStarted.ok).toBe(true);
    if (!battleStarted.ok) return;
    revision = battleStarted.view.revision;
    expect(battleStarted.view.battle).not.toBeNull();
    if (battleStarted.view.battle === null) return;
    expect(battleStarted.view.battle.enemyHp).toBe(boss.stats.hp);
    expect(battleStarted.view.battle.playerHp).toBe(blueprint.player.baseStats.hp);
    expect(battleStarted.view.battle.round).toBe(1);

    // 5) 回合数从数值推导：每回合伤害 max(1, attack - defense)
    const playerDamage = Math.max(1, blueprint.player.baseStats.attack - boss.stats.defense);
    const bossDamage = Math.max(1, boss.stats.attack - blueprint.player.baseStats.defense);
    const attacksToKill = Math.ceil(boss.stats.hp / playerDamage);
    // 前置校验：玩家必须能撑到最后一击（否则是蓝图数值问题，不是旅程问题）
    expect(blueprint.player.baseStats.hp - (attacksToKill - 1) * bossDamage).toBeGreaterThan(0);

    // 6) 连续 attack 直到 boss 被击败
    let lastView = battleStarted.view;
    for (let i = 0; i < attacksToKill; i += 1) {
      const attackResult = await performAction(
        { intent: { type: "battle_action", action: "attack" }, expectedRevision: revision },
        performDeps(writer)
      );
      expect(attackResult.ok, `attack round ${i + 1}`).toBe(true);
      if (!attackResult.ok) return;
      revision = attackResult.view.revision;
      lastView = attackResult.view;

      if (i < attacksToKill - 1) {
        // 战斗仍在进行
        expect(attackResult.view.battle).not.toBeNull();
        if (attackResult.view.battle === null) return;
        expect(attackResult.view.battle.enemyHp).toBe(boss.stats.hp - (i + 1) * playerDamage);
        expect(attackResult.view.ending).toBeNull();
      }
    }

    // 7) 最后一击应触发胜利 + 成功结局
    expect(lastView.ending).not.toBeNull();
    if (lastView.ending === null) return;
    expect(lastView.ending.outcome).toBe("success");
    expect(lastView.battle).toBeNull();
    expect(lastView.availableActions).toEqual([]);

    // 8) revision 增量全部可推导：前置序列 + 赴 boss 路程 + start_battle + attacks
    expect(revision).toBe(journey.intents.length + travelToBoss.length + 1 + attacksToKill);
    await writer.close();

    // 9) reload：全新 repository 重开同一文件
    const reader = openRepository(databasePath);
    const restored = await getCurrentGame({ repository: reader });
    expect(restored.status).toBe("active");
    if (restored.status !== "active") return;
    expect(restored.view).toEqual(lastView);

    // 10) 已存记录复核
    const record = await loadActiveRecord(reader);
    const statusById = new Map(record.state.quests.map((q) => [q.questId, q.status]));
    expect(statusById.get(stage1.id)).toBe("completed");
    expect(statusById.get(stage2.id)).toBe("completed");
    expect(statusById.get(stage3.id)).toBe("completed");
    expect(record.state.defeatedEnemyIds).toContain(boss.id);
    expect(record.state.ending).not.toBeNull();
    if (record.state.ending === null) return;
    expect(record.state.ending.outcome).toBe("success");
    expect(record.state.battle.status).toBe("resolved");

    // 11) 事件账本无重复
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

    // 12) 蓝图与内容预算在整个旅程后原封不动
    expect(record.blueprint).toEqual(blueprint);

    // 13) 结局后 action 安全拒绝且零写入
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
});

describe("Phase 4C 离线旅程：失败结局同样是完整存档（wuxia）", () => {
  it("失败：建档 → stage 1/2 → start_battle → withdraw → 失败结局 → reload", async () => {
    const blueprint = PIPELINE.blueprint;
    const stage1 = mainQuestOfStage(blueprint, 1);
    const stage2 = mainQuestOfStage(blueprint, 2);
    const stage3 = mainQuestOfStage(blueprint, 3);
    const boss = findBossEnemy(blueprint);

    const databasePath = join(RUN_ROOT, "withdraw-wuxia.sqlite");
    const writer = openRepository(databasePath);

    // 1) 建档 + 蓝图驱动推进到 stage 3 active 并抵达 boss 地点
    await seedGame(writer, "game-phase4c-withdraw-wuxia");
    const journey = buildStage3ReadyJourney(blueprint);
    let revision = await performSequence(writer, journey.intents, 0);
    const travelToBoss: PlayerIntent[] = [];
    appendTravel(blueprint, travelToBoss, journey.endLocationId, boss.locationId);
    revision = await performSequence(writer, travelToBoss, revision);

    // 2) start_battle
    const battleStarted = await performAction(
      { intent: { type: "start_battle", enemyId: boss.id }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(battleStarted.ok).toBe(true);
    if (!battleStarted.ok) return;
    revision = battleStarted.view.revision;

    // 3) withdraw — 立即失败
    const withdrawResult = await performAction(
      { intent: { type: "battle_action", action: "withdraw" }, expectedRevision: revision },
      performDeps(writer)
    );
    expect(withdrawResult.ok).toBe(true);
    if (!withdrawResult.ok) return;
    revision = withdrawResult.view.revision;
    expect(revision).toBe(journey.intents.length + travelToBoss.length + 2);

    // 4) 验证失败结局
    expect(withdrawResult.view.ending).not.toBeNull();
    if (withdrawResult.view.ending === null) return;
    expect(withdrawResult.view.ending.outcome).toBe("failure");
    expect(withdrawResult.view.battle).toBeNull();
    expect(withdrawResult.view.availableActions).toEqual([]);
    await writer.close();

    // 5) reload
    const reader = openRepository(databasePath);
    const restored = await getCurrentGame({ repository: reader });
    expect(restored.status).toBe("active");
    if (restored.status !== "active") return;
    expect(restored.view).toEqual(withdrawResult.view);

    // 6) 已存记录复核
    const record = await loadActiveRecord(reader);
    const statusById = new Map(record.state.quests.map((q) => [q.questId, q.status]));
    expect(statusById.get(stage1.id)).toBe("completed");
    expect(statusById.get(stage2.id)).toBe("completed");
    expect(statusById.get(stage3.id)).toBe("failed");
    expect(record.state.defeatedEnemyIds).not.toContain(boss.id);
    expect(record.state.defeatedEnemyIds).toEqual([]);
    expect(record.state.ending).not.toBeNull();
    if (record.state.ending === null) return;
    expect(record.state.ending.outcome).toBe("failure");
    expect(record.state.battle.status).toBe("resolved");

    // 7) 事件账本无重复
    const questFailedEvents = record.state.eventLedger.filter((e) => e.type === "quest_failed");
    expect(questFailedEvents).toHaveLength(1);
    const endingReachedEvents = record.state.eventLedger.filter((e) => e.type === "ending_reached");
    expect(endingReachedEvents).toHaveLength(1);
    const battleResolvedEvents = record.state.eventLedger.filter((e) => e.type === "battle_resolved");
    expect(battleResolvedEvents).toHaveLength(1);
    const enemyDefeatedEvents = record.state.eventLedger.filter((e) => e.type === "enemy_defeated");
    expect(enemyDefeatedEvents).toHaveLength(0);

    // 8) 蓝图与内容预算不变
    expect(record.blueprint).toEqual(blueprint);

    // 9) 结局后 action 安全拒绝且零写入
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
});
