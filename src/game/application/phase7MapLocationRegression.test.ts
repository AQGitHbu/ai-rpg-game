/** @vitest-environment node */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  asLocationId,
  type GameTypeId,
  type NewGameInput
} from "@/game/domain";
import { projectDialogueChoices } from "@/game/gameplay/rpg/actions";
import scienceFictionFixture from "../../../data/fixtures/phase1/science_fiction.json";
import urbanFixture from "../../../data/fixtures/phase1/urban.json";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { createGame, type CreateGameDependencies } from "./createGame";
import { getCurrentGame } from "./getCurrentGame";
import { performAction } from "./performAction";
import { runScenarioPipeline, createUnavailableTestScenarioSource, TEST_TRACE_ID } from "./applicationFixture.testutil";
import { asGameId, type GameRepository } from "./server/persistence/gameRepository";
import { createSqliteClient } from "./server/persistence/sqliteClient";
import {
  createSqliteGameRepository,
  type SqliteGameRepository
} from "./server/persistence/sqliteGameRepository";

type Phase1Fixture = { input: NewGameInput; seed: string };

const CASES: readonly { gameType: GameTypeId; fixture: Phase1Fixture }[] = [
  { gameType: "wuxia", fixture: wuxiaFixture as unknown as Phase1Fixture },
  { gameType: "science_fiction", fixture: scienceFictionFixture as unknown as Phase1Fixture },
  { gameType: "urban", fixture: urbanFixture as unknown as Phase1Fixture }
];

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

function createDependencies(repository: GameRepository, gameId: string): CreateGameDependencies {
  return {
    repository,
    newGameId: () => asGameId(gameId),
    newSeed: () => "seed-unused",
    now: () => FIXED_CREATED_AT,
    scenarioCandidateSource: createUnavailableTestScenarioSource(),
    newTraceId: () => TEST_TRACE_ID
  };
}

describe.each(CASES)("Phase 7 地图地点回归（$gameType）", ({ gameType, fixture }) => {
  it("create → observe → dialogue_choice → move → reload：revision 递增、view 安全", async () => {
    const baseline = runScenarioPipeline(fixture.input, fixture.seed);
    const databasePath = join(RUN_ROOT, `journey-${gameType}.sqlite`);
    const repo = openRepository(databasePath);

    // 1) create
    const created = await createGame(
      { input: fixture.input, seed: fixture.seed },
      createDependencies(repo, `game-phase7-${gameType}`)
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.view.revision).toBe(0);
    expect(created.view.world.gameType).toBe(gameType);
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

    // 3) dialogue_choice: find first NPC with available choices
    const state1 = await repo.getCurrentGame();
    expect(state1.ok).toBe(true);
    if (!state1.ok || state1.status !== "active") return;

    const npcWithChoice = state1.record.state.npcs.find((npcState) => {
      const choices = projectDialogueChoices(
        baseline.blueprint, state1.record.state, npcState.npcId
      );
      return choices.length > 0;
    });

    let revisionAfterDialogue = 1;
    if (npcWithChoice !== undefined) {
      const choices = projectDialogueChoices(
        baseline.blueprint, state1.record.state, npcWithChoice.npcId
      );
      const firstChoice = choices[0]!;
      const dialogueResult = await performAction(
        {
          intent: {
            type: "dialogue_choice",
            npcId: npcWithChoice.npcId,
            choiceId: firstChoice.choiceId
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

    // 4) move to loc_2
    const moved = await performAction(
      { intent: { type: "move", locationId: asLocationId("loc_2") }, expectedRevision: revisionAfterDialogue },
      { repository: repo, now: () => FIXED_ACTION_TIME }
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.view.revision).toBe(revisionAfterDialogue + 1);
    expect(moved.view.worldMap.nodes[0]?.state).toBe("current");
    expect(moved.view.locationScene.title).toBe(moved.view.currentLocation.name);

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
