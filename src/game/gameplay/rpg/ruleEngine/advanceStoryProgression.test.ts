import { describe, it, expect } from "vitest";
import { advanceStoryProgression } from "./advanceStoryProgression";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import type { GameEvent } from "@/game/domain/events";
import { asQuestId, asLocationId, asGenerationId } from "@/game/domain/worldEntity";

function makeWorld(overrides?: Partial<WorldState>): WorldState {
  return {
    version: 2,
    generation: { generationId: asGenerationId("test"), seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    locations: [],
    currentLocationId: asLocationId("loc_1"),
    unlockedLocationIds: [],
    visitedLocationIds: [],
    npcs: [],
    items: [],
    inventory: [],
    worldFacts: [],
    quests: [],
    enemies: [],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    endings: [],
    ending: null,
    factions: [],
    eventLedger: [],
    ...overrides,
  };
}

describe("advanceStoryProgression", () => {
  const ss = createInitialStoryState({
    gameLength: "short",
    initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 },
  });

  it("does not advance act when no main quest completed", () => {
    const ws = makeWorld();
    const events: GameEvent[] = [];
    const result = advanceStoryProgression(ws, ss, events);
    expect(result.nextStoryState.currentAct).toBe(1);
  });

  it("advances act when main quest completed (act 1 → 2)", () => {
    const ws = makeWorld({
      quests: [{
        id: asQuestId("q_main_1"),
        name: "主线1",
        description: "测试",
        objectives: [],
        onSuccess: { kind: "closed" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 1,
        status: "completed",
      }],
    });
    const events: GameEvent[] = [
      { type: "quest_completed", questId: asQuestId("q_main_1"), occurredAt: "t" },
    ];
    const result = advanceStoryProgression(ws, ss, events);
    expect(result.nextStoryState.currentAct).toBe(2);
    expect(result.nextStoryState.storyProgress).toBeGreaterThanOrEqual(33);
  });

  it("flags evolution.status needs_next_act when a non-final act completes", () => {
    const ws = makeWorld({
      quests: [{
        id: asQuestId("q_main_1"), name: "主线1", description: "测试", objectives: [],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [],
        kind: "main", stage: 1, status: "completed",
      }],
    });
    const events: GameEvent[] = [
      { type: "quest_completed", questId: asQuestId("q_main_1"), occurredAt: "t" },
    ];
    const result = advanceStoryProgression(ws, ss, events);
    expect(result.nextStoryState.currentAct).toBe(2);
    expect(result.nextStoryState.evolution.status).toBe("needs_next_act");
  });

  it("flags evolution.status needs_ending_pair when the final act's main quest completes", () => {
    const ws = makeWorld({
      quests: [{
        id: asQuestId("q_final"), name: "终局", description: "测试", objectives: [],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [],
        kind: "main", stage: 3, status: "completed",
      }],
    });
    const events: GameEvent[] = [
      { type: "quest_completed", questId: asQuestId("q_final"), occurredAt: "t" },
    ];
    const finalAct = { ...ss, currentAct: 3, targetActs: 3 };
    const result = advanceStoryProgression(ws, finalAct, events);
    expect(result.nextStoryState.evolution.status).toBe("needs_ending_pair");
  });

  it("sets endingAllowed at final act with high progress and no unresolved thread", () => {
    const nearEnd = {
      ...ss,
      currentAct: 3,
      targetActs: 3,
      storyProgress: 85,
      unresolvedThreads: [],
    };
    const ws = makeWorld({
      quests: [{
        id: asQuestId("q_final"), name: "终局", description: "测试", objectives: [],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [],
        kind: "main", stage: 3, status: "completed",
      }],
    });
    const result = advanceStoryProgression(ws, nearEnd, []);
    expect(result.nextStoryState.endingAllowed).toBe(true);
  });

  it("does not allow an ending before the current final-act quest is materialized", () => {
    const lateAct = {
      ...ss,
      currentAct: 3,
      targetActs: 3,
      storyProgress: 100,
      unresolvedThreads: ["thread_main"],
    };
    const ws = makeWorld({
      quests: [
        {
          id: asQuestId("q_main_1"), name: "主线1", description: "", objectives: [],
          onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [],
          kind: "main", stage: 1, status: "completed",
        },
        {
          id: asQuestId("q_main_2"), name: "主线2", description: "", objectives: [],
          onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [],
          kind: "main", stage: 2, status: "completed",
        },
      ],
    });

    const result = advanceStoryProgression(ws, lateAct, []);

    expect(result.nextStoryState.endingAllowed).toBe(false);
    expect(result.nextStoryState.evolution.status).toBe("needs_next_act");
    expect(result.nextStoryState.unresolvedThreads).toContain("thread_main");
  });

  it("does not set endingAllowed with unresolved main thread even at final act (Spec §13.3)", () => {
    const nearEnd = {
      ...ss,
      currentAct: 3,
      targetActs: 3,
      storyProgress: 90,
      unresolvedThreads: ["thread_main"],
    };
    const ws = makeWorld();
    const result = advanceStoryProgression(ws, nearEnd, []);
    expect(result.nextStoryState.endingAllowed).toBe(false);
  });

  it("does not set endingAllowed before final act", () => {
    const midGame = { ...ss, currentAct: 2, targetActs: 3, storyProgress: 50 };
    const ws = makeWorld();
    const result = advanceStoryProgression(ws, midGame, []);
    expect(result.nextStoryState.endingAllowed).toBe(false);
  });

  it("recycles main thread when all main quests resolved at final act", () => {
    const ws = makeWorld({
      quests: [
        {
          id: asQuestId("q_main_1"), name: "主线1", description: "", objectives: [],
          onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [],
          kind: "main", stage: 3, status: "completed",
        },
      ],
    });
    const events: GameEvent[] = [
      { type: "quest_completed", questId: asQuestId("q_main_1"), occurredAt: "t" },
    ];
    const finalAct = { ...ss, currentAct: 3, targetActs: 3, unresolvedThreads: ["thread_main"] };
    const result = advanceStoryProgression(ws, finalAct, events);
    expect(result.nextStoryState.unresolvedThreads).not.toContain("thread_main");
  });
});
