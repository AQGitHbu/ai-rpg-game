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
import { type PlayerIntent } from "@/game/gameplay/rpg/actions";
import scienceFictionFixture from "../../../data/fixtures/phase1/science_fiction.json";
import urbanFixture from "../../../data/fixtures/phase1/urban.json";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { createGame, type CreateGameDependencies } from "./createGame";
import { getCurrentGame } from "./getCurrentGame";
import { performAction } from "./performAction";
import { TEST_TRACE_ID } from "./applicationFixture.testutil";
import { createFixtureScenarioCandidateSource } from "./server/ai/fixtureScenarioCandidateSource";
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
// Phase 4C Task 5：三类型 generated 候选的完整游戏离线旅程回归。
//
// 与 phase6BattleEndingRegression 的差别：开局来自 phase4c fixture source
// （createGame source==="generated"），而非确定性 fallback 管线。旅程一律由
// reload 出的 record.blueprint 驱动——地点路径按连通图 BFS 求出、主线目标逐
// objective 映射为 intent、战斗回合数由玩家/boss 数值推导——任何合法候选蓝图
// 都能通过，绝不硬编码 fixture 内容。
//
// 覆盖：
//   1) 三类型各一条：创建(generated) → stage 1/2/3 主线 → boss 胜利 → 成功
//      结局 → 全新 repository reload 一致
//   2) wuxia 一条：start_battle → withdraw → 失败结局 → reload 一致
//
// 全程真实临时 SQLite，路径显式注入，零网络、零 .env.local。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };

const CASES: readonly { gameType: GameTypeId; fixture: Phase1Fixture; fixtureId: string }[] = [
  { gameType: "wuxia", fixture: wuxiaFixture as unknown as Phase1Fixture, fixtureId: "generated-wuxia" },
  {
    gameType: "science_fiction",
    fixture: scienceFictionFixture as unknown as Phase1Fixture,
    fixtureId: "generated-science-fiction"
  },
  { gameType: "urban", fixture: urbanFixture as unknown as Phase1Fixture, fixtureId: "generated-urban" }
];

const FIXTURE_ROOT = resolve("data/fixtures/phase4c");
const FIXED_CREATED_AT = "2026-07-29T00:00:00.000Z";
const FIXED_ACTION_TIME = "2026-07-29T10:00:00.000Z";

// 与 phase6BattleEndingRegression.test.ts 相同的 tmp/ 策略。
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

function createDependencies(
  repository: GameRepository,
  gameId: string,
  fixtureId: string
): CreateGameDependencies {
  return {
    repository,
    newGameId: () => asGameId(gameId),
    newSeed: () => "seed-unused",
    now: () => FIXED_CREATED_AT,
    scenarioCandidateSource: createFixtureScenarioCandidateSource({
      fixtureRoot: FIXTURE_ROOT,
      fixtureId
    }),
    newTraceId: () => TEST_TRACE_ID
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
 * 相比 phase6 版本泛化：stage 1/2 的 objective 逐类映射为 intent（visit →
 * move 路径、talk → 移动到 NPC 所在地点后 talk、obtain → 移动到预置地点后
 * take_item），不假设固定的 loc_2/唯一落位结构。
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

describe.each(CASES)(
  "Phase 4C 离线旅程：generated 候选跑通完整闭环（$gameType）",
  ({ gameType, fixture, fixtureId }) => {
    it("成功：创建(generated) → stage 1/2/3 主线 → boss 胜利 → 成功结局 → reload", async () => {
      const databasePath = join(RUN_ROOT, `victory-${gameType}.sqlite`);
      const writer = openRepository(databasePath);

      // 1) create：候选来自 fixture source，必须是 generated 而非 fallback
      const created = await createGame(
        { input: fixture.input, seed: fixture.seed },
        createDependencies(writer, `game-phase4c-victory-${gameType}`, fixtureId)
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.source).toBe("generated");

      // 2) 旅程完全由已存 blueprint 驱动（不读 fixture 文件本身）
      const blueprint = (await loadActiveRecord(writer)).blueprint;
      const stage1 = mainQuestOfStage(blueprint, 1);
      const stage2 = mainQuestOfStage(blueprint, 2);
      const stage3 = mainQuestOfStage(blueprint, 3);
      const boss = findBossEnemy(blueprint);

      // 3) stage 1/2 主线：objective 逐类映射为 intent
      const journey = buildStage3ReadyJourney(blueprint);
      let revision = await performSequence(writer, journey.intents, 0);
      expect(revision).toBe(journey.intents.length);

      // 4) 移动到 boss 所在地点
      const travelToBoss: PlayerIntent[] = [];
      appendTravel(blueprint, travelToBoss, journey.endLocationId, boss.locationId);
      revision = await performSequence(writer, travelToBoss, revision);

      // 5) start_battle：battle view 初值来自蓝图数值
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

      // 6) 回合数从数值推导：每回合伤害 max(1, attack - defense)
      const playerDamage = Math.max(1, blueprint.player.baseStats.attack - boss.stats.defense);
      const bossDamage = Math.max(1, boss.stats.attack - blueprint.player.baseStats.defense);
      const attacksToKill = Math.ceil(boss.stats.hp / playerDamage);
      // 前置校验：玩家必须能撑到最后一击（否则是蓝图数值问题，不是旅程问题）
      expect(blueprint.player.baseStats.hp - (attacksToKill - 1) * bossDamage).toBeGreaterThan(0);

      // 7) 连续 attack 直到 boss 被击败
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

      // 8) 最后一击应触发胜利 + 成功结局
      expect(lastView.ending).not.toBeNull();
      if (lastView.ending === null) return;
      expect(lastView.ending.outcome).toBe("success");
      expect(lastView.battle).toBeNull();
      expect(lastView.availableActions).toEqual([]);

      // 9) revision 增量全部可推导：前置序列 + 赴 boss 路程 + start_battle + attacks
      expect(revision).toBe(journey.intents.length + travelToBoss.length + 1 + attacksToKill);
      await writer.close();

      // 10) reload：全新 repository 重开同一文件
      const reader = openRepository(databasePath);
      const restored = await getCurrentGame({ repository: reader });
      expect(restored.status).toBe("active");
      if (restored.status !== "active") return;
      expect(restored.view).toEqual(lastView);

      // 11) 已存记录复核
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

      // 12) 事件账本无重复
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

      // 13) 蓝图与内容预算在整个旅程后原封不动
      expect(record.blueprint).toEqual(blueprint);
      expect(record.blueprint.contentBudget).toEqual(CONTENT_BUDGET);

      // 14) 结局后 action 安全拒绝且零写入
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
  }
);

describe("Phase 4C 离线旅程：失败结局同样是完整存档（wuxia）", () => {
  const { fixture, fixtureId } = CASES[0];

  it("失败：创建(generated) → stage 1/2/3 → start_battle → withdraw → 失败结局 → reload", async () => {
    const databasePath = join(RUN_ROOT, "withdraw-wuxia.sqlite");
    const writer = openRepository(databasePath);

    // 1) create
    const created = await createGame(
      { input: fixture.input, seed: fixture.seed },
      createDependencies(writer, "game-phase4c-withdraw-wuxia", fixtureId)
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.source).toBe("generated");

    // 2) blueprint 驱动推进到 stage 3 active 并抵达 boss 地点
    const blueprint = (await loadActiveRecord(writer)).blueprint;
    const stage1 = mainQuestOfStage(blueprint, 1);
    const stage2 = mainQuestOfStage(blueprint, 2);
    const stage3 = mainQuestOfStage(blueprint, 3);
    const boss = findBossEnemy(blueprint);
    const journey = buildStage3ReadyJourney(blueprint);
    let revision = await performSequence(writer, journey.intents, 0);
    const travelToBoss: PlayerIntent[] = [];
    appendTravel(blueprint, travelToBoss, journey.endLocationId, boss.locationId);
    revision = await performSequence(writer, travelToBoss, revision);

    // 3) start_battle
    const battleStarted = await performAction(
      { intent: { type: "start_battle", enemyId: boss.id }, expectedRevision: revision },
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
    expect(revision).toBe(journey.intents.length + travelToBoss.length + 2);

    // 5) 验证失败结局
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
    expect(record.state.defeatedEnemyIds).not.toContain(boss.id);
    expect(record.state.defeatedEnemyIds).toEqual([]);
    expect(record.state.ending).not.toBeNull();
    if (record.state.ending === null) return;
    expect(record.state.ending.outcome).toBe("failure");
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

    // 9) 蓝图与内容预算不变
    expect(record.blueprint).toEqual(blueprint);
    expect(record.blueprint.contentBudget).toEqual(CONTENT_BUDGET);

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
});
