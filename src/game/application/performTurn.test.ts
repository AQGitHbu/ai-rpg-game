import { describe, it, expect } from "vitest";
import { performTurn } from "./performTurn";
import type {
  ApplyStateInput,
  GameRecord,
  GameRepository,
} from "./server/persistence/gameRepository";
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
import { asLocationId, asNpcId, asGenerationId, asEnemyId, asQuestId, asItemId, asFactId } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import { createFixtureIntentParserSource } from "./server/ai/intentParserSource";
import { createRuleIntentParser } from "./server/ai/liveIntentParserSource";
import type { IntentParserSource } from "@/game/gameplay/rpg/intentParser/intentParserSource";
import { createDeterministicEvolutionSource } from "./deterministicEvolutionSource";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import type { WorldEvolutionSource } from "./worldEvolutionSource";
import { createApprovedChoice } from "@/game/domain/approvedChoice";
import { ENEMY_COMBAT_STATS, PLAYER_COMBAT_STATS, toStatBlock } from "@/game/domain/combat";
import { buildEncounter } from "@/game/gameplay/rpg/ruleEngine/buildEncounter";
import { createTurnOrder } from "@/game/gameplay/rpg/ruleEngine/combatMath";

function createSpyRepo(ws: WorldState, ss: StoryState): {
  repo: GameRepository;
  applyCalls: () => readonly ApplyStateInput[];
  record: () => GameRecord | null;
} {
  let record: GameRecord = {
    gameId: asGameId("g1"), worldState: ws, storyState: ss, revision: 0, createdAt: "2026-01-01",
  };
  const applyCallsHistory: ApplyStateInput[] = [];
  const repo: GameRepository = {
    async createInitialGame(input) {
      if (record !== null) return { ok: false as const, code: "ACTIVE_GAME_EXISTS" as const };
      record = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
      return { ok: true as const };
    },
    async replaceCurrentGame() { return { ok: false as const, code: "NO_ACTIVE_GAME" as const }; },
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
      record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
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

/** 世界带上一条主线任务：首个目标与老板交谈，第二个目标获取盟誓印谱。 */
function buildWorldWithMainQuest(): WorldState {
  return {
    ...buildWorldState(),
    quests: [{
      id: asQuestId("quest_0"),
      name: "查明真相",
      description: "查清矿坑的真相",
      objectives: [
        { kind: "talk_to_npc", npcId: asNpcId("npc_1") },
        { kind: "obtain_item", itemId: asItemId("item_seal") },
      ],
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: [],
      kind: "main",
      stage: 1,
      status: "active",
    }],
    items: [{ id: asItemId("item_seal"), name: "盟誓印谱", description: "刻着盟约的印谱", kind: "quest", tags: [] }],
  };
}

function buildFocusedDialogueStoryState(focusNpcId = asNpcId("npc_1")): StoryState {
  const base = buildStoryState();
  const support = createApprovedChoice({
    sceneId: "scene-focused",
    basedOnRevision: 0,
    label: "支持",
    action: { type: "talk", npcId: focusNpcId, dialogueAct: "support" },
  });
  const challenge = createApprovedChoice({
    sceneId: "scene-focused",
    basedOnRevision: 0,
    label: "质疑",
    action: { type: "talk", npcId: focusNpcId, dialogueAct: "challenge" },
  });
  if (!support.ok || !challenge.ok) throw new Error("focused dialogue fixture invalid");
  return {
    ...base,
    narrative: {
      ...base.narrative,
      currentScene: {
        sceneId: "scene-focused",
        turn: 0,
        narration: "老板等着你的回应。",
        usedFactIds: [],
        npcLine: { npcId: focusNpcId, text: "你怎么看？", emotion: "neutral", usedFactIds: [] },
        choices: [
          { choiceToken: support.choice.choiceToken, label: support.choice.label },
          { choiceToken: challenge.choice.choiceToken, label: challenge.choice.label },
        ],
        source: "fallback",
        event: { kind: "dialogue", focusNpcId },
        npcDialogues: [{ npcId: focusNpcId, npcName: "老板", npcRole: "路人", speechPages: ["你怎么看？"] }],
      },
      choiceRegistry: [support.choice, challenge.choice],
      generation: { status: "idle" },
    },
  };
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
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
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

  it("活跃战斗推进直接 CAS，不创建 pending narrative job", async () => {
    const enemy = {
      id: asEnemyId("enemy_1"), name: "灰狼", tier: "normal" as const,
      stats: toStatBlock(ENEMY_COMBAT_STATS.normal), locationId: asLocationId("loc_1"), tags: [],
    };
    const base = buildWorldState();
    const modern: WorldState = {
      ...base,
      player: { ...base.player, stats: toStatBlock(PLAYER_COMBAT_STATS) },
      enemies: [enemy],
    };
    const encounter = buildEncounter(modern, enemy.id);
    const active = {
      status: "active" as const,
      enemyId: enemy.id,
      enemyIds: [enemy.id],
      playerHp: 100,
      enemyHp: 55,
      round: 1,
      combatants: encounter,
      turnOrder: createTurnOrder(encounter),
      turnIndex: 0,
      enemyIntents: [],
      downedEnemyIds: [],
      lastAdvance: [],
    };
    const { repo, record, applyCalls } = createSpyRepo({ ...modern, battle: active }, buildStoryState());
    const action: Action = {
      type: "battle_action",
      action: "attack",
      command: { actorId: "ally:protagonist" as never, targetId: "enemy:enemy_1" as never },
    };
    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "battle_1", interaction: { kind: "fixed_choice", choiceToken: "battle" }, expectedRevision: 0, choiceMap: new Map([["battle", action]]) },
      { repository: repo, now: () => "2026-01-02" },
    );
    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    expect(record()?.storyState.narrative.generation.status).toBe("idle");
    expect(record()?.worldState.battle.status).toBe("active");
  });

  it("战斗失败恢复到战斗开始前，不创建战后叙事任务", async () => {
    const enemy = {
      id: asEnemyId("enemy_1"), name: "灰狼", tier: "normal" as const,
      stats: toStatBlock(ENEMY_COMBAT_STATS.normal), locationId: asLocationId("loc_1"), tags: [],
    };
    const base = buildWorldState();
    const beforeLedger = base.eventLedger;
    const world: WorldState = {
      ...base,
      enemies: [enemy],
      battle: {
        status: "active",
        enemyId: enemy.id,
        playerHp: 1,
        enemyHp: enemy.stats.hp,
        round: 1,
        battleKey: "battle-rollback",
        preBattleSnapshot: {
          playerStats: base.player.stats,
          defeatedEnemyIds: base.defeatedEnemyIds,
          eventLedger: beforeLedger,
        },
      },
    };
    const { repo, record, applyCalls } = createSpyRepo(world, buildStoryState());
    const action: Action = { type: "battle_action", action: "guard" };
    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "battle_defeat", interaction: { kind: "fixed_choice", choiceToken: "battle" }, expectedRevision: 0, choiceMap: new Map([["battle", action]]) },
      { repository: repo, now: () => "2026-01-02" },
    );
    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    expect(record()?.worldState.battle).toEqual({ status: "idle" });
    expect(record()?.worldState.eventLedger).toEqual(beforeLedger);
    expect(record()?.storyState.narrative.generation.status).toBe("idle");
  });

  it("成功回合 applyState 恰好一次，单次写入同时包含 WorldState、StoryState.turnNumber 和 pending job", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

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
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

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
    // Task 5 Step 4：talk + 玩家原话 → 强制 player_utterance 节拍进入 job
    const utteranceBeat = generation.job.mandatoryBeats.find((b) => b.kind === "player_utterance");
    expect(utteranceBeat).toBeDefined();
    expect(utteranceBeat?.subjectIds).toEqual(["npc_1"]);
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

  it("未知地点需要 AI 世界演化修复；缺失 source 返回稳定失败且零写入", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_move" }, expectedRevision: 0, choiceMap: new Map([["tok_move", { type: "move", locationId: asLocationId("loc_nope") }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("AI_CALL_FAILED");
    expect(result.failureKind).toBe("AI_CALL_FAILED");
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
    const repo: GameRepository = {
      async createInitialGame() { return { ok: true as const }; },
      async replaceCurrentGame() { return { ok: false as const, code: "NO_ACTIVE_GAME" as const }; },
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
// Task 3：worldEvolution 回合修复路径统一进入 TurnResolution 和 pending（单次 CAS）
// ---------------------------------------------------------------------------

const npcStrangerChoice: Map<string, Action> = new Map([["tok_stranger", { type: "talk", npcId: asNpcId("npc_stranger"), dialogueAct: "ask" }]]);

function sourceWithProposals(proposal: WorldDeltaProposal): WorldEvolutionSource {
  return { async propose() { return { ok: true, proposal }; } };
}

function throwingSource(): WorldEvolutionSource {
  return {
    async propose() {
      throw new Error("AI evolution source exploded");
    },
  };
}

const validLocationProposal: WorldDeltaProposal = {
  beatSummary: "世界扩展提案",
  newLocation: {
    name: "青山别院",
    description: "山腰上一座独立的别院，与世隔绝。",
    scale: "scene",
    connectFromLocationId: "loc_1",
  },
  newNpc: null,
  newItem: null,
  newEnemy: null,
  newFact: null,
  nextMainQuest: null,
  endingPair: null,
};

describe("performTurn worldEvolution 修复路径（Task 3）", () => {
  it("未知 NPC 修复 + 重演算成功 → 一次 CAS，pending job 保存真实对话", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_exp_npc", interaction: { kind: "fixed_choice", choiceToken: "tok_stranger" }, expectedRevision: 0, choiceMap: npcStrangerChoice },
      { repository: repo, now: () => "2026-01-02", worldEvolutionSource: createDeterministicEvolutionSource() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 单次 CAS：不存在第二次“非致命” commit
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    // 修复装配的新实体确实提交到世界（ID 按行动引用铸造）
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

  it("未知地点修复 + 重演算成功 → 一次 CAS，真实 travel pending", async () => {
    const wsMystery = { ...buildWorldState(), unlockedLocationIds: [...buildWorldState().unlockedLocationIds, asLocationId("loc_mystery")] };
    const { repo, record, applyCalls } = createSpyRepo(wsMystery, buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_exp_move", interaction: { kind: "fixed_choice", choiceToken: "tok_move" }, expectedRevision: 0, choiceMap: new Map([["tok_move", { type: "move", locationId: asLocationId("loc_mystery") }]]) },
      { repository: repo, now: () => "2026-01-02", worldEvolutionSource: createDeterministicEvolutionSource() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    // 修复装配的地点实体已提交（ID 按行动引用铸造）
    expect(saved.worldState.locations.some((l) => String(l.id) === "loc_mystery")).toBe(true);
    const generation = saved.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    expect(generation.job.actionSummary).toEqual({ kind: "move", locationId: "loc_mystery" });
    expect(generation.job.resolvedEvent.eventKind).toBe("travel");
  });

  it("重演算仍失败 → 已装配实体提交（一次 CAS）且结果不被吞掉", async () => {
    // talk → npc_stranger：装配只同意新增地点（talk 无法用它通过），重演算必仍失败
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_c", interaction: { kind: "fixed_choice", choiceToken: "tok_stranger" }, expectedRevision: 0, choiceMap: npcStrangerChoice },
      { repository: repo, now: () => "2026-01-02", worldEvolutionSource: sourceWithProposals(validLocationProposal) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(result.feedback).toBe("Action rejected: UNKNOWN_NPC");
    // 实体的提交必须真实发生：恰好一次 CAS，且世界状态里存在装配实体
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    expect(saved.worldState.locations.some((l) => l.name === "青山别院")).toBe(true);
    expect(saved.worldState.eventLedger.at(-1)!.type).toBe("blueprint_expanded");
  });

  it("语义审批拒绝 → 返回 AI_RESPONSE_INVALID 且不写入规则状态", async () => {
    const badProposal: WorldDeltaProposal = {
      beatSummary: "坏提案",
      newLocation: {
        name: "X",
        description: "名字短于两个字符，非法负荷。",
        scale: "scene",
        connectFromLocationId: "loc_1",
      },
      newNpc: null,
      newItem: null,
      newEnemy: null,
      newFact: null,
      nextMainQuest: null,
      endingPair: null,
    };
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_d", interaction: { kind: "fixed_choice", choiceToken: "tok_stranger" }, expectedRevision: 0, choiceMap: npcStrangerChoice },
      { repository: repo, now: () => "2026-01-02", worldEvolutionSource: sourceWithProposals(badProposal) },
    );

    expect(result).toMatchObject({ ok: false, code: "AI_RESPONSE_INVALID" });
    expect(applyCalls()).toHaveLength(0);
    expect(record()?.worldState.npcs.some((npc) => npc.id === "npc_stranger")).toBe(false);
  });

  it("worldEvolution source 抛错不破坏普通合法行动；触发场景返回 AI_CALL_FAILED", async () => {
    // 合法行动：source 从未被调用，回合照常单次 CAS 提交
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());
    const legal = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_e1", interaction: { kind: "fixed_choice", choiceToken: "tok_talk" }, expectedRevision: 0, choiceMap: new Map([["tok_talk", { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" }]]) },
      { repository: repo, now: () => "2026-01-02", worldEvolutionSource: throwingSource() },
    );
    expect(legal.ok).toBe(true);
    if (!legal.ok) return;
    expect(legal.revision).toBe(1);
    expect(applyCalls()).toHaveLength(1);

    // 触发场景下 source 抛错：不炸穿 performTurn，且零写入
    const { repo: repo2, record: record2, applyCalls: applyCalls2 } = createSpyRepo(buildWorldState(), buildStoryState());
    const triggered = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_e2", interaction: { kind: "fixed_choice", choiceToken: "tok_stranger" }, expectedRevision: 0, choiceMap: npcStrangerChoice },
      { repository: repo2, now: () => "2026-01-02", worldEvolutionSource: throwingSource() },
    );
    expect(triggered).toMatchObject({ ok: false, code: "AI_CALL_FAILED" });
    expect(applyCalls2()).toHaveLength(0);
    expect(record2()?.worldState.npcs.some((npc) => npc.id === "npc_stranger")).toBe(false);
  });

  it("整回合至多一次 propose（不发生第二轮 worldEvolution）", async () => {
    let proposeCalls = 0;
    const deterministic = createDeterministicEvolutionSource();
    const countingSource: WorldEvolutionSource = {
      async propose(ctx) {
        proposeCalls += 1;
        return deterministic.propose(ctx);
      },
    };

    // 修复回合：恰好一次 propose，随后一次 CAS 提交
    const firstRepo = createSpyRepo(buildWorldState(), buildStoryState());
    const first = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_f1", interaction: { kind: "fixed_choice", choiceToken: "tok_stranger" }, expectedRevision: 0, choiceMap: npcStrangerChoice },
      { repository: firstRepo.repo, now: () => "2026-01-02", worldEvolutionSource: countingSource },
    );
    expect(first.ok).toBe(true);
    expect(proposeCalls).toBe(1);
    expect(firstRepo.applyCalls()).toHaveLength(1);

    // 后续合法回合（新世界）：不再调用 source
    const secondRepo = createSpyRepo(buildWorldState(), buildStoryState());
    const second = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_f2", interaction: { kind: "fixed_choice", choiceToken: "tok_talk" }, expectedRevision: 0, choiceMap: new Map([["tok_talk", { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" }]]) },
      { repository: secondRepo.repo, now: () => "2026-01-02", worldEvolutionSource: countingSource },
    );
    expect(second.ok).toBe(true);
    expect(proposeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 9：自由文本与固定选择统一回合入口（目标 NPC 对话行为 / freeform 事件）
// ---------------------------------------------------------------------------

describe("performTurn 自由文本端到端（Task 9）", () => {
  const ruleSource = createRuleIntentParser();

  it("rejects a non-focused target before intent classification and writes nothing", async () => {
    let parserCalls = 0;
    const parser: IntentParserSource = {
      sourceVersion: "must-not-run",
      async parseIntent() {
        parserCalls += 1;
        return { ok: false, reason: "unclassifiable" };
      },
    };
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "invalid-target", interaction: { kind: "free_text", text: "我相信你", targetNpcId: asNpcId("npc_2") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02", intentParserSource: parser },
    );

    expect(result).toMatchObject({ ok: false, code: "ACTION_REJECTED" });
    expect(parserCalls).toBe(0);
    expect(applyCalls()).toHaveLength(0);
  });

  it("keeps location-like text addressed to the focused NPC as dialogue", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "focused-dialogue", interaction: { kind: "free_text", text: "去街道看看", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02", intentParserSource: ruleSource },
    );

    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    expect(record()!.worldState.currentLocationId).toBe(asLocationId("loc_1"));
    const generation = record()!.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    expect(generation.job.actionSummary).toEqual({ kind: "talk", npcId: "npc_1" });
    expect(generation.job.utterance).toBe("去街道看看");
  });

  it("accepts focused custom dialogue after entering a new location before the scene event becomes dialogue", async () => {
    const story = buildFocusedDialogueStoryState();
    const currentScene = story.narrative.currentScene;
    if (currentScene === null) throw new Error("focused scene fixture missing");
    const { repo, applyCalls } = createSpyRepo(buildWorldWithMainQuest(), {
      ...story,
      narrative: {
        ...story.narrative,
        currentScene: {
          ...currentScene,
          event: { kind: "travel", locationId: asLocationId("loc_1") },
        },
      },
    });

    const result = await performTurn(
      {
        gameId: asGameId("g1"),
        actionId: "focused-after-travel",
        interaction: { kind: "free_text", text: "我带来了这枚染血腰牌，你知道失踪镖队吗？", targetNpcId: asNpcId("npc_1") },
        expectedRevision: 0,
        choiceMap: new Map(),
      },
      { repository: repo, now: () => "2026-01-02", intentParserSource: ruleSource },
    );

    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
  });

  it("lets an in-location main-objective NPC replace a stale dialogue focus for custom input", async () => {
    const secondNpc: NpcEntry = {
      ...npc1,
      id: asNpcId("npc_2"),
      name: "传讯人",
      memory: { ...npc1.memory, npcId: asNpcId("npc_2") },
    };
    const world: WorldState = {
      ...buildWorldState(),
      npcs: [npc1, secondNpc],
      quests: [{
        id: asQuestId("quest_handoff"), name: "循迹", description: "与传讯人核对线索",
        objectives: [{ kind: "talk_to_npc", npcId: secondNpc.id }],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" }, tags: [],
        kind: "main", stage: 1, status: "active",
      }],
    };
    const { repo, record, applyCalls } = createSpyRepo(world, buildFocusedDialogueStoryState(npc1.id));

    const result = await performTurn(
      {
        gameId: asGameId("g1"), actionId: "handoff-custom-input",
        interaction: { kind: "free_text", text: "我带来了腰牌，请把你亲眼看见的经过说清楚。", targetNpcId: secondNpc.id },
        expectedRevision: 0, choiceMap: new Map(),
      },
      { repository: repo, now: () => "2026-01-02", intentParserSource: ruleSource },
    );

    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    const generation = record()!.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status === "pending") expect(generation.job.focusNpcId).toBe(secondNpc.id);
  });

  it("同一 NPC 连续两个 ready 场景的自定义输入使用不同 actionId，各自形成记忆与 pending job", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

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
      nextWorldState: afterFirst.worldState,
      nextStoryState: {
        ...afterFirst.storyState,
        narrative: {
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
        candidateEventPool: afterFirst.storyState.candidateEventPool,
      },
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
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

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
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

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
    const supportRepo = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());
    const sup = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_sup", interaction: { kind: "free_text", text: "我相信你", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: supportRepo.repo, now: () => "2026-01-02", intentParserSource: ruleSource },
    );
    expect(sup.ok).toBe(true);

    const challengeRepo = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());
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

  it("AI 意图源超时/非法 JSON → 返回可重试 AI_CALL_FAILED 且零写入", async () => {
    const failingSource: IntentParserSource = {
      sourceVersion: "stub-failing",
      async parseIntent() {
        return { ok: false, reason: "service_error", failureKind: "AI_CALL_FAILED" };
      },
    };
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_fail", interaction: { kind: "free_text", text: "我的武功升到一百级" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02", intentParserSource: failingSource },
    );

    expect(result).toMatchObject({ ok: false, code: "AI_CALL_FAILED" });
    expect(applyCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 4：performTurn 在提交前把规则结果/任务变化转成 objectiveTransition 与
// mandatoryBeats，并随 pending job 一起持久化（非占位值）。
// ---------------------------------------------------------------------------

describe("performTurn 叙事节拍与目标转换（Task 4）", () => {
  const talkAction: Action = { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" };

  it("目标推进回合：job 携带真实 objectiveTransition（before/completed/after）与 quest_progress 节拍", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldWithMainQuest(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_quest", interaction: { kind: "fixed_choice", choiceToken: "tok_talk" }, expectedRevision: 0, choiceMap: new Map([["tok_talk", talkAction]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyCalls()).toHaveLength(1);
    const generation = record()!.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;

    // 完成 talk 目标 → progressed：completed 记录旧目标，after 指向下一个未完成目标
    expect(generation.job.objectiveTransition.mode).toBe("progressed");
    expect(generation.job.objectiveTransition.before).toEqual({ questId: "quest_0", objectiveIndex: 0, label: "与老板交谈" });
    expect(generation.job.objectiveTransition.completed).toEqual([{ questId: "quest_0", objectiveIndex: 0, label: "与老板交谈" }]);
    expect(generation.job.objectiveTransition.after).toEqual({ questId: "quest_0", objectiveIndex: 1, label: "获取盟誓印谱" });
    // 本回合真实产出的节拍：subjectIds 引用实体 ID，instruction 来自当前状态
    expect(generation.job.mandatoryBeats).toContainEqual(expect.objectContaining({
      kind: "quest_progress",
      subjectIds: ["quest_0"],
      instruction: expect.stringContaining("与老板交谈"),
    }));
  });

  it("候选事件激活战斗：mandatoryBeats 含 battle_started 节拍，objectiveTransition 保持 unchanged", async () => {
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

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_battle", interaction: { kind: "fixed_choice", choiceToken: "tok_move" }, expectedRevision: 0, choiceMap: new Map([["tok_move", { type: "move", locationId: asLocationId("loc_2") }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyCalls()).toHaveLength(1);
    const generation = record()!.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    expect(generation.job.mandatoryBeats).toContainEqual(expect.objectContaining({
      kind: "battle_started",
      subjectIds: ["enemy_1"],
      instruction: expect.stringContaining("山贼"),
    }));
    // 无 active 任务 → 权威目标 null，模式 unchanged
    expect(generation.job.objectiveTransition).toEqual({ before: null, completed: [], after: null, mode: "unchanged" });
  });
});

// ---------------------------------------------------------------------------
// Task 3：规则层自动揭示——NPC 交接后同一回合自动发现无 approach 的必经事实，
// 与 npc_met/quest_completed 一起在单次 CAS 提交，job 覆盖完整 domainEventRange。
// ---------------------------------------------------------------------------

describe("performTurn — 自动揭示必经事实（Task 3）", () => {
  it("交谈完成交接后同回合自动发现事实并完成任务，单次 CAS 且 job 覆盖自动事件", async () => {
    const FACT_1_ID = asFactId("fact_1");
    const world: WorldState = {
      ...buildWorldState(),
      worldFacts: [{ factId: FACT_1_ID, text: "车轮印", source: "generated", discovered: false, locationId: asLocationId("loc_1") }],
      quests: [{
        id: asQuestId("quest_0"), name: "查明真相", description: "查清车轮印的来路",
        objectives: [
          { kind: "talk_to_npc", npcId: asNpcId("npc_1") },
          { kind: "discover_fact", factId: FACT_1_ID },
        ],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 1, status: "active",
      }],
    };
    const { repo, applyCalls } = createSpyRepo(world, buildStoryState());
    const talkAction: Action = { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" };

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_handoff", interaction: { kind: "fixed_choice", choiceToken: "tok_talk" }, expectedRevision: 0, choiceMap: new Map([["tok_talk", talkAction]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyCalls()).toHaveLength(1);
    const applied = applyCalls()[0]!;
    // 事实发现、任务完成与 npc_met 同回合按序落账（自动事件无 approach 元数据）
    expect(applied.nextWorldState.eventLedger.map((event) => event.type)).toEqual([
      "game_initialized", "npc_met", "fact_discovered", "quest_completed",
    ]);
    const autoEvent = applied.nextWorldState.eventLedger.find((event) => event.type === "fact_discovered");
    if (autoEvent?.type === "fact_discovered") {
      expect(autoEvent.factId).toBe(FACT_1_ID);
      expect(autoEvent.approachId).toBeUndefined();
      expect(autoEvent.evidenceQuality).toBeUndefined();
      expect(autoEvent.tensionDelta).toBeUndefined();
    }
    expect(applied.nextWorldState.worldFacts[0]?.discovered).toBe(true);
    expect(applied.nextWorldState.quests[0]?.status).toBe("completed");
    // pending job 覆盖本回合全部 3 个新事件（base ledger 长度为 1）
    const generation = applied.nextStoryState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    expect(generation.job.domainEventRange).toEqual({ fromLedgerIndex: 1, toLedgerIndexExclusive: 4 });
  });
});
