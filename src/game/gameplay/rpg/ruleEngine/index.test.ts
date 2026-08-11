import { describe, it, expect } from "vitest";
import { ruleEngine, resolveTurn } from "./index";
import { createInitialWorldState, appendNpc, appendLocation, type LocationEntry, type NpcEntry, type EnemyEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId, asEnemyId, type QuestId, type EndingId } from "@/game/domain/worldEntity";
import { asTurnId } from "@/game/domain/events";

describe("ruleEngine facade", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const ws = { ...appendLocation(baseWs, loc2), unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01" };

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
    const wsWithNpc = appendNpc(ws, npc);
    const result = ruleEngine(wsWithNpc, ss, { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" }, "act_3", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextStoryState.tension).toBe(33); // 30 + 3 (npc_met)
    }
  });
});

describe("ruleEngine status passthrough", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const ws = { ...appendLocation(baseWs, loc2), unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01" };

  it("passes partial_success from resolveByType to ResolvedEvent", () => {
    const hostileNpc: NpcEntry = {
      id: asNpcId("npc_hostile"), name: "卫兵", role: "守卫", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_hostile"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: -70 }, emotion: "angry", goals: [] },
    };
    const wsWithHostile = appendNpc(ws, hostileNpc);
    const result = ruleEngine(wsWithHostile, ss, { type: "talk", npcId: asNpcId("npc_hostile"), dialogueAct: "ask" }, "act_1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.status).toBe("partial_success");
    }
  });

  it("passes blocked status for move during battle", () => {
    const wsInBattle = { ...ws, battle: { status: "active" as const, enemyId: asEnemyId("e1"), playerHp: 50, enemyHp: 30, round: 1 } };
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
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const ws = { ...appendLocation(baseWs, loc2), unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01" };
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
    expect(r.domainEvents.map((e) => e.type)).toEqual(["location_visited"]);
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
    expect(result.resolution.domainEvents.map((e) => e.type)).toEqual(["player_intent_expressed"]);
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
    const wsWithHostile = appendNpc(ws, hostileNpc);
    const result = resolveTurn(wsWithHostile, ss, { type: "talk", npcId: asNpcId("npc_hostile"), dialogueAct: "ask" }, "act_3", baseRevision, turnId, "fixed_choice", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected rejection: ${result.code}`);
    const r = result.resolution;
    expect(r.primaryResult.status).toBe("partial_success");
    expect(r.primaryResult.eventKind).toBe("dialogue");
    expect(r.domainEvents.map((e) => e.type)).toEqual(["npc_met"]);
    expect(r.nextWorldState.eventLedger).toEqual([...wsWithHostile.eventLedger, ...r.domainEvents]);
  });

  it("orders domain events resolver → quest → ending and aligns eventLedger; bumps turn once", () => {
    const questId = "quest_1" as QuestId;
    const questWs: typeof ws = {
      ...ws,
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
    };
    // Spec §13.1：最终幕 + 无未决主线 thread → advance 推导 endingAllowed=true，
    // resolveEnding 最后调用并同回合抵达结局，无需额外点击。
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
    expect(r.domainEvents.map((e) => e.type)).toEqual([
      "location_visited",
      "quest_completed",
      "ending_reached",
    ]);
    expect(r.nextWorldState.eventLedger).toEqual([
      ...questWs.eventLedger,
      ...r.domainEvents,
    ]);
    expect(r.nextWorldState.quests[0]?.status).toBe("completed");
    expect(r.nextWorldState.ending).toEqual({ endingId: "ending_1", outcome: "success" });
    expect(r.turnNumber).toBe(ss.turnNumber + 1); // 非事件数（3 个事件也只加 1）
    expect(r.nextStoryState.turnNumber).toBe(r.turnNumber);
    expect(r.primaryResult.triggeredEvents).toEqual([
      "location_visited", "quest_completed", "ending_reached",
    ]);
  });

  it("blocked action keeps state and produces no commit payload", () => {
    const wsInBattle = { ...ws, battle: { status: "active" as const, enemyId: asEnemyId("e1"), playerHp: 50, enemyHp: 30, round: 1 } };
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
    const attackWs = {
      ...createInitialWorldState({
        generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
        player: { name: "侠客", identity: "剑客", stats: { hp: 30, attack: 6, defense: 4 } },
        startingLocation: startLoc,
        startingItemIds: [],
      }),
      enemies: [{
        id: asEnemyId("enemy_1"), name: "山贼", tier: "normal" as const,
        stats: { hp: 1, attack: 5, defense: 2 },
        locationId: asLocationId("loc_1"), tags: [],
      }],
    };
    const battleTurnId = asTurnId("turn_20");
    const first = resolveTurn(attackWs, ss, { type: "attack", enemyId: asEnemyId("enemy_1") }, "act_6", baseRevision, battleTurnId, "fixed_choice", deps);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("battle start unexpectedly rejected");
    expect(first.resolution.primaryResult.status).toBe("success");
    expect(first.resolution.domainEvents.map((e) => e.type)).toEqual(["battle_started"]);
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
    expect(r.domainEvents.map((e) => e.type)).toEqual([
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
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const enemy: EnemyEntry = {
    id: asEnemyId("enemy_1"), name: "山贼", tier: "normal" as const,
    stats: { hp: 10, attack: 5, defense: 2 },
    locationId: asLocationId("loc_1"), tags: [],
  };
  const ws = {
    ...appendLocation(baseWs, loc2),
    enemies: [enemy],
    unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")],
  };
  const deps = { now: () => "2026-01-01" };
  const baseRevision = 7;
  const turnId = asTurnId("turn_9");

  function makeSs(candidatePool: ReturnType<typeof createInitialStoryState>["candidateEventPool"]) {
    return {
      ...createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 0 } }),
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
    const types = r.domainEvents.map((e) => e.type);
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
    const activated = r.domainEvents.filter((e) => e.type === "candidate_event_activated");
    expect(activated.length).toBe(1);
    // 过期候选从池移除并记录 expired 审计
    expect(r.domainEvents.some((e) => e.type === "candidate_event_expired" && e.candidateId === "ce-old")).toBe(true);
    const remainingIds = r.nextStoryState.candidateEventPool.map((c) => c.id);
    expect(remainingIds).not.toContain("ce-old");
    // 未批准者保留在池（ce-a 或 ce-b 之一）
    expect(remainingIds.length).toBe(1);
    // 已批准者从池移除
    expect(remainingIds).not.toContain(activated[0]!.candidateId);
  });
});