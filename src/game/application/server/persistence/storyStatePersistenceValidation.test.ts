import { describe, expect, it } from "vitest";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { createInitialStoryState } from "@/game/domain/storyState";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { asEventId } from "@/game/domain/events";
import { parsePersistableStoryState } from "./storyStatePersistenceValidation";

function storyState() {
  return createInitialStoryState({
    gameLength: "short",
    initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 },
    initialNarrative: createFixtureNarrativeRuntimeState(),
  });
}

describe("parsePersistableStoryState", () => {
  it("accepts v10 only and reconstructs memory from the supplied ledger", () => {
    const event = makeCommittedEvent({ type: "player_intent_expressed", intentCode: "unmapped_freeform" });
    const value = { ...storyState(), memory: rebuildEpisodicMemory([event]) };
    const result = parsePersistableStoryState(value, [event]);
    expect(result).toMatchObject({ ok: true });
  });

  it("classifies v1-v9 as unsupported and future versions as version mismatch", () => {
    const value = storyState();
    expect(parsePersistableStoryState({ ...value, version: 7 }, [])).toMatchObject({ ok: false, code: "UNSUPPORTED_RECORD" });
    expect(parsePersistableStoryState({ ...value, version: 9 }, [])).toMatchObject({ ok: false, code: "UNSUPPORTED_RECORD" });
    expect(parsePersistableStoryState({ ...value, version: 11 }, [])).toMatchObject({ ok: false, code: "VERSION_MISMATCH" });
  });

  it("rejects memory cursor drift and episode eventIds that do not match the ledger", () => {
    const event = makeCommittedEvent({ type: "player_intent_expressed", intentCode: "unmapped_freeform" });
    const validMemory = rebuildEpisodicMemory([event]);
    expect(parsePersistableStoryState({
      ...storyState(),
      memory: { ...validMemory, reducedThroughSequence: -1 },
    }, [event])).toMatchObject({ ok: false, code: "INVALID_STORY_STATE" });
    expect(parsePersistableStoryState({
      ...storyState(),
      memory: {
        ...validMemory,
        episodes: validMemory.episodes.map((episode) => ({ ...episode, eventIds: ["missing:1"] })),
      },
    }, [event])).toMatchObject({ ok: false, code: "INVALID_STORY_STATE" });
  });

  it("rejects a structurally valid memory rebuilt from a different opening ledger", () => {
    const first = makeCommittedEvent({ type: "opening_history_established", factIds: ["fact_0"] } as never);
    const second = { ...first, eventId: asEventId("init:other:event:0") };
    expect(parsePersistableStoryState({
      ...storyState(), memory: rebuildEpisodicMemory([second]),
    }, [first])).toMatchObject({ ok: false, code: "INVALID_STORY_STATE" });
  });
});
