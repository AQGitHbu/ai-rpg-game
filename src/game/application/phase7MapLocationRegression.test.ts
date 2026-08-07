/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  asLocationId,
  type ScenarioBlueprint
} from "@/game/domain";
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
import { asGameId } from "./server/persistence/gameRepository";
import { createSqliteClient } from "./server/persistence/sqliteClient";
import {
  createSqliteGameRepository,
  type SqliteGameRepository
} from "./server/persistence/sqliteGameRepository";

// Phase 14 开局收窄后 createGame 只产出 1 幕起始锚点蓝图；本文件的旅程
// （observe → talk → move loc_b → reload）需要"运行时扩展后"的完整蓝图。
// 以 makeValidCandidate 为基座编译（wuxia 题材），直接写入真实 SQLite 存档。
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

const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-phase7-regression-";
try {
  for (const entry of readdirSync(TMP_ROOT)) {
    if (entry.startsWith(RUN_PREFIX)) {
      try {
        rmSync(join(TMP_ROOT, entry), { recursive: true, force: true });
      } catch { /* still locked */ }
    }
  }
} catch { /* tmp/ doesn't exist yet */ }
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
    try { await repository.close(); } catch { /* already closed */ }
  }
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch { /* Windows handle not released */ }
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

describe("Phase 7 地图地点回归（wuxia）", () => {
  it("create → observe → talk → move → reload：revision 递增、view 安全", async () => {
    const baseline = PIPELINE;
    const databasePath = join(RUN_ROOT, "journey-wuxia.sqlite");
    const repo = openRepository(databasePath);

    // 1) 建档
    await seedGame(repo, "game-phase7-wuxia");
    const created = await getCurrentGame({ repository: repo });
    expect(created.status).toBe("active");
    if (created.status !== "active") return;
    expect(created.view.revision).toBe(0);
    expect(created.view.world.gameType).toBe("wuxia");
    expect(created.view.worldMap.nodes[0]?.state).toBe("current");
    expect(created.view.locationScene.title).toBe(created.view.currentLocation.name);

    // 2) observe current location
    const currentLocationId = baseline.blueprint.locations[0]!.id;
    const observed = await performAction(
      { intent: { type: "observe", locationId: currentLocationId }, expectedRevision: 0 },
      { repository: repo, now: () => FIXED_ACTION_TIME }
    );
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(observed.view.revision).toBe(1);
    expect(observed.feedback.ok).toBe(true);

    // 3) talk: find first NPC at current location that hasn't been met yet
    const state1 = await repo.getCurrentGame();
    expect(state1.ok).toBe(true);
    if (!state1.ok || state1.status !== "active") return;

    const npcWithChoice = state1.record.state.npcs.find((npcState) =>
      npcState.locationId === state1.record.state.currentLocationId && !npcState.met
    );

    let revisionAfterDialogue = 1;
    if (npcWithChoice !== undefined) {
      const dialogueResult = await performAction(
        {
          intent: {
            type: "talk",
            npcId: npcWithChoice.npcId
          },
          expectedRevision: 1
        },
        { repository: repo, now: () => FIXED_ACTION_TIME }
      );
      expect(dialogueResult.ok).toBe(true);
      if (!dialogueResult.ok) return;
      expect(dialogueResult.view.revision).toBe(2);
      expect(dialogueResult.feedback.ok).toBe(true);
      revisionAfterDialogue = 2;
    }

    // 4) move to loc_b
    const moved = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_b") }, expectedRevision: revisionAfterDialogue },
      { repository: repo, now: () => FIXED_ACTION_TIME }
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.view.revision).toBe(revisionAfterDialogue + 1);
    expect(moved.view.worldMap.nodes[0]?.state).toBe("current");
    expect(moved.view.locationScene.title).toBe(moved.view.currentLocation.name);

    // Phase 8: map node positions are stable across actions
    const beforeMove = created.view.worldMap.nodes
      .filter((node): node is typeof node & { locationId: string } => node.state !== "locked")
      .map((node) => [node.locationId, node.position] as const);
    expect(beforeMove.every(([, position]) => typeof position === "string")).toBe(true);
    const afterMove = moved.view.worldMap.nodes
      .filter((node): node is typeof node & { locationId: string } => node.state !== "locked");
    for (const [locationId, position] of beforeMove) {
      const after = afterMove.find((node) => node.locationId === locationId);
      if (after !== undefined) expect(after.position).toBe(position);
    }

    // view safety: no hidden location names, no seed, no inputDigest
    const adventureJson = JSON.stringify({
      worldMap: moved.view.worldMap,
      locationScene: moved.view.locationScene,
      dialogues: moved.view.dialogues
    });
    for (const hidden of baseline.blueprint.locations.filter((l) => l.kind === "hidden")) {
      expect(adventureJson.includes(hidden.name), `hidden=${hidden.name}`).toBe(false);
    }
    expect(adventureJson.includes(baseline.blueprint.seed)).toBe(false);
    expect(adventureJson.includes(baseline.blueprint.inputDigest)).toBe(false);

    await repo.close();

    // 5) reload: fresh repository, same file → identical view
    const reader = openRepository(databasePath);
    const restored = await getCurrentGame({ repository: reader });
    expect(restored.status).toBe("active");
    if (restored.status !== "active") return;
    expect(restored.view).toEqual(moved.view);
  });
});
