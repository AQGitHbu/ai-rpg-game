import { describe, it, expect } from "vitest";
import { reconcileQuests } from "./reconcileQuests";
import { createInitialWorldState, type EnemyEntry, type NpcEntry, type LocationEntry, type WorldFactEntry } from "@/game/domain/worldState";
import { entitiesOfKind, projectEntityStore, type EntityCompatibilityProjection } from "@/game/domain/entity";
import { createWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import { asLocationId, asNpcId, asQuestId, asGenerationId, asItemId, asFactId, asEnemyId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import type { GameEvent } from "@/game/domain/events";
import type { WorldState } from "@/game/domain/worldState";

function withProjection(
  worldState: WorldState,
  overrides: Partial<EntityCompatibilityProjection>,
  eventLedger = worldState.eventLedger,
): WorldState {
  return createWorldStateFixture({
    generation: worldState.generation,
    projection: { ...projectEntityStore(worldState.entityStore), ...overrides },
    battle: worldState.battle,
    endings: worldState.endings,
    ending: worldState.ending,
    eventLedger,
  });
}

describe("reconcileQuests", () => {
  const loc: LocationEntry = {
    id: asLocationId("loc_1"), name: "t", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc,
    startingItemIds: [],
  });
  const deps = { now: () => "2026-01-01" };

  it("completes active quest when talk_to_npc objective satisfied", () => {
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "n", role: "r", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const ws = withProjection(withProjection(baseWs, { npcs: [npc] }), {
      quests: [{
        id: asQuestId("q1"), name: "talk quest", description: "t",
        objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_1") }],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" },
        tags: [], kind: "side", status: "active",
      }],
    });
    const result = reconcileQuests(ws, deps);
    expect(result.events[0]?.type).toBe("quest_completed");
    expect(result.nextWorldState.quests[0]?.status).toBe("completed");
  });

  it("does not complete quest when objective not satisfied", () => {
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "n", role: "r", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const ws = withProjection(withProjection(baseWs, { npcs: [npc] }), {
      quests: [{
        id: asQuestId("q1"), name: "talk quest", description: "t",
        objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_1") }],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" },
        tags: [], kind: "side", status: "active",
      }],
    });
    const result = reconcileQuests(ws, deps);
    expect(result.events).toHaveLength(0);
    expect(result.nextWorldState.quests[0]?.status).toBe("active");
  });

  it("item_obtained 历史事实在物品已交付后仍能完成获取目标", () => {
    const itemId = asItemId("item_1");
    const ws = withProjection(baseWs, {
      items: [{ id: itemId, name: "证物", description: "d", kind: "quest", tags: [] }],
      quests: [{
        id: asQuestId("q_item"), name: "item quest", description: "t",
        objectives: [{ kind: "obtain_item", itemId }],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" },
        tags: [], kind: "side", status: "active",
      }],
    }, [{ type: "item_obtained", itemId, locationId: asLocationId("loc_1"), occurredAt: "2026-01-01" }]);
    const result = reconcileQuests(ws, deps);
    expect(result.events[0]?.type).toBe("quest_completed");
    expect(result.nextWorldState.quests[0]?.status).toBe("completed");
  });

  it("只有明确 NPC objective 且当前 action participant 精确匹配时才产生 kept_promise signal", () => {
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "n", role: "r", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const ws = withProjection(withProjection(baseWs, { npcs: [npc] }), {
      quests: [{
        id: asQuestId("q_npc"), name: "npc quest", description: "t",
        objectives: [{ kind: "talk_to_npc", npcId: npc.id }],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "active",
      }],
    });
    const result = reconcileQuests(ws, deps, {
      talkToNpcSession: { npcId: npc.id, completed: true },
      actionContext: { participantNpcId: npc.id, actionId: "quest_action_1", turnNumber: 4 },
    });
    expect(result.nextWorldState.quests[0]?.status).toBe("completed");
    const npcRecord = entitiesOfKind(result.nextWorldState.entityStore, "npc").find((record) => record.core.id === npc.id);
    const edge = npcRecord?.relationships.outgoing.find((candidate) => candidate.targetId === PLAYER_ENTITY_ID);
    expect(edge?.evidence.at(-1)).toMatchObject({ signal: "kept_promise", actionId: "quest_action_1", turnNumber: 4 });
  });

  it("地点、敌人、物品、事实 objective 即使有 NPC focus 也不产生关系 signal", () => {
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "n", role: "r", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const itemId = asItemId("item_neutral");
    const fact: WorldFactEntry = { factId: asFactId("fact_neutral"), text: "fact", source: "generated", discovered: true };
    const enemy: EnemyEntry = { id: asEnemyId("enemy_neutral"), name: "enemy", tier: "normal", stats: { hp: 1, attack: 1, defense: 1 }, locationId: loc.id, tags: [] };
    const ws = withProjection(withProjection(baseWs, { npcs: [npc] }), {
      items: [{ id: itemId, name: "item", description: "d", kind: "quest", tags: [] }],
      worldFacts: [fact],
      enemies: [enemy],
      inventory: [itemId],
      visitedLocationIds: [loc.id],
      defeatedEnemyIds: [enemy.id],
      quests: [
        { id: asQuestId("q_loc"), name: "loc", description: "t", objectives: [{ kind: "visit_location", locationId: loc.id }], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "active" },
        { id: asQuestId("q_item"), name: "item", description: "t", objectives: [{ kind: "obtain_item", itemId }], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "active" },
        { id: asQuestId("q_fact"), name: "fact", description: "t", objectives: [{ kind: "discover_fact", factId: fact.factId }], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "active" },
        { id: asQuestId("q_enemy"), name: "enemy", description: "t", objectives: [{ kind: "defeat_enemy", enemyId: enemy.id }], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "active" },
      ],
    });
    const result = reconcileQuests(ws, deps, {
      talkToNpcSession: { npcId: npc.id, completed: true },
      actionContext: { participantNpcId: npc.id, actionId: "neutral_action", turnNumber: 5 },
    });
    expect(result.events.filter((event) => event.type === "quest_completed")).toHaveLength(4);
    const npcRecord = entitiesOfKind(result.nextWorldState.entityStore, "npc").find((record) => record.core.id === npc.id);
    expect(npcRecord?.relationships.outgoing.flatMap((edge) => edge.evidence)).toEqual([]);
  });

  it("已被 dialogue/give_item 使用的 actionId 重放时不重复奖励关系", () => {
    const actionId = "dialogue_used_action";
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "n", role: "r", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: {
        npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [{
          turnNumber: 3, actionId, locationId: asLocationId("loc_1"), dialogueAct: "ask",
          topicSummary: "dialogue", outcome: "positive", learnedFactIds: [], relationshipDelta: 3, summary: "dialogue",
        }], relationship: { affinity: 3 }, emotion: "neutral", goals: [],
      },
    };
    const ws = withProjection(withProjection(baseWs, { npcs: [npc] }), {
      quests: [{
        id: asQuestId("q_replay"), name: "npc quest", description: "t",
        objectives: [{ kind: "talk_to_npc", npcId: npc.id }],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "active",
      }],
    });
    const result = reconcileQuests(ws, deps, {
      talkToNpcSession: { npcId: npc.id, completed: true },
      actionContext: { participantNpcId: npc.id, actionId, turnNumber: 3 },
    });
    expect(result.nextWorldState.quests[0]?.status).toBe("completed");
    const npcRecord = entitiesOfKind(result.nextWorldState.entityStore, "npc").find((record) => record.core.id === npc.id);
    expect(npcRecord?.history.interactions).toHaveLength(1);
    expect(npcRecord?.relationships.outgoing.flatMap((edge) => edge.evidence)).toEqual([]);
  });

  it("history/evidence 窗口裁剪后仍由持久化 eventLedger actionId 阻止 quest signal replay", () => {
    const actionId = "old_dialogue_action";
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "n", role: "r", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: {
        npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [],
        interactionHistory: Array.from({ length: 10 }, (_, index) => ({
          turnNumber: index + 10, actionId: `newer_${index}`, locationId: asLocationId("loc_1"), dialogueAct: "ask",
          topicSummary: "newer", outcome: "positive", learnedFactIds: [], relationshipDelta: 0, summary: "newer",
        })),
        relationship: { affinity: 0 }, emotion: "neutral", goals: [],
      },
    };
    const replayEvidence: GameEvent = {
      type: "npc_dialogue_completed", npcId: npc.id, actionId, occurredAt: "2026-01-01",
    };
    const ws = withProjection(withProjection(baseWs, { npcs: [npc] }), {
      quests: [{
        id: asQuestId("q_replay_ledger"), name: "npc quest", description: "t",
        objectives: [{ kind: "talk_to_npc", npcId: npc.id }],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "active",
      }],
    }, [replayEvidence]);
    const result = reconcileQuests(ws, deps, {
      talkToNpcSession: { npcId: npc.id, completed: true },
      actionContext: { participantNpcId: npc.id, actionId, turnNumber: 20 },
    });
    expect(result.nextWorldState.quests[0]?.status).toBe("completed");
    const npcRecord = entitiesOfKind(result.nextWorldState.entityStore, "npc").find((record) => record.core.id === npc.id);
    expect(npcRecord?.relationships.outgoing.flatMap((edge) => edge.evidence)).toEqual([]);
  });

  it("当前回合由 actionContext 明确标记为新 action 时，不因 reconcile 前已写入 history 而跳过 signal", () => {
    const actionId = "current_dialogue_action";
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "n", role: "r", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: {
        npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [{
          turnNumber: 4, actionId, locationId: asLocationId("loc_1"), dialogueAct: "ask",
          topicSummary: "current", outcome: "positive", learnedFactIds: [], relationshipDelta: 0, summary: "current",
        }], relationship: { affinity: 0 }, emotion: "neutral", goals: [],
      },
    };
    const ws = withProjection(withProjection(baseWs, { npcs: [npc] }), {
      quests: [{
        id: asQuestId("q_current"), name: "npc quest", description: "t",
        objectives: [{ kind: "talk_to_npc", npcId: npc.id }],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "active",
      }],
    });
    const result = reconcileQuests(ws, deps, {
      talkToNpcSession: { npcId: npc.id, completed: true },
      actionContext: { participantNpcId: npc.id, actionId, turnNumber: 4, actionWasAlreadyUsed: false },
    });
    const npcRecord = entitiesOfKind(result.nextWorldState.entityStore, "npc").find((record) => record.core.id === npc.id);
    expect(npcRecord?.relationships.outgoing.flatMap((edge) => edge.evidence)).toMatchObject([
      expect.objectContaining({ signal: "kept_promise", actionId }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Task 15：任务 outcome 驱动地点与后续任务解锁。
// ---------------------------------------------------------------------------
describe("reconcileQuests 完整 outcome", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  function baseWs(overrides?: Partial<EntityCompatibilityProjection>): WorldState {
    const ws = createInitialWorldState({
      generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: loc1,
      startingItemIds: [],
    });
    return overrides === undefined ? ws : withProjection(ws, overrides);
  }
  const deps = { now: () => "2026-01-01" };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街市", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };

  it("完成第一幕 → onSuccess advance_story 不携带世界状态变化（不产出 quest_unlocked/location_unlocked）", () => {
    const ws = baseWs({
      locations: [loc1, loc2],
      quests: [
        {
          id: asQuestId("q1"), name: "开场", description: "t",
          objectives: [{ kind: "visit_location", locationId: asLocationId("loc_1") }],
          onSuccess: { kind: "advance_story" },
          onFailure: { kind: "closed" }, tags: [], kind: "main", status: "active",
        },
        { id: asQuestId("q2"), name: "后续", description: "t", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "locked" },
      ],
      visitedLocationIds: [asLocationId("loc_1")],
      unlockedLocationIds: [asLocationId("loc_1")],
    });
    const result = reconcileQuests(ws, deps);
    expect(result.nextWorldState.quests.find((q) => q.id === asQuestId("q1"))?.status).toBe("completed");
    // advance_story 是幕推进信号（Task 3 消费），本阶段零世界状态变化：
    expect(result.nextWorldState.quests.find((q) => q.id === asQuestId("q2"))?.status).toBe("locked");
    expect(result.nextWorldState.unlockedLocationIds).toEqual([asLocationId("loc_1")]);
    const types = result.events.map((e) => e.type);
    expect(types).toContain("quest_completed");
    expect(types).not.toContain("quest_unlocked");
    expect(types).not.toContain("location_unlocked");
  });

  it("解锁后的任务可继续检查但不重复完成已完成任务", () => {
    const ws = baseWs({
      quests: [
        { id: asQuestId("q1"), name: "a", description: "t", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "completed" },
      ],
    });
    const result = reconcileQuests(ws, deps);
    expect(result.events).toHaveLength(0);
    expect(result.nextWorldState.quests[0]?.status).toBe("completed");
  });

  it("onSuccess resolve_story 只保持完成，不绕过 ending resolver（不产出 ending_reached）", () => {
    const ws = baseWs({
      quests: [
        {
          id: asQuestId("q1"), name: "a", description: "t",
          objectives: [{ kind: "visit_location", locationId: asLocationId("loc_1") }],
          onSuccess: { kind: "resolve_story" },
          onFailure: { kind: "closed" }, tags: [], kind: "main", status: "active",
        },
      ],
      visitedLocationIds: [asLocationId("loc_1")],
    });
    const result = reconcileQuests(ws, deps);
    expect(result.events.map((e) => e.type)).not.toContain("ending_reached");
    expect(result.nextWorldState.quests[0]?.status).toBe("completed");
  });

  it("onFailure closed：failed 任务关闭", () => {
    const ws = baseWs({
      quests: [
        { id: asQuestId("q1"), name: "a", description: "t", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "failed" },
      ],
    });
    const result = reconcileQuests(ws, deps);
    expect(result.nextWorldState.quests[0]?.status).toBe("closed");
  });

  it("onFailure advance_story：failed 任务不携带解锁语义（不产出 quest_unlocked）", () => {
    const ws = baseWs({
      quests: [
        { id: asQuestId("q1"), name: "a", description: "t", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "advance_story" }, tags: [], kind: "main", status: "failed" },
        { id: asQuestId("q2"), name: "b", description: "t", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "locked" },
      ],
    });
    const result = reconcileQuests(ws, deps);
    expect(result.nextWorldState.quests.find((q) => q.id === asQuestId("q2"))?.status).toBe("locked");
    expect(result.events.map((e) => e.type)).not.toContain("quest_unlocked");
  });
});
