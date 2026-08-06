/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type ScenarioBlueprint } from "@/game/domain";
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
import { performAction } from "../performAction";
import { buildEndToEndRuleJourney, findBossEnemy, performRuleSequence } from "./offlineGenreJourney";
import { asGameId, type GameRecord, type GameRepository } from "../server/persistence/gameRepository";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import { createSqliteGameRepository, type SqliteGameRepository } from "../server/persistence/sqliteGameRepository";

// —— tmp/ 暂存策略与 phase4c 相同 ——
const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-offline-genre-";
try {
  for (const entry of readdirSync(TMP_ROOT)) {
    if (entry.startsWith(RUN_PREFIX)) {
      try { rmSync(join(TMP_ROOT, entry), { recursive: true, force: true }); } catch { /* 占用忽略 */ }
    }
  }
} catch { /* 无 tmp */ }
const RUN_ROOT = join(TMP_ROOT, `${RUN_PREFIX}${Date.now()}-${process.pid}`);
mkdirSync(RUN_ROOT, { recursive: true });
const openRepos: SqliteGameRepository[] = [];

afterAll(() => openRepos.forEach((r) => void r.close()));

function openRepository(name: string): SqliteGameRepository {
  const repo = createSqliteGameRepository({
    clientFactory: () => createSqliteClient(join(RUN_ROOT, `${name}.sqlite`)),
    logError: () => {},
  });
  openRepos.push(repo);
  return repo;
}

/** 从端口读回 active 记录（从 phase4c 复制）。 */
async function loadActiveRecord(repository: GameRepository): Promise<GameRecord> {
  const loaded = await repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") {
    throw new Error(`期望 active 存档，实际：${JSON.stringify(loaded)}`);
  }
  return loaded.record;
}

// Phase 14 开局收窄后 fallback 蓝图只有起始锚点（无 boss/完整旅程）。
// 本测试保留"offline 零 AI 规则通关"覆盖：以 makeValidCandidate 编译完整
// 蓝图（含 boss enemy_b 与 3 幕主线），offline 模式直接写入真实 SQLite 存档。
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
const BASE_STATE = initializeGameState(RUNTIME_BLUEPRINT);
const PIPELINE = {
  blueprint: RUNTIME_BLUEPRINT,
  state: { ...BASE_STATE, narrative: { ...BASE_STATE.narrative, mode: "offline" as const } }
};

function actionDeps(repo: SqliteGameRepository) {
  return { repository: repo, now: () => "2026-08-04T00:00:00.000Z" };
}

/** 用真实 adapter 写入 offline 模式完整蓝图存档。 */
async function seedGame(repository: SqliteGameRepository, gameId: string): Promise<void> {
  const created = await repository.createInitialGame({
    gameId: asGameId(gameId),
    blueprint: PIPELINE.blueprint,
    state: PIPELINE.state,
    createdAt: "2026-08-04T00:00:00.000Z",
  });
  expect(created).toEqual({ ok: true });
}

describe("offlineGenreJourney：完整蓝图 + offline 零 AI 规则通关", () => {
  it("wuxia：offline → 规则行动 → 成功结局，零 fetch", async () => {
    const writer = openRepository("wuxia");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("zero-network expected");
    });
    try {
      await seedGame(writer, "genre-wuxia");

      const record = await loadActiveRecord(writer);
        const boss = findBossEnemy(record.blueprint);
        const journey = buildEndToEndRuleJourney(record.blueprint, boss.locationId);
        let revision = 0;
        revision = await performRuleSequence(writer, journey.intents, revision);

        const started = await performAction(
          { intent: { type: "start_battle", enemyId: boss.id }, expectedRevision: revision },
          actionDeps(writer),
        );
        expect(started.ok).toBe(true);
        if (!started.ok) return;

        let view = started.view;
        let guard = 0;
        while (view.battle !== null && view.ending === null && guard < 200) {
          guard += 1;
          const attack = await performAction(
            { intent: { type: "battle_action", action: "attack" }, expectedRevision: view.revision },
            actionDeps(writer),
          );
          if (!attack.ok) throw new Error("attack 应当成功");
          view = attack.view;
        }
        expect(view.ending).not.toBeNull();
        if (view.ending !== null) expect(view.ending.outcome).toBe("success");
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
  });
});