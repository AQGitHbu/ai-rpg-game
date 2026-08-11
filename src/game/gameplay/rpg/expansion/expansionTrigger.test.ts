import { describe, it, expect } from "vitest";
import { checkExpansionTrigger } from "./expansionTrigger";
import { createInitialWorldState, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId, asQuestId, asEnemyId } from "@/game/domain/worldEntity";
import type { Action } from "@/game/domain/action";
import type { RuleEngineResult } from "@/game/gameplay/rpg/ruleEngine";

describe("checkExpansionTrigger", () => {
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  const action: Action = { type: "move", locationId: asLocationId("loc_unknown") };

  it("triggers entity_not_found when ruleEngine returns UNKNOWN_LOCATION", () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_LOCATION",
      feedback: "Action rejected: UNKNOWN_LOCATION",
    };
    const result = checkExpansionTrigger(initialResult, ws, ss, action);
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("entity_not_found");
  });

  it("triggers entity_not_found when ruleEngine returns UNKNOWN_NPC", () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_NPC",
      feedback: "Action rejected: UNKNOWN_NPC",
    };
    const talkAction: Action = { type: "talk", npcId: asNpcId("npc_unknown"), dialogueAct: "ask" };
    const result = checkExpansionTrigger(initialResult, ws, ss, talkAction);
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("entity_not_found");
  });

  it("does NOT trigger when ruleEngine succeeds", () => {
    const initialResult: RuleEngineResult = {
      ok: true,
      nextWorldState: ws,
      nextStoryState: ss,
      resolvedEvent: {
        actionId: "a1", status: "success", eventKind: "travel",
        facts: [], stateChanges: [], costs: [], rewards: [],
        triggeredEvents: [], rejectedEffects: [],
      },
    };
    const result = checkExpansionTrigger(initialResult, ws, ss, action);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_trigger");
  });

  it("does NOT trigger on non-entity rejections (e.g. LOCATION_NOT_CONNECTED)", () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "LOCATION_NOT_CONNECTED",
      feedback: "Action rejected: LOCATION_NOT_CONNECTED",
    };
    const result = checkExpansionTrigger(initialResult, ws, ss, action);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_trigger");
  });

  it("does NOT trigger when budget has no room for locations expansion", () => {
    const ssMaxed = { ...ss, budget: { ...ss.budget, locations: { ...ss.budget.locations, expanded: ss.budget.locations.max } } };
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_LOCATION",
      feedback: "Action rejected: UNKNOWN_LOCATION",
    };
    const result = checkExpansionTrigger(initialResult, ws, ssMaxed, action);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_trigger");
  });

  it("does NOT trigger when budget has no room for npcs expansion (UNKNOWN_NPC)", () => {
    const ssMaxedNpcs = { ...ss, budget: { ...ss.budget, npcs: { ...ss.budget.npcs, expanded: ss.budget.npcs.max } } };
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_NPC",
      feedback: "Action rejected: UNKNOWN_NPC",
    };
    const talkAction: Action = { type: "talk", npcId: asNpcId("npc_unknown"), dialogueAct: "ask" };
    const result = checkExpansionTrigger(initialResult, ws, ssMaxedNpcs, talkAction);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_trigger");
  });

  // ── Task 27：优先复用（主线任务角色缺口时可复用已有角色） ──

  it("returns reuse signal when a reusable NPC role can fill a main quest role gap", () => {
    const npc: NpcEntry = {
      id: asNpcId("npc_guard"),
      name: "守卫",
      role: "守卫",
      description: "城门守卫，似乎知道些消息。",
      locationId: asLocationId("loc_1"),
      isCompanion: false,
      tags: [],
      met: false,
      memory: {
        npcId: asNpcId("npc_guard"),
        knownFactIds: [],
        hiddenFactIds: [],
        interactionHistory: [],
        relationship: { affinity: 0 },
        emotion: "neutral",
        goals: [],
      },
    };
    const wsWithGuard = {
      ...ws,
      npcs: [npc],
      quests: [{
        id: asQuestId("quest_1"),
        name: "主线",
        description: "找到失踪的商人",
        objectives: [{ kind: "talk_to_npc" as const, npcId: asNpcId("npc_merchant_missing") }],
        onSuccess: { kind: "closed" as const },
        onFailure: { kind: "closed" as const },
        tags: [],
        kind: "main" as const,
        status: "active" as const,
      }],
    };
    const okResult: RuleEngineResult = {
      ok: true,
      nextWorldState: wsWithGuard,
      nextStoryState: ss,
      resolvedEvent: {
        actionId: "a_reuse", status: "success", eventKind: "observe",
        facts: [], stateChanges: [], costs: [], rewards: [],
        triggeredEvents: [], rejectedEffects: [],
      },
    };
    const result = checkExpansionTrigger(okResult, wsWithGuard, ss, { type: "explore" });
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("reuse");
    expect(result.reuse).toBeDefined();
    expect(result.reuse!.id).toBe("npc_guard");
    expect(result.reuse!.kind).toBe("npc");
  });

  it("still triggers entity_not_found for a specific unknown NPC (creates, does not guess reuse)", () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_NPC",
      feedback: "Action rejected: UNKNOWN_NPC",
    };
    const talkAction: Action = { type: "talk", npcId: asNpcId("npc_unknown"), dialogueAct: "ask" };
    const result = checkExpansionTrigger(initialResult, ws, ss, talkAction);
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("entity_not_found");
    expect(result.reuse).toBeUndefined();
  });

  // ── Task 27：低张力与收束信号 ──

  it("triggers low_tension when tension is persistently low with budget room and not in climax", () => {
    const lowSs = {
      ...ss,
      tension: 12,
      currentAct: 2,
      nextPacingNeed: "develop" as const,
    };
    const okResult: RuleEngineResult = {
      ok: true,
      nextWorldState: ws,
      nextStoryState: lowSs,
      resolvedEvent: {
        actionId: "a_ok", status: "success", eventKind: "observe",
        facts: [], stateChanges: [], costs: [], rewards: [],
        triggeredEvents: [], rejectedEffects: [],
      },
    };
    const exploreAction: Action = { type: "explore" };
    const result = checkExpansionTrigger(okResult, ws, lowSs, exploreAction);
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("low_tension");
  });

  it("does NOT trigger low_tension when tension is not low", () => {
    const midSs = { ...ss, tension: 50, currentAct: 2, nextPacingNeed: "develop" as const };
    const okResult: RuleEngineResult = {
      ok: true,
      nextWorldState: ws,
      nextStoryState: midSs,
      resolvedEvent: {
        actionId: "a_ok2", status: "success", eventKind: "observe",
        facts: [], stateChanges: [], costs: [], rewards: [],
        triggeredEvents: [], rejectedEffects: [],
      },
    };
    const result = checkExpansionTrigger(okResult, ws, midSs, { type: "explore" });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no_trigger");
  });

  it("returns reuse (enemy) on low tension when a reusable hostile enemy exists", () => {
    const lowSs = { ...ss, tension: 12, currentAct: 2, nextPacingNeed: "develop" as const };
    const wsWithEnemy = {
      ...ws,
      enemies: [{ id: asEnemyId("enemy_wolf"), name: "狼", tier: "normal" as const, stats: { hp: 20, attack: 4, defense: 0 }, locationId: asLocationId("loc_1"), tags: [] }],
    };
    const okResult: RuleEngineResult = {
      ok: true,
      nextWorldState: wsWithEnemy,
      nextStoryState: lowSs,
      resolvedEvent: {
        actionId: "a_lowreuse", status: "success", eventKind: "observe",
        facts: [], stateChanges: [], costs: [], rewards: [],
        triggeredEvents: [], rejectedEffects: [],
      },
    };
    const result = checkExpansionTrigger(okResult, wsWithEnemy, lowSs, { type: "explore" });
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("reuse");
    expect(result.reuse!.kind).toBe("enemy");
    expect(result.reuse!.id).toBe("enemy_wolf");
  });

  it("gives closure signal and does NOT trigger during climax pacing", () => {
    const climaxSs = {
      ...ss,
      tension: 20,
      currentAct: 3,
      targetActs: 3,
      storyProgress: 90,
      nextPacingNeed: "climax" as const,
    };
    const okResult: RuleEngineResult = {
      ok: true,
      nextWorldState: ws,
      nextStoryState: climaxSs,
      resolvedEvent: {
        actionId: "a_climax", status: "success", eventKind: "observe",
        facts: [], stateChanges: [], costs: [], rewards: [],
        triggeredEvents: [], rejectedEffects: [],
      },
    };
    const result = checkExpansionTrigger(okResult, ws, climaxSs, { type: "explore" });
    expect(result.triggered).toBe(false);
    expect(result.closureSignal).toBe("climax");
  });

  it("gives closure signal and does NOT trigger when hard limit reached", () => {
    const hardLimitSs = {
      ...ss,
      tension: 15,
      currentAct: 2,
      budget: {
        ...ss.budget,
        npcs: { opening: 30, expanded: 0, max: 10 },
        hardLimit: { locations: 40, npcs: 30 },
      },
    };
    const okResult: RuleEngineResult = {
      ok: true,
      nextWorldState: ws,
      nextStoryState: hardLimitSs,
      resolvedEvent: {
        actionId: "a_hard", status: "success", eventKind: "observe",
        facts: [], stateChanges: [], costs: [], rewards: [],
        triggeredEvents: [], rejectedEffects: [],
      },
    };
    const result = checkExpansionTrigger(okResult, ws, hardLimitSs, { type: "explore" });
    expect(result.triggered).toBe(false);
    expect(result.closureSignal).toBe("hard_limit");
  });

  // ── Task 27：任务角色缺口 ──

  it("triggers quest_gap when a main quest objective references a missing entity", () => {
    const wsWithQuest = {
      ...ws,
      quests: [{
        id: asQuestId("quest_1"),
        name: "主线",
        description: "找到失踪的商人",
        objectives: [{ kind: "talk_to_npc" as const, npcId: asNpcId("npc_merchant_missing") }],
        onSuccess: { kind: "closed" as const },
        onFailure: { kind: "closed" as const },
        tags: [],
        kind: "main" as const,
        status: "active" as const,
      }],
    };
    const okResult: RuleEngineResult = {
      ok: true,
      nextWorldState: wsWithQuest,
      nextStoryState: ss,
      resolvedEvent: {
        actionId: "a_questgap", status: "success", eventKind: "observe",
        facts: [], stateChanges: [], costs: [], rewards: [],
        triggeredEvents: [], rejectedEffects: [],
      },
    };
    const result = checkExpansionTrigger(okResult, wsWithQuest, ss, { type: "explore" });
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("quest_gap");
  });
});
