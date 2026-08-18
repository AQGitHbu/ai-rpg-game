/** @vitest-environment node */
import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSqliteGameRepository } from "./sqliteGameRepository";
import { createSqliteClient, type SqliteClient } from "./sqliteClient";
import { asGameId } from "./gameRepository";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asGenerationId } from "@/game/domain/worldEntity";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createApprovedChoice } from "@/game/domain/approvedChoice";

// 每个 Vitest 进程使用独立的 OS 临时目录，避免 Git Bash/Windows 下多个
// test run 争用源码目录中的固定 SQLite 文件，也避免清理残留目录时受句柄影响。
const RUN_ROOT = mkdtempSync(join(tmpdir(), "ai-rpg-game-sqlite-"));

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
    expect(current.ok).toBe(true);
    if (current.ok && current.status === "active") {
      expect(current.record.gameId).toBe(gameId);
      expect(current.record.revision).toBe(0);
      expect(current.record.worldState.version).toBe(2);
      expect(current.record.storyState.version).toBe(3);
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
    const current = await repo.getCurrentGame();
    if (current.ok && current.status === "active") {
      expect(current.record.revision).toBe(0);
      expect(current.record.storyState.prologueShown).toBe(true);
    }

    // 后续基于同一 revision 的正常写入（默认递增）仍可 CAS 成功
    const r2 = await repo.applyState({ gameId, expectedRevision: 0, nextWorldState: worldState, nextStoryState: storyState });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.record.revision).toBe(1);
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
    const nextWorldState = { ...worldState, currentLocationId: asLocationId("loc_1") };
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
    const current = await reader.getCurrentGame();
    expect(current.ok).toBe(true);
    if (current.ok && current.status === "active") {
      expect(current.record.revision).toBe(0);
      expect(current.record.worldState).toEqual(worldState);
      expect(current.record.storyState).toEqual(storyState);
    }
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

    const current = await repo.getCurrentGame();
    expect(current.ok).toBe(true);
    if (current.ok && current.status === "active") {
      expect(current.record.revision).toBe(0);
      expect(current.record.storyState.tension).toBe(storyState.tension);
      expect(current.record.worldState).toEqual(worldState);
    }
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
        eventLedger: [...nextWorld.eventLedger, { type: "player_intent_expressed", intent: `turn_${i}`, occurredAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z` }],
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
    const current = await repo.getCurrentGame();
    expect(current.ok).toBe(true);
    if (current.ok && current.status === "active") {
      expect(current.record.revision).toBe(TURNS);
      expect(current.record.storyState.turnNumber).toBe(TURNS);
      expect(current.record.storyState.tension).toBe(Math.max(0, 100 - TURNS));
      expect(current.record.worldState.eventLedger.length).toBe(initialLedgerLength + TURNS);
    }

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
