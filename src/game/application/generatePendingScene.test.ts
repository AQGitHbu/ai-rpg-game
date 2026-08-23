import { describe, it, expect, vi } from "vitest";
import { generatePendingScene } from "./generatePendingScene";
import { createInitialWorldState, appendNpc, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { asFactId, asItemId, asLocationId, asNpcId, asGenerationId, asQuestId } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { SceneSource, SceneSourceResult, ScenePerformanceProposal } from "./sceneSource";
import type { NarrativeEventKind } from "@/game/domain/narrative";
import type { ResolvedEvent, ResolvedEventStatus } from "@/game/domain/resolvedEvent";
import { ATMOSPHERE_BEAT_ID } from "./approveAndWriteScene";
import { createDeterministicEvolutionSource } from "./deterministicEvolutionSource";
import { createDeterministicSceneSource, buildInvestigationOutcomeNarrative } from "./deterministicSceneSource";

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

function makeWorldState() {
  const base = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc,
    startingItemIds: [],
  });
  return {
    ...appendNpc(base, npc),
    // 通用生成夹具保留一个真实可探索钩子，使 talk + explore 都是规则合法候选。
    worldFacts: [{
      factId: asFactId("fact_1"),
      text: "柜台下藏着一张旧纸条。",
      source: "generated" as const,
      discovered: false,
      locationId: asLocationId("loc_1"),
    }],
  };
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
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

function makeGameRecord(option:
  | { kind: "pending"; job: PendingNarrativeJob }
  | { kind: "idle" }
  | { kind: "legacy_pending" },
): GameRecord {
  const base = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } });
  let ss: StoryState;
  if (option.kind === "pending") {
    ss = { ...base, narrative: { ...base.narrative, generation: { status: "pending", job: option.job } } };
  } else if (option.kind === "idle") {
    ss = base;
  } else {
    ss = {
      ...base,
      narrative: {
        ...base.narrative,
        generation: { status: "pending", requestedAt: "2026-01-01" } as never,
      },
    };
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

function makeSpySceneSource(sourceKind: ScenePerformanceProposal["source"] = "fallback"): { source: SceneSource; contexts: () => readonly SceneGenerationContext[] } {
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

  it("returns legacy_pending for a pending generation without a job, without calling the source", async () => {
    const record = makeGameRecord({ kind: "legacy_pending" });
    const spy = makeSpySceneSource();
    const result = await generatePendingScene(makeDeps(record, spy.source));
    expect(result).toBe("legacy_pending");
    expect(spy.contexts()).toHaveLength(0);
  });

  it("returns unavailable when no active game", async () => {
    const spy = makeSpySceneSource();
    const result = await generatePendingScene(makeDeps(null, spy.source));
    expect(result).toBe("unavailable");
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
    expect(latest.ok && latest.status === "active" ? latest.record.storyState.narrative.generation.status : "idle").toBe("failed");
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
    expect(JSON.stringify(input.nextStoryState.narrative.currentScene)).not.toContain("actionKey");
    expect(input.nextStoryState.narrative.choiceRegistry).toHaveLength(2);
    expect(new Set(input.nextStoryState.narrative.choiceRegistry!.map((x) => x.choiceToken)).size).toBe(2);
    expect(input.nextStoryState.narrative.choiceRegistry!.every((x) => x.basedOnRevision === 8)).toBe(true);
    const context = spy.contexts()[0];
    expect(context.job.jobId).toBe(IMPORTANT_JOB_ID);
    expect(context.job.actionId).toBe(IMPORTANT_ACTION_ID);
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
        ...createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
        narrative: {
          ...createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }).narrative,
          generation: {
            status: "pending",
            job: makeJob({ summary: { kind: "explore" }, eventKind: "observe" }),
          },
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
    expect(writeBack.nextStoryState.narrative.currentScene?.event?.kind).toBe("travel");
    expect(writeBack.nextStoryState.narrative.currentScene?.source).toBe("fallback");
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
    expect(writeBack.nextStoryState.narrative.currentScene?.source).toBe("fallback");
    expect(writeBack.nextStoryState.narrative.generation.status).toBe("idle");
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
    const invalidGenerated: SceneSource = {
      async generateScene(context): Promise<SceneSourceResult> {
        calls += 1;
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
    const input = vi.mocked(repo.applySceneWriteBack).mock.calls[0]![0];
    expect(input.nextStoryState.narrative.currentScene?.source).toBe("generated");
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
          source: "generated",
        } };
      },
    };
    const result = await generatePendingScene({ repository: repo, sceneSource: answering, now: () => "2026-01-02" });
    expect(result).toBe("saved");
    const input = vi.mocked(repo.applySceneWriteBack).mock.calls[0]![0];
    expect(input.nextStoryState.narrative.currentScene?.npcLine?.text).toBe("这件事我也正想说。你先把手里的线索交给我核对。");
    expect(input.nextStoryState.narrative.currentScene?.source).toBe("generated");
  });

  // ── Task 2：AI 预生成单线行动叙事的审批与持久化 ─────────────────────────

  // 权威主线目标链：调查车轮印（fact_2）→ 前往北巷旧道（loc_2）→ 与老板交谈。
  // 当前目标（discover_fact fact_2）起是连续单线前缀，context.upcomingLinearObjectives
  // 投影出 discover_fact(fact_2) 与 visit_location(loc_2)，供审批校验实体引用。
  // （若当前目标本身是 talk_to_npc 等分支点，投影为空，预生成叙事无从获批——
  //  与生产修复后“从当前目标开始投影”的语义一致。）
  function linearObjectiveRecord(): GameRecord {
    const world = makeWorldState();
    const loc2: LocationEntry = {
      id: asLocationId("loc_2"), name: "北巷旧道", description: "t", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    };
    return {
      ...makeGameRecord({
        kind: "pending",
        job: makeJob({ summary: { kind: "explore" }, eventKind: "observe" }),
      }),
      worldState: {
        ...world,
        locations: [...world.locations, loc2],
        worldFacts: [...world.worldFacts, {
          factId: asFactId("fact_2"),
          text: "车轮印在后巷泥水中断续向北延伸。",
          source: "generated" as const,
          discovered: false,
          locationId: asLocationId("loc_1"),
          investigationLabel: "酒楼后巷的车轮印",
        }],
        quests: [{
          id: asQuestId("quest_1"),
          name: "追查车轮印",
          description: "查明车轮印的去向。",
          objectives: [
            { kind: "discover_fact", factId: asFactId("fact_2") },
            { kind: "visit_location", locationId: asLocationId("loc_2") },
            { kind: "talk_to_npc", npcId: asNpcId("npc_1") },
          ],
          onSuccess: { kind: "advance_story" },
          onFailure: { kind: "closed" },
          tags: [],
          kind: "main" as const,
          stage: 1,
          status: "active" as const,
        }],
      },
    };
  }

  function linearArrivalRecord(): GameRecord {
    const record = linearObjectiveRecord();
    const ambientNpc: NpcEntry = {
      ...npc,
      id: asNpcId("npc_2"),
      name: "值夜伙计",
      locationId: asLocationId("loc_1"),
      memory: { ...npc.memory, npcId: asNpcId("npc_2") },
    };
    return {
      ...record,
      worldState: {
        ...record.worldState,
        locations: record.worldState.locations.map((location) =>
          String(location.id) === "loc_1"
            ? { ...location, npcIds: [asNpcId("npc_2")] }
            : String(location.id) === "loc_2"
              ? { ...location, npcIds: [asNpcId("npc_1")] }
            : location),
        npcs: [
          ...record.worldState.npcs.map((entry) =>
            String(entry.id) === "npc_1"
              ? { ...entry, locationId: asLocationId("loc_2") }
              : entry),
          ambientNpc,
        ],
      },
    };
  }

  it("persists approved linearActionNarratives into linearNarrativeQueue on scene write-back", async () => {
    const record = linearObjectiveRecord();
    const repo = makeMockRepo(record);
    const pregenerated: SceneSource = {
      async generateScene(): Promise<SceneSourceResult> {
        return { ok: true, proposal: {
          sceneId: "scene-pregenerated",
          segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
          npcLine: null,
          objectiveLink: { questId: "quest_1", objectiveIndex: 0, mode: "hint" },
          choices: [
            { candidateId: "candidate_1", label: "查看四周" },
            { candidateId: "candidate_2", label: "与老板交谈" },
          ],
          linearActionNarratives: [
            { actionKind: "investigate", factId: "fact_2", narration: "车轮印在后巷泥水中断续向北延伸。" },
            { actionKind: "move", locationId: "loc_2", narration: "北巷旧道就在前方，夜色掩不住那条土路。" },
          ],
          source: "generated",
        } };
      },
    };
    const result = await generatePendingScene({ repository: repo, sceneSource: pregenerated, now: () => "2026-01-02" });
    expect(result).toBe("saved");
    const input = vi.mocked(repo.applySceneWriteBack).mock.calls[0]![0];
    expect(input.nextStoryState.narrative.linearNarrativeQueue).toEqual([
      { actionKind: "investigate", factId: asFactId("fact_2"), narration: "车轮印在后巷泥水中断续向北延伸。", source: "generated" },
      { actionKind: "move", locationId: asLocationId("loc_2"), narration: "北巷旧道就在前方，夜色掩不住那条土路。", source: "generated" },
    ]);
  });

  it("persists the target NPC line together with a pre-generated move", async () => {
    const record = linearArrivalRecord();
    const repo = makeMockRepo(record);
    const pregenerated: SceneSource = {
      async generateScene(): Promise<SceneSourceResult> {
        return { ok: true, proposal: {
          sceneId: "scene-arrival-pregenerated",
          segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
          npcLine: null,
          objectiveLink: { questId: "quest_1", objectiveIndex: 0, mode: "hint" },
          choices: [
            { candidateId: "candidate_1", label: "查看四周" },
            { candidateId: "candidate_2", label: "整理线索" },
          ],
          linearActionNarratives: [{
            actionKind: "move",
            locationId: "loc_2",
            narration: "你沿着旧道赶往北巷旧道。",
            arrivalNpcLine: {
              npcId: "npc_1",
              text: "你就是来查旧镖局的人吧。镖局出事那晚，我亲眼见过一件关键的事。",
              emotion: "neutral",
              usedFactIds: [],
            },
          }],
          source: "generated",
        } };
      },
    };
    const result = await generatePendingScene({ repository: repo, sceneSource: pregenerated, now: () => "2026-01-02" });
    expect(result).toBe("saved");
    const input = vi.mocked(repo.applySceneWriteBack).mock.calls[0]![0];
    expect(input.nextStoryState.narrative.linearNarrativeQueue).toEqual([{
      actionKind: "move",
      locationId: asLocationId("loc_2"),
      narration: "你沿着旧道赶往北巷旧道。",
      source: "generated",
      arrivalNpcLine: {
        npcId: asNpcId("npc_1"),
        text: "你就是来查旧镖局的人吧。镖局出事那晚，我亲眼见过一件关键的事。",
        emotion: "neutral",
        usedFactIds: [],
      },
    }]);
  });

  it("整场 proposal 触发审批失败时不写入 deterministic fallback", async () => {
    const record = linearObjectiveRecord();
    const repo = makeMockRepo(record);
    const logger = { warn: vi.fn() };
    const sceneWithBrokenCore: SceneSource = {
      async generateScene(): Promise<SceneSourceResult> {
        return { ok: true, proposal: {
          sceneId: "scene-broken-core",
          segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
          npcLine: null,
          objectiveLink: null,
          // candidate_1 重复会触发场景核心硬拒绝，但下面两条线性叙事
          // 都命中服务端下发的事实/地点链，不能随 fallback 一起丢失。
          choices: [
            { candidateId: "candidate_1", label: "查看四周" },
            { candidateId: "candidate_1", label: "再次查看" },
          ],
          linearActionNarratives: [
            { actionKind: "investigate", factId: "fact_2", narration: "车轮印向北巷旧道延伸。" },
            { actionKind: "move", locationId: "loc_2", narration: "北巷旧道隐在夜色尽头。" },
          ],
          source: "generated",
        } };
      },
    };
    const result = await generatePendingScene({
      repository: repo,
      sceneSource: sceneWithBrokenCore,
      logger: logger as never,
      now: () => "2026-01-02",
    });
    expect(result).toBe("failed");
    expect(vi.mocked(repo.applySceneWriteBack)).not.toHaveBeenCalled();
  });

  it("drops linearActionNarratives referencing entities outside the authoritative objective chain", async () => {
    const record = linearObjectiveRecord();
    const repo = makeMockRepo(record);
    const logger = { warn: vi.fn() };
    const fabricated: SceneSource = {
      async generateScene(): Promise<SceneSourceResult> {
        return { ok: true, proposal: {
          sceneId: "scene-fabricated",
          segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" }],
          npcLine: null,
          objectiveLink: { questId: "quest_1", objectiveIndex: 0, mode: "hint" },
          choices: [
            { candidateId: "candidate_1", label: "查看四周" },
            { candidateId: "candidate_2", label: "与老板交谈" },
          ],
          // 一条合法 + 一条捏造：任意非法条目 → 整字段丢弃（不是逐条过滤）。
          linearActionNarratives: [
            { actionKind: "investigate", factId: "fact_2", narration: "车轮印在后巷泥水中断续向北延伸。" },
            { actionKind: "investigate", factId: "fact_fabricated", narration: "我凭空捏造了一个新事实。" },
          ],
          source: "generated",
        } };
      },
    };
    const result = await generatePendingScene({
      repository: repo,
      sceneSource: fabricated,
      logger: logger as never,
      now: () => "2026-01-02",
    });
    expect(result).toBe("saved");
    const input = vi.mocked(repo.applySceneWriteBack).mock.calls[0]![0];
    expect(input.nextStoryState.narrative.linearNarrativeQueue).toEqual([]);
    expect(input.nextStoryState.narrative.currentScene?.source).toBe("generated");
    expect(logger.warn).toHaveBeenCalledWith("linear_narratives_dropped", expect.anything());
  });

  // ── Task 3：investigate 纳入即时消费 fast path（含演化状态防护） ─────────

  // investigate fact_2 已结算（交谈已完成、事实已发现）→ 权威当前目标为
  // visit_location loc_2，objectiveTarget 具象化为“北巷旧道”，供消费/兜底场景引用。
  function investigateResolvedRecord(): GameRecord {
    const record = linearObjectiveRecord();
    return {
      ...record,
      worldState: {
        ...record.worldState,
        npcs: record.worldState.npcs.map((n) =>
          String(n.id) === "npc_1" ? { ...n, met: true } : n),
        worldFacts: record.worldState.worldFacts.map((f) =>
          String(f.factId) === "fact_2" ? { ...f, discovered: true } : f),
      },
    };
  }

  function investigateJob(): PendingNarrativeJob {
    return makeJob({
      summary: { kind: "investigate", factId: asFactId("fact_2") },
      eventKind: "investigate",
      facts: [{ factId: asFactId("fact_2"), change: "discovered", source: "scene_witness" }],
    });
  }

  it("resolves investigate immediately by consuming pre-generated AI narrative without remote AI call", async () => {
    const base = investigateResolvedRecord();
    const record: GameRecord = {
      ...base,
      storyState: {
        ...base.storyState,
        narrative: {
          ...base.storyState.narrative,
          generation: { status: "pending", job: investigateJob() },
          linearNarrativeQueue: [
            { actionKind: "investigate", factId: asFactId("fact_2"), narration: "车轮印在后巷泥水中断续向北延伸。", source: "generated" },
            { actionKind: "move", locationId: asLocationId("loc_2"), narration: "北巷旧道就在前方，夜色掩不住那条土路。", source: "generated" },
          ],
        },
      },
    };
    const spy = makeSpySceneSource();
    const deps = makeDeps(record, spy.source);
    const result = await generatePendingScene(deps);
    expect(result).toBe("saved");
    expect(spy.contexts()).toHaveLength(0);
    const writeBack = vi.mocked(deps.repository.applySceneWriteBack).mock.calls[0]![0];
    const scene = writeBack.nextStoryState.narrative.currentScene!;
    expect(scene.narration).toBe("车轮印在后巷泥水中断续向北延伸。");
    expect(scene.source).toBe("generated");
    expect(scene.event).toEqual({ kind: "investigate", factId: asFactId("fact_2") });
    // 消费即除：只移除精确匹配的 investigate 条目，move 条目原样保留。
    expect(writeBack.nextStoryState.narrative.linearNarrativeQueue).toEqual([
      { actionKind: "move", locationId: asLocationId("loc_2"), narration: "北巷旧道就在前方，夜色掩不住那条土路。", source: "generated" },
    ]);
  });

  it("calls the injected source when investigate queue has no matching entry", async () => {
    const base = investigateResolvedRecord();
    const record: GameRecord = {
      ...base,
      storyState: {
        ...base.storyState,
        narrative: {
          ...base.storyState.narrative,
          generation: {
            status: "pending",
            job: makeJob({
              summary: { kind: "investigate", factId: asFactId("fact_2") },
              eventKind: "investigate",
              facts: [{ factId: asFactId("fact_2"), change: "discovered", source: "scene_witness" }],
              beats: [{
                beatId: "fact_discovered_0",
                kind: "fact_discovered",
                subjectIds: ["fact_2"],
                instruction: "发现了线索：车轮印在后巷泥水中断续向北延伸。",
              }],
            }),
          },
          // 当前 investigate 没有命中，但未来 move 仍有已审批的预生成叙事；
          // 即时兜底不应把这条后续队列一起清掉。
          linearNarrativeQueue: [
            { actionKind: "move", locationId: asLocationId("loc_2"), narration: "北巷旧道就在前方。", source: "generated" },
          ],
        },
      },
    };
    const logger = { warn: vi.fn(), info: vi.fn() };
    const deps = { ...makeDeps(record, createDeterministicSceneSource()), logger: logger as never };
    const result = await generatePendingScene(deps);
    expect(result).toBe("saved");
    const writeBack = vi.mocked(deps.repository.applySceneWriteBack).mock.calls[0]![0];
    const scene = writeBack.nextStoryState.narrative.currentScene!;
    expect(scene.source).toBe("fallback");
    expect(writeBack.nextStoryState.narrative.linearNarrativeQueue).toEqual([
      { actionKind: "move", locationId: asLocationId("loc_2"), narration: "北巷旧道就在前方。", source: "generated" },
    ]);
    expect(logger.info).toHaveBeenCalledWith("narrative_queue_miss", { generationPath: "live_scene" });
  });

  it("does not use fast path when evolution demands next act or ending pair", async () => {
    const base = investigateResolvedRecord();
    const record: GameRecord = {
      ...base,
      storyState: {
        ...base.storyState,
        evolution: { ...base.storyState.evolution, status: "needs_next_act" },
        narrative: {
          ...base.storyState.narrative,
          generation: { status: "pending", job: investigateJob() },
          // 即使存在精确匹配的预生成条目，幕推进挂起时也不能被 fast path 短路。
          linearNarrativeQueue: [
            { actionKind: "investigate", factId: asFactId("fact_2"), narration: "车轮印在后巷泥水中断续向北延伸。", source: "generated" },
          ],
        },
      },
    };
    const evolutionSource = createDeterministicEvolutionSource();
    const proposeSpy = vi.spyOn(evolutionSource, "propose");
    const result = await generatePendingScene({
      repository: makeMockRepo(record),
      sceneSource: createDeterministicSceneSource(),
      worldEvolutionSource: evolutionSource,
      now: () => "2026-01-02",
    });
    expect(result).toBe("failed");
    expect(proposeSpy).toHaveBeenCalled();
  });

  // ── Task 5：调查方法结果反馈链 ─────────────────────────────────────────

  it("uses the chosen approach in deterministic investigation feedback", () => {
    const narration = buildInvestigationOutcomeNarrative({
      approachLabel: "翻查附近杂物",
      evidenceQuality: "noisy",
      factText: "车轮印指向北巷旧道",
      baseNarrative: "你在泥地边发现了断续的车轮印。",
    });
    expect(narration).toContain("翻查附近杂物");
    expect(narration).toContain("留下了动静");
  });

  // ── Task 4：单线移动优先消费预生成队列 ──────────────────────────────────

  it("move job: consumes the pre-generated queue narrative without calling scene or world AI", async () => {
    const base = investigateResolvedRecord();
    const record: GameRecord = {
      ...base,
      storyState: {
        ...base.storyState,
        narrative: {
          ...base.storyState.narrative,
          generation: {
            status: "pending",
            job: makeJob({ summary: { kind: "move", locationId: asLocationId("loc_2") }, eventKind: "travel" }),
          },
          linearNarrativeQueue: [
            { actionKind: "investigate", factId: asFactId("fact_2"), narration: "车轮印在后巷泥水中断续向北延伸。", source: "generated" },
            { actionKind: "move", locationId: asLocationId("loc_2"), narration: "北巷旧道就在前方，夜色掩不住那条土路。", source: "generated" },
          ],
        },
      },
    };
    const spy = makeSpySceneSource();
    const evolutionSource = createDeterministicEvolutionSource();
    const proposeSpy = vi.spyOn(evolutionSource, "propose");
    const deps = { ...makeDeps(record, spy.source), worldEvolutionSource: evolutionSource };
    const result = await generatePendingScene(deps);
    expect(result).toBe("saved");
    expect(spy.contexts()).toHaveLength(0);
    expect(proposeSpy).not.toHaveBeenCalled();
    const writeBack = vi.mocked(deps.repository.applySceneWriteBack).mock.calls[0]![0];
    const scene = writeBack.nextStoryState.narrative.currentScene!;
    expect(scene.narration).toBe("北巷旧道就在前方，夜色掩不住那条土路。");
    expect(scene.source).toBe("generated");
    // 消费即除：只移除精确匹配的 move 条目，investigate 条目原样保留。
    expect(writeBack.nextStoryState.narrative.linearNarrativeQueue).toEqual([
      { actionKind: "investigate", factId: asFactId("fact_2"), narration: "车轮印在后巷泥水中断续向北延伸。", source: "generated" },
    ]);
  });

  it("move queue hit writes the arrival NPC line as generated dialogue without another scene call", async () => {
    const base = linearArrivalRecord();
    const record: GameRecord = {
      ...base,
      worldState: {
        ...base.worldState,
        currentLocationId: asLocationId("loc_2"),
        visitedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")],
        worldFacts: base.worldState.worldFacts.map((fact) =>
          String(fact.factId) === "fact_2" ? { ...fact, discovered: true } : fact),
      },
      storyState: {
        ...base.storyState,
        narrative: {
          ...base.storyState.narrative,
          generation: {
            status: "pending",
            job: makeJob({ summary: { kind: "move", locationId: asLocationId("loc_2") }, eventKind: "travel" }),
          },
          linearNarrativeQueue: [{
            actionKind: "move",
            locationId: asLocationId("loc_2"),
            narration: "你沿着旧道赶往北巷旧道。",
            source: "generated",
            arrivalNpcLine: {
              npcId: asNpcId("npc_1"),
              text: "你就是来查旧镖局的人吧。镖局出事那晚，我亲眼见过一件关键的事。",
              emotion: "neutral",
              usedFactIds: [],
            },
          }],
        },
      },
    };
    const spy = makeSpySceneSource();
    const deps = makeDeps(record, spy.source);
    const result = await generatePendingScene(deps);
    expect(result).toBe("saved");
    expect(spy.contexts()).toHaveLength(0);
    const writeBack = vi.mocked(deps.repository.applySceneWriteBack).mock.calls[0]![0];
    const scene = writeBack.nextStoryState.narrative.currentScene!;
    expect(scene.source).toBe("generated");
    expect(scene.npcLine).toMatchObject({
      npcId: asNpcId("npc_1"),
      text: "你就是来查旧镖局的人吧。镖局出事那晚，我亲眼见过一件关键的事。",
    });
    expect(scene.npcDialogues).toContainEqual(expect.objectContaining({
      npcId: asNpcId("npc_1"),
      speechSource: "generated",
      speechPages: ["你就是来查旧镖局的人吧。镖局出事那晚，我亲眼见过一件关键的事。"],
    }));
    expect(writeBack.nextStoryState.narrative.linearNarrativeQueue).toEqual([]);
  });

  it("does not consume a legacy move entry without arrival dialogue", async () => {
    const base = linearArrivalRecord();
    const record: GameRecord = {
      ...base,
      worldState: {
        ...base.worldState,
        currentLocationId: asLocationId("loc_2"),
        visitedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")],
        worldFacts: base.worldState.worldFacts.map((fact) =>
          String(fact.factId) === "fact_2" ? { ...fact, discovered: true } : fact),
      },
      storyState: {
        ...base.storyState,
        narrative: {
          ...base.storyState.narrative,
          generation: {
            status: "pending",
            job: makeJob({ summary: { kind: "move", locationId: asLocationId("loc_2") }, eventKind: "travel" }),
          },
          linearNarrativeQueue: [{
            actionKind: "move",
            locationId: asLocationId("loc_2"),
            narration: "你沿着旧道赶往北巷旧道。",
            source: "generated",
          }],
        },
      },
    };
    const spy = makeSpySceneSource("generated");
    const logger = { info: vi.fn(), warn: vi.fn() };
    const deps = { ...makeDeps(record, spy.source), logger: logger as never };
    const result = await generatePendingScene(deps);
    expect(result).toBe("failed");
    expect(spy.contexts()).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith("narrative_queue_incomplete", {
      reason: "missing_arrival_npc_dialogue",
    });
    expect(deps.repository.applySceneWriteBack).not.toHaveBeenCalled();
  });

  it("move job: queue miss does not consume and preserves other future queue entries", async () => {
    const base = investigateResolvedRecord();
    const record: GameRecord = {
      ...base,
      storyState: {
        ...base.storyState,
        narrative: {
          ...base.storyState.narrative,
          generation: {
            status: "pending",
            job: makeJob({ summary: { kind: "move", locationId: asLocationId("loc_2") }, eventKind: "travel" }),
          },
          // 当前 move 未命中，但未来 investigate 仍有已审批的预生成叙事；
          // 即时 live 兜底不应把这条后续队列一起清掉。
          linearNarrativeQueue: [
            { actionKind: "investigate", factId: asFactId("fact_2"), narration: "车轮印在后巷泥水中断续向北延伸。", source: "generated" },
          ],
        },
      },
    };
    const deps = makeDeps(record, createDeterministicSceneSource());
    const result = await generatePendingScene(deps);
    expect(result).toBe("saved");
    const writeBack = vi.mocked(deps.repository.applySceneWriteBack).mock.calls[0]![0];
    expect(writeBack.nextStoryState.narrative.currentScene?.source).toBe("fallback");
    expect(writeBack.nextStoryState.narrative.linearNarrativeQueue).toEqual([
      { actionKind: "investigate", factId: asFactId("fact_2"), narration: "车轮印在后巷泥水中断续向北延伸。", source: "generated" },
    ]);
  });

  it("move job: queue hit with insufficient legal candidates must not call world/scene AI (stable invalid)", async () => {
    const isolatedLocation: LocationEntry = {
      ...loc,
      npcIds: [],
      connectedLocationIds: [],
    };
    const isolatedWorld = createInitialWorldState({
      generation: { generationId: asGenerationId("g-shortage-queue"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: isolatedLocation,
      startingItemIds: [],
    });
    const job = makeJob({ summary: { kind: "move", locationId: asLocationId("loc_1") }, eventKind: "travel" });
    const base = makeGameRecord({ kind: "pending", job });
    const record: GameRecord = {
      ...base,
      worldState: isolatedWorld,
      storyState: {
        ...base.storyState,
        narrative: {
          ...base.storyState.narrative,
          generation: { status: "pending", job },
          linearNarrativeQueue: [
            { actionKind: "move", locationId: asLocationId("loc_1"), narration: "旧纸堆里的暗记被你翻了出来。", source: "generated" },
          ],
        },
      },
    };
    const spy = makeSpySceneSource();
    const evolutionSource = createDeterministicEvolutionSource();
    const proposeSpy = vi.spyOn(evolutionSource, "propose");
    const result = await generatePendingScene({
      repository: makeMockRepo(record),
      sceneSource: spy.source,
      worldEvolutionSource: evolutionSource,
      now: () => "2026-01-02",
    });
    expect(result).toBe("failed");
    // 队列命中绝不能落入 scene_candidate_shortage 补救调用 world AI。
    expect(proposeSpy).not.toHaveBeenCalled();
    expect(spy.contexts()).toHaveLength(0);
  });

  it("composes the queued investigation narration with the settled approach/evidence result and the next objective", async () => {
    const base = investigateResolvedRecord();
    const world = base.worldState;
    const record: GameRecord = {
      ...base,
      worldState: {
        ...world,
        worldFacts: world.worldFacts.map((f) =>
          String(f.factId) === "fact_2" ? {
            ...f,
            investigationApproaches: [
              { approachId: "follow", label: "沿痕迹追查", evidenceQuality: "clean", tensionDelta: 4 },
              { approachId: "search", label: "翻查附近杂物", evidenceQuality: "noisy", tensionDelta: 8 },
            ],
          } : f),
        eventLedger: [
          { type: "location_visited", locationId: asLocationId("loc_1"), occurredAt: "2026-01-02" },
          { type: "fact_discovered", factId: asFactId("fact_2"), occurredAt: "2026-01-02", approachId: "follow", evidenceQuality: "clean", tensionDelta: 4 },
        ],
      },
      storyState: {
        ...base.storyState,
        narrative: {
          ...base.storyState.narrative,
          generation: { status: "pending", job: makeJob({
            summary: { kind: "investigate", factId: asFactId("fact_2") },
            eventKind: "investigate",
            facts: [{ factId: asFactId("fact_2"), change: "discovered", source: "scene_witness" }],
          }) },
          linearNarrativeQueue: [
            { actionKind: "investigate", factId: asFactId("fact_2"), narration: "车轮印在后巷泥水中断续向北延伸。", source: "generated" },
          ],
        },
      },
    };
    const spy = makeSpySceneSource();
    const deps = makeDeps(record, spy.source);
    const result = await generatePendingScene(deps);
    expect(result).toBe("saved");
    expect(spy.contexts()).toHaveLength(0);
    const writeBack = vi.mocked(deps.repository.applySceneWriteBack).mock.calls[0]![0];
    const scene = writeBack.nextStoryState.narrative.currentScene!;
    // baseNarrative（队列叙事）为主体，叠加已结算的方式/证据结果/下一目标。
    expect(scene.narration).toContain("车轮印在后巷泥水中断续向北延伸");
    expect(scene.narration).toContain("沿痕迹追查");
    expect(scene.narration).toContain("北巷旧道");
    // 场景写回不得再次修改事件账本或 tension。
    expect(writeBack.nextWorldState.eventLedger).toEqual(record.worldState.eventLedger);
    expect(writeBack.nextStoryState.tension).toBe(record.storyState.tension);
  });
});
