import { describe, expect, it } from "vitest";
import { asFactId, asGenerationId, asLocationId, PLAYER_ENTITY_ID } from "./worldEntity";
import { asEventId } from "./events";
import { createWorldStateFixture, emptyProjection } from "./testing/worldStateFixture.testutil";
import { makeCommittedEvent } from "./testing/committedEventFactory";
import type { StoryThread } from "./storyThreads";
import { advanceStoryThreads } from "../gameplay/rpg/storyThreads/advanceStoryThreads";

const FACT = asFactId("fact_letter");
const EVENT = asEventId("turn:letter_received");

function world(discovered = true) {
  return createWorldStateFixture({
    generation: { generationId: asGenerationId("gen_threads"), seed: "threads", templateVersion: "v1", inputDigest: "", gameType: "wuxia" },
    projection: {
      ...emptyProjection({
        player: { name: "侠客", identity: "旅人", stats: { hp: 10, attack: 2, defense: 1 } },
        locations: [{ id: asLocationId("loc_temple"), name: "破庙", description: "", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] }],
        currentLocationId: asLocationId("loc_temple"),
      }),
      worldFacts: [{ factId: FACT, text: "信中有证词", source: "generated", discovered }],
    },
    eventLedger: [makeCommittedEvent({ type: "fact_discovered", factId: FACT }, { eventId: EVENT, factIds: [FACT] })],
  });
}

function thread(overrides: Partial<StoryThread> = {}): StoryThread {
  return {
    id: "thread:letter",
    kind: "question",
    participantIds: [PLAYER_ENTITY_ID],
    causeEventIds: [EVENT],
    questIds: [],
    goalRefs: [],
    promiseRefs: [],
    question: "证词是否可信？",
    status: "open",
    evidenceEventIds: [],
    closure: [{ kind: "knows_fact", actorId: PLAYER_ENTITY_ID, factId: FACT }],
    tentativeDirections: ["核验来源"],
    ...overrides,
  };
}

describe("advanceStoryThreads", () => {
  it("advances only when a committed related event supplies evidence", () => {
    const result = advanceStoryThreads({ worldState: world(false), threads: [thread()], eventIds: [EVENT] });
    expect(result[0]).toMatchObject({ status: "advanced", evidenceEventIds: [EVENT] });
  });

  it("resolves a thread only when closure has conditions and the current world satisfies them", () => {
    const result = advanceStoryThreads({ worldState: world(true), threads: [thread()], eventIds: [EVENT] });
    expect(result[0]).toMatchObject({ status: "resolved", evidenceEventIds: [EVENT] });
  });

  it("does not auto-close an empty closure or an unrelated event", () => {
    const empty = advanceStoryThreads({ worldState: world(true), threads: [thread({ closure: [] })], eventIds: [EVENT] });
    const unrelated = advanceStoryThreads({ worldState: world(true), threads: [thread({ causeEventIds: [asEventId("turn:other")], participantIds: [] })], eventIds: [EVENT] });
    expect(empty[0]?.status).toBe("advanced");
    expect(unrelated[0]).toEqual(thread({ causeEventIds: [asEventId("turn:other")], participantIds: [] }));
  });
});
