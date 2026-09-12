// SQLite NarrativeJobRepository（Plan 2026-09-09 / Task 7）。
//
// 同一 SQLite 实例实现 job 持久化与游戏发布：publish 在同一 write
// transaction 内写游戏状态并把 job 标记 published。lease 30 秒 TTL 由调用方
// 给定；renew 验证相同 owner/fence（TTL 过期不否决续租，接管递增 fence 后
// 才会 LEASE_LOST）。worker 写入同时验证 lease 三元组、version、status
// 与当前周期。

/** @vitest-environment node */
import { createStagedHarness } from "../../testing/stagedNarrativeHarness.testutil";
import { runJob } from "../../narrativeGeneration/runJob";
import { startLeaseKeeper } from "../../narrativeGeneration/leaseKeeper";
import { describe, it, expect, afterAll, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSqliteNarrativeJobs } from "./sqliteNarrativeJobs";
import { createSqliteGameRepository } from "./sqliteGameRepository";
import { createSqliteClient, type SqliteClient } from "./sqliteClient";
import { asGameId } from "./gameRepository";
import type { StoredJob, NarrativeJobRepository } from "./narrativeJobRepository";
import {
  createWorldStateFixtureWith,
  emptyProjection,
} from "@/game/domain/testing/worldStateFixture.testutil";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { asGenerationId, asLocationId, asNpcId, type GenerationMetadata } from "@/game/domain/worldEntity";
import { asEventId, asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { makeStagedPlan, makeNarrationOutput, FIXTURE_NARRATION_UNIT } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import type { PlanningContext } from "@/game/application/narrativeGeneration/stageSource";
import { parsePlanProposal } from "@/game/domain/narrativePlan";

const RUN_ROOT = mkdtempSync(join(tmpdir(), "ai-rpg-game-narrative-jobs-"));

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("gen_jobs"), seed: "jobs-seed", templateVersion: "v2",
  inputDigest: "", gameType: "wuxia",
};

const PROJECTION: EntityCompatibilityProjection = emptyProjection({
  player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [{
    id: asLocationId("loc_1"), name: "t", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  }],
  currentLocationId: asLocationId("loc_1"),
});

function fixtureWorld(): WorldState {
  return createWorldStateFixtureWith({ generation: GENERATION, base: PROJECTION });
}

function fixtureStory(): StoryState {
  return createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 },
  });
}

function fixturePendingJob(jobId = "job-1") {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId(jobId),
    turnId: asTurnId("turn-1"),
    actionId: "action-1",
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: { kind: "talk", npcId: asNpcId("npc_1") },
    resolvedEvent: {
      actionId: "action-1",
      status: "success",
      eventKind: "observe",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventIds: [asEventId("turn-1:event-1")],
    focusNpcId: asNpcId("npc_1"),
    requestedAt: "2026-09-09T08:00:00.000Z",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
    generationKind: "npc_fixed_choice",
    sceneRequestKind: "npc_response",
  });
  if (!result.ok) throw new Error("fixture pending job 构造失败");
  return result.job;
}

let jobCounter = 0;
function decisionJob(overrides: Partial<StoredJob> = {}): StoredJob {
  jobCounter += 1;
  const planningInput: PlanningContext = {
    kind: "decision",
    world: fixtureWorld(),
    story: fixtureStory(),
    job: fixturePendingJob(`pending-${jobCounter}`),
  };
  return {
    schemaVersion: 1,
    id: `job-${jobCounter}`,
    scope: "decision",
    version: 0,
    cycle: 0,
    status: "pending",
    input: planningInput,
    inputDigest: `digest-${jobCounter}`,
    baseRevision: 0,
    gameId: "game-1",
    units: [],
    usedRequests: 0,
    baselineRequests: 1,
    deadline: "2026-09-09T08:10:00.000Z",
    failureCode: null,
    initialization: null,
    ...overrides,
  };
}

let fileCounter = 0;
function nextDbPath(): string {
  fileCounter += 1;
  return join(RUN_ROOT, `case-${fileCounter}.sqlite`);
}

const openedJobs: (NarrativeJobRepository & { close(): Promise<void> })[] = [];
const openedGames: ReturnType<typeof createSqliteGameRepository>[] = [];
const rawClients: SqliteClient[] = [];

function openStores(databasePath: string): {
  jobs: ReturnType<typeof createSqliteNarrativeJobs>;
  games: ReturnType<typeof createSqliteGameRepository>;
} {
  const client = createSqliteClient(databasePath);
  rawClients.push(client);
  const jobs = createSqliteNarrativeJobs({ client, logError: () => {} });
  const games = createSqliteGameRepository({ clientFactory: () => client, logError: () => {} });
  openedJobs.push(jobs);
  openedGames.push(games);
  return { jobs, games };
}

afterAll(async () => {
  for (const repo of openedJobs) {
    try { await repo.close(); } catch { /* ignore */ }
  }
  for (const repo of openedGames) {
    try { await repo.close(); } catch { /* ignore */ }
  }
  for (const client of rawClients) {
    try { await client.close(); } catch { /* ignore */ }
  }
  try { rmSync(RUN_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

const OWNER_A = "worker-a";
const OWNER_B = "worker-b";
const NOW = "2026-09-09T08:00:00.000Z";
const EXPIRES = "2026-09-09T08:00:30.000Z";

it("一致性审核在途重开SQLite保留charge，有界重审；显式retry清新周期凭据", async () => {
  const h = createStagedHarness();
  await h.startDecision();
  const ready = await h.run();
  if (!ready.ok) throw Error(ready.code);
  const path = nextDbPath();
  const first = openStores(path);
  const job = { ...ready.value, version: 0, dialogueConsistencyReview: {
    ...ready.value.dialogueConsistencyReview!, status: "running" as const, passDigest: undefined,
  } };
  expect((await first.jobs.start({ job, requestId: "review-running", digest: job.inputDigest })).ok).toBe(true);
  await first.jobs.close();
  const second = openStores(path);
  expect(await second.jobs.get(job.id)).toMatchObject({ ok: true, value: {
    usedRequests: job.usedRequests, dialogueConsistencyReview: { attempts: 1, status: "running" } } });
  const claim = await second.jobs.claim({ id: job.id, owner: OWNER_A, now: NOW, expiresAt: EXPIRES });
  if (!claim.ok) throw Error(claim.code);
  const review = vi.fn(async () => ({ ok: true as const, verdict: "pass" as const, failedIds: [] }));
  h.source.reviewDialogueConsistency = review;
  const resumed = await runJob({ id: job.id, lease: claim.value }, { jobs: second.jobs, source: h.source,
    now: () => NOW, signal: new AbortController().signal });
  expect(resumed).toMatchObject({ ok: true, value: { usedRequests: job.usedRequests + 1,
    dialogueConsistencyReview: { attempts: 2, status: "approved" } } });
  expect(review).toHaveBeenCalledTimes(1);
  if (!resumed.ok) throw Error(resumed.code);
  // Re-read through SQLite's parsers; object-key normalization must not invalidate either receipt.
  const beforeExpressions = h.calls.length;
  const reused = await runJob({ id: job.id, lease: claim.value }, { jobs: second.jobs, source: h.source,
    now: () => NOW, signal: new AbortController().signal });
  expect(reused).toMatchObject({ ok: true, value: { usedRequests: resumed.value.usedRequests } });
  expect(h.calls).toHaveLength(beforeExpressions);
  expect(review).toHaveBeenCalledTimes(1);
  const failed = await second.jobs.save({ lease: claim.value, expectedVersion: resumed.value.version,
    job: { ...resumed.value, status: "failed" } });
  if (!failed.ok) throw Error(failed.code);
  const retried = await second.jobs.control({ id: job.id, operation: "retry", expectedVersion: failed.value.version,
    expectedCycle: 0, now: NOW });
  expect(retried).toMatchObject({ ok: true, value: { cycle: 1, usedRequests: 0 } });
  if (retried.ok) expect(retried.value.dialogueConsistencyReview).toBeUndefined();
});

it.each([undefined, { version: 1, cycle: 0, inputDigest: "a".repeat(64), attempts: 3, status: "running" },
  { version: 1, cycle: 0, inputDigest: "a".repeat(64), attempts: 1, status: "running", privateText: "hidden" },
])("旧字段可选，新字段非法时SQLite读取拒绝：%j", async review => {
  const stores = openStores(nextDbPath());
  const job = decisionJob();
  const started = await stores.jobs.start({ job: { ...job, dialogueConsistencyReview: review as never }, requestId: `req-${job.id}`, digest: job.inputDigest });
  expect(started.ok).toBe(true);
  const loaded = await stores.jobs.get(job.id);
  expect(loaded).toMatchObject(review === undefined ? { ok: true } : { ok: false, code: "UNSUPPORTED_JOB" });
});

it.each(["missing", "text", "stale", "draft", "metadata"])("publish事务根据持久化内容重算审核门禁，拒绝%s且游戏零写入", async change => {
  const h = createStagedHarness();
  await h.startDecision();
  const ready = await h.run();
  if (!ready.ok) throw Error(ready.code);
  const { jobs, games } = openStores(nextDbPath());
  const created = await games.createInitialGame({ gameId: asGameId("game-1"), worldState: fixtureWorld(), storyState: fixtureStory(), createdAt: NOW });
  expect(created.ok).toBe(true);
  const job: StoredJob = { ...ready.value, version: 0, gameId: "game-1",
    dialogueConsistencyReview: change === "missing" ? undefined : { ...ready.value.dialogueConsistencyReview!,
      ...(change === "stale" ? { cycle: 99 } : {}) },
    units: ready.value.units.map(u => change === "metadata" && u.value !== null && "stage" in u.value && u.value.stage === "character"
      ? { ...u, value: { ...u.value, emotion: u.value.emotion === "neutral" ? "warm" : "neutral" } }
      : change === "draft" && u.value !== null && "units" in u.value
      ? { ...u, value: { ...u.value, units: u.value.units.map(unit => unit.draft?.stage === "character" ? { ...unit, draft: { ...unit.draft, parts: unit.draft.parts.map(part => ({ ...part, text: part.text + "啊" })) } } : unit) } }
      : u.value !== null && "stage" in u.value && u.value.stage === "choices" && change === "text"
      ? { ...u, value: { ...u.value, labels: u.value.labels.map((l, i) => i === 0 ? { ...l, label: l.label + "啊" } : l) } } : u),
  };
  await jobs.start({ job, requestId: "tamper", digest: job.inputDigest });
  const lease = await jobs.claim({ id: job.id, owner: OWNER_A, now: NOW, expiresAt: EXPIRES });
  if (!lease.ok) throw Error(lease.code);
  expect(await jobs.publish({ lease: lease.value, expectedVersion: 0, publication: { kind: "decision", input: {
    gameId: asGameId("game-1"), expectedRevision: 0, nextWorldState: fixtureWorld(), nextStoryState: fixtureStory(),
  } } })).toMatchObject({ ok: false, code: "JOB_CONFLICT" });
  const current = await games.getCurrentGame();
  expect(current).toMatchObject({ ok: true, status: "active", record: { revision: 0 } });
  expect(await jobs.get(job.id)).toMatchObject({ ok: true, value: { status: "pending" } });
});

async function startDecisionJob(jobs: NarrativeJobRepository, job?: StoredJob) {
  const stored = job ?? decisionJob();
  const started = await jobs.start({ requestId: `req-${stored.id}`, digest: stored.inputDigest, job: stored });
  expect(started.ok).toBe(true);
  return stored;
}

describe("sqliteNarrativeJobs", () => {
  it("95 秒请求期间另一 SQLite worker 无法接管，旧 expiresAt 保存会自动换成续租凭据", async () => {
    const database = nextDbPath();
    const first = openStores(database).jobs;
    const second = openStores(database).jobs;
    const job = await startDecisionJob(first);
    const claimed = await first.claim({ id: job.id, owner: OWNER_A, now: NOW, expiresAt: EXPIRES });
    if (!claimed.ok) throw new Error(claimed.code);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(Date.parse(NOW));
    const keeper = startLeaseKeeper({ jobs: first, lease: claimed.value, now: () => new Date().toISOString() });
    try {
      for (let index = 0; index < 19; index++) {
        await vi.advanceTimersByTimeAsync(5_000);
        const competing = await second.claim({ id: job.id, owner: OWNER_B, now: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() });
        expect(competing.ok).toBe(false);
      }
      const saved = await keeper.jobs.save({ lease: claimed.value, expectedVersion: job.version, job });
      expect(saved.ok).toBe(true);
      await keeper.stop();
      await vi.advanceTimersByTimeAsync(35_000);
      const takeover = await second.claim({ id: job.id, owner: OWNER_B, now: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() });
      expect(takeover.ok).toBe(true);
    } finally { await keeper.stop(); vi.useRealTimers(); }
  });
  it("start/get 往返；同 requestId 同 digest 返回现有 job；不同 digest 冲突", async () => {
    const { jobs } = openStores(nextDbPath());
    const stored = decisionJob();
    const started = await jobs.start({ requestId: "req-1", digest: stored.inputDigest, job: stored });
    expect(started.ok).toBe(true);
    const again = await jobs.start({ requestId: "req-1", digest: stored.inputDigest, job: stored });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.id).toBe(stored.id);
    const conflict = await jobs.start({ requestId: "req-1", digest: "other-digest", job: stored });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("JOB_CONFLICT");
    const fetched = await jobs.get(stored.id);
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(fetched.value.id).toBe(stored.id);
      expect(fetched.value.scope).toBe("decision");
      expect(fetched.value.units).toEqual([]);
    }
  });

  it("只读查询返回同 game/NPC 最近六个已发布 decision job", async () => {
    const { jobs } = openStores(nextDbPath());
    for (let revision = 1; revision <= 8; revision++) {
      const base = decisionJob();
      if (base.input.kind !== "decision") throw Error("decision");
      const stored: StoredJob = { ...base, id: `history-${revision}`, status: "published",
        gameId: "history-game", baseRevision: revision,
        input: { ...base.input, job: { ...base.input.job, focusNpcId: asNpcId("npc_history") } } };
      expect((await jobs.start({ requestId: `req-history-${revision}`, digest: stored.inputDigest, job: stored })).ok).toBe(true);
    }
    for (const [id, status, gameId, npcId] of [
      ["wrong-status", "failed", "history-game", "npc_history"],
      ["wrong-game", "published", "other-game", "npc_history"],
      ["wrong-npc", "published", "history-game", "npc_other"],
    ] as const) {
      const base = decisionJob();
      if (base.input.kind !== "decision") throw Error("decision");
      const stored: StoredJob = { ...base, id, status, gameId, baseRevision: 9,
        input: { ...base.input, job: { ...base.input.job, focusNpcId: asNpcId(npcId) } } };
      expect((await jobs.start({ requestId: `req-${id}`, digest: stored.inputDigest, job: stored })).ok).toBe(true);
    }
    const result = await jobs.getRecentDialogueJobs!({ gameId: "history-game", npcId: "npc_history", beforeRevision: 9 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map(job => job.baseRevision)).toEqual([8, 7, 6, 5, 4, 3]);
  });

  it("initialization job 必须带 envelope；decision job 的 initialization 必须为 null", async () => {
    const { jobs } = openStores(nextDbPath());
    const withoutEnvelope = decisionJob({ scope: "initialization", gameId: null, baseRevision: null });
    const rejected = await jobs.start({ requestId: "req-init-1", digest: withoutEnvelope.inputDigest, job: withoutEnvelope });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("JOB_CONFLICT");

    const withEnvelope = decisionJob({
      scope: "initialization",
      gameId: null,
      baseRevision: null,
      initialization: {
        requestId: "req-init-2",
        newGameId: "game-new",
        seed: "seed-1",
        generation: GENERATION,
        target: { kind: "create" },
      },
    });
    const okStarted = await jobs.start({ requestId: "req-init-2", digest: withEnvelope.inputDigest, job: withEnvelope });
    expect(okStarted.ok).toBe(true);

    const decisionWithEnvelope = decisionJob({
      initialization: {
        requestId: "req-init-3", newGameId: "game-x", seed: "s", generation: GENERATION,
        target: { kind: "create" },
      },
    });
    const rejectedDecision = await jobs.start({ requestId: "req-d-1", digest: decisionWithEnvelope.inputDigest, job: decisionWithEnvelope });
    expect(rejectedDecision.ok).toBe(false);
  });

  it("第二个 claimant 失败；lease 过期后接管递增 fence", async () => {
    const { jobs } = openStores(nextDbPath());
    const stored = await startDecisionJob(jobs);
    const first = await jobs.claim({ id: stored.id, owner: OWNER_A, now: NOW, expiresAt: EXPIRES });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.fence).toBe(1);
    const second = await jobs.claim({ id: stored.id, owner: OWNER_B, now: NOW, expiresAt: EXPIRES });
    expect(second.ok).toBe(false);
    // 过期后接管：fence 递增
    const takeover = await jobs.claim({
      id: stored.id, owner: OWNER_B, now: "2026-09-09T08:01:00.000Z", expiresAt: "2026-09-09T08:01:30.000Z",
    });
    expect(takeover.ok).toBe(true);
    if (takeover.ok) expect(takeover.value.fence).toBe(2);
  });

  it("renew 验证相同 owner/fence；过期但未被接管的租约可续租；stale worker save 返回 LEASE_LOST", async () => {
    const { jobs } = openStores(nextDbPath());
    const stored = await startDecisionJob(jobs);
    const lease = await jobs.claim({ id: stored.id, owner: OWNER_A, now: NOW, expiresAt: EXPIRES });
    if (!lease.ok) throw new Error("claim failed");
    const renewed = await jobs.renew({ lease: lease.value, now: NOW, expiresAt: "2026-09-09T08:00:40.000Z" });
    expect(renewed.ok).toBe(true);
    if (renewed.ok) expect(renewed.value.fence).toBe(lease.value.fence);
    // 其他 fence 的 renew 失败
    const wrongFence = await jobs.renew({
      lease: { ...lease.value, fence: 99 }, now: NOW, expiresAt: "2026-09-09T08:00:40.000Z",
    });
    expect(wrongFence.ok).toBe(false);
    if (!wrongFence.ok) expect(wrongFence.code).toBe("LEASE_LOST");
    // 接管后旧 owner 保存失败
    await jobs.claim({ id: stored.id, owner: OWNER_B, now: "2026-09-09T08:01:00.000Z", expiresAt: "2026-09-09T08:01:30.000Z" });
    const staleSave = await jobs.save({
      lease: lease.value, expectedVersion: stored.version,
      job: { ...stored, units: [{ unit: null, key: FIXTURE_NARRATION_UNIT, inputDigest: "d1", attempts: 1, status: "running", value: null }] },
    });
    expect(staleSave.ok).toBe(false);
    if (!staleSave.ok) expect(staleSave.code).toBe("LEASE_LOST");
  });

  it("renew 不否决已过期但未被接管的租约：provider 长跑跨过 TTL 后仍可续租", async () => {
    // provider 单次调用 45-90s 可超过 30s TTL；TTL 只是 claim 接管的触发条件，
    // 并发权威是 fence。持有者仍在工作且租约未被接管时必须能续租，
    // 否则长跑任务会被自己的 TTL 杀死（Medium-1 修复面）。
    const { jobs } = openStores(nextDbPath());
    const stored = await startDecisionJob(jobs);
    const lease = await jobs.claim({ id: stored.id, owner: OWNER_A, now: NOW, expiresAt: EXPIRES });
    if (!lease.ok) throw new Error("claim failed");
    // now 已越过 expiresAt，但没人接管（fence 未变）→ 续租成功。
    const renewedAfterExpiry = await jobs.renew({
      lease: lease.value,
      now: "2026-09-09T08:01:20.000Z",
      expiresAt: "2026-09-09T08:01:50.000Z",
    });
    expect(renewedAfterExpiry.ok).toBe(true);
    if (renewedAfterExpiry.ok) {
      expect(renewedAfterExpiry.value.fence).toBe(lease.value.fence);
      expect(renewedAfterExpiry.value.expiresAt).toBe("2026-09-09T08:01:50.000Z");
    }
    // 接管后（fence 递增）同一过期租约续租必须失败。
    // 接管 claim 的 now 必须晚于续租后的 expiresAt（08:01:50），否则撞活跃租约。
    await jobs.claim({ id: stored.id, owner: OWNER_B, now: "2026-09-09T08:02:00.000Z", expiresAt: "2026-09-09T08:02:30.000Z" });
    const renewedAfterTakeover = await jobs.renew({
      lease: lease.value,
      now: "2026-09-09T08:02:10.000Z",
      expiresAt: "2026-09-09T08:02:40.000Z",
    });
    expect(renewedAfterTakeover.ok).toBe(false);
    if (!renewedAfterTakeover.ok) expect(renewedAfterTakeover.code).toBe("LEASE_LOST");
  });

  it("临时库 reopen 后 approved 单元保留；版本随 save 递增", async () => {
    const path = nextDbPath();
    const first = openStores(path);
    const stored = await startDecisionJob(first.jobs);
    const lease = await first.jobs.claim({ id: stored.id, owner: OWNER_A, now: NOW, expiresAt: EXPIRES });
    if (!lease.ok) throw new Error("claim failed");
    const parsedPlan = parsePlanProposal(makeStagedPlan());
    if (!parsedPlan.ok) throw new Error("fixture plan parse failed");
    const approvedOutput = makeNarrationOutput();
    const saved = await first.jobs.save({
      lease: lease.value, expectedVersion: stored.version,
      job: {
        ...stored,
        units: [
          { unit: parsedPlan.value.units[0] ?? null, key: FIXTURE_NARRATION_UNIT, inputDigest: "d1", attempts: 1, status: "approved", value: approvedOutput, disclosureReviewDigest: "a".repeat(64) },
        ],
      },
    });
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.value.version).toBe(stored.version + 1);
    await first.games.close();
    await first.jobs.close();
    // reopen：新实例同一文件
    const second = openStores(path);
    const afterReopen = await second.jobs.get(stored.id);
    expect(afterReopen.ok).toBe(true);
    if (afterReopen.ok) {
      const approved = afterReopen.value.units.filter((unit) => unit.status === "approved");
      expect(approved).toHaveLength(1);
      expect(approved[0]?.disclosureReviewDigest).toBe("a".repeat(64));
      expect(JSON.stringify(approved[0]?.value)).toContain("风从门缝");
    }
  });

  it("decision publish：CAS 成功原子更新游戏并标记 published；CAS 失败游戏不变且 job 未发布", async () => {
    const path = nextDbPath();
    const { jobs, games } = openStores(path);
    // 先建当前存档 revision 0
    const created = await games.createInitialGame({
      gameId: asGameId("game-1"),
      worldState: fixtureWorld(),
      storyState: fixtureStory(),
      createdAt: NOW,
    });
    expect(created.ok).toBe(true);
    const stored = await startDecisionJob(jobs);
    const lease = await jobs.claim({ id: stored.id, owner: OWNER_A, now: NOW, expiresAt: EXPIRES });
    if (!lease.ok) throw new Error("claim failed");
    const harness = createStagedHarness();
    await harness.startDecision();
    const ready = await harness.run();
    if (!ready.ok) throw Error(ready.code);
    const withUnits: StoredJob = { ...ready.value, id: stored.id, gameId: stored.gameId, version: stored.version };
    await jobs.save({ lease: lease.value, expectedVersion: stored.version, job: withUnits });

    const world = fixtureWorld();
    const story = fixtureStory();
    const stalePublish = await jobs.publish({
      lease: lease.value,
      expectedVersion: stored.version,
      publication: {
        kind: "decision",
        input: { gameId: asGameId("game-1"), expectedRevision: 0, nextWorldState: world, nextStoryState: story },
      },
    });
    // expectedVersion 已被 save 递增 → 冲突，游戏保持不变
    expect(stalePublish.ok).toBe(false);
    const currentBefore = await games.getCurrentGame();
    if (currentBefore.ok && currentBefore.status === "active") {
      expect(currentBefore.record.revision).toBe(0);
    }
    const notPublished = await jobs.get(stored.id);
    if (notPublished.ok) expect(notPublished.value.status).not.toBe("published");

    const publish = await jobs.publish({
      lease: lease.value,
      expectedVersion: stored.version + 1,
      publication: {
        kind: "decision",
        input: { gameId: asGameId("game-1"), expectedRevision: 0, nextWorldState: world, nextStoryState: story },
      },
    });
    expect(publish.ok).toBe(true);
    const current = await games.getCurrentGame();
    if (current.ok && current.status === "active") {
      expect(current.record.revision).toBe(1);
    }
    const publishedJob = await jobs.get(stored.id);
    if (publishedJob.ok) expect(publishedJob.value.status).toBe("published");
  });

  it("control：cancel 只接受 pending/failed；retry 只接受 failed 且递增周期", async () => {
    const { jobs } = openStores(nextDbPath());
    const stored = await startDecisionJob(jobs);
    const cancelled = await jobs.control({
      id: stored.id, expectedVersion: stored.version, expectedCycle: stored.cycle, operation: "cancel", now: NOW,
    });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error("cancel failed");
    expect(cancelled.value.status).toBe("cancelled");
    // published/cancelled 不可 retry
    const retryCancelled = await jobs.control({
      id: stored.id, expectedVersion: cancelled.value.version, expectedCycle: 0, operation: "retry", now: NOW,
    });
    expect(retryCancelled.ok).toBe(false);

    const failedJob = decisionJob();
    await jobs.start({ requestId: `req-${failedJob.id}`, digest: failedJob.inputDigest, job: { ...failedJob, status: "failed", failureCode: "unit_output_invalid" } });
    const retried = await jobs.control({
      id: failedJob.id, expectedVersion: 0, expectedCycle: 0, operation: "retry", now: NOW,
    });
    expect(retried.ok).toBe(true);
    if (retried.ok) {
      expect(retried.value.status).toBe("pending");
      expect(retried.value.cycle).toBe(1);
    }
    // 版本 CAS 不匹配返回冲突
    const conflict = await jobs.control({
      id: failedJob.id, expectedVersion: 0, expectedCycle: 1, operation: "cancel", now: NOW,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("JOB_CONFLICT");
  });

  it("同 gameId 的 pending decision job 唯一", async () => {
    const { jobs } = openStores(nextDbPath());
    await startDecisionJob(jobs, decisionJob({ gameId: "game-dup" }));
    const duplicate = decisionJob({ gameId: "game-dup" });
    const rejected = await jobs.start({ requestId: `req-${duplicate.id}`, digest: duplicate.inputDigest, job: duplicate });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("JOB_CONFLICT");
  });

  it.each(["pending", "failed"] as const)("初始化 %s 槽必须显式取消后才可替换", async status => {
    const { jobs } = openStores(nextDbPath());
    const first = decisionJob({ scope: "initialization", status, gameId: null, baseRevision: null,
      initialization: { requestId: "init-first", newGameId: "g-first", seed: "s", generation: GENERATION, target: { kind: "create" } } });
    expect((await jobs.start({ requestId: "init-first", digest: first.inputDigest, job: first })).ok).toBe(true);
    const next = decisionJob({ ...first, id: "init-next", initialization: { ...first.initialization!, requestId: "init-next" } });
    expect(await jobs.start({ requestId: "init-next", digest: next.inputDigest, job: next })).toMatchObject({ ok: false, code: "JOB_CONFLICT" });
    expect(await jobs.getInitialization()).toMatchObject({ ok: true, value: { id: first.id } });
    expect((await jobs.control({ id: first.id, operation: "cancel", expectedVersion: 0, expectedCycle: 0, now: NOW })).ok).toBe(true);
    expect((await jobs.start({ requestId: "init-next", digest: next.inputDigest, job: next })).ok).toBe(true);
  });
});

it.each([undefined, "fact_rumor"])("SQLite仍读取旧aspect-only及新factId定位的拒绝凭据：%s", async factId => {
  const stores = openStores(nextDbPath());
  const job = decisionJob();
  const violation = { scope: "expression" as const, unitKey: "character_current", type: "missing_response" as const,
    aspect: "source" as const, ...(factId === undefined ? {} : { factId }) };
  const review = { version: 1 as const, cycle: 0, inputDigest: "a".repeat(64), attempts: 1,
    status: "failed" as const, violations: [violation] };
  expect((await stores.jobs.start({ job: { ...job, dialogueConsistencyReview: review },
    requestId: `req-${job.id}`, digest: job.inputDigest })).ok).toBe(true);
  expect(await stores.jobs.get(job.id)).toMatchObject({ ok: true, value: { dialogueConsistencyReview: review } });
});

it.each([null, [], { choices_current: { version: 1, cycle: 0, inputDigest: "a".repeat(64), attempts: 3, status: "approved" } }])(
  "SQLite读取拒绝非法前置凭据，不能当作旧版已通过：%j", async planningDialogueReviews => {
    const stores = openStores(nextDbPath());
    const job = decisionJob();
    await stores.jobs.start({ job: { ...job, planningDialogueReviews: planningDialogueReviews as never },
      requestId: `planning-review-${job.id}`, digest: job.inputDigest });
    expect(await stores.jobs.get(job.id)).toMatchObject({ ok: false, code: "UNSUPPORTED_JOB" });
  });

it("SQLite reopen preserves final and planning protocol recovery counters and safe diagnostic", async () => {
  const path = nextDbPath();
  const stores = openStores(path);
  const job = decisionJob();
  const receipt = { version: 1 as const, cycle: 0, inputDigest: "a".repeat(64), attempts: 2,
    status: "failed" as const, protocolCorrections: 1, contentRepairs: 0,
    lastFailure: "protocol_error" as const,
    protocolIssue: { code: "foreign_inquiryId" as const, path: "$.violations[0].inquiryId" } };
  await stores.jobs.start({ job: { ...job, usedRequests: 4, dialogueConsistencyReview: receipt,
    planningDialogueReviews: { choices_current: receipt } }, requestId: "recovery-counters", digest: job.inputDigest });
  await stores.jobs.close();
  const reopened = openStores(path);
  expect(await reopened.jobs.get(job.id)).toMatchObject({ ok: true, value: { usedRequests: 4,
    dialogueConsistencyReview: receipt, planningDialogueReviews: { choices_current: receipt } } });
});
it.each([{ protocolCorrections: 2 }, { contentRepairs: -1 }, { protocolIssue: { code: "invalid_schema", path: "$.PRIVATE_KEY" } }])(
  "SQLite rejects corrupt recovery allowances and unsafe paths: %j", async patch => {
    const stores = openStores(nextDbPath());
    const job = decisionJob();
    const receipt = { version: 1, cycle: 0, inputDigest: "a".repeat(64), attempts: 1, status: "failed",
      protocolCorrections: 0, contentRepairs: 0, ...patch };
    await stores.jobs.start({ job: { ...job, dialogueConsistencyReview: receipt as never }, requestId: "corrupt-recovery", digest: job.inputDigest });
    expect(await stores.jobs.get(job.id)).toMatchObject({ ok: false, code: "UNSUPPORTED_JOB" });
  });
