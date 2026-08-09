import { describe, it, expect } from "vitest";
import { reconcileQuests } from "./reconcileQuests";
import { createInitialWorldState, appendNpc, type NpcEntry, type LocationEntry } from "@/game/domain/worldState";
import { asLocationId, asNpcId, asQuestId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { WorldState } from "@/game/domain/worldState";

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
    const ws: WorldState = {
      ...appendNpc(baseWs, npc),
      quests: [{
        id: asQuestId("q1"), name: "talk quest", description: "t",
        objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_1") }],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" },
        tags: [], kind: "side", status: "active",
      }],
    };
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
    const ws: WorldState = {
      ...appendNpc(baseWs, npc),
      quests: [{
        id: asQuestId("q1"), name: "talk quest", description: "t",
        objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_1") }],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" },
        tags: [], kind: "side", status: "active",
      }],
    };
    const result = reconcileQuests(ws, deps);
    expect(result.events).toHaveLength(0);
    expect(result.nextWorldState.quests[0]?.status).toBe("active");
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
  function baseWs(overrides?: Partial<WorldState>): WorldState {
    const ws = createInitialWorldState({
      generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: loc1,
      startingItemIds: [],
    });
    return overrides ? { ...ws, ...overrides } : ws;
  }
  const deps = { now: () => "2026-01-01" };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街市", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };

  it("完成第一幕 → unlock_quests 与 location_unlocked 同回合", () => {
    const ws = baseWs({
      locations: [loc1, loc2],
      quests: [
        {
          id: asQuestId("q1"), name: "开场", description: "t",
          objectives: [{ kind: "visit_location", locationId: asLocationId("loc_1") }],
          onSuccess: { kind: "unlock_quests", questIds: [asQuestId("q2")], locationIds: [asLocationId("loc_2")] },
          onFailure: { kind: "closed" }, tags: [], kind: "main", status: "active",
        },
        { id: asQuestId("q2"), name: "后续", description: "t", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "locked" },
      ],
      visitedLocationIds: [asLocationId("loc_1")],
      unlockedLocationIds: [asLocationId("loc_1")],
    });
    const result = reconcileQuests(ws, deps);
    expect(result.nextWorldState.quests.find((q) => q.id === asQuestId("q1"))?.status).toBe("completed");
    expect(result.nextWorldState.quests.find((q) => q.id === asQuestId("q2"))?.status).toBe("active");
    expect(result.nextWorldState.unlockedLocationIds).toContain(asLocationId("loc_2"));
    // 同回合事件：quest_completed + quest_unlocked + location_unlocked
    const types = result.events.map((e) => e.type);
    expect(types).toContain("quest_completed");
    expect(types).toContain("quest_unlocked");
    expect(types).toContain("location_unlocked");
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

  it("onSuccess reach_ending 只保持完成，不绕过 ending resolver（不产出 ending_reached）", () => {
    const ws = baseWs({
      quests: [
        {
          id: asQuestId("q1"), name: "a", description: "t",
          objectives: [{ kind: "visit_location", locationId: asLocationId("loc_1") }],
          onSuccess: { kind: "reach_ending", endingId: "end_1" as never },
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

  it("onFailure unlock_quests：failed 任务解锁失败路线", () => {
    const ws = baseWs({
      quests: [
        { id: asQuestId("q1"), name: "a", description: "t", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "unlock_quests", questIds: [asQuestId("q2")] }, tags: [], kind: "main", status: "failed" },
        { id: asQuestId("q2"), name: "b", description: "t", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "side", status: "locked" },
      ],
    });
    const result = reconcileQuests(ws, deps);
    expect(result.nextWorldState.quests.find((q) => q.id === asQuestId("q2"))?.status).toBe("active");
    expect(result.events.map((e) => e.type)).toContain("quest_unlocked");
  });
});
