/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CONTENT_BUDGET, type NewGameInput } from "@/game/domain";
import scienceFictionFixture from "../../../data/fixtures/phase1/science_fiction.json";
import urbanFixture from "../../../data/fixtures/phase1/urban.json";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import phase4cManifest from "../../../data/fixtures/phase4c/manifest.json";
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
// Phase 4C（Task 4）契约回归：版本化离线 fixture 集 × createGame 编排 × 真实 SQLite。
// 与 phase4a 回归同构，但遍历 phase4c manifest 的全部 12 条 entry（不挑样本），证明：
//   1) 集合版本化：候选契约保持 phase4b-v1，fixture 集版本 phase4c-v1；
//   2) expectedFallback=false ⇒ source="generated"，true ⇒ 稳定 fallback；
//   3) 事件序列与 manifest.expectedStages 逐一吻合（契约测试，仅内部）；
//   4) reload：全新 repository 重开同一文件，getCurrentGame 投影相同 view；
//   5) 蓝图守住内容预算与既有双结局路线；
//   6) 玩家可见 view 不含 fixture 名称与内部诊断字段（含 responseText/failureMode）。
// 临时库只放 tmp/，路径显式注入，不触碰 db/、.foundation 或任何共享仓。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const WUXIA = wuxiaFixture as unknown as Phase1Fixture;
const SCIENCE_FICTION = scienceFictionFixture as unknown as Phase1Fixture;
const URBAN = urbanFixture as unknown as Phase1Fixture;

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

const MANIFEST_FIXTURES = phase4cManifest.fixtures as ManifestFixture[];

/** gameType → phase1 输入 fixture 映射（三类型；manifest 只会出现这三个值）。 */
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
const RUN_PREFIX = "sqlite-phase4c-regression-";
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
    fixtureDependencies(writer, `game-phase4c-case-${fileCounter}`, fixtureId, stages)
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

/** 蓝图必须守住内容预算与既有双结局路线（成功/失败两条 route 各占其一）。 */
function assertBudgetsAndEndings(record: GameRecord, label: string): void {
  const { blueprint } = record;
  expect(blueprint.locations.length, label).toBeGreaterThanOrEqual(CONTENT_BUDGET.mainLocations);
  expect(blueprint.locations.length, label).toBeLessThanOrEqual(
    CONTENT_BUDGET.mainLocations + CONTENT_BUDGET.hiddenLocationsMax
  );
  expect(blueprint.npcs.length, label).toBeGreaterThanOrEqual(CONTENT_BUDGET.coreNpcsMin);
  expect(blueprint.npcs.length, label).toBeLessThanOrEqual(CONTENT_BUDGET.coreNpcsMax);
  const sideQuests = blueprint.quests.filter((quest) => quest.kind === "side");
  expect(sideQuests.length, label).toBeLessThanOrEqual(CONTENT_BUDGET.sideQuestsMax);
  // 双结局路线：恰好两个结局、ID 互异，且都有可判定的达成条件。
  expect(blueprint.endings.length, label).toBe(CONTENT_BUDGET.endings);
  const endingIds = new Set(blueprint.endings.map((ending) => ending.id));
  expect(endingIds.size, label).toBe(CONTENT_BUDGET.endings);
  for (const ending of blueprint.endings) {
    expect(ending.requirements.length, label).toBeGreaterThan(0);
  }
}

/** 玩家可见面绝不泄漏 fixture 名称或内部诊断字段（4C 黑名单再加两项）。 */
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

describe("Phase 4C 回归：fixture 集版本化", () => {
  it("manifest：候选契约 phase4b-v1 不升级，fixture 集版本 phase4c-v1", () => {
    expect(phase4cManifest.contractVersion).toBe("phase4b-v1");
    expect(phase4cManifest.fixtureSetVersion).toBe("phase4c-v1");
    expect(phase4cManifest.fixtures).toHaveLength(12);
  });
});

describe("Phase 4C 回归：manifest 全部 12 条 entry 逐一契约验证", () => {
  for (const entry of MANIFEST_FIXTURES) {
    const expectedSource = entry.expectedFallback ? "fallback" : "generated";
    it(`${entry.id}：${expectedSource} + 事件契约 + reload + 预算/双结局 + 零泄漏`, async () => {
      const stages: ScenarioGenerationStage[] = [];
      const { created, record } = await createAndReload(inputFor(entry), entry.id, stages);
      if (!created.ok) return;

      // 失败路径不半途而废：expectedFallback=true 时玩家仍拿到完整 fallback 开局。
      expect(created.source).toBe(expectedSource);
      expect(stages).toEqual(entry.expectedStages);
      assertBudgetsAndEndings(record, entry.id);
      assertNoInternalLeak(created, entry.id);
    });
  }
});
