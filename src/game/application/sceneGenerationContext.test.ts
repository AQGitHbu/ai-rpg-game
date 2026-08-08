import { describe, it, expect } from "vitest";
import {
  buildSceneGenerationContext,
  type SceneGenerationContext,
} from "./sceneGenerationContext";
import {
  createInitialWorldState,
  appendNpc,
  appendLocation,
  type LocationEntry,
  type NpcEntry,
} from "@/game/domain/worldState";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import {
  asLocationId,
  asNpcId,
  asGenerationId,
} from "@/game/domain/scenarioBlueprint";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { GameRecordV2 } from "./server/persistence/gameRepositoryV2";

const loc1: LocationEntry = {
  id: asLocationId("loc_1"), name: "客栈", description: "一间简朴的客栈", kind: "main",
  connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
};
const loc2: LocationEntry = {
  id: asLocationId("loc_2"), name: "街道", description: "一条热闹的街道", kind: "main",
  connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
};
const npc1: NpcEntry = {
  id: asNpcId("npc_1"), name: "客栈老板", role: "路人", description: "热情的老板",
  locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
  memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
};

const IMPORTANT_ACTION_ID = "act_persist";

function makeJob(): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId("job_1"),
    turnId: asTurnId("turn_1"),
    actionId: IMPORTANT_ACTION_ID,
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: { kind: "move", locationId: asLocationId("loc_2") },
    resolvedEvent: {
      actionId: IMPORTANT_ACTION_ID,
      status: "success",
      eventKind: "travel",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 1, toLedgerIndexExclusive: 2 },
    requestedAt: "2026-01-02",
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

function makeWorld(): ReturnType<typeof createInitialWorldState> {
  const base = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const withNpc = appendNpc(appendLocation(base, loc2), npc1);
  return { ...withNpc, unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
}

function makeRecord(withJob = true): GameRecordV2 {
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });
  const storyState: StoryState = withJob
    ? { ...ss, narrative: { ...ss.narrative, generation: { status: "pending", job: makeJob() } } }
    : ss;
  return {
    gameId: "g1" as never,
    worldState: makeWorld(),
    storyState,
    revision: 0,
    createdAt: "2026-01-01",
  };
}

function acceptContext(_context: SceneGenerationContext): void {}

describe("buildSceneGenerationContext", () => {
  it("copies the pending job and derives current location, present NPCs and story hints", () => {
    const record = makeRecord();
    const context = buildSceneGenerationContext(record);
    const generation = record.storyState.narrative.generation;
    expect(context.job).toEqual(generation.status === "pending" ? generation.job : undefined);
    expect(context.currentLocation).toEqual({ id: loc1.id, name: loc1.name, description: loc1.description });
    expect(context.presentNpcs).toEqual([{ id: npc1.id, name: npc1.name, role: npc1.role }]);
    expect(context.story.currentAct).toBe(1);
    expect(context.story.targetActs).toBe(3);
    expect(context.story.tension).toBe(30);
    expect(context.story.nextPacingNeed).toBe("reveal");
    expect(context.reachableLocations).toEqual([{ id: loc2.id, name: loc2.name }]);
  });

  it("never receives the whole record: a GameRecordV2 is not assignable to the context type", () => {
    const record = makeRecord();
    // @ts-expect-error SceneSource must not receive the full record
    acceptContext(record);
    const context = buildSceneGenerationContext(record);
    // @ts-expect-error full candidate pool must not leak into the context type
    context.story.candidateEventPool;
  });

  it("context JSON carries no eventLedger / candidateEventPool / worldFacts secret text", () => {
    const record = makeRecord();
    const context = buildSceneGenerationContext(record);
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("eventLedger");
    expect(serialized).not.toContain("candidateEventPool");
    expect(serialized).not.toContain("worldFacts");
  });

  it("is deterministic: same record produces an identical context", () => {
    const contextA = buildSceneGenerationContext(makeRecord());
    const contextB = buildSceneGenerationContext(makeRecord());
    expect(contextA).toEqual(contextB);
  });
});