import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, expect, it, vi } from "vitest";
import type { Action } from "./action";
import {
  asNarrativeJobId,
  asTurnId,
  type CommittedNarrativeEvent,
} from "./events";
import type { ResolvedEvent } from "./resolvedEvent";
import {
  asGenerationId,
  asLocationId,
  type GenerationMetadata,
} from "./worldEntity";
import { createInitialStoryState, type StoryState } from "./storyState";
import { createTurnResolution, type TurnResolution } from "./turnResolution";
import {
  createInitialWorldState,
  type LocationEntry,
  type WorldState,
} from "./worldState";

const generation: GenerationMetadata = {
  generationId: asGenerationId("generation-1"),
  seed: "seed-1",
  templateVersion: "template-1",
  inputDigest: "digest-1",
  gameType: "wuxia",
};

const startingLocation: LocationEntry = {
  id: asLocationId("location-1"),
  name: "山门",
  description: "故事开始之处",
  kind: "main",
  connectedLocationIds: [],
  npcIds: [],
  availableItemIds: [],
  tags: [],
};

function createStates(): {
  readonly previousStoryState: StoryState;
  readonly nextStoryState: StoryState;
  readonly nextWorldState: WorldState;
  readonly domainEvents: readonly CommittedNarrativeEvent[];
} {
  const previousStoryState = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 },
  });
  const worldState = createInitialWorldState({
    generation,
    player: {
      name: "林舟",
      identity: "游侠",
      stats: { hp: 20, attack: 5, defense: 3 },
    },
    startingLocation,
    startingItemIds: [],
  });
  const domainEvents: readonly CommittedNarrativeEvent[] = [
    {
      type: "location_observed",
      locationId: startingLocation.id,
      occurredAt: "2026-08-08T08:00:00.000Z",
    },
    {
      type: "location_visited",
      locationId: startingLocation.id,
      occurredAt: "2026-08-08T08:00:01.000Z",
    },
  ];
  const priorEvents: readonly CommittedNarrativeEvent[] = [
    {
      type: "location_observed",
      locationId: startingLocation.id,
      occurredAt: "2026-08-08T07:59:56.000Z",
    },
    {
      type: "location_observed",
      locationId: startingLocation.id,
      occurredAt: "2026-08-08T07:59:57.000Z",
    },
    {
      type: "location_observed",
      locationId: startingLocation.id,
      occurredAt: "2026-08-08T07:59:58.000Z",
    },
    {
      type: "location_observed",
      locationId: startingLocation.id,
      occurredAt: "2026-08-08T07:59:59.000Z",
    },
  ];

  return {
    previousStoryState,
    nextStoryState: { ...previousStoryState, tension: 35 },
    nextWorldState: {
      ...worldState,
      eventLedger: [...worldState.eventLedger, ...priorEvents, ...domainEvents],
    },
    domainEvents,
  };
}

function createCanonicalResolvedEvent(actionId = "action-1"): ResolvedEvent {
  return {
    actionId,
    status: "success",
    eventKind: "observe",
    facts: [],
    stateChanges: [],
    costs: [],
    rewards: [],
    triggeredEvents: ["location_observed", "location_visited"],
    rejectedEffects: [],
  };
}

function createResolution(): TurnResolution {
  const states = createStates();
  const action: Action = { type: "explore" };

  return createTurnResolution({
    turnId: asTurnId("turn-1"),
    baseRevision: 41,
    interactionKind: "fixed_choice",
    action,
    primaryResult: createCanonicalResolvedEvent(),
    domainEvents: states.domainEvents,
    previousStoryState: states.previousStoryState,
    nextWorldState: states.nextWorldState,
    nextStoryState: states.nextStoryState,
  });
}

describe("TurnResolution", () => {
  it("carries the complete ordered result of rules orchestration", () => {
    const resolution = createResolution();

    expect(resolution.turnId).toBe("turn-1");
    expect(resolution.actionId).toBe("action-1");
    expect(resolution.baseRevision).toBe(41);
    expect(resolution.turnNumber).toBe(1);
    expect(resolution.interactionKind).toBe("fixed_choice");
    expect(resolution.action).toEqual({ type: "explore" });
    expect(resolution.primaryResult).toEqual(createCanonicalResolvedEvent());
    expect(resolution.domainEvents.map((event) => event.kind)).toEqual([
      "location_observed",
      "location_visited",
    ]);
    expect(resolution.nextWorldState.eventLedger.slice(-2)).toEqual(resolution.domainEvents);
    expect(resolution.nextStoryState.tension).toBe(35);
  });

  it("increments turnNumber once when one turn emits multiple domain events", () => {
    const resolution = createResolution();

    expect(resolution.domainEvents).toHaveLength(2);
    expect(resolution.nextStoryState.turnNumber).toBe(1);
    expect(resolution.turnNumber).toBe(1);
  });

  it("derives actionId from primaryResult as the single causal source", () => {
    const states = createStates();
    const primaryResult = createCanonicalResolvedEvent("action-from-primary-result");

    const resolution = createTurnResolution({
      turnId: asTurnId("turn-action-invariant"),
      baseRevision: 41,
      interactionKind: "fixed_choice",
      action: { type: "explore" },
      primaryResult,
      domainEvents: states.domainEvents,
      previousStoryState: states.previousStoryState,
      nextWorldState: states.nextWorldState,
      nextStoryState: states.nextStoryState,
    });

    expect(resolution.actionId).toBe("action-from-primary-result");
    expect(resolution.actionId).toBe(resolution.primaryResult.actionId);
  });

  it("keeps schema version, database revision, turn number, and ledger cursor separate", () => {
    const resolution = createResolution();

    expect({
      schemaVersion: resolution.nextStoryState.version,
      baseRevision: resolution.baseRevision,
      turnNumber: resolution.turnNumber,
      ledgerCursor: resolution.nextWorldState.eventLedger.length,
    }).toEqual({
      schemaVersion: 7,
      baseRevision: 41,
      turnNumber: 1,
      ledgerCursor: 7,
    });
  });

  it("does not read the system clock or randomness", () => {
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now must be injected outside domain");
    });
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("randomness must be injected outside domain");
    });

    try {
      expect(asTurnId("turn-pure")).toBe("turn-pure");
      expect(asNarrativeJobId("job-pure")).toBe("job-pure");
      expect(createResolution().turnNumber).toBe(1);
      expect(dateNow).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
      random.mockRestore();
    }
  });

  it("keeps TurnId and NarrativeJobId as distinct branded identifiers", () => {
    const jobId = asNarrativeJobId("job-1");

    // @ts-expect-error NarrativeJobId must not be assignable to TurnId.
    const wrongId: ReturnType<typeof asTurnId> = jobId;
    expect(wrongId).toBe("job-1");
  });

  it("rejects legacy stateVersion from the canonical ResolvedEvent contract", () => {
    const canonical = createCanonicalResolvedEvent();

    // @ts-expect-error event-ledger length is not a canonical ResolvedEvent version.
    const legacy: ResolvedEvent = { ...canonical, stateVersion: 2 };
    expect(Object.keys(canonical)).not.toContain("stateVersion");
    expect("stateVersion" in legacy).toBe(true);
  });
});
