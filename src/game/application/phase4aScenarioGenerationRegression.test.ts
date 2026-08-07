/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { budgetPolicyOf, type NewGameInput } from "@/game/domain";
import scienceFictionFixture from "../../../data/fixtures/phase1/science_fiction.json";
import urbanFixture from "../../../data/fixtures/phase1/urban.json";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
// Phase 4A 迁移：契约已升至 scenario-dynamic-v3，fixture 集改用 phase4c 的 v3
// 合法候选（startAnchor/endingDirection/1 幕开场），而非 phase4 的 v2 全量蓝图。
import phase4Manifest from "../../../data/fixtures/phase4c/manifest.json";
import { createGame, type CreateGameDependencies, type CreateGameResult } from "./createGame";
import { getCurrentGame } from "./getCurrentGame";
import { TEST_TRACE_ID } from "./applicationFixture.testutil";
import type { ScenarioGenerationStage } from "./scenarioGeneration";
import { createFixtureScenarioCandidateSource } from "./server/ai/fixtureScenarioCandidateSource";
import { asGameId, type GameRecord } from "./server/persistence/gameRepository";
import { createSqliteClient } from "./server/persistence/sqliteClient";
import {
  createSqliteGameRepository,
  type SqliteGameRepository
} from "./server/persistence/sqliteGameRepository";

// ---------------------------------------------------------------------------
// Phase 4a（Task 5）回归：fixture source × createGame 编排 × 真实 SQLite。
// 覆盖三个合法生成 fixture（wuxia / science_fiction / urban）与三个失败
// fixture（timeout / unrepairable-reference / budget-exceeded），证明：
//   1) 合法候选 source="generated"、失败路径稳定 fallback；
//   2) 事件序列与 manifest.expectedStages 逐一吻合（契约测试，仅内部）；
//   3) reload：全新 repository 重开同一文件，getCurrentGame 投影相同 view；
//   4) 蓝图守住 Phase 14 开场预算（恰 1 地点/1 NPC/1 主线 stage 1，无支线/结局）；
//   5) 零半初始化记录：唯一一条 revision=0 的完整记录，绝无 corrupt；
//   6) 玩家可见 view 不含 fixture 名称与内部诊断字段。
// 临时库只放 tmp/，路径显式注入，不触碰 db/、.foundation 或任何共享仓。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const WUXIA: Phase1Fixture = { ...(wuxiaFixture as unknown as Phase1Fixture), input: { ...(wuxiaFixture as unknown as Phase1Fixture).input, gameLength: "short" } };
const SCIENCE_FICTION: Phase1Fixture = { ...(scienceFictionFixture as unknown as Phase1Fixture), input: { ...(scienceFictionFixture as unknown as Phase1Fixture).input, gameLength: "short" } };
const URBAN: Phase1Fixture = { ...(urbanFixture as unknown as Phase1Fixture), input: { ...(urbanFixture as unknown as Phase1Fixture).input, gameLength: "short" } };

const FIXTURE_ROOT = resolve("data/fixtures/phase4c");

type ManifestFixture = {
  id: string;
  file: string;
  gameType: string;
  seed: string;
  expectedAttempt: string;
  expectedCategory?: string;
  expectedFallback: boolean;
  expectedStages: string[];
};

const MANIFEST_FIXTURES = phase4Manifest.fixtures as ManifestFixture[];

/** gameType 与 phase1 输入 fixture 的映射（三类型合法样本）。 */
const INPUT_BY_GAME_TYPE: Record<string, Phase1Fixture> = {
  wuxia: WUXIA,
  science_fiction: SCIENCE_FICTION,
  urban: URBAN
};

function inputFor(entry: ManifestFixture): Phase1Fixture {
  const fixture = INPUT_BY_GAME_TYPE[entry.gameType];
  if (fixture === undefined) throw new Error(`manifest gameType 未映射：${entry.gameType}`);
  return fixture;
}

// 与其他 SQLite 测试相同的 tmp/ 策略：每次运行独立目录，先清扫上一轮残留。
const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-phase4a-regression-";
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

function fixtureDependencies(
  repository: SqliteGameRepository,
  gameId: string,
  fixtureId: string,
  stages: ScenarioGenerationStage[]
): CreateGameDependencies {
  return {
    repository,
    newGameId: () => asGameId(gameId),
    newSeed: () => "seed-unused",
    now: () => "2026-07-29T00:00:00.000Z",
    scenarioCandidateSource: createFixtureScenarioCandidateSource({
      fixtureRoot: FIXTURE_ROOT,
      fixtureId
    }),
    newTraceId: () => TEST_TRACE_ID,
    generationObserver: (event) => stages.push(event.stage)
  };
}

/** 创建 + 重开验证的公共主干：返回创建结果与重开后的完整记录。 */
async function createAndReload(
  fixture: Phase1Fixture,
  fixtureId: string,
  stages: ScenarioGenerationStage[]
): Promise<{ created: CreateGameResult; record: GameRecord }> {
  const databasePath = nextDbPath();
  const writer = openRepository(databasePath);
  // gameId 只用序号：不把 fixture 名称带进 view.gameId，否则泄漏断言会被自己污染。
  const created = await createGame(
    { input: fixture.input, seed: fixture.seed },
    fixtureDependencies(writer, `game-phase4a-case-${fileCounter}`, fixtureId, stages)
  );
  expect(created.ok, fixtureId).toBe(true);
  if (!created.ok) throw new Error(`createGame 失败：${fixtureId}`);
  await writer.close();

  // reload：全新 repository 实例读同一文件（模拟进程重启/刷新恢复）。
  const reader = openRepository(databasePath);
  const current = await getCurrentGame({ repository: reader });
  expect(current.status, fixtureId).toBe("active");
  if (current.status !== "active") throw new Error(`重开失败：${fixtureId}`);
  expect(current.view).toEqual(created.view);
  expect(JSON.stringify(current.view)).toBe(JSON.stringify(created.view));

  // 零半初始化记录：唯一记录完整可读（非 corrupt）、revision 归零。
  const raw = await reader.getCurrentGame();
  if (!raw.ok || raw.status !== "active") throw new Error(`记录不可读：${fixtureId}`);
  expect(raw.record.revision).toBe(0);
  return { created, record: raw.record };
}

/** Phase 14 收窄后的开场预算形态：起初 1 地点/1 NPC/1 主线 1 幕，无支线/结局。 */
function assertBudgetsAndEndings(record: GameRecord, label: string): void {
  const { blueprint } = record;
  const policy = budgetPolicyOf(blueprint);
  expect(blueprint.locations.length, label).toBe(1);
  expect(blueprint.npcs.length, label).toBeGreaterThanOrEqual(1);
  expect(blueprint.npcs.length, label).toBeLessThanOrEqual(policy.opening.coreNpcsMax);
  expect(blueprint.quests.length, label).toBe(1);
  const firstQuest = blueprint.quests[0];
  expect(firstQuest.kind, label).toBe("main");
  if (firstQuest.kind !== "main") throw new Error("opening quest must be main");
  expect(firstQuest.stage, label).toBe(1);
  expect(blueprint.items.length, label).toBe(0);
  expect(blueprint.enemies.length, label).toBe(0);
  expect(blueprint.endings.length, label).toBe(0);
  // 开始锚点精确指向开场三个起始实体。
  expect(blueprint.startAnchor.locationId, label).toBe(blueprint.locations[0].id);
  expect(blueprint.startAnchor.npcId, label).toBe(blueprint.npcs[0].id);
  expect(blueprint.startAnchor.startQuestId, label).toBe(blueprint.quests[0].id);
  // 终点方向骨架已锁定（lockedAt >= 1）。
  expect(blueprint.endingDirection.lockedAt, label).toBeGreaterThanOrEqual(1);
}

/** 玩家可见面绝不泄漏 fixture 名称或内部诊断字段。 */
function assertNoInternalLeak(created: CreateGameResult, fixtureId: string): void {
  if (!created.ok) return;
  const serialized = JSON.stringify(created.view);
  for (const secret of [
    fixtureId,
    "fixture",
    "FIXTURE_",
    '"diagnostics"',
    '"traceId"',
    "responseText",
    "failureMode"
  ]) {
    expect(serialized, fixtureId).not.toContain(secret);
  }
}

/** 六样本：三个合法三类型 + 三个失败（传输超时 / 不可修复引用 / 超预算）。 */
const SAMPLE_CASES: readonly string[] = [
  "generated-wuxia",
  "generated-science-fiction",
  "generated-urban",
  "transport-timeout",
  "unrepairable-reference",
  "budget-exceeded"
];

describe("Phase 4a 回归：v4 夹具 × createGame × SQLite（六样本）", () => {
  for (const fixtureId of SAMPLE_CASES) {
    const entry = MANIFEST_FIXTURES.find((candidate) => candidate.id === fixtureId);
    if (entry === undefined) throw new Error(`manifest 缺少 fixture：${fixtureId}`);
    const expectedSource = entry.expectedFallback ? "fallback" : "generated";

    it(`${fixtureId}：${expectedSource} + 事件契约 + reload + 开场预算 + 零泄漏`, async () => {
      const stages: ScenarioGenerationStage[] = [];
      const { created, record } = await createAndReload(inputFor(entry), fixtureId, stages);
      if (!created.ok) return;

      expect(created.source).toBe(expectedSource);
      expect(stages).toEqual(entry.expectedStages);
      assertBudgetsAndEndings(record, fixtureId);
      assertNoInternalLeak(created, fixtureId);
    });
  }
});