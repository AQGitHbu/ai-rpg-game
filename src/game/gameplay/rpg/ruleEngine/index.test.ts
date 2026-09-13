import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { ruleEngine, resolveTurn } from "./index";
import {
  type EnemyEntry, type LocationEntry, type NpcEntry,
  type PlayerState, type WorldState,
} from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId, asEnemyId, asQuestId, asFactId, type GenerationMetadata, type QuestId, type EndingId, type FactId } from "@/game/domain/worldEntity";
import { asTurnId } from "@/game/domain/events";
import type { NpcEntityRecord } from "@/game/domain/entity";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import {
  createWorldStateFixtureWith,
  emptyProjection,
  type WorldStateFixtureOverrides,
} from "@/game/domain/testing/worldStateFixture.testutil";

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia",
};
const PLAYER: PlayerState = { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } };
const LOC_1: LocationEntry = {
  id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
  connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
};
const LOC_2: LocationEntry = {
  id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
  connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
};
const BASE = emptyProjection({
  player: PLAYER,
  locations: [LOC_1, LOC_2],
  currentLocationId: LOC_1.id,
  unlockedLocationIds: [LOC_1.id, LOC_2.id],
});
const INITIALIZED_LEDGER = [makeCommittedEvent({ type: "game_initialized", generation: GENERATION }, { sequence: 0 })];

/** 一次传入完整兼容投影：覆盖项与 entityStore 由同一组装点重建。 */
function makeWorld(overrides: WorldStateFixtureOverrides = {}): WorldState {
  return createWorldStateFixtureWith({ generation: GENERATION, base: BASE }, { eventLedger: INITIALIZED_LEDGER, ...overrides });
}

describe("ruleEngine facade", () => {
  const ws = makeWorld();
  const ss = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01", turnId: asTurnId("test:turn") };

  it("returns ok for valid move action", () => {
    const result = ruleEngine(ws, ss, { type: "move", locationId: asLocationId("loc_2") }, "act_1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.currentLocationId).toBe(asLocationId("loc_2"));
      expect(result.resolvedEvent.status).toBe("success");
      expect(result.resolvedEvent.eventKind).toBe("travel");
    }
  });

  it("returns failure for unknown location", () => {
    const result = ruleEngine(ws, ss, { type: "move", locationId: asLocationId("nope") }, "act_2", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_LOCATION");
    }
  });

  it("updates story metrics after action", () => {
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const wsWithNpc = makeWorld({ npcs: [npc] });
    const result = ruleEngine(wsWithNpc, ss, { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" }, "act_3", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextStoryState.tension).toBe(33); // 30 + 3 (npc_met)
    }
  });

  it("对话会话至少连续两轮后才完成 talk_to_npc 目标", () => {
    const npc: NpcEntry = {
      id: asNpcId("npc_dialogue"), name: "线人", role: "知情人", description: "知道一条线索",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_dialogue"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const dialogueWs = makeWorld({
      npcs: [npc],
      quests: [{
        id: asQuestId("quest_dialogue"), name: "查清口供", description: "把口供问完整",
        objectives: [{ kind: "talk_to_npc", npcId: npc.id }],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 1, status: "active",
      }],
    });
    const dialogueState = {
      ...ss,
      narrative: {
        ...ss.narrative,
        dialogueSession: { npcId: npc.id, turnCount: 0, requiredTurns: 2, completed: false },
      },
    };

    const first = resolveTurn(
      dialogueWs,
      dialogueState,
      { type: "talk", npcId: npc.id, dialogueAct: "support", topic: { kind: "general" } },
      "dialogue_1",
      0,
      asTurnId("turn_dialogue_1"),
      "fixed_choice",
      deps,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("第一轮对话不应失败");
    expect(first.resolution.nextWorldState.quests[0]?.status).toBe("active");
    expect(first.resolution.domainEvents.map((event) => event.kind)).not.toContain("quest_completed");
    expect(first.resolution.nextStoryState.narrative.dialogueSession).toMatchObject({ turnCount: 1, completed: false });

    const second = resolveTurn(
      first.resolution.nextWorldState,
      first.resolution.nextStoryState,
      { type: "talk", npcId: npc.id, dialogueAct: "challenge", topic: { kind: "thread", threadId: "main_thread" } },
      "dialogue_2",
      1,
      asTurnId("turn_dialogue_2"),
      "fixed_choice",
      deps,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("第二轮对话不应失败");
    expect(second.resolution.nextWorldState.quests[0]?.status).toBe("completed");
    expect(second.resolution.domainEvents.map((event) => event.kind)).toContain("quest_completed");
    expect(second.resolution.domainEvents).toContainEqual(expect.objectContaining({
      kind: "npc_dialogue_completed",
      actionId: "dialogue_2",
      payload: expect.objectContaining({
        type: "npc_dialogue_completed",
        npcId: npc.id,
      }),
    }));
    expect(second.resolution.nextStoryState.narrative.dialogueSession).toMatchObject({ turnCount: 2, completed: true });
  });

  it("交接到另一名 NPC 时重置已完成会话，不能用第一项回应完成新目标", () => {
    const oldNpc: NpcEntry = {
      id: asNpcId("npc_old"), name: "旧 NPC", role: "线人", description: "旧线人",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId("npc_old"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const nextNpc: NpcEntry = {
      id: asNpcId("npc_next"), name: "新 NPC", role: "掌柜", description: "新掌柜",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_next"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const handoffWorld = makeWorld({
      npcs: [oldNpc, nextNpc],
      quests: [{
        id: asQuestId("quest_next"), name: "新目标", description: "与新 NPC 交谈",
        objectives: [{ kind: "talk_to_npc", npcId: nextNpc.id }],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 1, status: "active",
      }],
    });
    const handoffStory = {
      ...ss,
      narrative: {
        ...ss.narrative,
        dialogueSession: { npcId: oldNpc.id, turnCount: 2, requiredTurns: 2, completed: true },
      },
    };
    const result = resolveTurn(
      handoffWorld,
      handoffStory,
      { type: "talk", npcId: nextNpc.id, dialogueAct: "support", topic: { kind: "general" } },
      "handoff_dialogue_1",
      0,
      asTurnId("turn_handoff_dialogue_1"),
      "fixed_choice",
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolution.nextStoryState.narrative.dialogueSession).toMatchObject({
        npcId: nextNpc.id,
        turnCount: 1,
        requiredTurns: 2,
        completed: false,
      });
      expect(result.resolution.nextWorldState.quests[0]?.status).toBe("active");
    }
  });

  it("交接到新 NPC 的 ask 只启动零轮会话，不得把 met 当成目标完成", () => {
    const oldNpc: NpcEntry = {
      id: asNpcId("npc_old_ask"), name: "旧 NPC", role: "线人", description: "旧线人",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId("npc_old_ask"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const nextNpc: NpcEntry = {
      id: asNpcId("npc_next_ask"), name: "赵文远", role: "州府师爷", description: "负责告示",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_next_ask"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const handoffWorld = makeWorld({
      npcs: [oldNpc, nextNpc],
      quests: [{
        id: asQuestId("quest_next_ask"), name: "当铺暗影", description: "与赵文远交谈",
        objectives: [{ kind: "talk_to_npc", npcId: nextNpc.id }],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 2, status: "active",
      }],
    });
    const handoffStory = {
      ...ss,
      narrative: {
        ...ss.narrative,
        dialogueSession: { npcId: oldNpc.id, turnCount: 2, requiredTurns: 2, completed: true },
      },
    };

    const result = resolveTurn(
      handoffWorld,
      handoffStory,
      { type: "talk", npcId: nextNpc.id, dialogueAct: "ask" },
      "handoff_dialogue_ask",
      0,
      asTurnId("turn_handoff_dialogue_ask"),
      "fixed_choice",
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolution.nextStoryState.narrative.dialogueSession).toEqual({
      npcId: nextNpc.id,
      turnCount: 0,
      requiredTurns: 2,
      completed: false,
    });
    expect(result.resolution.nextWorldState.quests[0]?.status).toBe("active");
    expect(result.resolution.domainEvents.map((event) => event.kind)).not.toContain("quest_completed");
  });
});

describe("ruleEngine status passthrough", () => {
  const ws = makeWorld();
  const ss = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01", turnId: asTurnId("test:turn") };

  it("passes partial_success from resolveByType to ResolvedEvent", () => {
    const hostileNpc: NpcEntry = {
      id: asNpcId("npc_hostile"), name: "卫兵", role: "守卫", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_hostile"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: -70 }, emotion: "angry", goals: [] },
    };
    const wsWithHostile = makeWorld({ npcs: [hostileNpc] });
    const result = ruleEngine(wsWithHostile, ss, { type: "talk", npcId: asNpcId("npc_hostile"), dialogueAct: "ask" }, "act_1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.status).toBe("partial_success");
    }
  });

  it("passes blocked status for move during battle", () => {
    const wsInBattle = makeWorld({ battle: { status: "active", enemyId: asEnemyId("e1"), playerHp: 50, enemyHp: 30, round: 1 } });
    const result = ruleEngine(wsInBattle, ss, { type: "move", locationId: asLocationId("loc_2") }, "act_1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.status).toBe("blocked");
      expect(result.resolvedEvent.stateChanges).toEqual([]);
    }
  });

  it("populates stateChanges in ResolvedEvent", () => {
    const result = ruleEngine(ws, ss, { type: "move", locationId: asLocationId("loc_2") }, "act_1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.stateChanges.length).toBeGreaterThan(0);
      expect(result.resolvedEvent.stateChanges.some((sc) => sc.path === "currentLocationId")).toBe(true);
    }
  });
});

describe("resolveTurn facade", () => {
  const ws = makeWorld();
  const ss = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01", turnId: asTurnId("test:turn") };
  const baseRevision = 7;
  const turnId = asTurnId("turn_9");

  it("threads action/actionId/turnId/baseRevision/interactionKind and returns faithful result", () => {
    const action = { type: "move", locationId: asLocationId("loc_2") } as const;
    const result = resolveTurn(ws, ss, action, "act_1", baseRevision, turnId, "fixed_choice", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected rejection: ${result.code}`);
    const r = result.resolution;
    expect(r.action).toEqual(action);
    expect(r.actionId).toBe("act_1");
    expect(r.turnId).toBe(turnId);
    expect(r.baseRevision).toBe(baseRevision);
    expect(r.interactionKind).toBe("fixed_choice");
    expect(r.turnNumber).toBe(ss.turnNumber + 1);
    expect(r.nextStoryState.turnNumber).toBe(r.turnNumber);
    expect(r.primaryResult.status).toBe("success");
    expect(r.primaryResult.eventKind).toBe("travel");
    expect(r.domainEvents.map((e) => e.kind)).toEqual(["location_visited"]);
    expect(r.nextWorldState.eventLedger).toEqual([...ws.eventLedger, ...r.domainEvents]);
  });

  it("threads free_text interactionKind through", () => {
    const result = resolveTurn(ws, ss, { type: "explore" }, "act_2", baseRevision, turnId, "free_text", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected rejection");
    expect(result.resolution.interactionKind).toBe("free_text");
  });

  it("freeform records a structured player_intent_expressed event without extra world changes", () => {
    const result = resolveTurn(ws, ss, { type: "freeform", intent: "chat", rawText: "你好" }, "act_2", baseRevision, turnId, "free_text", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected rejection");
    // Spec §13.5：freeform 不产生实质世界变化，但必须以结构化 player_intent_expressed 事件落账意图。
    expect(result.resolution.domainEvents.map((e) => e.kind)).toEqual(["player_intent_expressed"]);
    expect(result.resolution.nextWorldState).not.toBe(ws);
    expect(result.resolution.nextWorldState.eventLedger).toEqual([
      ...ws.eventLedger,
      ...result.resolution.domainEvents,
    ]);
  });

  it("talk to hostile npc yields partial_success with domain event and aligned ledger", () => {
    const hostileNpc: NpcEntry = {
      id: asNpcId("npc_hostile"), name: "卫兵", role: "守卫", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_hostile"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: -70 }, emotion: "angry", goals: [] },
    };
    const wsWithHostile = makeWorld({ npcs: [hostileNpc] });
    const result = resolveTurn(wsWithHostile, ss, { type: "talk", npcId: asNpcId("npc_hostile"), dialogueAct: "ask" }, "act_3", baseRevision, turnId, "fixed_choice", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected rejection: ${result.code}`);
    const r = result.resolution;
    expect(r.primaryResult.status).toBe("partial_success");
    expect(r.primaryResult.eventKind).toBe("dialogue");
    expect(r.domainEvents.map((e) => e.kind)).toEqual(["npc_interaction_recorded", "npc_met"]);
    expect(r.nextWorldState.eventLedger).toEqual([...wsWithHostile.eventLedger, ...r.domainEvents]);
    const npc = r.nextWorldState.entityStore.records.find((record) => record.core.id === hostileNpc.id);
    expect(npc?.core.kind).toBe("npc");
    if (npc === undefined || npc.core.kind !== "npc") return;
    expect((npc as NpcEntityRecord).history.interactions[0]?.eventId).toBe(r.domainEvents[0]?.eventId);
  });

  it("a non-dialogue action can finish the final quest without prematurely resolving an ending", () => {
    const questId = "quest_1" as QuestId;
    const questWs = makeWorld({
      quests: [{
        id: questId, name: "q", description: "d",
        objectives: [{ kind: "visit_location", locationId: asLocationId("loc_2") }],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 3, status: "active",
      }],
      endings: [{
        id: "ending_1" as EndingId, name: "终局", description: "d",
        requirements: [{ kind: "quest_completed", questId }],
      }],
    });
    // 最终幕 + 无未决主线 thread 会推导 endingAllowed=true，但玩家仍须在
    // 结局对中明确选择 support/challenge；移动本身不应跳过这一步。
    const ssFinalAct = {
      ...ss,
      currentAct: 3,
      targetActs: 3,
      storyProgress: 85,
      unresolvedThreads: [],
      endingAllowed: false,
    };
    const result = resolveTurn(questWs, ssFinalAct, { type: "move", locationId: asLocationId("loc_2") }, "act_4", baseRevision, turnId, "fixed_choice", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected failure");
    const r = result.resolution;
    expect(r.domainEvents.map((e) => e.kind)).toEqual([
      "location_visited",
      "quest_completed",
    ]);
    expect(r.nextWorldState.eventLedger).toEqual([
      ...questWs.eventLedger,
      ...r.domainEvents,
    ]);
    expect(r.nextWorldState.quests[0]?.status).toBe("completed");
    expect(r.nextWorldState.ending).toBeNull();
    expect(r.turnNumber).toBe(ss.turnNumber + 1); // 非事件数（2 个事件也只加 1）
    expect(r.nextStoryState.turnNumber).toBe(r.turnNumber);
    expect(r.primaryResult.triggeredEvents).toEqual([
      "location_visited", "quest_completed",
    ]);
  });

  it("resolves an ending only after an explicit final support/challenge dialogue decision", () => {
    const questId = "quest_final" as QuestId;
    const finalNpc: NpcEntry = {
      id: asNpcId("npc_final"), name: "见证人", role: "卷宗保管人", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId("npc_final"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const questOutcome = makeCommittedEvent({ type: "quest_completed", questId }, { sequence: 1, questIds: [questId] });
    const finalWs = makeWorld({
      eventLedger: [...INITIALIZED_LEDGER, questOutcome],
      npcs: [finalNpc],
      quests: [{
        id: questId, name: "终幕主线", description: "d",
        objectives: [{ kind: "visit_location", locationId: asLocationId("loc_1") }],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 3, status: "completed",
      }],
      endings: [
        { id: "ending_trust" as EndingId, name: "共担真相", description: "d", requirements: [{ kind: "npc_affinity_at_least", npcId: finalNpc.id, value: 1 }] },
        { id: "ending_doubt" as EndingId, name: "独自揭露", description: "d", requirements: [{ kind: "npc_affinity_at_most", npcId: finalNpc.id, value: 0 }] },
      ],
    });
    const boundThread = { ...ss.threads[0]!, questIds: [questId], status: "advanced" as const };
    const ssFinalAct = {
      ...ss,
      currentAct: 3,
      targetActs: 3,
      storyProgress: 85,
      threads: [boundThread],
      unresolvedThreads: [boundThread.id],
      endingAllowed: true,
    };

    const result = resolveTurn(
      finalWs,
      ssFinalAct,
      { type: "talk", npcId: finalNpc.id, dialogueAct: "support" },
      "act_final_choice",
      baseRevision,
      turnId,
      "fixed_choice",
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected failure");
    expect(result.resolution.domainEvents.map((event) => event.kind)).toContain("ending_reached");
    expect(result.resolution.nextWorldState.ending).toEqual({ endingId: "ending_trust", outcome: "success" });
  });

  it("blocked action keeps state and produces no commit payload", () => {
    const wsInBattle = makeWorld({ battle: { status: "active", enemyId: asEnemyId("e1"), playerHp: 50, enemyHp: 30, round: 1 } });
    const result = resolveTurn(wsInBattle, ss, { type: "move", locationId: asLocationId("loc_2") }, "act_4", baseRevision, turnId, "fixed_choice", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected failure");
    const r = result.resolution;
    expect(r.primaryResult.status).toBe("blocked");
    expect(r.primaryResult.eventKind).toBe("travel");
    expect(r.domainEvents).toEqual([]);
    expect(r.nextWorldState).toBe(wsInBattle); // 同一对象：无任何写入
    expect(r.nextStoryState).toBe(ss); // 无回合推进
    expect(r.turnNumber).toBe(ss.turnNumber);
    expect(r.nextWorldState.eventLedger).toEqual(wsInBattle.eventLedger);
    expect(r.primaryResult.rejectedEffects).toEqual([{ description: "被战斗阻止", reason: "battle_active" }]);
  });

  it("invalid action returns rejection with stable code and no writes", () => {
    const result = resolveTurn(ws, ss, { type: "move", locationId: asLocationId("nope") }, "act_5", baseRevision, turnId, "fixed_choice", deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("UNKNOWN_LOCATION");
    expect(result.feedback).toContain("rejected");
  });

  it("battle victory yields ordered battle events and a single turn bump", () => {
    const startLoc: LocationEntry = {
      id: asLocationId("loc_1"), name: "荒野", description: "t", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    };
    const attackWs = createWorldStateFixtureWith({
      generation: GENERATION,
      base: emptyProjection({
        player: { name: "侠客", identity: "剑客", stats: { hp: 30, attack: 6, defense: 4 } },
        locations: [startLoc],
        currentLocationId: startLoc.id,
      }),
    }, {
      eventLedger: INITIALIZED_LEDGER,
      enemies: [{
        id: asEnemyId("enemy_1"), name: "山贼", tier: "normal" as const,
        stats: { hp: 1, attack: 5, defense: 2 },
        locationId: asLocationId("loc_1"), tags: [],
      }],
    });
    const battleTurnId = asTurnId("turn_20");
    const first = resolveTurn(attackWs, ss, { type: "attack", enemyId: asEnemyId("enemy_1") }, "act_6", baseRevision, battleTurnId, "fixed_choice", deps);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("battle start unexpectedly rejected");
    expect(first.resolution.primaryResult.status).toBe("success");
    expect(first.resolution.domainEvents.map((e) => e.kind)).toEqual(["battle_started"]);
    expect(first.resolution.nextWorldState.eventLedger).toEqual([...attackWs.eventLedger, ...first.resolution.domainEvents]);

    const second = resolveTurn(
      first.resolution.nextWorldState,
      first.resolution.nextStoryState,
      { type: "battle_action", action: "attack" },
      "act_7", baseRevision + 1, asTurnId("turn_21"), "fixed_choice", deps,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("battle action unexpectedly rejected");
    const r = second.resolution;
    expect(r.primaryResult.status).toBe("success");
    expect(r.primaryResult.eventKind).toBe("battle");
    expect(r.domainEvents.map((e) => e.kind)).toEqual([
      "battle_round_resolved",
      "battle_resolved",
      "enemy_defeated",
    ]);
    expect(r.nextWorldState.eventLedger).toEqual([...first.resolution.nextWorldState.eventLedger, ...r.domainEvents]);
    expect(r.nextWorldState.battle).toEqual({ status: "resolved", enemyId: asEnemyId("enemy_1"), outcome: "victory" });
    expect(r.nextWorldState.defeatedEnemyIds).toEqual([asEnemyId("enemy_1")]);
    expect(r.turnNumber).toBe(first.resolution.turnNumber + 1); // 一回合多事件只 +1
    expect(r.nextStoryState.turnNumber).toBe(r.turnNumber);
    expect(r.primaryResult.triggeredEvents).toEqual([
      "battle_round_resolved", "battle_resolved", "enemy_defeated",
    ]);
  });
});

describe("candidate reaction events integrate after player action (Task 20)", () => {
  const enemy: EnemyEntry = {
    id: asEnemyId("enemy_1"), name: "山贼", tier: "normal" as const,
    stats: { hp: 10, attack: 5, defense: 2 },
    locationId: asLocationId("loc_1"), tags: [],
  };
  const ws = makeWorld({ enemies: [enemy] });
  const deps = { now: () => "2026-01-01", turnId: asTurnId("test:turn") };
  const baseRevision = 7;
  const turnId = asTurnId("turn_9");

  function makeSs(candidatePool: ReturnType<typeof createInitialStoryState>["candidateEventPool"]) {
    return {
      ...createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 0 } }),
      candidateEventPool: candidatePool,
    };
  }

  it("player action events come first, then candidate reaction events; clicked action not invalidated", () => {
    const ss = makeSs([{
      id: "ce-1",
      kind: "enemy_appears",
      involvedEntityIds: ["enemy_1", "loc_1"],
      prerequisiteFactIds: [],
      proposedEffects: [{ kind: "enemy_appears", enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") }],
      intendedPacing: "complicate",
      reason: "敌人在客栈现身",
      proposedAtTurn: 1,
      expiresAtTurn: 9,
    }]);
    // 玩家先移动；候选事件在玩家行动完成后激活，且不会让已点击的 move 变 invalid。
    const result = resolveTurn(ws, ss, { type: "move", locationId: asLocationId("loc_2") }, "act_1", baseRevision, turnId, "fixed_choice", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("move should not be invalidated by candidate");
    const r = result.resolution;
    // 玩家事件（location_visited）必须先于反应事件（battle_started）与激活审计。
    const types = r.domainEvents.map((e) => e.kind);
    expect(types[0]).toBe("location_visited");
    expect(types).toContain("battle_started");
    expect(types).toContain("candidate_event_activated");
    // 顺序固定：玩家事件 < 候选反应事件
    expect(types.indexOf("location_visited")).toBeLessThan(types.indexOf("battle_started"));
    expect(types.indexOf("battle_started")).toBeLessThan(types.indexOf("candidate_event_activated"));
    expect(r.nextWorldState.eventLedger).toEqual([...ws.eventLedger, ...r.domainEvents]);
    expect(r.primaryResult.status).toBe("success"); // 点击的行动保持成功
    expect(r.primaryResult.eventKind).toBe("travel");
  });

  it("approves at most 1 candidate per turn; remaining stays in pool; rejected/expired removed with audit", () => {
    const pool = [
      { id: "ce-a", kind: "enemy_appears" as const, involvedEntityIds: ["enemy_1", "loc_1"], prerequisiteFactIds: [] as never[],
        proposedEffects: [{ kind: "enemy_appears" as const, enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") }],
        intendedPacing: "complicate" as const, reason: "a", proposedAtTurn: 1, expiresAtTurn: 9 },
      { id: "ce-b", kind: "enemy_appears" as const, involvedEntityIds: ["enemy_1", "loc_1"], prerequisiteFactIds: [] as never[],
        proposedEffects: [{ kind: "enemy_appears" as const, enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") }],
        intendedPacing: "escalate" as const, reason: "b", proposedAtTurn: 1, expiresAtTurn: 9 },
      // 过期候选：当前回合 5 ≥ expiresAtTurn 4 → 拒绝并移除
      { id: "ce-old", kind: "hostile_force_acts" as const, involvedEntityIds: ["loc_1"], prerequisiteFactIds: [] as never[],
        proposedEffects: [{ kind: "hostile_force_acts" as const, locationId: asLocationId("loc_1"), action: "attack" }],
        intendedPacing: "escalate" as const, reason: "old", proposedAtTurn: 1, expiresAtTurn: 4 },
    ] as const;
    const ss = { ...makeSs(pool as unknown as ReturnType<typeof createInitialStoryState>["candidateEventPool"]), turnNumber: 5 };
    const result = resolveTurn(ws, ss, { type: "explore" }, "act_2", baseRevision, turnId, "fixed_choice", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("explore should succeed");
    const r = result.resolution;
    // 最多批准 1 条（ce-a 或 ce-b）
    const activated = r.domainEvents.filter((e) => e.kind === "candidate_event_activated");
    expect(activated.length).toBe(1);
    // 过期候选从池移除并记录 expired 审计
    expect(r.domainEvents.some((e) => e.kind === "candidate_event_expired" && (e.payload as { candidateId: string }).candidateId === "ce-old")).toBe(true);
    const remainingIds = r.nextStoryState.candidateEventPool.map((c) => c.id);
    expect(remainingIds).not.toContain("ce-old");
    // 未批准者保留在池（ce-a 或 ce-b 之一）
    expect(remainingIds.length).toBe(1);
    // 已批准者从池移除
    expect(remainingIds).not.toContain((activated[0]!.payload as { candidateId: string }).candidateId);
  });
});

describe("resolveTurn — 自动揭示无 approach 的必经事实 (Task 3)", () => {
  const ss = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01", turnId: asTurnId("test:turn") };
  const FACT_1_ID = asFactId("fact_1");
  const FACT_2_ID = asFactId("fact_2");
  const BOSS_NPC: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };

  function discoverFactQuest(questId: string, factIds: readonly FactId[]): WorldState["quests"][number] {
    return {
      id: asQuestId(questId), name: "追查线索", description: "查明车轮印的来路",
      objectives: factIds.map((factId) => ({ kind: "discover_fact", factId })),
      onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
      tags: [], kind: "main", stage: 1, status: "active",
    };
  }

  it("任意成功行动后，同回合自动揭示当前地点无 approach 事实并完成其目标", () => {
    const autoWs = makeWorld({
      worldFacts: [{ factId: FACT_1_ID, text: "车轮印", source: "generated", discovered: false, locationId: asLocationId("loc_1") }],
      quests: [discoverFactQuest("quest_auto", [FACT_1_ID])],
    });
    const result = resolveTurn(autoWs, ss, { type: "explore" }, "act_auto", 0, asTurnId("turn_auto"), "fixed_choice", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("explore should succeed");
    const r = result.resolution;
    const types = r.domainEvents.map((e) => e.kind);
    expect(types).toContain("fact_discovered");
    expect(types).toContain("quest_completed");
    expect(r.domainEvents.find((e) => e.kind === "fact_discovered")).toMatchObject({
      kind: "fact_discovered",
      payload: { type: "fact_discovered", factId: FACT_1_ID },
    });
    expect(r.nextWorldState.worldFacts[0]?.discovered).toBe(true);
    expect(r.nextWorldState.quests[0]?.status).toBe("completed");
    expect(r.nextStoryState.tension).toBe(50); // 30 + 12 (fact_discovered) + 8 (quest_completed)
    expect(r.nextWorldState.eventLedger).toEqual([...autoWs.eventLedger, ...r.domainEvents]);
  });

  it("同一回合连续确认当前地点事实目标并完成任务", () => {
    const autoWs = makeWorld({
      worldFacts: [
        { factId: FACT_1_ID, text: "车轮印", source: "generated", discovered: false, locationId: asLocationId("loc_1") },
        { factId: FACT_2_ID, text: "脚印", source: "generated", discovered: false, locationId: asLocationId("loc_1") },
      ],
      quests: [discoverFactQuest("quest_auto", [FACT_1_ID, FACT_2_ID])],
    });
    const result = resolveTurn(autoWs, ss, { type: "explore" }, "act_auto2", 0, asTurnId("turn_auto2"), "fixed_choice", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("explore should succeed");
    const r = result.resolution;
    expect(r.domainEvents.filter((e) => e.kind === "fact_discovered")).toHaveLength(2);
    expect(r.nextWorldState.quests[0]?.status).toBe("completed");
    expect(r.nextWorldState.worldFacts[1]?.discovered).toBe(true);
    expect(r.nextStoryState.turnNumber).toBe(ss.turnNumber + 1);
  });

  it("有已审批 approach 的事实也自动揭示，不再留待玩家调查", () => {
    const autoWs = makeWorld({
      worldFacts: [{
        factId: FACT_1_ID, text: "车轮印", source: "generated", discovered: false, locationId: asLocationId("loc_1"),
        investigationApproaches: [
          { approachId: "careful", label: "沿痕迹追查", evidenceQuality: "clean", tensionDelta: 4 },
          { approachId: "risky", label: "翻查附近杂物", evidenceQuality: "noisy", tensionDelta: 12 },
        ],
      }],
      quests: [discoverFactQuest("quest_auto", [FACT_1_ID])],
    });
    const result = resolveTurn(autoWs, ss, { type: "explore" }, "act_auto3", 0, asTurnId("turn_auto3"), "fixed_choice", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("explore should succeed");
    const r = result.resolution;
    expect(r.domainEvents.some((e) => e.kind === "fact_discovered")).toBe(true);
    expect(r.nextWorldState.worldFacts[0]?.discovered).toBe(true);
    expect(r.nextWorldState.quests[0]?.status).toBe("completed");
  });

  it("移动完成 visit_location 后，同回合推进游标并自动揭示下一事实", () => {
    const autoWs = makeWorld({
      worldFacts: [{
        factId: FACT_1_ID,
        text: "车轮印",
        source: "generated",
        discovered: false,
        locationId: asLocationId("loc_2"),
        investigationApproaches: [
          { approachId: "careful", label: "沿痕迹追查", evidenceQuality: "clean", tensionDelta: 4 },
          { approachId: "risky", label: "翻查附近杂物", evidenceQuality: "noisy", tensionDelta: 12 },
        ],
      }],
      quests: [{
        id: asQuestId("quest_move_fact"),
        name: "追查线索",
        description: "前往现场并查明线索。",
        objectives: [
          { kind: "visit_location", locationId: asLocationId("loc_2") },
          { kind: "discover_fact", factId: FACT_1_ID },
        ],
        onSuccess: { kind: "advance_story" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 1,
        status: "active",
      }],
      visitedLocationIds: [asLocationId("loc_1")],
    });
    const revealedStory = {
      ...ss,
      reveal: { questId: asQuestId("quest_move_fact"), visibleObjectiveIndex: 0 },
    };
    const result = resolveTurn(autoWs, revealedStory, { type: "move", locationId: asLocationId("loc_2") }, "act_move_fact", 0, asTurnId("turn_move_fact"), "fixed_choice", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("move should succeed");
    expect(result.resolution.nextWorldState.currentLocationId).toBe(asLocationId("loc_2"));
    expect(result.resolution.nextWorldState.worldFacts[0]?.discovered).toBe(true);
    expect(result.resolution.domainEvents.map((event) => event.kind)).toContain("fact_discovered");
    expect(result.resolution.nextStoryState.reveal).toBeNull();
  });

  it("当前目标不是 discover_fact 时不自动揭示", () => {
    const autoWs = makeWorld({
      npcs: [BOSS_NPC],
      worldFacts: [{ factId: FACT_1_ID, text: "车轮印", source: "generated", discovered: false, locationId: asLocationId("loc_1") }],
      quests: [{
        id: asQuestId("quest_talk"), name: "交谈", description: "与老板交谈",
        objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_1") }],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 1, status: "active",
      }],
    });
    const result = resolveTurn(autoWs, ss, { type: "explore" }, "act_auto4", 0, asTurnId("turn_auto4"), "fixed_choice", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("explore should succeed");
    expect(result.resolution.domainEvents.some((e) => e.kind === "fact_discovered")).toBe(false);
  });

  it("其它地点的事实不自动揭示", () => {
    const autoWs = makeWorld({
      worldFacts: [{ factId: FACT_1_ID, text: "车轮印", source: "generated", discovered: false, locationId: asLocationId("loc_2") }],
      quests: [discoverFactQuest("quest_auto", [FACT_1_ID])],
    });
    const result = resolveTurn(autoWs, ss, { type: "explore" }, "act_auto5", 0, asTurnId("turn_auto5"), "fixed_choice", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("explore should succeed");
    expect(result.resolution.domainEvents.some((e) => e.kind === "fact_discovered")).toBe(false);
    expect(result.resolution.nextWorldState.worldFacts[0]?.discovered).toBe(false);
  });
});

import { asItemId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { applyEntityMutations } from "@/game/gameplay/rpg/entityWorld";
import { entitiesOfKind, parseEntityStore, validateEntityReferences } from "@/game/domain/entity";
import { buildOutcomeBeats } from "@/game/gameplay/rpg/narrativeContext";

describe("NPC 对话赠予与场景拾取分离", () => {
  const npcId = asNpcId("gift_npc");
  const itemId = asItemId("gift_letter");
  function giftFixture(marked = true) {
    const world = makeWorld({
      npcs: [{ id: npcId, name: "信使", role: "证人", description: "保管密信", locationId: LOC_1.id, isCompanion: false, tags: [], met: true,
        memory: { npcId, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } }],
      items: [{ id: itemId, name: "密信", description: "信使保管的信", kind: "quest", tags: [] }],
      locations: [{ ...LOC_1, npcIds: [npcId], availableItemIds: [itemId] }, LOC_2],
      quests: [{ id: asQuestId("gift_quest"), name: "托付", description: "对话取得密信后出发", kind: "main", stage: 1, status: "active", tags: [], onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        objectives: [{ kind: "talk_to_npc", npcId }, { kind: "obtain_item", itemId, ...(marked ? { giftFromNpcId: npcId } : {}) }, { kind: "visit_location", locationId: LOC_2.id }] }],
    });
    const changed = applyEntityMutations(world, [{ kind: "transfer_item", itemId, owner: { kind: "npc", npcId } }]);
    if (!changed.ok) throw new Error("fixture ownership failed");
    const initial = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 1, events: 0 } });
    const story = { ...initial, reveal: { questId: asQuestId("gift_quest"), visibleObjectiveIndex: 0 }, narrative: { ...initial.narrative, dialogueSession: { npcId, turnCount: 1, requiredTurns: 2, completed: false } } };
    return { world: changed.worldState, story };
  }
  const resolve = (fixture: ReturnType<typeof giftFixture>, actionId = "gift-completion") => resolveTurn(fixture.world, fixture.story, { type: "talk", npcId, dialogueAct: "support" }, actionId, 3, asTurnId(actionId), "fixed_choice", { now: () => "2026-01-01", turnId: asTurnId(actionId) });

  it("完成赠予者对白后，同一规则回合取得标记物品、推进目标并保留赠予证据", () => {
    const before = giftFixture();
    const result = resolve(before);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.feedback);
    const after = result.resolution;
    expect(after.nextWorldState.inventory).toEqual([itemId]);
    expect(before.world.inventory).toEqual([]);
    expect(after.nextStoryState.turnNumber).toBe(before.story.turnNumber + 1);
    expect(after.nextStoryState.reveal?.visibleObjectiveIndex).toBe(2);
    const obtained = after.domainEvents.find(event => event.kind === "item_obtained")!;
    expect(obtained.actorIds).toEqual([npcId]);
    expect(obtained.targetIds).toEqual([PLAYER_ENTITY_ID]);
    expect(obtained.causeEventIds).toContain(after.domainEvents.find(event => event.kind === "npc_dialogue_completed")!.eventId);
    expect(after.primaryResult.stateChanges).toContainEqual(expect.objectContaining({ path: "inventory", description: "信使将密信交给你。" }));
    expect(buildOutcomeBeats({ resolvedEvent: after.primaryResult, beforeWorldState: before.world, beforeStoryState: before.story, afterWorldState: after.nextWorldState, afterStoryState: after.nextStoryState })).toContainEqual(expect.objectContaining({ kind: "item_obtained", subjectIds: [itemId, npcId] }));
    expect(entitiesOfKind(after.nextWorldState.entityStore, "item")[0]!.possession.owner.kind).toBe("player");
    expect(resolve({ world: after.nextWorldState, story: after.nextStoryState as typeof before.story })).toMatchObject({ ok: false });
  });
  it("未完成对白不赠予；没有明确赠予标记不能取得 NPC 保管物品", () => {
    const first = giftFixture();
    first.story.narrative.dialogueSession.turnCount = 0;
    const pending = resolve(first);
    expect(pending.ok && pending.resolution.nextWorldState.inventory).toEqual([]);
    const unmarked = resolve(giftFixture(false));
    expect(unmarked.ok && unmarked.resolution.nextWorldState.inventory).toEqual([]);
  });
  it("NPC 赠予标记持久化可往返，并拒绝不存在的赠予者", () => {
    const fixture = giftFixture();
    expect(parseEntityStore(JSON.parse(JSON.stringify(fixture.world.entityStore))).ok).toBe(true);
    const corrupted = structuredClone(fixture.world.entityStore);
    const quest = entitiesOfKind(corrupted, "quest")[0]!;
    (quest.quest.objectives[1] as { giftFromNpcId: string }).giftFromNpcId = "absent_npc";
    expect(validateEntityReferences(corrupted)).toContainEqual(expect.objectContaining({ code: "unknown_quest_objective_ref", referencedId: "absent_npc" }));
  });
  it("赠予标记与归属冲突拒绝整个对白结算，不把场景物品自动拾取", () => {
    const fixture = giftFixture();
    const changed = applyEntityMutations(fixture.world, [{ kind: "transfer_item", itemId, owner: { kind: "location", locationId: LOC_1.id } }]);
    if (!changed.ok) throw new Error("fixture mutation failed");
    expect(resolve({ ...fixture, world: changed.worldState })).toMatchObject({ ok: false, code: "INVALID_RESOLUTION" });
    expect(changed.worldState.inventory).toEqual([]);
  });
});
