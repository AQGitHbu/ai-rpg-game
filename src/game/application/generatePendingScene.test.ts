import { describe, it, expect, vi } from "vitest";
import { generatePendingScene } from "./generatePendingScene";
import { createInitialWorldState, appendNpc, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { SceneSource, SceneSourceResult } from "./sceneSource";
import type { NarrativeEventKind } from "@/game/domain/narrative";
import type { ResolvedEventStatus } from "@/game/domain/resolvedEvent";
import { ATMOSPHERE_BEAT_ID } from "./approveAndWriteScene";

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
  return appendNpc(base, npc);
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
      facts: [],
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
  return {
    createInitialGame: vi.fn(),
    replaceCurrentGame: vi.fn(),
    getCurrentGame: vi.fn(async () => {
      if (record === null) return { ok: true as const, status: "none" as const };
      return { ok: true as const, status: "active" as const, record };
    }),
    applyState: vi.fn(),
    applySceneWriteBack: vi.fn(async () => {
      if (record === null) return { ok: false as const, code: "NO_ACTIVE_GAME" as const };
      return { ok: true as const, record };
    }),
    clearCurrentGame: vi.fn(async () => ({ ok: true as const })),
  };
}

function makeSpySceneSource(): { source: SceneSource; contexts: () => readonly SceneGenerationContext[] } {
  const seen: SceneGenerationContext[] = [];
  const sceneSource: SceneSource = {
    async generateScene(context: SceneGenerationContext): Promise<SceneSourceResult> {
      seen.push(context);
      return {
        sceneId: `scene-${context.job.jobId}`,
        segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "dummy" }],
        npcLine: null,
        objectiveLink: null,
        choices: [
          { candidateId: "candidate_1", label: "a" },
          { candidateId: "candidate_2", label: "b" },
        ],
        source: "fallback",
      };
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

  it("returns unavailable when the scene source fails", async () => {
    const record = makeGameRecord({
      kind: "pending",
      job: makeJob({ summary: { kind: "move", locationId: asLocationId("loc_1") }, eventKind: "travel" }),
    });
    const result = await generatePendingScene(makeDeps(record, failingSceneSource()));
    expect(result).toBe("unavailable");
  });

  it("hands the real persisted job to the source and writes back to idle", async () => {
    const record = makeGameRecord({
      kind: "pending",
      job: makeJob({ summary: { kind: "move", locationId: asLocationId("loc_1") }, eventKind: "travel" }),
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

  it("move job: the source receives a travel eventKind, not observe — no fabricated event", async () => {
    const record = makeGameRecord({
      kind: "pending",
      job: makeJob({ summary: { kind: "move", locationId: asLocationId("loc_1") }, eventKind: "travel" }),
    });
    const spy = makeSpySceneSource();
    const result = await generatePendingScene(makeDeps(record, spy.source));
    expect(result).toBe("saved");
    expect(spy.contexts()[0].job.resolvedEvent.eventKind).toBe("travel");
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
    const job = makeJob({ summary: { kind: "move", locationId: asLocationId("loc_1") }, eventKind: "travel" });
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

  it("stub 提案缺强制 player_utterance 节拍 → 整场回退确定性源并保存（fallback 过同一审批）", async () => {
    const record = utteranceRecord();
    const repo = makeMockRepo(record);
    // stub 源只给 atmosphere 段、无台词 → 缺强制节拍 → 审批拒绝 → 确定性 fallback
    const stub: SceneSource = {
      async generateScene(): Promise<SceneSourceResult> {
        return {
          sceneId: "scene-stub",
          segments: [{ beatId: ATMOSPHERE_BEAT_ID, text: "dummy" }],
          npcLine: null,
          objectiveLink: null,
          choices: [
            { candidateId: "candidate_1", label: "a" },
            { candidateId: "candidate_2", label: "b" },
          ],
          source: "generated",
        };
      },
    };
    const result = await generatePendingScene({ repository: repo, sceneSource: stub, now: () => "2026-01-02" });
    expect(result).toBe("saved");
    const input = vi.mocked(repo.applySceneWriteBack).mock.calls[0]![0];
    const scene = input.nextStoryState.narrative.currentScene!;
    expect(scene.source).toBe("fallback");
    expect(scene.npcLine?.npcId).toBe(asNpcId("npc_1"));
    expect(scene.npcLine?.answeredBeatIds).toContain("player_utterance");
  });

  it("stub 提案正确应答 player_utterance 节拍 → 直接采纳（不触发 fallback）", async () => {
    const record = utteranceRecord();
    const repo = makeMockRepo(record);
    const answering: SceneSource = {
      async generateScene(): Promise<SceneSourceResult> {
        return {
          sceneId: "scene-answer",
          segments: [
            { beatId: "player_utterance", text: "你提出了你的疑问。" },
            { beatId: ATMOSPHERE_BEAT_ID, text: "暮色渐沉。" },
          ],
          npcLine: { npcId: "npc_1", text: "这件事我也正想说。", emotion: "warm", answeredBeatIds: ["player_utterance"], usedFactIds: [], usedInteractionActionIds: [] },
          objectiveLink: null,
          choices: [
            { candidateId: "candidate_1", label: "支持" },
            { candidateId: "candidate_2", label: "质疑" },
          ],
          source: "generated",
        };
      },
    };
    const result = await generatePendingScene({ repository: repo, sceneSource: answering, now: () => "2026-01-02" });
    expect(result).toBe("saved");
    const input = vi.mocked(repo.applySceneWriteBack).mock.calls[0]![0];
    expect(input.nextStoryState.narrative.currentScene?.npcLine?.text).toBe("这件事我也正想说。");
    expect(input.nextStoryState.narrative.currentScene?.source).toBe("generated");
  });
});
