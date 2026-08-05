/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { OFFLINE_CASE_IDS, resolveOfflineBaseline } from "../server/offlineBaselines";
import { createGame } from "../createGame";
import { performAction } from "../performAction";
import { createUnavailableTestScenarioSource } from "../applicationFixture.testutil";
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

function offlineDeps(repo: SqliteGameRepository) {
  return {
    repository: repo,
    newGameId: () => asGameId(`genre-${Math.random().toString(36).slice(2)}`),
    newSeed: () => "seed-unused",
    newTraceId: () => "genre-journey",
    now: () => "2026-08-04T00:00:00.000Z",
    scenarioCandidateSource: createUnavailableTestScenarioSource(),
    runtimeNarrativeMode: "offline" as const,
  };
}

function actionDeps(repo: SqliteGameRepository) {
  return { repository: repo, now: () => "2026-08-04T00:00:00.000Z" };
}

describe("offlineGenreJourney：7 题材 fallback 蓝图零 AI 规则通关", () => {
  for (const caseId of OFFLINE_CASE_IDS) {
    it(`${caseId}：fallback + offline → 规则行动 → 成功结局，零 fetch`, async () => {
      const baseline = resolveOfflineBaseline(caseId);
      expect(baseline).not.toBeNull();
      if (baseline === null) return;
      const writer = openRepository(caseId);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("zero-network expected");
      });
      try {
        const created = await createGame(
          { input: baseline.input, seed: baseline.seed },
          offlineDeps(writer),
        );
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        expect(created.source).toBe("fallback");

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
    }, 60_000);
  }
});