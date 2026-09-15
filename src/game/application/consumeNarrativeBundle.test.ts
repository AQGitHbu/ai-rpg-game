import { describe, expect, it } from "vitest";
import { consumeNarrativeBundle } from "./consumeNarrativeBundle";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asGenerationId, asLocationId, PLAYER_ENTITY_ID, type GenerationMetadata } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { commitEventDrafts, commitInitializationEvent } from "@/game/domain/eventLedger";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import type { CommittedNarrativeEvent } from "@/game/domain/events";

const locTown = asLocationId("loc_town");
const locTemple = asLocationId("loc_temple");
const generation: GenerationMetadata = {
  generationId: asGenerationId("generation_history"),
  seed: "history-seed",
  templateVersion: "v1",
  inputDigest: "history-digest",
  gameType: "wuxia",
};
const projection: EntityCompatibilityProjection = {
  player: { name: "侠客", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [
    { id: locTown, name: "小镇", description: "小镇", kind: "main", connectedLocationIds: [locTemple], npcIds: [], availableItemIds: [], tags: [] },
    { id: locTemple, name: "破庙", description: "破庙", kind: "main", connectedLocationIds: [locTown], npcIds: [], availableItemIds: [], tags: [] },
  ],
  currentLocationId: locTown,
  unlockedLocationIds: [locTown, locTemple],
  visitedLocationIds: [locTown],
  npcs: [], items: [], inventory: [], worldFacts: [], quests: [], enemies: [], defeatedEnemyIds: [], factions: [],
};

function states() {
  const beforeWorldState = createWorldStateFixtureWith({ generation, base: projection });
  const initialized = commitInitializationEvent({
    generation,
    locationId: locTown,
    entityStore: beforeWorldState.entityStore,
    committedAt: "2026-09-12T00:00:00.000Z",
  });
  if (!initialized.ok) throw new Error("initialization event failed");
  const moved = commitEventDrafts({
    ledger: initialized.ledger,
    drafts: [{
      eventKey: "move",
      episodeKey: "turn",
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [],
      locationId: locTemple,
      causeKeys: [],
      factIds: [],
      questIds: [],
      outcome: "success",
      salience: 20,
      payload: { type: "location_visited", locationId: locTemple },
    }],
    source: { turnId: asTurnId("turn:move"), actionId: "move-1", turnNumber: 1, committedAt: "2026-09-12T00:00:01.000Z" },
    entityStore: beforeWorldState.entityStore,
  });
  if (!moved.ok) throw new Error("move event failed");
  const resolvedWorldState = createWorldStateFixtureWith(
    { generation, base: projection },
    { currentLocationId: locTemple, visitedLocationIds: [locTown, locTemple], eventLedger: moved.ledger },
  );
  const storyState = createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 2, npcs: 0, quests: 0, events: 1 },
  });
  if (storyState.narrative.status !== "ready") throw new Error("ready narrative expected");
  const jobId = asNarrativeJobId("job:bundle");
  const beforeStoryState = {
    ...storyState,
    narrative: {
      ...storyState.narrative,
      narrativeBundle: {
          contractVersion: 3 as const,
        originJobId: jobId,
        activeStepIds: ["step:temple"],
        steps: [{
          stepId: "step:temple",
          objectiveKey: "none",
          consumptionGroupKey: "move:temple",
          trigger: { kind: "move" as const, locationId: locTemple },
          scene: {
            segments: [{ beatId: "arrival", text: "你走进破庙。" }],
            npcLine: null,
            event: { kind: "travel" as const, locationId: locTemple },
            objectiveLink: null,
            choiceSeeds: [],
            source: "generated" as const,
          },
          nextStepIds: [],
        }],
        terminal: { kind: "next_decision" as const, target: { kind: "current_scene" as const } },
      },
    },
  };
  return { beforeWorldState, resolvedWorldState, beforeStoryState, moved: moved.appended[0] as CommittedNarrativeEvent };
}

describe("consumeNarrativeBundle", () => {
  it("records the consumed player action and only the published scene expressions", () => {
    const { beforeWorldState, resolvedWorldState, beforeStoryState, moved } = states();
    const result = consumeNarrativeBundle({
      beforeStoryState,
      resolvedWorldState,
      resolvedStoryState: beforeStoryState,
      action: { type: "move", locationId: locTemple },
      actionId: "move-1",
      postCommitRevision: 1,
      resolvedEvent: {
        actionId: "move-1", status: "success", eventKind: "travel", facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [],
      },
      domainEvents: [moved],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextStoryState.history?.entries.map((entry) => entry.kind)).toEqual(["player_choice", "narration"]);
    expect(result.nextStoryState.history?.entries.find((entry) => entry.kind === "narration")?.text).toBe("你走进破庙。");
  });
});
