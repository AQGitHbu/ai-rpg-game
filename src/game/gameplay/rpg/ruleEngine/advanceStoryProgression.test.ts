import { describe, it, expect } from "vitest";
import { advanceStoryProgression } from "./advanceStoryProgression";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import type { GameEvent } from "@/game/domain/events";
import { asQuestId, asLocationId } from "@/game/domain/scenarioBlueprint";

function makeWorld(overrides?: Partial<WorldState>): WorldState {
  return {
    version: 2,
    generation: { generationId: "" as any, seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
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
    towns: [],
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

  it("sets endingAllowed at final act with high progress", () => {
    const nearEnd = {
      ...ss,
      currentAct: 3,
      targetActs: 3,
      storyProgress: 85,
    };
    const ws = makeWorld();
    const result = advanceStoryProgression(ws, nearEnd, []);
    expect(result.nextStoryState.endingAllowed).toBe(true);
  });

  it("does not set endingAllowed before final act", () => {
    const midGame = { ...ss, currentAct: 2, targetActs: 3, storyProgress: 50 };
    const ws = makeWorld();
    const result = advanceStoryProgression(ws, midGame, []);
    expect(result.nextStoryState.endingAllowed).toBe(false);
  });

  it("resolves thread when main quest completed", () => {
    const ws = makeWorld({
      quests: [{
        id: asQuestId("q_main_1"),
        name: "主线1",
        description: "",
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
    const ssWithActThread = { ...ss, unresolvedThreads: [...ss.unresolvedThreads, "act_1"] };
    const result = advanceStoryProgression(ws, ssWithActThread, events);
    expect(result.nextStoryState.unresolvedThreads).not.toContain("act_1");
    expect(result.nextStoryState.unresolvedThreads).toContain("act_2");
  });
});
