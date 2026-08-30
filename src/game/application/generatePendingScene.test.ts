import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect, vi } from "vitest";
import { generatePendingScene } from "./generatePendingScene";
import { createInitialWorldState, type LocationEntry, type NpcEntry, type WorldFactEntry, type WorldState } from "@/game/domain/worldState";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { asFactId, asItemId, asLocationId, asNpcId, asGenerationId, type GenerationMetadata } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId, type GameEvent } from "@/game/domain/events";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import {
  createWorldStateFixtureWith,
  type WorldStateFixtureOverrides,
} from "@/game/domain/testing/worldStateFixture.testutil";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { SceneSource, SceneSourceResult, ScenePerformanceProposal } from "./sceneSource";
import type { WorldEvolutionSource } from "./worldEvolutionSource";
import type { NarrativeEventKind } from "@/game/domain/narrative";
import type { ResolvedEvent, ResolvedEventStatus } from "@/game/domain/resolvedEvent";
import { ATMOSPHERE_BEAT_ID } from "./approveAndWriteScene";
import { createDeterministicEvolutionSource } from "./deterministicEvolutionSource";

const IMPORTANT_ACTION_ID = "act_persist";
const IMPORTANT_JOB_ID = "job_persist";

const loc: LocationEntry = {
  id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
  connectedLocationIds: [], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
};
const npc: NpcEntry = {
  id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
  locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
  memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
};

// 通用生成夹具保留一个真实可探索钩子，使 talk + explore 都是规则合法候选。
const counterFact: WorldFactEntry = {
  factId: asFactId("fact_1"),
  text: "柜台下藏着一张旧纸条。",
  source: "generated",
  discovered: false,
  locationId: asLocationId("loc_1"),
};

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia",
};

const BASE_PROJECTION: EntityCompatibilityProjection = {
  player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [loc],
  currentLocationId: loc.id,
  unlockedLocationIds: [loc.id],
  visitedLocationIds: [loc.id],
  npcs: [npc],
  items: [],
  inventory: [],
  worldFacts: [counterFact],
  quests: [],
  enemies: [],
  defeatedEnemyIds: [],
  factions: [],
};

const INITIALIZED_LEDGER: readonly GameEvent[] = [{ type: "game_initialized", generation: GENERATION }];

function makeWorldState(overrides: WorldStateFixtureOverrides = {}): WorldState {
  return createWorldStateFixtureWith(
    { generation: GENERATION, base: BASE_PROJECTION },
    { eventLedger: INITIALIZED_LEDGER, ...overrides },
  );
}

type JobFixture = {
  summary: PendingNarrativeJob["actionSummary"];
  eventKind: NarrativeEventKind;
  status?: ResolvedEventStatus;
  utterance?: string;
  focusNpcId?: string;
  jobId?: string;
  actionId?: string;
  beats?: PendingNarrativeJob["mandatoryBeats"];
  facts?: ResolvedEvent["facts"];
  generationKind?: PendingNarrativeJob["generationKind"];
};

function makeJob(fixture: JobFixture): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId(fixture.jobId ?? IMPORTANT_JOB_ID),
    turnId: asTurnId("turn_1"),
    actionId: fixture.actionId ?? IMPORTANT_ACTION_ID,
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: fixture.summary,
    utterance: fixture.utterance,
    resolvedEvent: {
      actionId: fixture.actionId ?? IMPORTANT_ACTION_ID,
      status: fixture.status ?? "success",
      eventKind: fixture.eventKind,
      facts: fixture.facts ?? [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 1, toLedgerIndexExclusive: 2 },
    focusNpcId: fixture.focusNpcId !== undefined ? asNpcId(fixture.focusNpcId) : undefined,
    requestedAt: "2026-01-02",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: fixture.beats ?? [],
    generationKind: fixture.generationKind ?? "npc_fixed_choice",
    sceneRequestKind: "npc_response",
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

function makeGameRecord(option:
  | { kind: "pending"; job: PendingNarrativeJob }
  | { kind: "idle" },
): GameRecord {
  const base = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } });
  let ss: StoryState;
  if (option.kind === "pending") {
    ss = {
      ...base,
      narrative: {
        status: "provider_pending",
        mode: base.narrative.mode,
        job: option.job,
        lastPresentedScene: null,
      },
    };
  } else {
    ss = base;
  }
  return {
    gameId: "g1" as never,
    worldState: makeWorldState(),
    storyState: ss,
    revision: 7,
    createdAt: "2026-01-01",
  };
}

function makeMockRepo(record: GameRecord | null): GameRepository {
  let currentRecord = record;
  return {
    createInitialGame: vi.fn(),
    replaceCurrentGame: vi.fn(),
    getCurrentGame: vi.fn(async () => {
      if (currentRecord === null) return { ok: true as const, status: "none" as const };
      return { ok: true as const, status: "active" as const, record: currentRecord };
    }),
    applyState: vi.fn(async (input) => {
      if (currentRecord === null) return { ok: false as const, code: "NO_ACTIVE_GAME" as const };
      currentRecord = {
        ...currentRecord,
        worldState: input.nextWorldState,
        storyState: input.nextStoryState,
        revision: input.incrementRevision === false ? currentRecord.revision : currentRecord.revision + 1,
      };
      return { ok: true as const, record: currentRecord };
    }),
    applySceneWriteBack: vi.fn(async () => {
      if (currentRecord === null) return { ok: false as const, code: "NO_ACTIVE_GAME" as const };
      return { ok: true as const, record: currentRecord };
    }),
    clearCurrentGame: vi.fn(async () => ({ ok: true as const })),
  };
}

function makeSpySceneSource(sourceKind: ScenePerformanceProposal["source"] = "fixture"): { source: SceneSource; contexts: () => readonly SceneGenerationContext[] } {
  const seen: SceneGenerationContext[] = [];
  const sceneSource: SceneSource = {
    async generateScene(context: SceneGenerationContext): Promise<SceneSourceResult> {
      seen.push(context);
      const proposal: ScenePerformanceProposal = {
        sceneId: `scene-${context.job.jobId}`,
        segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "dummy" }],
        npcLine: null,
        objectiveLink: null,
        choices: [
          { candidateId: "candidate_1", label: "a" },
          { candidateId: "candidate_2", label: "b" },
        ],
        preparedContinuations: [],
        source: sourceKind,
      };
      return { ok: true, proposal };
    },
  };
  return { source: sceneSource, contexts: () => seen };
}

function failingSceneSource(): SceneSource {
  return {
    async generateScene(): Promise<SceneSourceResult> {
      throw new Error("ai down");
    },
  };
}

function makeDeps(record: GameRecord | null, source: SceneSource) {
  return {
    repository: makeMockRepo(record),
    sceneSource: source,
    now: () => "2026-01-02",
  };
}

describe("generatePendingScene", () => {
  it("returns not_pending when generation is idle", async () => {
    const record = makeGameRecord({ kind: "idle" });
    const spy = makeSpySceneSource();
    const result = await generatePendingScene(makeDeps(record, spy.source));
    expect(result).toBe("not_pending");
    expect(spy.contexts()).toHaveLength(0);
  });

  it("returns unavailable when no active game", async () => {
    const spy = makeSpySceneSource();
    const result = await generatePendingScene(makeDeps(null, spy.source));
    expect(result).toBe("unavailable");
  });

  it("rejects a forged non-whitelist job before calling scene or world providers", async () => {
    const validJob = makeJob({ summary: { kind: "explore" }, eventKind: "observe" });
    const forgedJob = {
      ...validJob,
      generationKind: "prepared_action",
    } as unknown as PendingNarrativeJob;
    const record = makeGameRecord({ kind: "pending", job: forgedJob });
    const scene = makeSpySceneSource();
    const propose = vi.fn();
    const repository = makeMockRepo(record);
    const result = await generatePendingScene({
      repository,
      sceneSource: scene.source,
      worldEvolutionSource: { propose } as unknown as WorldEvolutionSource,
      now: () => "2026-01-02",
    });

    expect(result).toBe("failed");
    expect(scene.contexts()).toHaveLength(0);
    expect(propose).not.toHaveBeenCalled();
    const latest = await repository.getCurrentGame();
    expect(latest.ok && latest.status === "active" ? latest.record.storyState.narrative.status : "ready").toBe("provider_failed");
  });

  it("persists failed when the scene source fails", async () => {
    const record = makeGameRecord({
      kind: "pending",
      job: makeJob({ summary: { kind: "explore" }, eventKind: "observe" }),
    });
    const deps = makeDeps(record, failingSceneSource());
    const result = await generatePendingScene(deps);
    expect(result).toBe("failed");
    const latest = await deps.repository.getCurrentGame();
    expect(latest.ok && latest.status === "active" ? latest.record.storyState.narrative.status : "ready").toBe("provider_failed");
  });

  it("hands the real persisted job to the source and writes back to idle", async () => {
    const record = makeGameRecord({
      kind: "pending",
      job: makeJob({ summary: { kind: "explore" }, eventKind: "observe" }),
    });
    const spy = makeSpySceneSource();
    const deps = makeDeps(record, spy.source);
    const result = await generatePendingScene(deps);
    expect(result).toBe("saved");
    expect(deps.repository.applySceneWriteBack).toHaveBeenCalledOnce();
    const input = vi.mocked(deps.repository.applySceneWriteBack).mock.calls[0]![0];
    expect(input.nextStoryState.narrative.status).toBe("ready");
    if (input.nextStoryState.narrative.status !== "ready") return;
    expect(JSON.stringify(input.nextStoryState.narrative.currentScene)).not.toContain("actionKey");
    expect(input.nextStoryState.narrative.choiceRegistry).toHaveLength(2);
    expect(new Set(input.nextStoryState.narrative.choiceRegistry.map((x) => x.choiceToken)).size).toBe(2);
    expect(input.nextStoryState.narrative.choiceRegistry.every((x) => x.basedOnRevision === 8)).toBe(true);
    const context = spy.contexts()[0];
    expect(context.job.jobId).toBe(IMPORTANT_JOB_ID);
    expect(context.job.actionId).toBe(IMPORTANT_ACTION_ID);
  });

  it("从失败 job 恢复时把上次稳定原因带入首个内容修复请求", async () => {
    const baseRecord = makeGameRecord({
      kind: "pending",
      job: makeJob({ summary: { kind: "explore" }, eventKind: "observe" }),
    });
    if (baseRecord.storyState.narrative.status !== "provider_pending") throw new Error("pending fixture missing");
    const record: GameRecord = {
      ...baseRecord,
      storyState: {
        ...baseRecord.storyState,
        narrative: {
          ...baseRecord.storyState.narrative,
          retryContext: { attempt: 1, reason: "segment_unknown_beat" },
        },
      },
    };
    const spy = makeSpySceneSource();
    const result = await generatePendingScene({
      ...makeDeps(record, spy.source),
      auditLink: { traceId: "trace-retry" },
    });

    expect(result).toBe("saved");
    expect(spy.contexts()[0]?.repairAttempt).toEqual({ attempt: 1, reason: "segment_unknown_beat" });
    expect(spy.contexts()[0]?.auditLink?.retry).toEqual({
      origin: "normal",
      mechanism: "content_repair",
      attempt: 1,
      reason: "segment_unknown_beat",
    });
  });

  it("materializes reachable content before scene generation when fewer than two choices exist", async () => {
    const isolatedLocation: LocationEntry = {
      ...loc,
      npcIds: [],
      connectedLocationIds: [],
    };
    const isolatedWorld = createInitialWorldState({
      generation: { generationId: asGenerationId("g-shortage"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: isolatedLocation,
      startingItemIds: [],
    });
    const record: GameRecord = {
      ...makeGameRecord({
        kind: "pending",
        job: makeJob({ summary: { kind: "explore" }, eventKind: "observe" }),
      }),
      worldState: isolatedWorld,
      storyState: {
        ...createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
        narrative: {
          status: "provider_pending",
          mode: "ai",
          job: makeJob({ summary: { kind: "explore" }, eventKind: "observe" }),
          lastPresentedScene: null,
        },
      },
    };
    const spy = makeSpySceneSource();
    const repo = makeMockRepo(record);

    const result = await generatePendingScene({
      repository: repo,
      sceneSource: spy.source,
      worldEvolutionSource: createDeterministicEvolutionSource(),
      now: () => "2026-01-02",
    });

    expect(result).toBe("saved");
    expect(spy.contexts()[0]!.legalActionCandidates.length).toBeGreaterThanOrEqual(2);
    const writeBack = vi.mocked(repo.applySceneWriteBack).mock.calls[0]![0];
    expect(writeBack.nextWorldState.npcs.length + writeBack.nextWorldState.locations.length).toBeGreaterThan(1);
    expect(writeBack.nextWorldState.items).toHaveLength(1);
  });

  it("move job: uses the injected source when no generated queue entry exists", async () => {
    const record = makeGameRecord({
      kind: "pending",
      job: makeJob({ summary: { kind: "move", locationId: asLocationId("loc_1") }, eventKind: "travel" }),
    });
    const spy = makeSpySceneSource();
    const deps = makeDeps(record, spy.source);
    const result = await generatePendingScene(deps);
    expect(result).toBe("saved");
    expect(spy.contexts()).toHaveLength(1);
    const writeBack = vi.mocked(deps.repository.applySceneWriteBack).mock.calls[0]![0];
    expect(writeBack.nextStoryState.narrative.status).toBe("ready");
    if (writeBack.nextStoryState.narrative.status !== "ready") return;
    expect(writeBack.nextStoryState.narrative.currentScene.event?.kind).toBe("travel");
    expect(writeBack.nextStoryState.narrative.currentScene.source).toBe("fixture");
  });

  it("take_item job: uses the injected source when no generated queue entry exists", async () => {
    const record = makeGameRecord({
      kind: "pending",
      job: makeJob({ summary: { kind: "take_item", itemId: asItemId("item_1") }, eventKind: "item" }),
    });
    const spy = makeSpySceneSource();
    const deps = makeDeps(record, spy.source);
    const result = await generatePendingScene(deps);

    expect(result).toBe("saved");
    expect(spy.contexts()).toHaveLength(1);
    const writeBack = vi.mocked(deps.repository.applySceneWriteBack).mock.calls[0]![0];
    expect(writeBack.nextStoryState.narrative.status).toBe("ready");
    if (writeBack.nextStoryState.narrative.status !== "ready") return;
    expect(writeBack.nextStoryState.narrative.currentScene.source).toBe("fixture");
  });

  it("does not rewrite partial_success/failure/blocked: the source sees the real status", async () => {
    for (const status of ["partial_success", "failure", "blocked"] as const) {
      const record = makeGameRecord({
        kind: "pending",
        job: makeJob({ summary: { kind: "talk", npcId: asNpcId("npc_1") }, eventKind: "dialogue", status }),
      });
      const spy = makeSpySceneSource();
      const result = await generatePendingScene(makeDeps(record, spy.source));
      expect(result).toBe("saved");
      expect(spy.contexts()[0].job.resolvedEvent.status).toBe(status);
    }
  });

  it("talk job: utterance and focusNpcId survive on the context.job", async () => {
    const utterance = "请问关于失踪的商队有什么线索吗？";
    const record = makeGameRecord({
      kind: "pending",
      job: makeJob({
        summary: { kind: "talk", npcId: asNpcId("npc_1") },
        eventKind: "dialogue",
        utterance,
        focusNpcId: "npc_1",
      }),
    });
    const spy = makeSpySceneSource();
    const result = await generatePendingScene(makeDeps(record, spy.source));
    expect(result).toBe("saved");
    expect(spy.contexts()[0].job.utterance).toBe(utterance);
    expect(String(spy.contexts()[0].job.focusNpcId)).toBe("npc_1");
  });

  it("process restart: re-hydrating the record from the same JSON rebuilds an identical source context", async () => {
    const job = makeJob({ summary: { kind: "explore" }, eventKind: "observe" });
    const recordJson = JSON.stringify(makeGameRecord({ kind: "pending", job }));

    const run = async () => {
      const hydrated = JSON.parse(recordJson) as GameRecord;
      const spy = makeSpySceneSource();
      const result = await generatePendingScene(makeDeps(hydrated, spy.source));
      expect(result).toBe("saved");
      return spy.contexts();
    };

    const first = await run();
    const second = await run();
    expect(first).toEqual(second);
  });

  // ── Task 6：缺强制节拍 / 未应答 → 整场回退确定性源（同一审批） ──────────

  function utteranceRecord(): GameRecord {
    const job = makeJob({
      summary: { kind: "talk", npcId: asNpcId("npc_1") },
      eventKind: "dialogue",
      utterance: "商队失踪的事你知道吗？",
      focusNpcId: "npc_1",
      beats: [
        { beatId: "player_utterance", kind: "player_utterance", subjectIds: ["npc_1"], instruction: "直接回应" },
        { beatId: ATMOSPHERE_BEAT_ID, kind: "atmosphere", subjectIds: [], instruction: "氛围" },
      ],
    });
    return makeGameRecord({ kind: "pending", job });
  }

  it("stub 提案缺强制 player_utterance 节拍 → 持久化失败，不生成 deterministic 场景", async () => {
    const record = utteranceRecord();
    const repo = makeMockRepo(record);
    // stub 源只给 atmosphere 段、无台词 → 缺强制节拍 → 审批拒绝 → 确定性 fallback
    const stub: SceneSource = {
      async generateScene(): Promise<SceneSourceResult> {
        return { ok: true, proposal: {
          sceneId: "scene-stub",
          segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "dummy" }],
          npcLine: null,
          objectiveLink: null,
          choices: [
            { candidateId: "candidate_1", label: "a" },
            { candidateId: "candidate_2", label: "b" },
          ],
          preparedContinuations: [],
          source: "generated",
        } };
      },
    };
    const result = await generatePendingScene({ repository: repo, sceneSource: stub, now: () => "2026-01-02" });
    expect(result).toBe("failed");
    expect(vi.mocked(repo.applySceneWriteBack)).not.toHaveBeenCalled();
  });

  it("真实 AI 形状的提案被审批拒绝时先修复重试，成功后保持 generated", async () => {
    const record = utteranceRecord();
    const repo = makeMockRepo(record);
    const logger = { warn: vi.fn() };
    let calls = 0;
    const seenContexts: SceneGenerationContext[] = [];
    const invalidGenerated: SceneSource = {
      async generateScene(context): Promise<SceneSourceResult> {
        calls += 1;
        seenContexts.push(context);
        if (calls === 2) {
          expect(context.repairAttempt).toEqual({ attempt: 1, reason: "approval:missing_mandatory_beat" });
          return { ok: true, proposal: {
            sceneId: "scene-repaired-generated",
            segments: [
              { beatId: "player_utterance", text: "你把疑问问得很直白。" },
              { beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" },
            ],
            npcLine: {
              npcId: "npc_1",
              text: "这件事我也正想说。你先把手里的线索交给我核对。",
              emotion: "warm",
              answeredBeatIds: ["player_utterance"],
              usedFactIds: [],
              usedInteractionActionIds: [],
            },
            objectiveLink: null,
            choices: [
              { candidateId: "candidate_1", label: "请把线索交代清楚" },
              { candidateId: "candidate_2", label: "先观察现场" },
            ],
            preparedContinuations: [],
            source: "generated",
          } };
        }
        return { ok: true, proposal: {
          sceneId: "scene-invalid-generated",
          segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
          npcLine: null,
          objectiveLink: null,
          choices: [
            { candidateId: "candidate_1", label: "支持" },
            { candidateId: "candidate_2", label: "观察" },
          ],
          preparedContinuations: [],
          source: "generated",
        } };
      },
    };

    const result = await generatePendingScene({
      repository: repo,
      sceneSource: invalidGenerated,
      logger: logger as never,
      now: () => "2026-01-02",
    });

    expect(result).toBe("saved");
    expect(calls).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith("scene_generation_rejected", { code: "missing_mandatory_beat" });
    expect(logger.warn).toHaveBeenCalledWith("scene_generation_content_retry", {
      reason: "approval:missing_mandatory_beat",
      attempt: 1,
    });
    expect(seenContexts[1]?.auditLink?.retry).toEqual({
      origin: "normal",
      mechanism: "content_repair",
      attempt: 1,
      reason: "approval:missing_mandatory_beat",
    });
    const input = vi.mocked(repo.applySceneWriteBack).mock.calls[0]![0];
    expect(input.nextStoryState.narrative.status).toBe("ready");
    if (input.nextStoryState.narrative.status !== "ready") return;
    expect(input.nextStoryState.narrative.currentScene.source).toBe("generated");
  });

  it("stub 提案正确应答 player_utterance 节拍 → 直接采纳（不触发 fallback）", async () => {
    const record = utteranceRecord();
    const repo = makeMockRepo(record);
    const answering: SceneSource = {
      async generateScene(): Promise<SceneSourceResult> {
        return { ok: true, proposal: {
          sceneId: "scene-answer",
          segments: [
            { beatId: "player_utterance", text: "你提出了你的疑问。" },
            { beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" },
          ],
          npcLine: { npcId: "npc_1", text: "这件事我也正想说。你先把手里的线索交给我核对。", emotion: "warm", answeredBeatIds: ["player_utterance"], usedFactIds: [], usedInteractionActionIds: [] },
          objectiveLink: null,
          choices: [
            { candidateId: "candidate_1", label: "支持" },
            { candidateId: "candidate_2", label: "质疑" },
          ],
          preparedContinuations: [],
          source: "generated",
        } };
      },
    };
    const result = await generatePendingScene({ repository: repo, sceneSource: answering, now: () => "2026-01-02" });
    expect(result).toBe("saved");
    const input = vi.mocked(repo.applySceneWriteBack).mock.calls[0]![0];
    expect(input.nextStoryState.narrative.status).toBe("ready");
    if (input.nextStoryState.narrative.status !== "ready") return;
    expect(input.nextStoryState.narrative.currentScene.npcLine?.text).toBe("这件事我也正想说。你先把手里的线索交给我核对。");
    expect(input.nextStoryState.narrative.currentScene.source).toBe("generated");
  });

});
