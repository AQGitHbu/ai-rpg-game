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
import type { EventCandidate } from "@/game/domain/candidateEvent";
import { asLocationId, asNpcId, asGenerationId, asEnemyId } from "@/game/domain/scenarioBlueprint";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import { createFixtureIntentParserSource } from "./server/ai/intentParserSource";
import { createRuleIntentParserV2 } from "./server/ai/liveIntentParserSourceV2";
import type { IntentParserSource } from "@/game/gameplay/rpg/intentParser/intentParserSource";
import { createFixtureExpansionSource } from "./server/ai/expansionSource";
import type { ExpansionProposal } from "@/game/gameplay/rpg/expansion/expansionTypes";
import type { ExpansionSource } from "@/game/gameplay/rpg/expansion/expansionSource";

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
  const talkAction: Action = { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" };

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

  it("玩家行动优先完成后激活候选反应；池生命周期在单次 CAS 中持久化（Task 20）", async () => {
    const enemyWs = {
      ...buildWorldState(),
      enemies: [{
        id: asEnemyId("enemy_1"), name: "山贼", tier: "normal" as const,
        stats: { hp: 10, attack: 5, defense: 2 },
        locationId: asLocationId("loc_1"), tags: [],
      }],
    };
    const candidate: EventCandidate = {
      id: "ce-1",
      kind: "enemy_appears",
      involvedEntityIds: ["enemy_1", "loc_1"],
      prerequisiteFactIds: [],
      proposedEffects: [{ kind: "enemy_appears", enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") }],
      intendedPacing: "complicate",
      reason: "敌人在客栈现身",
      proposedAtTurn: 1,
      expiresAtTurn: 9,
    };
    const ss = { ...buildStoryState(), candidateEventPool: [candidate] };
    const { repo, record, applyCalls } = createSpyRepo(enemyWs, ss);

    const moveAction: Action = { type: "move", locationId: asLocationId("loc_2") };
    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_move", interaction: { kind: "fixed_choice", choiceToken: "tok_move" }, expectedRevision: 0, choiceMap: new Map([["tok_move", moveAction]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 单次 CAS 提交
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    // 玩家行动（location_visited）先于候选反应（battle_started + activated 审计）
    const ledger = saved.worldState.eventLedger;
    const types = ledger.map((e) => e.type);
    expect(types.indexOf("location_visited")).toBeLessThan(types.indexOf("battle_started"));
    expect(types.indexOf("battle_started")).toBeLessThan(types.indexOf("candidate_event_activated"));
    // 已批准候选从池移除；池随状态一并持久化
    expect(saved.storyState.candidateEventPool.map((c) => c.id)).not.toContain("ce-1");
    expect(saved.worldState.battle).toEqual({ status: "active", enemyId: asEnemyId("enemy_1"), playerHp: 100, enemyHp: 10, round: 1 });
  });
});

// ---------------------------------------------------------------------------
// Task 6：Expansion 路径统一进入 TurnResolution 和 pending（单次 CAS）
// ---------------------------------------------------------------------------

const npcStrangerChoice: Map<string, Action> = new Map([["tok_stranger", { type: "talk", npcId: asNpcId("npc_stranger"), dialogueAct: "ask" }]]);

function sourceWithProposals(proposals: readonly ExpansionProposal[]): ExpansionSource {
  return { async propose() { return { proposals }; } };
}

function throwingSource(): ExpansionSource {
  return {
    async propose() {
      throw new Error("AI expansion source exploded");
    },
  };
}

const validLocationProposal: ExpansionProposal = {
  kind: "location",
  name: "青山别院",
  description: "山腰上一座独立的别院，与世隔绝。",
  scale: "scene",
  connectFromLocationId: "loc_1",
  reason: "世界扩展提案",
};

describe("performTurn Expansion 单路径（Task 6）", () => {
  it("未知 NPC 扩展 + 重演算成功 → 一次 CAS，pending job 保存真实对话", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_exp_npc", interaction: { kind: "fixed_choice", choiceToken: "tok_stranger" }, expectedRevision: 0, choiceMap: npcStrangerChoice },
      { repository: repo, now: () => "2026-01-02", expansionSource: createFixtureExpansionSource() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 单次 CAS：不存在第二次“非致命” commit
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    // 已扩展实体确实提交到世界
    expect(saved.worldState.npcs.map((n) => String(n.id))).toContain("npc_stranger");
    const generation = saved.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    // pending job 保存真实 Action/ResolvedEvent
    expect(generation.job.actionSummary).toEqual({ kind: "talk", npcId: "npc_stranger" });
    expect(generation.job.resolvedEvent.actionId).toBe("act_exp_npc");
    expect(generation.job.resolvedEvent.status).toBe("success");
    expect(generation.job.resolvedEvent.eventKind).toBe("dialogue");
  });

  it("未知地点扩展 + 重演算成功 → 一次 CAS，真实 travel pending", async () => {
    const wsMystery = { ...buildWorldState(), unlockedLocationIds: [...buildWorldState().unlockedLocationIds, asLocationId("loc_mystery")] };
    const { repo, record, applyCalls } = createSpyRepo(wsMystery, buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_exp_move", interaction: { kind: "fixed_choice", choiceToken: "tok_move" }, expectedRevision: 0, choiceMap: new Map([["tok_move", { type: "move", locationId: asLocationId("loc_mystery") }]]) },
      { repository: repo, now: () => "2026-01-02", expansionSource: createFixtureExpansionSource() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    // 扩展的地点实体已提交
    expect(saved.worldState.locations.some((l) => String(l.id) === "loc_mystery")).toBe(true);
    const generation = saved.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    expect(generation.job.actionSummary).toEqual({ kind: "move", locationId: "loc_mystery" });
    expect(generation.job.resolvedEvent.eventKind).toBe("travel");
  });

  it("重演算仍失败 → 已扩展实体提交（一次 CAS）且结果不被吞掉", async () => {
    // talk → npc_stranger：扩展只同意新增地点（talk 无法用它通过），重演算必仍失败
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_c", interaction: { kind: "fixed_choice", choiceToken: "tok_stranger" }, expectedRevision: 0, choiceMap: npcStrangerChoice },
      { repository: repo, now: () => "2026-01-02", expansionSource: sourceWithProposals([validLocationProposal]) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(result.feedback).toBe("Action rejected: UNKNOWN_NPC");
    // 实体的提交必须真实发生：恰好一次 CAS，且世界状态里存在扩展实体
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    expect(saved.worldState.locations.some((l) => l.name === "青山别院")).toBe(true);
    expect(saved.worldState.eventLedger.at(-1)!.type).toBe("blueprint_expanded");
  });

  it("审批拒绝（提案未获批准）→ 保持原行动拒绝且零规则写入", async () => {
    const badProposal: ExpansionProposal = {
      kind: "location",
      name: "X",
      description: "名字短于两个字符，非法负荷。",
      scale: "scene",
      connectFromLocationId: "loc_1",
      reason: "坏提案",
    };
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_d", interaction: { kind: "fixed_choice", choiceToken: "tok_stranger" }, expectedRevision: 0, choiceMap: npcStrangerChoice },
      { repository: repo, now: () => "2026-01-02", expansionSource: sourceWithProposals([badProposal]) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(result.feedback).toBe("Action rejected: UNKNOWN_NPC");
    expect(applyCalls()).toHaveLength(0);
  });

  it("Expansion source 抛错不破坏普通合法行动；触发场景下也干净降级拒绝", async () => {
    // 合法行动：source 从未被调用，回合照常单次 CAS 提交
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());
    const legal = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_e1", interaction: { kind: "fixed_choice", choiceToken: "tok_talk" }, expectedRevision: 0, choiceMap: new Map([["tok_talk", { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" }]]) },
      { repository: repo, now: () => "2026-01-02", expansionSource: throwingSource() },
    );
    expect(legal.ok).toBe(true);
    if (!legal.ok) return;
    expect(legal.revision).toBe(1);
    expect(applyCalls()).toHaveLength(1);

    // 触发场景下 source 抛错：不炸穿 performTurn，干净拒绝且零写入
    const { repo: repo2, applyCalls: applyCalls2 } = createSpyRepo(buildWorldState(), buildStoryState());
    const triggered = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_e2", interaction: { kind: "fixed_choice", choiceToken: "tok_stranger" }, expectedRevision: 0, choiceMap: npcStrangerChoice },
      { repository: repo2, now: () => "2026-01-02", expansionSource: throwingSource() },
    );
    expect(triggered.ok).toBe(false);
    if (triggered.ok) return;
    expect(triggered.code).toBe("ACTION_REJECTED");
    expect(triggered.feedback).toBe("Action rejected: UNKNOWN_NPC");
    expect(applyCalls2()).toHaveLength(0);
  });

  it("整回合至多一次 propose（不发生第二轮 Expansion）", async () => {
    let proposeCalls = 0;
    const fixture = createFixtureExpansionSource();
    const countingSource: ExpansionSource = {
      async propose(ctx) {
        proposeCalls += 1;
        return fixture.propose(ctx);
      },
    };

    // 扩展回合：恰好一次 propose，随后一次 CAS 提交
    const firstRepo = createSpyRepo(buildWorldState(), buildStoryState());
    const first = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_f1", interaction: { kind: "fixed_choice", choiceToken: "tok_stranger" }, expectedRevision: 0, choiceMap: npcStrangerChoice },
      { repository: firstRepo.repo, now: () => "2026-01-02", expansionSource: countingSource },
    );
    expect(first.ok).toBe(true);
    expect(proposeCalls).toBe(1);
    expect(firstRepo.applyCalls()).toHaveLength(1);

    // 后续合法回合（新世界）：不再调用 source
    const secondRepo = createSpyRepo(buildWorldState(), buildStoryState());
    const second = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_f2", interaction: { kind: "fixed_choice", choiceToken: "tok_talk" }, expectedRevision: 0, choiceMap: new Map([["tok_talk", { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" }]]) },
      { repository: secondRepo.repo, now: () => "2026-01-02", expansionSource: countingSource },
    );
    expect(second.ok).toBe(true);
    expect(proposeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 9：自由文本与固定选择统一回合入口（目标 NPC 对话行为 / freeform 事件）
// ---------------------------------------------------------------------------

describe("performTurn 自由文本端到端（Task 9）", () => {
  const ruleSource = createRuleIntentParserV2();

  it("同一 NPC 连续两个 ready 场景的自定义输入使用不同 actionId，各自形成记忆与 pending job", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const first = await performTurn(
      { gameId: asGameId("g1"), actionId: "uuid-1", interaction: { kind: "free_text", text: "我相信你", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02", intentParserSource: ruleSource },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const afterFirst = record()!;
    const sceneWrite = await repo.applySceneWriteBack({
      gameId: afterFirst.gameId,
      expectedRevision: afterFirst.revision,
      nextNarrative: {
        ...afterFirst.storyState.narrative,
        currentScene: {
          sceneId: "scene-1",
          turn: 1,
          narration: "老板等着你的下一句话。",
          usedFactIds: [],
          npcLine: { npcId: asNpcId("npc_1"), text: "请继续。", emotion: "neutral", usedFactIds: [] },
          choices: [
            { choiceToken: "tok-1", label: "继续询问" },
            { choiceToken: "tok-2", label: "提出质疑" },
          ],
          source: "fallback",
          event: { kind: "dialogue", focusNpcId: asNpcId("npc_1") },
        },
        generation: { status: "idle" },
      },
      nextCandidateEventPool: afterFirst.storyState.candidateEventPool,
    });
    expect(sceneWrite.ok).toBe(true);
    if (!sceneWrite.ok) return;

    const second = await performTurn(
      { gameId: asGameId("g1"), actionId: "uuid-2", interaction: { kind: "free_text", text: "你在撒谎", targetNpcId: asNpcId("npc_1") }, expectedRevision: sceneWrite.record.revision, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-03", intentParserSource: ruleSource },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const saved = record()!;
    const history = saved.worldState.npcs.find((npc) => npc.id === asNpcId("npc_1"))!.memory.interactionHistory;
    expect(history.map((entry) => entry.actionId)).toEqual(["uuid-1", "uuid-2"]);
    expect(new Set(history.map((entry) => entry.actionId)).size).toBe(2);
    expect(saved.storyState.turnNumber).toBe(2);

    expect(applyCalls()).toHaveLength(2);
    const pendingJobs = applyCalls().map((call) => call.nextStoryState.narrative.generation);
    expect(pendingJobs.every((generation) => generation.status === "pending")).toBe(true);
    expect(pendingJobs.map((generation) => generation.status === "pending" ? generation.job.actionId : null)).toEqual(["uuid-1", "uuid-2"]);
    expect(pendingJobs.map((generation) => generation.status === "pending" ? generation.job.turnId : null)).toEqual(["uuid-1", "uuid-2"]);
  });

  it("短问候也提交真实回合，并在 CAS 后留下可生成回应的 pending job", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "uuid-greeting", interaction: { kind: "free_text", text: "嗨", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02", intentParserSource: ruleSource },
    );

    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    expect(saved.storyState.turnNumber).toBe(1);
    expect(saved.worldState.npcs[0]!.memory.interactionHistory).toHaveLength(1);
    const generation = saved.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    expect(generation.job.actionId).toBe("uuid-greeting");
    expect(generation.job.utterance).toBe("嗨");
  });

  it("targetNpcId + 我相信你 → support talk：NPC 记忆变化 + pending job", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_sup", interaction: { kind: "free_text", text: "我相信你", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02", intentParserSource: ruleSource },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision).toBe(1);
    expect(applyCalls()).toHaveLength(1);

    const saved = record()!;
    const npc = saved.worldState.npcs.find((n) => n.id === asNpcId("npc_1"))!;
    expect(npc.met).toBe(true);
    // support：基础 +3 + 首次见面 +5 → affinity 8
    expect(npc.memory.relationship.affinity).toBe(8);
    expect(npc.memory.emotion).toBe("warm");
    expect(npc.memory.interactionHistory[0]!.relationshipDelta).toBe(8);
    expect(npc.memory.interactionHistory[0]!.summary).toContain("关系+8");

    const generation = saved.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    expect(generation.job.actionSummary).toEqual({ kind: "talk", npcId: "npc_1" });
    expect(generation.job.utterance).toBe("我相信你");
    expect(generation.job.focusNpcId).toBe("npc_1");
  });

  it("你在撒谎 → challenge talk：与 support 产生不同关系增量与记忆", async () => {
    const supportRepo = createSpyRepo(buildWorldState(), buildStoryState());
    const sup = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_sup", interaction: { kind: "free_text", text: "我相信你", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: supportRepo.repo, now: () => "2026-01-02", intentParserSource: ruleSource },
    );
    expect(sup.ok).toBe(true);

    const challengeRepo = createSpyRepo(buildWorldState(), buildStoryState());
    const cha = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_cha", interaction: { kind: "free_text", text: "你在撒谎", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: challengeRepo.repo, now: () => "2026-01-02", intentParserSource: ruleSource },
    );
    expect(cha.ok).toBe(true);
    if (!cha.ok) return;

    const supportNpc = supportRepo.record()!.worldState.npcs.find((n) => n.id === asNpcId("npc_1"))!;
    const challengeNpc = challengeRepo.record()!.worldState.npcs.find((n) => n.id === asNpcId("npc_1"))!;
    // challenge：基础 -2 + 首次见面 +5 → affinity 3，与 support(+8) 不同
    expect(challengeNpc.memory.relationship.affinity).toBe(3);
    expect(challengeNpc.memory.relationship.affinity).not.toBe(supportNpc.memory.relationship.affinity);
    expect(challengeNpc.memory.interactionHistory[0]!.relationshipDelta).toBe(3);
    expect(supportNpc.memory.interactionHistory[0]!.relationshipDelta).toBe(8);
    // 事件：两回合都以 npc_met 记录，但关系变化不同
    const chaGen = challengeRepo.record()!.storyState.narrative.generation;
    expect(chaGen.status).toBe("pending");
    if (chaGen.status !== "pending") return;
    expect(chaGen.job.resolvedEvent.triggeredEvents).toContain("npc_met");
  });

  it("我的等级升到100 → freeform：属性不变，但产生 player_intent_expressed 事件 + 可回应 pending", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_free", interaction: { kind: "free_text", text: "我的等级升到100" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02", intentParserSource: ruleSource },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    // 越权声明不改变任何属性
    expect(saved.worldState.player.stats).toEqual({ hp: 100, attack: 10, defense: 5 });
    expect(saved.worldState.eventLedger.length).toBe(buildWorldState().eventLedger.length + 1);
    const intentEvent = saved.worldState.eventLedger.at(-1)!;
    expect(intentEvent.type).toBe("player_intent_expressed");
    if (intentEvent.type === "player_intent_expressed") {
      expect(intentEvent.intent).toBe("unclassified");
    }
    // 事件不含玩家原文（无泄漏）
    expect(JSON.stringify(saved.worldState.eventLedger)).not.toContain("升到100");

    // 可回应 pending job：freeform 原文进入 job，场景可据此回应
    const generation = saved.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    expect(generation.job.actionSummary).toEqual({ kind: "freeform" });
    expect(generation.job.utterance).toBe("我的等级升到100");
    expect(generation.job.resolvedEvent.triggeredEvents).toContain("player_intent_expressed");
  });

  it("AI 意图源超时/非法 JSON → 降级 freeform：属性不变、回合照常提交", async () => {
    const failingSource: IntentParserSource = {
      sourceVersion: "stub-failing",
      async parseIntent() {
        return { ok: false, reason: "service_error" };
      },
    };
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_fail", interaction: { kind: "free_text", text: "我的武功升到一百级" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02", intentParserSource: failingSource },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    expect(saved.worldState.player.stats).toEqual({ hp: 100, attack: 10, defense: 5 });
    const generation = saved.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    expect(generation.job.actionSummary).toEqual({ kind: "freeform" });
    expect(generation.job.utterance).toBe("我的武功升到一百级");
  });
});
