import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
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
  return createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });
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
      status: "ready",
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
        source: "fixture",
        event: { kind: "dialogue", focusNpcId },
        npcDialogues: [{ npcId: focusNpcId, npcName: "老板", npcRole: "路人", speechPages: ["你怎么看？"] }],
      },
      choiceRegistry: [support.choice, challenge.choice],
    },
  };
}

function pendingNarrative(storyNarrative: StoryState["narrative"]): Extract<StoryState["narrative"], { status: "provider_pending" }> {
  if (storyNarrative.status !== "provider_pending") throw new Error("expected provider_pending narrative fixture");
  return storyNarrative;
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
    generationKind: "npc_fixed_choice",
    sceneRequestKind: "npc_response",
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

function buildPendingStoryState(): StoryState {
  const ss = buildStoryState();
  return {
    ...ss,
    narrative: { status: "provider_pending", mode: ss.narrative.mode, job: makePendingJob(), lastPresentedScene: null },
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
    const saved = record();
    expect(saved?.storyState.narrative.status).toBe("ready");
    if (saved?.storyState.narrative.status === "ready") {
      expect(saved.storyState.narrative.currentScene.source).toBe("rule");
    }
    expect(record()?.worldState.battle.status).toBe("active");
  });

  it("战斗结算缺少精确预备结果时零写入并返回稳定缺失码", async () => {
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
    expect(result).toMatchObject({ ok: false, code: "NARRATIVE_CONTINUATION_MISSING" });
    expect(applyCalls()).toHaveLength(0);
    expect(record()?.worldState).toBe(world);
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
    const generation = pendingNarrative(saved.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
    expect(generation.job.jobId).toBe("job_act_1");
    expect(generation.job.turnId).toBe("act_1");
    expect(generation.job.turnNumber).toBe(1);
    expect(generation.job.actionSummary).toEqual({ kind: "talk", npcId: "npc_1" });
    expect(generation.job.domainEventRange).toEqual({ fromLedgerIndex: 1, toLedgerIndexExclusive: 2 });
    expect(generation.job.requestedAt).toBe("2026-01-02");
    expect(generation.job.generationKind).toBe("npc_fixed_choice");
    expect(generation.job.sceneRequestKind).toBe("npc_response");
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
    const generation = pendingNarrative(saved.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
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

  it("两轮对话第一轮即使规则回合写入 met 也必须生成普通 npc_response，而不是 handoff", async () => {
    const { repo, record } = createSpyRepo(buildWorldWithMainQuest(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      {
        gameId: asGameId("g1"),
        actionId: "dialogue_first_response",
        interaction: { kind: "fixed_choice", choiceToken: "tok_talk" },
        expectedRevision: 0,
        choiceMap: new Map([[
          "tok_talk",
          { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support", topic: { kind: "general" } },
        ]]),
      },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    const generation = pendingNarrative(record()!.storyState.narrative);
    expect(generation.job.sceneRequestKind).toBe("npc_response");
    expect(generation.job.objectiveTransition.completed).toEqual([]);
    expect(generation.job.objectiveTransition.after?.objectiveIndex).toBe(0);
  });

  it("终幕第二轮完成最后 talk 目标时仍生成 npc_handoff", async () => {
    const baseWorld = buildWorldWithMainQuest();
    const finalWorld = {
      ...baseWorld,
      quests: baseWorld.quests.map((quest) => ({
        ...quest,
        objectives: [quest.objectives[0]!],
      })),
    };
    const finalStory = {
      ...buildStoryState(),
      unresolvedThreads: [],
      currentAct: 1,
      targetActs: 1,
      storyProgress: 0,
    };
    const { repo, record } = createSpyRepo(finalWorld, finalStory);
    const first = await performTurn(
      {
        gameId: asGameId("g1"),
        actionId: "final_dialogue_first",
        interaction: { kind: "fixed_choice", choiceToken: "tok_talk" },
        expectedRevision: 0,
        choiceMap: new Map([[
          "tok_talk",
          { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support", topic: { kind: "general" } },
        ]]),
      },
      { repository: repo, now: () => "2026-01-02" },
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
          status: "ready",
          mode: "ai",
          currentScene: {
            sceneId: "scene-final-dialogue",
            turn: 1,
            narration: "老板等着你的下一句话。",
            usedFactIds: [],
            npcLine: { npcId: asNpcId("npc_1"), text: "请继续。", emotion: "neutral", usedFactIds: [] },
            choices: [],
            source: "fixture",
            event: { kind: "dialogue", focusNpcId: asNpcId("npc_1") },
          },
          choiceRegistry: [],
          ...(afterFirst.storyState.narrative.dialogueSession === undefined
            ? {}
            : { dialogueSession: afterFirst.storyState.narrative.dialogueSession }),
        },
      },
    });
    expect(sceneWrite.ok).toBe(true);
    if (!sceneWrite.ok) return;

    const second = await performTurn(
      {
        gameId: asGameId("g1"),
        actionId: "final_dialogue_second",
        interaction: { kind: "fixed_choice", choiceToken: "tok_talk_second" },
        expectedRevision: sceneWrite.record.revision,
        choiceMap: new Map([[
          "tok_talk_second",
          { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "challenge", topic: { kind: "general" } },
        ]]),
      },
      { repository: repo, now: () => "2026-01-03" },
    );

    expect(second.ok).toBe(true);
    const generation = pendingNarrative(record()!.storyState.narrative);
    expect(generation.job.sceneRequestKind).toBe("npc_handoff");
  });

  it("非对白幕边界必须留下场景编排任务，避免 needs_next_act 卡在无目标界面", async () => {
    const boundaryWorld = {
      ...buildWorldWithMainQuest(),
      npcs: buildWorldWithMainQuest().npcs.map((npc) => ({ ...npc, met: true })),
      quests: buildWorldWithMainQuest().quests.map((quest) => ({ ...quest, objectives: [quest.objectives[0]!] })),
    };
    const boundaryStory = buildStoryState();
    const { repo, record } = createSpyRepo(boundaryWorld, boundaryStory);

    const result = await performTurn(
      {
        gameId: asGameId("g1"),
        actionId: "boundary_prepare",
        interaction: { kind: "fixed_choice", choiceToken: "tok_explore" },
        expectedRevision: 0,
        choiceMap: new Map([["tok_explore", { type: "explore" }]]),
      },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    const generation = pendingNarrative(record()!.storyState.narrative);
    expect(generation.job.generationKind).toBe("npc_fixed_choice");
    expect(generation.job.sceneRequestKind).toBe("npc_response");
  });

  it("free_text 行动携带 utterance 进入 pending job", async () => {
    const { repo, record } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_2", interaction: { kind: "free_text", text: "和老板聊聊", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02", intentParserSource: createFixtureIntentParserSource() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const generation = pendingNarrative(record()!.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
    expect(generation.job.actionSummary).toEqual({ kind: "talk", npcId: "npc_1" });
    expect(generation.job.utterance).toBe("和老板聊聊");
    expect(generation.job.focusNpcId).toBe("npc_1");
    expect(generation.job.generationKind).toBe("npc_free_text");
    expect(generation.job.sceneRequestKind).toBe("npc_response");
    // Task 5 Step 4：talk + 玩家原话 → 强制 player_utterance 节拍进入 job
    const utteranceBeat = generation.job.mandatoryBeats.find((b: PendingNarrativeJob["mandatoryBeats"][number]) => b.kind === "player_utterance");
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

  it("未知地点是客户端行动错误，不触发世界 AI 且零写入", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_move" }, expectedRevision: 0, choiceMap: new Map([["tok_move", { type: "move", locationId: asLocationId("loc_nope") }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(result.failureKind).toBeUndefined();
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

  it("ack_prologue 是本地规则场景，一次 CAS 进入 ready", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_5", interaction: { kind: "fixed_choice", choiceToken: "tok_ack" }, expectedRevision: 0, choiceMap: new Map([["tok_ack", { type: "ack_prologue" }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    const saved = record();
    expect(saved?.storyState.narrative.status).toBe("ready");
    if (saved?.storyState.narrative.status === "ready") {
      expect(saved.storyState.narrative.currentScene.source).toBe("rule");
    }
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

const npcStrangerChoice: Map<string, Action> = new Map([["tok_stranger", { type: "talk", npcId: asNpcId("npc_stranger"), dialogueAct: "ask" }]]);

function throwingSource(): WorldEvolutionSource {
  return {
    async propose() {
      throw new Error("AI evolution source exploded");
    },
  };
}

describe("performTurn provider boundary（Task 7）", () => {
  it("未知 NPC 是客户端行动错误：不修复世界、不调用 world source、不写入", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_exp_npc", interaction: { kind: "fixed_choice", choiceToken: "tok_stranger" }, expectedRevision: 0, choiceMap: npcStrangerChoice },
      { repository: repo, now: () => "2026-01-02", worldEvolutionSource: throwingSource() },
    );

    expect(result).toMatchObject({ ok: false, code: "ACTION_REJECTED" });
    expect(applyCalls()).toHaveLength(0);
    expect(record()?.worldState.npcs.some((npc) => npc.id === "npc_stranger")).toBe(false);
  });

  it("未知地点是客户端行动错误：不修复世界、不调用 world source、不写入", async () => {
    const wsMystery = { ...buildWorldState(), unlockedLocationIds: [...buildWorldState().unlockedLocationIds, asLocationId("loc_mystery")] };
    const { repo, record, applyCalls } = createSpyRepo(wsMystery, buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_exp_move", interaction: { kind: "fixed_choice", choiceToken: "tok_move" }, expectedRevision: 0, choiceMap: new Map([["tok_move", { type: "move", locationId: asLocationId("loc_mystery") }]]) },
      { repository: repo, now: () => "2026-01-02", worldEvolutionSource: throwingSource() },
    );

    expect(result).toMatchObject({ ok: false, code: "ACTION_REJECTED" });
    expect(applyCalls()).toHaveLength(0);
    expect(record()?.worldState.locations.some((location) => location.id === "loc_mystery")).toBe(false);
  });

  it("合法 NPC 回合只创建 provider job，performTurn 不调用 world source", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());
    const legal = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_e1", interaction: { kind: "fixed_choice", choiceToken: "tok_talk" }, expectedRevision: 0, choiceMap: new Map([["tok_talk", { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" }]]) },
      { repository: repo, now: () => "2026-01-02", worldEvolutionSource: throwingSource() },
    );
    expect(legal.ok).toBe(true);
    if (!legal.ok) return;
    expect(legal.revision).toBe(1);
    expect(applyCalls()).toHaveLength(1);

    expect(pendingNarrative(record()!.storyState.narrative).status).toBe("provider_pending");
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

  it("rejects a missing free-text target before intent classification and writes nothing", async () => {
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
      { gameId: asGameId("g1"), actionId: "missing-target", interaction: { kind: "free_text", text: "我相信你" }, expectedRevision: 0, choiceMap: new Map() },
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
    const generation = pendingNarrative(record()!.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
    expect(generation.job.actionSummary).toEqual({ kind: "talk", npcId: "npc_1" });
    expect(generation.job.utterance).toBe("去街道看看");
  });

  it("accepts focused custom dialogue after entering a new location before the scene event becomes dialogue", async () => {
    const story = buildFocusedDialogueStoryState();
    if (story.narrative.status !== "ready") throw new Error("focused scene fixture missing");
    const currentScene = story.narrative.currentScene;
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
    const generation = pendingNarrative(record()!.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status === "provider_pending") expect(generation.job.focusNpcId).toBe(secondNpc.id);
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
          status: "ready",
          mode: "ai",
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
            source: "fixture",
            event: { kind: "dialogue", focusNpcId: asNpcId("npc_1") },
          },
          choiceRegistry: [],
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
    const pendingJobs = applyCalls().map((call) => pendingNarrative(call.nextStoryState.narrative));
    expect(pendingJobs.every((generation) => generation.status === "provider_pending")).toBe(true);
    expect(pendingJobs.map((generation) => generation.status === "provider_pending" ? generation.job.actionId : null)).toEqual(["uuid-1", "uuid-2"]);
    expect(pendingJobs.map((generation) => generation.status === "provider_pending" ? generation.job.turnId : null)).toEqual(["uuid-1", "uuid-2"]);
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
    const generation = pendingNarrative(saved.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
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

    const generation = pendingNarrative(saved.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
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
    const chaGen = pendingNarrative(challengeRepo.record()!.storyState.narrative);
    expect(chaGen.status).toBe("provider_pending");
    if (chaGen.status !== "provider_pending") return;
    expect(chaGen.job.resolvedEvent.triggeredEvents).toContain("npc_met");
  });

  it("没有权威 NPC 目标的自由输入被拒绝且不调用意图源", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_free", interaction: { kind: "free_text", text: "我的等级升到100" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02", intentParserSource: ruleSource },
    );

    expect(result).toMatchObject({ ok: false, code: "ACTION_REJECTED" });
    expect(applyCalls()).toHaveLength(0);
  });

  it("AI 意图源超时/非法 JSON → 返回可重试 AI_CALL_FAILED 且零写入", async () => {
    const failingSource: IntentParserSource = {
      sourceVersion: "stub-failing",
      async parseIntent() {
        return { ok: false, reason: "service_error", failureKind: "AI_CALL_FAILED" };
      },
    };
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_fail", interaction: { kind: "free_text", text: "我的武功升到一百级", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
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
    const generation = pendingNarrative(record()!.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;

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

  it("候选事件激活战斗：规则场景一次 CAS 完成，不创建 provider job", async () => {
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
    const narrative = record()!.storyState.narrative;
    expect(narrative.status).toBe("ready");
    if (narrative.status !== "ready") return;
    expect(narrative.currentScene.source).toBe("rule");
    expect(narrative.currentScene.event?.kind).toBe("travel");
    expect(narrative.currentScene.choices).toEqual([]);
    expect(record()!.worldState.battle.status).toBe("active");
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
    const generation = pendingNarrative(applied.nextStoryState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
    expect(generation.job.domainEventRange).toEqual({ fromLedgerIndex: 1, toLedgerIndexExclusive: 4 });
  });
});
