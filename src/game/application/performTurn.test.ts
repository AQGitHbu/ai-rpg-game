import { describe, it, expect } from "vitest";
import { performTurn } from "./performTurn";
import type {
  ApplyStateV2Input,
  GameRecordV2,
  GameRepositoryV2,
} from "./server/persistence/gameRepositoryV2";
import { asGameId } from "./server/persistence/gameRepository";
import {
  createInitialWorldState,
  appendLocation,
  appendNpc,
  type LocationEntry,
  type NpcEntry,
} from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId, asEnemyId } from "@/game/domain/scenarioBlueprint";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import { createFixtureIntentParserSource } from "./server/ai/intentParserSource";

function createSpyRepo(ws: WorldState, ss: StoryState): {
  repo: GameRepositoryV2;
  applyCalls: () => readonly ApplyStateV2Input[];
  record: () => GameRecordV2 | null;
} {
  let record: GameRecordV2 = {
    gameId: asGameId("g1"), worldState: ws, storyState: ss, revision: 0, createdAt: "2026-01-01",
  };
  const applyCallsHistory: ApplyStateV2Input[] = [];
  const repo: GameRepositoryV2 = {
    async createInitialGame(input) {
      if (record !== null) return { ok: false as const, code: "ACTIVE_GAME_EXISTS" as const };
      record = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
      return { ok: true as const };
    },
    async getCurrentGame() {
      return { ok: true, status: "active", record };
    },
    async applyState(input) {
      applyCallsHistory.push(input);
      if (input.expectedRevision !== record.revision) return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
      return { ok: true, record };
    },
    async applySceneWriteBack(input) {
      if (input.expectedRevision !== record.revision) return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      record = { ...record, storyState: { ...record.storyState, narrative: input.nextNarrative, candidateEventPool: input.nextCandidateEventPool }, revision: record.revision + 1 };
      return { ok: true, record };
    },
    async clearCurrentGame() { return { ok: true as const }; },
  };
  return { repo, record: () => record, applyCalls: () => applyCallsHistory };
}

const loc1: LocationEntry = {
  id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
  connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
};
const loc2: LocationEntry = {
  id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
  connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
};
const npc1: NpcEntry = {
  id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
  locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
  memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
};

function buildWorldState(): WorldState {
  const base = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  return { ...appendNpc(appendLocation(base, loc2), npc1), unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
}

function buildStoryState(): StoryState {
  return createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });
}

function makePendingJob(): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId("existing-job"),
    turnId: asTurnId("existing-turn"),
    actionId: "act_existing",
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: { kind: "talk", npcId: asNpcId("npc_1") },
    resolvedEvent: {
      actionId: "act_existing", status: "success", eventKind: "dialogue",
      facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
    requestedAt: "2026-01-02",
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

function buildPendingStoryState(): StoryState {
  const ss = buildStoryState();
  return {
    ...ss,
    narrative: { ...ss.narrative, generation: { status: "pending", job: makePendingJob() } },
  };
}

describe("performTurn 单次 CAS 提交", () => {
  const talkAction: Action = { type: "talk", npcId: asNpcId("npc_1") };

  it("成功回合 applyState 恰好一次，单次写入同时包含 WorldState、StoryState.turnNumber 和 pending job", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_talk" }, expectedRevision: 0, choiceMap: new Map([["tok_talk", talkAction]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision).toBe(1);
    // 单次提交：不存在第二次“非致命” commit
    expect(applyCalls()).toHaveLength(1);

    const written = applyCalls()[0]!;
    const saved = record()!;
    expect(saved.revision).toBe(1);
    expect(saved.worldState).toBe(written.nextWorldState);
    expect(saved.storyState).toBe(written.nextStoryState);
    expect(saved.storyState.turnNumber).toBe(1);
    const generation = saved.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    expect(generation.job.jobId).toBe("job_act_1");
    expect(generation.job.turnId).toBe("act_1");
    expect(generation.job.turnNumber).toBe(1);
    expect(generation.job.actionSummary).toEqual({ kind: "talk", npcId: "npc_1" });
    expect(generation.job.domainEventRange).toEqual({ fromLedgerIndex: 1, toLedgerIndexExclusive: 2 });
    expect(generation.job.requestedAt).toBe("2026-01-02");
  });

  it("pending job.resolvedEvent 等于真实 TurnResolution.primaryResult，basedOnRevision 等于提交后 revision", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_talk" }, expectedRevision: 0, choiceMap: new Map([["tok_talk", talkAction]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    const generation = saved.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    // resolvedEvent：与规则引擎真实产出的 primaryResult 完全一致（actionId/状态/事件种类/触发事件）
    expect(generation.job.resolvedEvent).toEqual({
      actionId: "act_1",
      status: "success",
      eventKind: "dialogue",
      facts: [],
      stateChanges: [{ path: "npcs[npc_1].met", description: "与老板交谈", operation: "set" }],
      costs: [],
      rewards: [],
      triggeredEvents: ["npc_met"],
      rejectedEffects: [],
    });
    // basedOnRevision 等于提交后的 revision（record.revision = expectedRevision + 1）
    expect(generation.job.basedOnRevision).toBe(saved.revision);
    expect(generation.job.basedOnRevision).toBe(1);
  });

  it("free_text 行动携带 utterance 进入 pending job", async () => {
    const { repo, record } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_2", interaction: { kind: "free_text", text: "和老板聊聊" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02", intentParserSource: createFixtureIntentParserSource() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const generation = record()!.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    expect(generation.job.actionSummary).toEqual({ kind: "talk", npcId: "npc_1" });
    expect(generation.job.utterance).toBe("和老板聊聊");
    expect(generation.job.focusNpcId).toBe("npc_1");
  });

  it("pending 期间拒绝推进世界（ack_prologue 例外仍允许尝试）", async () => {
    const ws = buildWorldState();
    const { repo, applyCalls } = createSpyRepo(ws, buildPendingStoryState());

    const rejected = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_3", interaction: { kind: "fixed_choice", choiceToken: "tok_talk" }, expectedRevision: 0, choiceMap: new Map([["tok_talk", talkAction]]) },
      { repository: repo, now: () => "2026-01-02" },
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe("ACTION_REJECTED");

    const ackResult = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_4", interaction: { kind: "fixed_choice", choiceToken: "tok_ack" }, expectedRevision: 0, choiceMap: new Map([["tok_ack", { type: "ack_prologue" }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );
    // ack 是展示标记例外：不被 pending 栅栏拦截（无事件回合最终因无法建立 job 零写入）
    expect(ackResult.ok).toBe(false);
    expect(applyCalls()).toHaveLength(0);
  });

  it("pending 期间自由文本同样被拒绝，且零写入", async () => {
    const ws = buildWorldState();
    const { repo, applyCalls } = createSpyRepo(ws, buildPendingStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_6", interaction: { kind: "free_text", text: "和老板聊聊" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02", intentParserSource: createFixtureIntentParserSource() },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(result.feedback).toBe("正在编排下一幕，请稍候。");
    expect(applyCalls()).toHaveLength(0);
  });

  it("CAS stale 时不返回行动成功且零写入", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_1" }, expectedRevision: 99, choiceMap: new Map([["tok_talk", talkAction]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("STALE_GAME_REVISION");
    expect(applyCalls()).toHaveLength(0);
  });

  it("unknown choice 零写入", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "nope" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNKNOWN_CHOICE");
    expect(applyCalls()).toHaveLength(0);
  });

  it("rule reject（未知地点）→ 零写入", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_move" }, expectedRevision: 0, choiceMap: new Map([["tok_move", { type: "move", locationId: asLocationId("loc_nope") }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(applyCalls()).toHaveLength(0);
  });

  it("blocked（战斗中 move）→ 零写入，绝不以 success 提交", async () => {
    const ws: WorldState = {
      ...buildWorldState(),
      battle: { status: "active", enemyId: asEnemyId("enemy_1"), playerHp: 80, enemyHp: 80, round: 1 },
    };
    const { repo, applyCalls } = createSpyRepo(ws, buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_move" }, expectedRevision: 0, choiceMap: new Map([["tok_move", { type: "move", locationId: asLocationId("loc_2") }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(applyCalls()).toHaveLength(0);
  });

  it("pending job 构造失败（ack_prologue 无领域事件）→ 零写入拒绝", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_5", interaction: { kind: "fixed_choice", choiceToken: "tok_ack" }, expectedRevision: 0, choiceMap: new Map([["tok_ack", { type: "ack_prologue" }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(applyCalls()).toHaveLength(0);
  });

  it("没有活跃对局 → NO_ACTIVE_GAME", async () => {
    const repo: GameRepositoryV2 = {
      async createInitialGame() { return { ok: true as const }; },
      async getCurrentGame() { return { ok: true, status: "none" }; },
      async applyState() { return { ok: false as const, code: "NO_ACTIVE_GAME" as const }; },
      async applySceneWriteBack() { return { ok: false as const, code: "NO_ACTIVE_GAME" as const }; },
      async clearCurrentGame() { return { ok: true as const }; },
    };

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_1" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NO_ACTIVE_GAME");
  });
});