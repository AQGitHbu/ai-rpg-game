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
const rawClients: SqliteClient[] = [];

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
  for (const client of rawClients) {
    try { client.close(); } catch { /* ignore */ }
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

  // -------------------------------------------------------------------------
  // Task 14 Step 3：旧 v2 schema 明确分类为 LEGACY_V2_RECORD，不迁移、不伪装。
  // -------------------------------------------------------------------------

  it("record_version=0 的旧 v2 存档返回 LEGACY_V2_RECORD", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    await repo.initializeSchema();
    const raw = createSqliteClient(dbPath);
    rawClients.push(raw);
    await raw.batch(
      [
        `CREATE TABLE IF NOT EXISTS game_records_v2 (
          game_id TEXT PRIMARY KEY, record_version INTEGER NOT NULL,
          world_state_json TEXT NOT NULL, story_state_json TEXT NOT NULL,
          created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS current_game_v2 (slot INTEGER PRIMARY KEY CHECK (slot = 1), game_id TEXT NOT NULL)`,
      ],
      "write",
    );
    await raw.execute({
      sql: `INSERT INTO game_records_v2 (game_id, record_version, world_state_json, story_state_json, created_at, revision)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["legacy_game", 0, JSON.stringify({ version: 1 }), JSON.stringify({ version: 1 }), "2025-01-01", 0],
    });
    await raw.execute({ sql: "INSERT INTO current_game_v2 (slot, game_id) VALUES (1, ?)", args: ["legacy_game"] });

    const result = await repo.getCurrentGame();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("corrupt");
      if (result.status === "corrupt") expect(result.reason).toBe("LEGACY_V2_RECORD");
    }
  });

  it("JSON 内部 version=1 的旧 v2 存档返回 LEGACY_V2_RECORD（不伪装）", async () => {
    const dbPath = nextDbPath();
    const repo = openRepo(dbPath);
    await repo.initializeSchema();
    const raw = createSqliteClient(dbPath);
    rawClients.push(raw);
    await raw.batch(
      [
        `CREATE TABLE IF NOT EXISTS game_records_v2 (
          game_id TEXT PRIMARY KEY, record_version INTEGER NOT NULL,
          world_state_json TEXT NOT NULL, story_state_json TEXT NOT NULL,
          created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS current_game_v2 (slot INTEGER PRIMARY KEY CHECK (slot = 1), game_id TEXT NOT NULL)`,
      ],
      "write",
    );
    await raw.execute({
      sql: `INSERT INTO game_records_v2 (game_id, record_version, world_state_json, story_state_json, created_at, revision)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["legacy_v1", 1, JSON.stringify({ version: 1 }), JSON.stringify({ version: 1 }), "2025-01-01", 0],
    });
    await raw.execute({ sql: "INSERT INTO current_game_v2 (slot, game_id) VALUES (1, ?)", args: ["legacy_v1"] });

    const result = await repo.getCurrentGame();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("corrupt");
      if (result.status === "corrupt") expect(result.reason).toBe("LEGACY_V2_RECORD");
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
        `CREATE TABLE IF NOT EXISTS game_records_v2 (
          game_id TEXT PRIMARY KEY, record_version INTEGER NOT NULL,
          world_state_json TEXT NOT NULL, story_state_json TEXT NOT NULL,
          created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS current_game_v2 (slot INTEGER PRIMARY KEY CHECK (slot = 1), game_id TEXT NOT NULL)`,
      ],
      "write",
    );
    await raw.execute({
      sql: `INSERT INTO game_records_v2 (game_id, record_version, world_state_json, story_state_json, created_at, revision)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["unknown_v", 99, JSON.stringify({ version: 2 }), JSON.stringify({ version: 2 }), "2025-01-01", 0],
    });
    await raw.execute({ sql: "INSERT INTO current_game_v2 (slot, game_id) VALUES (1, ?)", args: ["unknown_v"] });

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

type SqliteTransactionV2 = Awaited<ReturnType<SqliteClient["transaction"]>>;

function wrapTransactionWithFault(
  tx: SqliteTransactionV2,
  shouldThrow: (sql: string) => boolean,
): SqliteTransactionV2 {
  return new Proxy(tx, {
    get(target, property) {
      if (property === "execute") {
        return (async (stmtOrSql: unknown, args?: unknown) => {
          const sql =
            typeof stmtOrSql === "string" ? stmtOrSql : (stmtOrSql as { sql: string }).sql;
          if (shouldThrow(sql)) throw new Error(`注入故障：${sql}`);
          return (target.execute as (a: unknown, b?: unknown) => Promise<unknown>)(stmtOrSql, args);
        }) as SqliteTransactionV2["execute"];
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

describe("sqliteGameRepositoryV2：事务原子性", () => {
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

    const current = await repo.getCurrentGame();
    expect(current.ok).toBe(true);
    if (current.ok && current.status === "active") {
      expect(current.record.revision).toBe(0);
      expect(current.record.worldState).toEqual(worldState);
      expect(current.record.storyState).toEqual(storyState);
    }
  });

  it("UPDATE 前失败（注入 UPDATE 语句异常）→ 回滚后 World/Story 均保持旧值", async () => {
    const dbPath = nextDbPath();
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");

    const seed = openRepo(dbPath);
    await seed.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    const faulty = createSqliteGameRepositoryV2({
      clientFactory: () => createFaultClient(
        createSqliteClient(dbPath),
        (sql) => /^\s*UPDATE\s+game_records_v2/i.test(sql),
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
    const current = await reader.getCurrentGame();
    expect(current.ok).toBe(true);
    if (current.ok && current.status === "active") {
      expect(current.record.revision).toBe(0);
      expect(current.record.worldState).toEqual(worldState);
      expect(current.record.storyState).toEqual(storyState);
    }
  });

  it("read-back 失败（UPDATE 成功后注入读取异常）→ 整体回滚，旧值保留", async () => {
    const dbPath = nextDbPath();
    const { worldState, storyState } = buildTestState();
    const gameId = asGameId("g1");

    const seed = openRepo(dbPath);
    await seed.createInitialGame({ gameId, worldState, storyState, createdAt: "2026-01-01" });

    const faulty = createSqliteGameRepositoryV2({
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
    const current = await reader.getCurrentGame();
    expect(current.ok).toBe(true);
    if (current.ok && current.status === "active") {
      expect(current.record.revision).toBe(0);
      expect(current.record.worldState).toEqual(worldState);
      expect(current.record.storyState).toEqual(storyState);
    }
  });
});

describe("sqliteGameRepositoryV2：stale 后旧值保留", () => {
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

    const current = await repo.getCurrentGame();
    expect(current.ok).toBe(true);
    if (current.ok && current.status === "active") {
      expect(current.record.revision).toBe(0);
      expect(current.record.storyState.tension).toBe(storyState.tension);
      expect(current.record.worldState).toEqual(worldState);
    }
  });
});
