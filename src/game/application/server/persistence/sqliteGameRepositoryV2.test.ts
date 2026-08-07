/** @vitest-environment node */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { createSqliteGameRepositoryV2 } from "./sqliteGameRepositoryV2";
import { createSqliteClient, type SqliteClient } from "./sqliteClient";
import { asGameId } from "./gameRepository";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";

const RUN_ROOT = join(import.meta.dirname ?? __dirname, ".tmp-sqlite-v2-test");

function buildTestState(): { worldState: WorldState; storyState: StoryState } {
  const loc: LocationEntry = {
    id: asLocationId("loc_1"), name: "t", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const worldState = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc,
    startingItemIds: [],
  });
  const storyState = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  return { worldState, storyState };
}

let fileCounter = 0;
function nextDbPath(): string {
  fileCounter += 1;
  return join(RUN_ROOT, `case-${fileCounter}.sqlite`);
}

const openedRepos: ReturnType<typeof createSqliteGameRepositoryV2>[] = [];

function openRepo(databasePath: string): ReturnType<typeof createSqliteGameRepositoryV2> {
  const repo = createSqliteGameRepositoryV2({
    clientFactory: () => createSqliteClient(databasePath),
    logError: () => {},
  });
  openedRepos.push(repo);
  return repo;
}

afterAll(async () => {
  for (const repo of openedRepos) {
    try { await repo.close(); } catch { /* ignore */ }
  }
  try { rmSync(RUN_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeAll(() => {
  try { rmSync(RUN_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(RUN_ROOT, { recursive: true });
});

describe("sqliteGameRepositoryV2", () => {
  it("createInitialGame + getCurrentGame roundtrip", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");

    expect(await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" })).toEqual({ ok: true });

    const current = await repo.getCurrentGame();
    expect(current.ok).toBe(true);
    if (current.ok && current.status === "active") {
      expect(current.record.gameId).toBe(gameId);
      expect(current.record.revision).toBe(0);
      expect(current.record.worldState.version).toBe(2);
      expect(current.record.storyState.version).toBe(2);
    }
  });

  it("createInitialGame rejects when active game exists", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();

    await repo.createInitialGame({ gameId: asGameId("g1"), worldState, storyState, createdAt: "2026-01-01" });
    const result = await repo.createInitialGame({ gameId: asGameId("g2"), worldState, storyState, createdAt: "2026-01-01" });
    expect(result).toEqual({ ok: false, code: "ACTIVE_GAME_EXISTS" });
  });

  it("applyState CAS success and stale rejection", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");

    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    const r1 = await repo.applyState({ gameId, expectedRevision: 0, nextWorldState: worldState, nextStoryState: storyState });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.record.revision).toBe(1);

    const r2 = await repo.applyState({ gameId, expectedRevision: 0, nextWorldState: worldState, nextStoryState: storyState });
    expect(r2).toEqual({ ok: false, code: "STALE_GAME_REVISION" });
  });

  it("applySceneWriteBack only updates narrative + candidateEventPool", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");

    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    const newNarrative = { ...storyState.narrative, mode: "ai" as const };
    const r = await repo.applySceneWriteBack({
      gameId,
      expectedRevision: 0,
      nextNarrative: newNarrative,
      nextCandidateEventPool: storyState.candidateEventPool,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.storyState.narrative.mode).toBe("ai");
      expect(r.record.storyState.tension).toBe(storyState.tension);
      expect(r.record.worldState).toEqual(worldState);
      expect(r.record.revision).toBe(1);
    }
  });

  it("getCurrentGame returns none when no game exists", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const result = await repo.getCurrentGame();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("none");
  });
});
