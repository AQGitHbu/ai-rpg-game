import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { advanceStoryProgression } from "./advanceStoryProgression";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import { createWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import type { WorldState } from "@/game/domain/worldState";
import type { NarrativeEventDraft, CommittedNarrativeEvent, NarrativeEventPayload } from "@/game/domain/events";
import { asEventId, asTurnId, episodeIdForTurn } from "@/game/domain/events";
import { asQuestId, asLocationId, asGenerationId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

const LOC_1 = asLocationId("loc_1");

const BASE_PROJECTION: EntityCompatibilityProjection = {
  player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [{
    id: LOC_1,
    name: "山道",
    description: "测试",
    kind: "main",
    connectedLocationIds: [],
    npcIds: [],
    availableItemIds: [],
    tags: [],
  }],
  currentLocationId: LOC_1,
  unlockedLocationIds: [LOC_1],
  visitedLocationIds: [LOC_1],
  npcs: [],
  items: [],
  inventory: [],
  worldFacts: [],
  quests: [],
  enemies: [],
  defeatedEnemyIds: [],
  factions: [],
};

function makeWorld(overrides?: Partial<EntityCompatibilityProjection>): WorldState {
  return createWorldStateFixture({
    generation: { generationId: asGenerationId("test"), seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    projection: { ...BASE_PROJECTION, ...overrides },
  });
}

describe("advanceStoryProgression", () => {
  const ss = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 },
  });

  it("does not advance act when no main quest completed", () => {
    const ws = makeWorld();
    const events: NarrativeEventDraft[] = [];
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
    const events: NarrativeEventDraft[] = [
      { eventKey: "quest_completed:q_main_1", episodeKey: "turn", actorIds: [PLAYER_ENTITY_ID], targetIds: [PLAYER_ENTITY_ID], locationId: null, causeKeys: [], factIds: [], questIds: [asQuestId("q_main_1")], outcome: "success", salience: 80, payload: { type: "quest_completed", questId: asQuestId("q_main_1") } } as unknown as NarrativeEventDraft,
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
    const events: NarrativeEventDraft[] = [
      { eventKey: "quest_completed:q_main_1", episodeKey: "turn", actorIds: [PLAYER_ENTITY_ID], targetIds: [PLAYER_ENTITY_ID], locationId: null, causeKeys: [], factIds: [], questIds: [asQuestId("q_main_1")], outcome: "success", salience: 80, payload: { type: "quest_completed", questId: asQuestId("q_main_1") } } as unknown as NarrativeEventDraft,
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
    const events: NarrativeEventDraft[] = [
      { eventKey: "quest_completed:q_final", episodeKey: "turn", actorIds: [PLAYER_ENTITY_ID], targetIds: [PLAYER_ENTITY_ID], locationId: null, causeKeys: [], factIds: [], questIds: [asQuestId("q_final")], outcome: "success", salience: 80, payload: { type: "quest_completed", questId: asQuestId("q_final") } } as unknown as NarrativeEventDraft,
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
      threads: [{
        ...ss.threads[0]!,
        questIds: [asQuestId("q_final")],
      }],
      unresolvedThreads: [ss.threads[0]!.id],
    };
    const ws = makeWorld({
      quests: [{
        id: asQuestId("q_final"), name: "终局", description: "测试", objectives: [],
        onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [],
        kind: "main", stage: 3, status: "completed",
      }],
    });
    const result = advanceStoryProgression(ws, nearEnd, [{
      eventKey: "quest_completed:q_final", episodeKey: "turn", actorIds: [PLAYER_ENTITY_ID], targetIds: [PLAYER_ENTITY_ID], locationId: null,
      causeKeys: [], factIds: [], questIds: [asQuestId("q_final")], outcome: "success", salience: 80,
      payload: { type: "quest_completed", questId: asQuestId("q_final") },
    } as unknown as NarrativeEventDraft]);
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
    const events: NarrativeEventDraft[] = [
      { eventKey: "quest_completed:q_main_1", episodeKey: "turn", actorIds: [PLAYER_ENTITY_ID], targetIds: [PLAYER_ENTITY_ID], locationId: null, causeKeys: [], factIds: [], questIds: [asQuestId("q_main_1")], outcome: "success", salience: 80, payload: { type: "quest_completed", questId: asQuestId("q_main_1") } } as unknown as NarrativeEventDraft,
    ];
    const finalAct = { ...ss, currentAct: 3, targetActs: 3, unresolvedThreads: ["thread_main"] };
    const result = advanceStoryProgression(ws, finalAct, events);
    expect(result.nextStoryState.unresolvedThreads).not.toContain("thread_main");
  });

  it("closes every justified quest-bound thread but leaves explicit and unrelated concerns unresolved", () => {
    const questId = asQuestId("q_final");
    const ws = makeWorld({
      quests: [{ id: questId, name: "终局", description: "", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "main", stage: 3, status: "completed" }],
    });
    const baseThread = ss.threads[0]!;
    const threads: StoryState["threads"] = [
      { ...baseThread, id: "thread:ferry", questIds: [questId] },
      { ...baseThread, id: "thread:first_run", questIds: [questId] },
      { ...baseThread, id: "thread:unrelated", questIds: [] },
      { ...baseThread, id: "thread:explicit", questIds: [questId], closure: [{ kind: "knows_fact" as const, actorId: PLAYER_ENTITY_ID, factId: "fact_unmet" as never }] },
    ];
    const result = advanceStoryProgression(ws, {
      ...ss, currentAct: 3, targetActs: 3, storyProgress: 100, threads,
      unresolvedThreads: threads.map((entry) => entry.id),
    }, [{
      eventKey: "quest_completed:q_final", episodeKey: "turn", actorIds: [PLAYER_ENTITY_ID], targetIds: [PLAYER_ENTITY_ID], locationId: null,
      causeKeys: [], factIds: [], questIds: [questId], outcome: "success", salience: 80,
      payload: { type: "quest_completed", questId },
    } as unknown as NarrativeEventDraft]);

    expect(result.nextStoryState.threads.map((entry) => [entry.id, entry.status])).toEqual([
      ["thread:ferry", "resolved"],
      ["thread:first_run", "resolved"],
      ["thread:unrelated", "open"],
      ["thread:explicit", "open"],
    ]);
    expect(result.nextStoryState.endingAllowed).toBe(false);
  });

  it("keeps evolution stable after a prepared ending pair and opens the ending when all bound concerns conclude", () => {
    const questId = asQuestId("q_final");
    const ws = { ...makeWorld({
      quests: [{ id: questId, name: "终局", description: "", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "main", stage: 3, status: "completed" }],
    }), endings: [
      { id: "ending_trust", name: "信任", description: "", theme: "trust", requirements: [] },
      { id: "ending_doubt", name: "存疑", description: "", theme: "doubt", requirements: [] },
    ] as never };
    const thread = { ...ss.threads[0]!, questIds: [questId], status: "advanced" as const };
    const result = advanceStoryProgression(ws, {
      ...ss, currentAct: 3, targetActs: 3, storyProgress: 100,
      threads: [thread], unresolvedThreads: [thread.id],
      evolution: { ...ss.evolution, status: "needs_ending_pair" },
    }, [{
      eventKey: "quest_completed:q_final", episodeKey: "turn", actorIds: [PLAYER_ENTITY_ID], targetIds: [PLAYER_ENTITY_ID], locationId: null,
      causeKeys: [], factIds: [], questIds: [questId], outcome: "success", salience: 80,
      payload: { type: "quest_completed", questId },
    } as unknown as NarrativeEventDraft]);
    expect(result.nextStoryState).toMatchObject({ endingAllowed: true, evolution: { status: "stable" }, unresolvedThreads: [] });
  });
});
