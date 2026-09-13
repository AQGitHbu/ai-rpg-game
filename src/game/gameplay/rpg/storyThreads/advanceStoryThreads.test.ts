import { describe, expect, it } from "vitest";
import { asEventId } from "@/game/domain/events";
import { asFactId, asGenerationId, asLocationId, asQuestId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import type { StoryThread } from "@/game/domain/storyThreads";
import { advanceStoryThreads, reconcileRuleDerivedStoryThreads } from "./advanceStoryThreads";

const FACT_ID = asFactId("fact_letter");
const EVENT_ID = asEventId("turn:letter_received");

function world() {
  return createWorldStateFixture({
    generation: { generationId: asGenerationId("gen_thread_advance"), seed: "thread-advance", templateVersion: "v1", inputDigest: "", gameType: "wuxia" },
    projection: {
      ...emptyProjection({
        player: { name: "侠客", identity: "旅人", stats: { hp: 10, attack: 2, defense: 1 } },
        locations: [{ id: asLocationId("loc_temple"), name: "破庙", description: "", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] }],
        currentLocationId: asLocationId("loc_temple"),
      }),
      worldFacts: [{ factId: FACT_ID, text: "信中有证词", source: "generated", discovered: true }],
    },
    eventLedger: [makeCommittedEvent({ type: "fact_discovered", factId: FACT_ID }, { eventId: EVENT_ID, factIds: [FACT_ID] })],
  });
}

function thread(overrides: Partial<StoryThread> = {}): StoryThread {
  return {
    id: "thread:letter",
    kind: "question",
    participantIds: [PLAYER_ENTITY_ID],
    causeEventIds: [EVENT_ID],
    questIds: [],
    goalRefs: [],
    promiseRefs: [],
    question: "证词是否可信？",
    status: "open",
    evidenceEventIds: [],
    closure: [{ kind: "knows_fact", actorId: PLAYER_ENTITY_ID, factId: FACT_ID }],
    tentativeDirections: ["核验来源"],
    ...overrides,
  };
}

describe("advanceStoryThreads", () => {
  it("consumes only an event that exists in the committed ledger", () => {
    const result = advanceStoryThreads({ worldState: world(), threads: [thread()], eventIds: [EVENT_ID] });
    expect(result[0]).toMatchObject({ status: "resolved", evidenceEventIds: [EVENT_ID] });

    const uncommitted = advanceStoryThreads({ worldState: world(), threads: [thread()], eventIds: [asEventId("turn:not_committed")] });
    expect(uncommitted[0]).toEqual(thread());
  });

  it("does not resolve an open question without a non-empty closure", () => {
    const result = advanceStoryThreads({ worldState: world(), threads: [thread({ closure: [] })], eventIds: [EVENT_ID] });
    expect(result[0]).toMatchObject({ status: "advanced", evidenceEventIds: [EVENT_ID] });
  });

  it("reconciles every quest-bound concern from committed outcomes and preserves other obligations", () => {
    const questId = asQuestId("quest_ferry");
    const outcomeId = asEventId("turn:ferry_completed");
    const current = createWorldStateFixture({
      generation: { generationId: asGenerationId("gen_thread_ending"), seed: "ending", templateVersion: "v1", inputDigest: "", gameType: "wuxia" },
      projection: {
        ...emptyProjection({
          player: { name: "侠客", identity: "旅人", stats: { hp: 10, attack: 2, defense: 1 } },
          locations: [{ id: asLocationId("loc_ferry"), name: "渡口", description: "", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] }],
          currentLocationId: asLocationId("loc_ferry"),
        }),
        quests: [{ id: questId, name: "查清渡口", description: "", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "main", stage: 3, status: "completed" }],
      },
      eventLedger: [makeCommittedEvent({ type: "quest_completed", questId }, { eventId: outcomeId, questIds: [questId] })],
    });
    const bound = (id: string, overrides: Partial<StoryThread> = {}): StoryThread => thread({
      id, causeEventIds: [], participantIds: [], questIds: [questId], closure: [], ...overrides,
    });
    const result = reconcileRuleDerivedStoryThreads({ worldState: current, threads: [
      bound("thread:ferry_block"),
      bound("thread:first_run"),
      bound("thread:explicit", { closure: [{ kind: "knows_fact", actorId: PLAYER_ENTITY_ID, factId: FACT_ID }] }),
      bound("thread:promise", { promiseRefs: [{ npcId: "npc_missing" as never, promiseId: "promise_open" }] }),
      thread({ id: "thread:unbound", causeEventIds: [], participantIds: [], questIds: [], closure: [] }),
    ] });

    expect(result.map((entry) => [entry.id, entry.status])).toEqual([
      ["thread:ferry_block", "advanced"],
      ["thread:first_run", "advanced"],
      ["thread:explicit", "open"],
      ["thread:promise", "open"],
      ["thread:unbound", "open"],
    ]);
    expect(result[0]?.evidenceEventIds).toEqual([outcomeId]);
    expect(result[1]?.evidenceEventIds).toEqual([outcomeId]);
  });

  it("requires both resolved quest state and its committed outcome event", () => {
    const questId = asQuestId("quest_ferry");
    const current = createWorldStateFixture({
      generation: { generationId: asGenerationId("gen_thread_no_event"), seed: "ending", templateVersion: "v1", inputDigest: "", gameType: "wuxia" },
      projection: {
        ...emptyProjection({
          player: { name: "侠客", identity: "旅人", stats: { hp: 10, attack: 2, defense: 1 } },
          locations: [{ id: asLocationId("loc_ferry"), name: "渡口", description: "", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] }],
          currentLocationId: asLocationId("loc_ferry"),
        }),
        quests: [{ id: questId, name: "查清渡口", description: "", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "main", stage: 3, status: "completed" }],
      },
      eventLedger: [],
    });
    const concern = thread({ causeEventIds: [], participantIds: [], questIds: [questId], closure: [] });
    expect(reconcileRuleDerivedStoryThreads({ worldState: current, threads: [concern] })[0]).toEqual(concern);
  });
});
