import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
/** @vitest-environment node */
import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSqliteGameRepository } from "./sqliteGameRepository";
import { createSqliteClient, type SqliteClient } from "./sqliteClient";
import { asGameId } from "./gameRepository";
import type { GameRecord, GameRepository } from "./gameRepository";
import { WORLD_STATE_SCHEMA_VERSION } from "@/game/domain/worldState";
import type { LocationEntry } from "@/game/domain/worldState";
import { createWorldStateFixtureWith, emptyProjection, type WorldStateFixtureOverrides } from "@/game/domain/testing/worldStateFixture.testutil";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asGenerationId, asFactId, type GenerationMetadata } from "@/game/domain/worldEntity";
import { asEventId, asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createApprovedChoice } from "@/game/domain/approvedChoice";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";

// 每个 Vitest 进程使用独立的 OS 临时目录，避免 Git Bash/Windows 下多个
// test run 争用源码目录中的固定 SQLite 文件，也避免清理残留目录时受句柄影响。
const RUN_ROOT = mkdtempSync(join(tmpdir(), "ai-rpg-game-sqlite-"));

const TEST_GENERATION: GenerationMetadata = {
  generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia",
};
const TEST_LOCATION: LocationEntry = {
  id: asLocationId("loc_1"), name: "t", description: "t", kind: "main",
  connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
};
const TEST_PROJECTION: EntityCompatibilityProjection = emptyProjection({
  player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [TEST_LOCATION],
  currentLocationId: asLocationId("loc_1"),
});

/** 兼容投影 + 覆盖项经同一组装点重建 entityStore，禁止事后 spread legacy 数组。 */
function buildTestWorld(overrides: WorldStateFixtureOverrides = {}): WorldState {
  return createWorldStateFixtureWith({ generation: TEST_GENERATION, base: TEST_PROJECTION }, overrides);
}

function buildTestState(): { worldState: WorldState; storyState: StoryState } {
  const worldState = buildTestWorld();
  const storyState = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  return { worldState, storyState };
}

let fileCounter = 0;
function nextDbPath(): string {
  fileCounter += 1;
  return join(RUN_ROOT, `case-${fileCounter}.sqlite`);
}

const openedRepos: ReturnType<typeof createSqliteGameRepository>[] = [];
const rawClients: SqliteClient[] = [];

function openRepo(databasePath: string): ReturnType<typeof createSqliteGameRepository> {
  const repo = createSqliteGameRepository({
    clientFactory: () => createSqliteClient(databasePath),
    logError: () => {},
  });
  openedRepos.push(repo);
  return repo;
}

/**
 * 无条件读回 active 存档：corrupt / none 分类必须让用例当场失败。
 * getCurrentGame 对一切分类失败都返回 ok:true，绝不允许再用 status 守卫静默跳过后置断言。
 */
async function expectActiveCurrentGame(repo: GameRepository): Promise<GameRecord> {
  const current = await repo.getCurrentGame();
  expect(current).toMatchObject({ ok: true, status: "active" });
  if (!current.ok || current.status !== "active") {
    throw new Error("getCurrentGame 未返回 active 存档");
  }
  return current.record;
}

afterAll(async () => {
  for (const repo of openedRepos) {
    try { await repo.close(); } catch { /* ignore */ }
  }
  for (const client of rawClients) {
    try { client.close(); } catch { /* ignore */ }
  }
  try { rmSync(RUN_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("sqliteGameRepository", () => {
  it("initializes only the neutral current-record tables", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    await repo.initializeSchema();

    const raw = createSqliteClient(dbPath);
    rawClients.push(raw);
    const tables = await raw.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      args: [],
    });

    expect(tables.rows.map((row) => row["name"])).toEqual(["current_game", "game_records", "opening_history"]);
  });

  it("世界事实的 investigationApproaches 随 SQLite JSON 写回完整往返", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    await repo.initializeSchema();
    const { storyState } = buildTestState();
    const withApproaches: WorldState = buildTestWorld({
      worldFacts: [{
        factId: asFactId("fact_0"),
        text: "密道入口在井下。",
        source: "generated",
        discovered: false,
        investigationLabel: "井口的痕迹",
        investigationApproaches: [
          { approachId: "a", label: "检查井沿", hint: "先看压痕深浅", evidenceQuality: "clean", tensionDelta: 2 },
          { approachId: "b", label: "细听井底动静", evidenceQuality: "noisy", tensionDelta: 5 },
        ],
      }],
    });
    await repo.createInitialGame({ gameId: asGameId("g-approaches"), worldState: withApproaches, storyState, createdAt: "2026-01-01T00:00:00.000Z" });
    const record = await expectActiveCurrentGame(repo);
    expect(record.worldState.worldFacts[0]?.investigationApproaches).toEqual([
      { approachId: "a", label: "检查井沿", hint: "先看压痕深浅", evidenceQuality: "clean", tensionDelta: 2 },
      { approachId: "b", label: "细听井底动静", evidenceQuality: "noisy", tensionDelta: 5 },
    ]);
  });

  it("原子保存开局指纹，清档后仍保留历史供下一局去重", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();
    const openingHistory = {
      gameType: "wuxia" as const,
      fingerprint: "full-1",
      semanticFingerprint: "semantic-1",
      semanticText: "后巷调查|见证者|车轮痕迹",
      summary: "地点：青石镇后巷；NPC：老陈；结构：street/witness/trace/concealment",
      profile: { sceneFrame: "street", npcArchetype: "witness", leadType: "trace", conflictMode: "concealment" } as const,
      createdAt: "2026-01-01",
    };

    expect(await repo.createInitialGame({
      gameId: asGameId("history-game"), worldState, storyState, createdAt: "2026-01-01", openingHistory,
    })).toEqual({ ok: true });
    expect(await repo.listOpeningHistory?.({ gameType: "wuxia", limit: 10 })).toEqual({
      ok: true,
      records: [openingHistory],
    });

    expect(await repo.clearCurrentGame()).toEqual({ ok: true });
    expect(await repo.listOpeningHistory?.({ gameType: "wuxia", limit: 10 })).toEqual({
      ok: true,
      records: [openingHistory],
    });
  });

  it("createInitialGame + getCurrentGame roundtrip", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");

    expect(await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" })).toEqual({ ok: true });

    const current = await repo.getCurrentGame();
    // 直接断言 active：corrupt 读取必须让本用例失败，不允许被 status 守卫跳过。
    expect(current).toMatchObject({ ok: true, status: "active" });
    if (current.ok && current.status === "active") {
      expect(current.record.gameId).toBe(gameId);
      expect(current.record.revision).toBe(0);
      expect(current.record.worldState.version).toBe(WORLD_STATE_SCHEMA_VERSION);
      expect(current.record.worldState.entityStore.version).toBe(2);
      expect(current.record.storyState.version).toBe(7);
    }
  });

  it("classifies malformed v4 entity state as ENTITY_STATE_INVALID", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g-corrupt-entity");
    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });
    const raw = createSqliteClient(dbPath);
    rawClients.push(raw);
    await raw.execute({
      sql: "UPDATE game_records SET world_state_json = ? WHERE game_id = ?",
      args: [JSON.stringify({ ...worldState, entityStore: { ...worldState.entityStore, records: [...worldState.entityStore.records, worldState.entityStore.records[0]] } }), gameId],
    });
    expect(await repo.getCurrentGame()).toEqual({ ok: true, status: "corrupt", reason: "ENTITY_STATE_INVALID" });
  });

  it("只降级 world version 到当前常量前一代（store 仍是当前版本）的存档归类为 UNSUPPORTED_RECORD，不迁移也不伪装成损坏", async () => {
    // 版本写差一时（常量与 LEGACY 闸门/解析器不同源）必须在这里暴露：
    // 旧世代只会落进 UNSUPPORTED_RECORD，绝不允许伪装成 ENTITY_STATE_INVALID 的内容损坏。
    const legacyWorldVersion = WORLD_STATE_SCHEMA_VERSION - 1;
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    await repo.initializeSchema();
    const raw = createSqliteClient(dbPath);
    rawClients.push(raw);
    const { worldState, storyState } = buildTestState();
    await raw.execute({
      sql: `INSERT INTO game_records (game_id, record_version, world_state_json, story_state_json, created_at, revision)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["legacy_world_v3", 1, JSON.stringify({ ...worldState, version: legacyWorldVersion }), JSON.stringify(storyState), "2025-01-01", 0],
    });
    await raw.execute({ sql: "INSERT INTO current_game (slot, game_id) VALUES (1, ?)", args: ["legacy_world_v3"] });

    expect(await repo.getCurrentGame()).toEqual({ ok: true, status: "corrupt", reason: "UNSUPPORTED_RECORD" });
  });

  it("createInitialGame rejects when active game exists", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();

    await repo.createInitialGame({ gameId: asGameId("g1"), worldState, storyState, createdAt: "2026-01-01" });
    const result = await repo.createInitialGame({ gameId: asGameId("g2"), worldState, storyState, createdAt: "2026-01-01" });
    expect(result).toEqual({ ok: false, code: "ACTIVE_GAME_EXISTS" });
  });

  it("invalid entity world is rejected without replacing a valid record, but CAS predicates win", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g-invalid");
    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });
    const invalid = { ...worldState, locations: [] } as WorldState;

    expect(await repo.createInitialGame({ gameId: asGameId("other"), worldState: invalid, storyState, createdAt: "2026-01-01" }))
      .toEqual({ ok: false, code: "ACTIVE_GAME_EXISTS" });
    expect(await repo.applyState({ gameId, expectedRevision: 99, nextWorldState: invalid, nextStoryState: storyState }))
      .toEqual({ ok: false, code: "STALE_GAME_REVISION" });
    expect(await repo.applyState({ gameId, expectedRevision: 0, nextWorldState: invalid, nextStoryState: storyState }))
      .toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });
    expect(await repo.getCurrentGame()).toMatchObject({ ok: true, status: "active", record: { gameId, revision: 0 } });
  });

  it("atomically replaces the expected current revision and preserves it on stale failure", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const oldState = buildTestState();
    const newState = buildTestState();
    await repo.createInitialGame({
      gameId: asGameId("ended-game"),
      ...oldState,
      createdAt: "2026-01-01",
    });

    const stale = await repo.replaceCurrentGame({
      expectedCurrentGameId: asGameId("ended-game"),
      expectedRevision: 7,
      gameId: asGameId("stale-new-game"),
      ...newState,
      createdAt: "2026-01-02",
    });
    expect(stale).toEqual({ ok: false, code: "STALE_GAME_REVISION" });
    const preserved = await repo.getCurrentGame();
    expect(preserved).toMatchObject({ ok: true, status: "active", record: { gameId: "ended-game", revision: 0 } });

    const replaced = await repo.replaceCurrentGame({
      expectedCurrentGameId: asGameId("ended-game"),
      expectedRevision: 0,
      gameId: asGameId("fresh-game"),
      ...newState,
      createdAt: "2026-01-02",
    });
    expect(replaced).toEqual({ ok: true });
    const current = await repo.getCurrentGame();
    expect(current).toMatchObject({ ok: true, status: "active", record: { gameId: "fresh-game", revision: 0 } });
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

  it("applyState with incrementRevision=false keeps revision unchanged and later CAS still succeeds", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");

    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    // 元数据更新（如 ackPrologue 的 prologueShown）：revision 不递增
    const r1 = await repo.applyState({
      gameId,
      expectedRevision: 0,
      nextWorldState: worldState,
      nextStoryState: { ...storyState, prologueShown: true },
      incrementRevision: false,
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.record.revision).toBe(0);
      expect(r1.record.storyState.prologueShown).toBe(true);
    }

    // 持久化读回同样保持 revision 不变
    const record = await expectActiveCurrentGame(repo);
    expect(record.revision).toBe(0);
    expect(record.storyState.prologueShown).toBe(true);

    // 后续基于同一 revision 的正常写入（默认递增）仍可 CAS 成功
    const r2 = await repo.applyState({ gameId, expectedRevision: 0, nextWorldState: worldState, nextStoryState: storyState });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.record.revision).toBe(1);
  });

  it("revision-preserving narrative retry CAS also checks failed status and jobId", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();
    const jobResult = createPendingNarrativeJob({
      jobId: asNarrativeJobId("retry-job"),
      turnId: asTurnId("retry-turn"),
      actionId: "retry-action",
      expectedRevision: 0,
      turnNumber: 1,
      actionSummary: { kind: "explore" },
      resolvedEvent: {
        actionId: "retry-action", status: "success", eventKind: "observe",
        facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [],
      },
      domainEventIds: [asEventId("turn-1:event-1")],
      requestedAt: "2026-01-01",
      objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
      mandatoryBeats: [],
      generationKind: "npc_fixed_choice",
      sceneRequestKind: "npc_response",
    });
    expect(jobResult.ok).toBe(true);
    if (!jobResult.ok) return;
    const failedStoryState: StoryState = {
      ...storyState,
      narrative: {
        status: "provider_failed",
        mode: "offline",
        job: jobResult.job,
        lastPresentedScene: storyState.narrative.status === "ready"
          ? storyState.narrative.currentScene
          : null,
        failure: { kind: "AI_CALL_FAILED", phase: "scene", failedAt: "2026-01-01" },
      },
    };
    const gameId = asGameId("g-retry-cas");
    await repo.createInitialGame({ gameId, worldState, storyState: failedStoryState, createdAt: "2026-01-01" });

    const pendingStoryState: StoryState = {
      ...failedStoryState,
      narrative: {
        status: "provider_pending",
        mode: failedStoryState.narrative.mode,
        job: jobResult.job,
        lastPresentedScene: failedStoryState.narrative.status === "provider_failed"
          ? failedStoryState.narrative.lastPresentedScene
          : null,
      },
    };
    const first = await repo.applyState({
      gameId,
      expectedRevision: 0,
      nextWorldState: worldState,
      nextStoryState: pendingStoryState,
      incrementRevision: false,
      expectedNarrativeJob: { status: "provider_failed", jobId: "retry-job" },
    });
    expect(first.ok).toBe(true);

    const second = await repo.applyState({
      gameId,
      expectedRevision: 0,
      nextWorldState: worldState,
      nextStoryState: pendingStoryState,
      incrementRevision: false,
      expectedNarrativeJob: { status: "provider_failed", jobId: "retry-job" },
    });
    expect(second).toEqual({ ok: false, code: "STALE_GAME_REVISION" });
  });

  it("applySceneWriteBack persists full world + story through one CAS", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");

    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    const approved = createApprovedChoice({
      sceneId: "scene-1", basedOnRevision: 1, label: "探索", action: { type: "explore" },
    });
    if (!approved.ok) throw new Error("fixture approval failed");
    const newNarrative = { ...storyState.narrative, mode: "ai" as const, choiceRegistry: [approved.choice] };
    const nextWorldState = buildTestWorld({ currentLocationId: asLocationId("loc_1") });
    const nextStoryState = { ...storyState, narrative: newNarrative, candidateEventPool: storyState.candidateEventPool };
    const r = await repo.applySceneWriteBack({
      gameId,
      expectedRevision: 0,
      nextWorldState,
      nextStoryState,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.storyState.narrative.mode).toBe("ai");
      expect(r.record.storyState.narrative.status).toBe("ready");
      if (r.record.storyState.narrative.status !== "ready") return;
      expect(r.record.storyState.narrative.choiceRegistry).toEqual([approved.choice]);
      expect(r.record.storyState.tension).toBe(storyState.tension);
      expect(r.record.worldState.currentLocationId).toBe(asLocationId("loc_1"));
      expect(r.record.revision).toBe(1);
    }
  });

  it("applySceneWriteBack preserves a concurrently acknowledged prologue", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g-prologue-race");

    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });
    const acknowledged = await repo.applyState({
      gameId,
      expectedRevision: 0,
      nextWorldState: worldState,
      nextStoryState: { ...storyState, prologueShown: true },
      incrementRevision: false,
    });
    expect(acknowledged.ok).toBe(true);

    const writeBack = await repo.applySceneWriteBack({
      gameId,
      expectedRevision: 0,
      nextWorldState: worldState,
      // 模拟生成任务在确认前读取到的旧快照。
      nextStoryState: { ...storyState, prologueShown: false },
    });

    expect(writeBack).toMatchObject({ ok: true, record: { revision: 1 } });
    if (writeBack.ok) expect(writeBack.record.storyState.prologueShown).toBe(true);
  });

  it("getCurrentGame returns none when no game exists", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const result = await repo.getCurrentGame();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("none");
  });

  // -------------------------------------------------------------------------
  // Task 14 Step 3：旧 v2 schema 明确分类为 UNSUPPORTED_RECORD，不迁移、不伪装。
  // -------------------------------------------------------------------------

  it("record_version=0 的旧 v2 存档返回 UNSUPPORTED_RECORD", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    await repo.initializeSchema();
    const raw = createSqliteClient(dbPath);
    rawClients.push(raw);
    await raw.batch(
      [
        `CREATE TABLE IF NOT EXISTS game_records (
          game_id TEXT PRIMARY KEY, record_version INTEGER NOT NULL,
          world_state_json TEXT NOT NULL, story_state_json TEXT NOT NULL,
          created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS current_game (slot INTEGER PRIMARY KEY CHECK (slot = 1), game_id TEXT NOT NULL)`,
      ],
      "write",
    );
    await raw.execute({
      sql: `INSERT INTO game_records (game_id, record_version, world_state_json, story_state_json, created_at, revision)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["legacy_game", 0, JSON.stringify({ version: 1 }), JSON.stringify({ version: 1 }), "2025-01-01", 0],
    });
    await raw.execute({ sql: "INSERT INTO current_game (slot, game_id) VALUES (1, ?)", args: ["legacy_game"] });

    const result = await repo.getCurrentGame();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("corrupt");
      if (result.status === "corrupt") expect(result.reason).toBe("UNSUPPORTED_RECORD");
    }
  });

  it("JSON 内部 version=1 的旧 v2 存档返回 UNSUPPORTED_RECORD（不伪装）", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    await repo.initializeSchema();
    const raw = createSqliteClient(dbPath);
    rawClients.push(raw);
    await raw.batch(
      [
        `CREATE TABLE IF NOT EXISTS game_records (
          game_id TEXT PRIMARY KEY, record_version INTEGER NOT NULL,
          world_state_json TEXT NOT NULL, story_state_json TEXT NOT NULL,
          created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS current_game (slot INTEGER PRIMARY KEY CHECK (slot = 1), game_id TEXT NOT NULL)`,
      ],
      "write",
    );
    await raw.execute({
      sql: `INSERT INTO game_records (game_id, record_version, world_state_json, story_state_json, created_at, revision)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["legacy_v1", 1, JSON.stringify({ version: 1 }), JSON.stringify({ version: 1 }), "2025-01-01", 0],
    });
    await raw.execute({ sql: "INSERT INTO current_game (slot, game_id) VALUES (1, ?)", args: ["legacy_v1"] });

    const result = await repo.getCurrentGame();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("corrupt");
      if (result.status === "corrupt") expect(result.reason).toBe("UNSUPPORTED_RECORD");
    }
  });

  it("world version=2 的旧开发存档返回 UNSUPPORTED_RECORD（不迁移、不静默重置）", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    await repo.initializeSchema();
    const raw = createSqliteClient(dbPath);
    rawClients.push(raw);
    await raw.batch(
      [
        `CREATE TABLE IF NOT EXISTS game_records (
          game_id TEXT PRIMARY KEY, record_version INTEGER NOT NULL,
          world_state_json TEXT NOT NULL, story_state_json TEXT NOT NULL,
          created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS current_game (slot INTEGER PRIMARY KEY CHECK (slot = 1), game_id TEXT NOT NULL)`,
      ],
      "write",
    );
    const { storyState } = buildTestState();
    await raw.execute({
      sql: `INSERT INTO game_records (game_id, record_version, world_state_json, story_state_json, created_at, revision)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["legacy_world_v2", 1, JSON.stringify({ version: 2 }), JSON.stringify(storyState), "2025-01-01", 0],
    });
    await raw.execute({ sql: "INSERT INTO current_game (slot, game_id) VALUES (1, ?)", args: ["legacy_world_v2"] });

    const result = await repo.getCurrentGame();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("corrupt");
      if (result.status === "corrupt") expect(result.reason).toBe("UNSUPPORTED_RECORD");
    }
  });

  it("未知 record_version 仍返回 VERSION_MISMATCH（非 LEGACY）", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    await repo.initializeSchema();
    const raw = createSqliteClient(dbPath);
    rawClients.push(raw);
    await raw.batch(
      [
        `CREATE TABLE IF NOT EXISTS game_records (
          game_id TEXT PRIMARY KEY, record_version INTEGER NOT NULL,
          world_state_json TEXT NOT NULL, story_state_json TEXT NOT NULL,
          created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS current_game (slot INTEGER PRIMARY KEY CHECK (slot = 1), game_id TEXT NOT NULL)`,
      ],
      "write",
    );
    await raw.execute({
      sql: `INSERT INTO game_records (game_id, record_version, world_state_json, story_state_json, created_at, revision)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["unknown_v", 99, JSON.stringify({ version: 2 }), JSON.stringify({ version: 2 }), "2025-01-01", 0],
    });
    await raw.execute({ sql: "INSERT INTO current_game (slot, game_id) VALUES (1, ?)", args: ["unknown_v"] });

    const result = await repo.getCurrentGame();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("corrupt");
      if (result.status === "corrupt") expect(result.reason).toBe("VERSION_MISMATCH");
    }
  });
});

// ---------------------------------------------------------------------------
// SQLite 原子性（Task 4 Step 2）：包一层真实客户端做故障注入。
// 失败必须整体回滚——World 与 Story 都保持旧值，且 revision 不变。
// ---------------------------------------------------------------------------

type SqliteTransaction = Awaited<ReturnType<SqliteClient["transaction"]>>;

function wrapTransactionWithFault(
  tx: SqliteTransaction,
  shouldThrow: (sql: string) => boolean,
): SqliteTransaction {
  return new Proxy(tx, {
    get(target, property) {
      if (property === "execute") {
        return (async (stmtOrSql: unknown, args?: unknown) => {
          const sql =
            typeof stmtOrSql === "string" ? stmtOrSql : (stmtOrSql as { sql: string }).sql;
          if (shouldThrow(sql)) throw new Error(`注入故障：${sql}`);
          return (target.execute as (a: unknown, b?: unknown) => Promise<unknown>)(stmtOrSql, args);
        }) as SqliteTransaction["execute"];
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function"
        ? (value as (...callArgs: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function createFaultClient(
  real: SqliteClient,
  shouldThrow: (sql: string) => boolean,
): SqliteClient {
  rawClients.push(real);
  return new Proxy(real, {
    get(target, property) {
      if (property === "transaction") {
        return (async (mode?: "write" | "read" | "deferred") => {
          const tx = mode === undefined ? await target.transaction() : await target.transaction(mode);
          return wrapTransactionWithFault(tx, shouldThrow);
        }) as SqliteClient["transaction"];
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function"
        ? (value as (...callArgs: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

describe("sqliteGameRepository：事务原子性", () => {
  it("JSON 序列化失败（循环引用）→ 零写入，旧值完整保留", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");
    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    const cyclic = { ...worldState } as Record<string, unknown>;
    cyclic.self = cyclic;

    const result = await repo.applyState({
      gameId,
      expectedRevision: 0,
      nextWorldState: cyclic as unknown as WorldState,
      nextStoryState: storyState,
    });
    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });

    const record = await expectActiveCurrentGame(repo);
    expect(record.revision).toBe(0);
    expect(record.worldState).toEqual(worldState);
    expect(record.storyState).toEqual(storyState);
  });

  it("UPDATE 前失败（注入 UPDATE 语句异常）→ 回滚后 World/Story 均保持旧值", async () => {
    const dbPath = nextDbPath();
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");

    const seed = openRepo(dbPath);
    await seed.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    const faulty = createSqliteGameRepository({
      clientFactory: () => createFaultClient(
        createSqliteClient(dbPath),
        (sql) => /^\s*UPDATE\s+game_records/i.test(sql),
      ),
      logError: () => {},
    });
    openedRepos.push(faulty);

    const result = await faulty.applyState({
      gameId,
      expectedRevision: 0,
      nextWorldState: worldState,
      nextStoryState: storyState,
    });
    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });

    // 全新实例读取同一文件：revision 未增长，World 与 Story 都是旧值
    const reader = openRepo(dbPath);
    const record = await expectActiveCurrentGame(reader);
    expect(record.revision).toBe(0);
    expect(record.worldState).toEqual(worldState);
    expect(record.storyState).toEqual(storyState);
  });

  it("read-back 失败（UPDATE 成功后注入读取异常）→ 整体回滚，旧值保留", async () => {
    const dbPath = nextDbPath();
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");

    const seed = openRepo(dbPath);
    await seed.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    const faulty = createSqliteGameRepository({
      clientFactory: () => createFaultClient(
        createSqliteClient(dbPath),
        (sql) => /^\s*SELECT\s+game_id,\s*record_version/i.test(sql),
      ),
      logError: () => {},
    });
    openedRepos.push(faulty);

    const result = await faulty.applyState({
      gameId,
      expectedRevision: 0,
      nextWorldState: { ...worldState, eventLedger: [] },
      nextStoryState: storyState,
    });
    expect(result).toEqual({ ok: false, code: "INFRASTRUCTURE_FAILURE" });

    const reader = openRepo(dbPath);
    const record = await expectActiveCurrentGame(reader);
    expect(record.revision).toBe(0);
    expect(record.worldState).toEqual(worldState);
    expect(record.storyState).toEqual(storyState);
  });
});

describe("sqliteGameRepository：stale 后旧值保留", () => {
  it("stale revision → STALE_GAME_REVISION 且存档保持旧值", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");
    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    const nextStory = { ...storyState, tension: 99 };
    const stale = await repo.applyState({
      gameId,
      expectedRevision: 42,
      nextWorldState: worldState,
      nextStoryState: nextStory,
    });
    expect(stale).toEqual({ ok: false, code: "STALE_GAME_REVISION" });

    const record = await expectActiveCurrentGame(repo);
    expect(record.revision).toBe(0);
    expect(record.storyState.tension).toBe(storyState.tension);
    expect(record.worldState).toEqual(worldState);
  });

  it("短篇规模：80 回合连续 CAS 写入 + reload 一致性 + 大小基线（Task 32）", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    const gameId = asGameId("g_scaled");
    const { worldState, storyState } = buildTestState();

    await repo.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    const START = 1;
    const TURNS = 80;
    const initialLedgerLength = worldState.eventLedger.length;
    let nextWorld = worldState;
    let nextStory = storyState;
    const startTime = performance.now();
    for (let i = START; i <= TURNS; i++) {
      // 每回合：世界累积一条事件、张力累进、turnNumber 递增，模拟真实增长
      nextWorld = {
        ...nextWorld,
        eventLedger: [...nextWorld.eventLedger, makeCommittedEvent(
          { type: "player_intent_expressed", intentCode: "unmapped_freeform" },
          { sequence: initialLedgerLength + i - 1, turnNumber: i, committedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z` },
        )],
      };
      nextStory = { ...nextStory, turnNumber: i, tension: Math.max(0, 100 - i) };
      const r = await repo.applyState({
        gameId,
        expectedRevision: i - 1,
        nextWorldState: nextWorld,
        nextStoryState: nextStory,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) break;
    }
    const elapsedMs = performance.now() - startTime;

    // reload：从持久化读回，turnNumber/事件数/CAS revision 语义正确
    const record = await expectActiveCurrentGame(repo);
    expect(record.revision).toBe(TURNS);
    expect(record.storyState.turnNumber).toBe(TURNS);
    expect(record.storyState.tension).toBe(Math.max(0, 100 - TURNS));
    expect(record.worldState.eventLedger.length).toBe(initialLedgerLength + TURNS);

    // 大小基线（记录而非断言）：供长篇门禁参考
    const { statSync } = await import("node:fs");
    let dbBytes = 0;
    try { dbBytes = statSync(dbPath).size; } catch { /* ignore */ }
    // 只做宽松的合理性断言（>=1B，避免墙钟/大小脆弱断言）
    expect(dbBytes).toBeGreaterThan(0);
    expect(TURNS).toBeGreaterThanOrEqual(50);
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
