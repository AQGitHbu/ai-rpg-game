import { describe, expect, it } from "vitest";
import {
  asEpisodeId,
  asEventId,
  asTurnId,
} from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import {
  asFactId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
} from "@/game/domain/worldEntity";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { retrieveNarrativeMemory } from "./retrieveNarrativeMemory";
import type { EvidenceSelection } from "./retrieveStoryEvidence";

const OLD_LOCATION = asLocationId("location:old");
const OTHER_LOCATION = asLocationId("location:other");
const FOCUS_NPC = asNpcId("npc:focus");
const QUEST = asQuestId("quest:main");

function event(sequence: number, input: Parameters<typeof makeCommittedEvent>[0], overrides: Partial<ReturnType<typeof makeCommittedEvent>> = {}) {
  const turnId = overrides.turnId ?? asTurnId(`turn:${sequence}`);
  return makeCommittedEvent(input, {
    sequence,
    turnId,
    eventId: overrides.eventId ?? asEventId(`event:${sequence}`),
    episodeId: overrides.episodeId ?? asEpisodeId(`episode:turn:${sequence}`),
    locationId: overrides.locationId ?? OTHER_LOCATION,
    turnNumber: overrides.turnNumber ?? sequence + 1,
    ...overrides,
  });
}

describe("retrieveNarrativeMemory", () => {
  it("recalls the opening history cause behind a required opening thread", () => {
    const backgroundFact = asFactId("fact:background");
    const questionFact = asFactId("fact:question");
    const history = event(0, {
      type: "opening_history_established", factIds: [backgroundFact],
    }, { factIds: [backgroundFact], turnNumber: 0 });
    const thread = event(1, {
      type: "opening_thread_established",
      threadId: "thread_init_question",
      questionFactId: questionFact,
      supportingFactIds: [],
    }, { factIds: [questionFact], causeEventIds: [history.eventId], turnNumber: 0 });
    const ledger = [history, thread];

    const result = retrieveNarrativeMemory({
      memory: rebuildEpisodicMemory(ledger), ledger, requiredEventIds: [thread.eventId],
      beforeSequenceExclusive: thread.sequence,
    });
    expect(result.requiredEvents).toEqual([thread]);
    const causeMatch = result.relevantEpisodes.find((match) => match.matchedBy.includes("cause"));
    expect(causeMatch?.episode.eventIds).toContain(history.eventId);
  });

  it("recalls an item from its payload without inventing a character participant or including current events", () => {
    const itemId = asItemId("item:keepsake");
    const ledger = [
      event(0, { type: "item_obtained", itemId, locationId: OLD_LOCATION }, { actorIds: [], targetIds: [] }),
      event(1, { type: "item_given", itemId, npcId: FOCUS_NPC, locationId: OLD_LOCATION }, { actorIds: [], targetIds: [] }),
    ];
    const result = retrieveNarrativeMemory({
      memory: rebuildEpisodicMemory(ledger), ledger,
      relevantEntityIds: [itemId], beforeSequenceExclusive: 1,
    });
    expect(result.relevantEpisodes.map((match) => match.episode.eventIds)).toEqual([[ledger[0]!.eventId]]);
    expect(result.relevantEpisodes[0]!.matchedBy).toContain("entity");
  });

  it("recalls the parent cause of the current event without repeating its episode as history", () => {
    const ledger = [
      event(0, { type: "location_observed", locationId: OTHER_LOCATION }),
      event(1, { type: "location_observed", locationId: OLD_LOCATION }, { causeEventIds: [asEventId("event:0")] }),
    ];
    const result = retrieveNarrativeMemory({
      memory: rebuildEpisodicMemory(ledger), ledger,
      requiredEventIds: [ledger[1]!.eventId],
      beforeSequenceExclusive: 1,
    });
    expect(result.requiredEvents).toEqual([ledger[1]]);
    expect(result.relevantEpisodes.map((match) => match.episode.eventIds)).toEqual([[ledger[0]!.eventId]]);
    expect(result.relevantEpisodes[0]!.matchedBy).toContain("cause");
  });

  it("prioritizes explicit historical event references and fact matches over entity-only matches", () => {
    const factId = asFactId("fact:old");
    const ledger = [
      event(0, { type: "fact_discovered", factId }, { factIds: [factId] }),
      event(1, { type: "npc_met", npcId: FOCUS_NPC }, { actorIds: [FOCUS_NPC] }),
      event(2, { type: "location_observed", locationId: OTHER_LOCATION }),
    ];
    const result = retrieveNarrativeMemory({
      memory: rebuildEpisodicMemory(ledger), ledger,
      requiredEventIds: [ledger[2]!.eventId], relevantFactIds: [factId], focusNpcId: FOCUS_NPC,
    });
    expect(result.relevantEpisodes.map((match) => match.episode.fromSequence)).toEqual([2, 0, 1]);
  });

  it("ranks a structurally related old episode above recent unrelated episodes and caps results", () => {
    const ledger = Array.from({ length: 14 }, (_, sequence) => event(
      sequence,
      { type: "fact_discovered", factId: asFactId(`fact:${sequence}`) },
      sequence === 1
        ? {
            episodeId: asEpisodeId("episode:old-focus"),
            eventId: asEventId("event:old-focus"),
            actorIds: [FOCUS_NPC],
            locationId: OLD_LOCATION,
            questIds: [QUEST],
          }
        : sequence >= 2 && sequence <= 8
          ? { locationId: OLD_LOCATION }
        : undefined,
    ));
    const result = retrieveNarrativeMemory({
      memory: rebuildEpisodicMemory(ledger),
      ledger,
      requiredEventIds: [ledger[0]!.eventId],
      relevantEntityIds: [String(FOCUS_NPC)],
      relevantQuestIds: [QUEST],
      currentLocationId: OLD_LOCATION,
      maxEpisodes: 6,
      maxRecentScenes: 4,
    });

    expect(result.requiredEvents.map((entry) => entry.eventId)).toEqual([ledger[0]!.eventId]);
    expect(result.relevantEpisodes).toHaveLength(6);
    expect(result.relevantEpisodes[0]!.episode.episodeId).toBe(ledger[0]!.episodeId);
    expect(result.relevantEpisodes[1]!.episode.episodeId).toBe("episode:old-focus");
    expect(result.relevantEpisodes.map((entry) => entry.episode.episodeId)).not.toContain("episode:turn:13");
  });

  it("keeps the latest four recent scenes while requiring structural relevance for episodes", () => {
    const ledger = Array.from({ length: 5 }, (_, sequence) => event(
      sequence,
      {
        type: "narrative_scene_presented",
        sceneId: `scene:${sequence}`,
        focusNpcId: FOCUS_NPC,
        pacing: "develop",
        beatIds: [`beat:${sequence}`],
        revealedFactIds: [],
      },
      {
        locationId: OLD_LOCATION,
        actorIds: [FOCUS_NPC],
        eventId: asEventId(`scene-event:${sequence}`),
      },
    ));
    const result = retrieveNarrativeMemory({
      memory: rebuildEpisodicMemory(ledger),
      ledger,
      relevantEntityIds: [String(FOCUS_NPC)],
      currentLocationId: OLD_LOCATION,
      maxEpisodes: 6,
      maxRecentScenes: 4,
    });

    expect(result.recentScenes.map((scene) => scene.sceneId)).toEqual([
      "scene:1", "scene:2", "scene:3", "scene:4",
    ]);
  });

  it("keeps mandatory evidence events when episode cards are fully budgeted out", () => {
    const ledger = Array.from({ length: 13 }, (_, sequence) => event(sequence, {
      type: "npc_dialogue_completed",
      npcId: FOCUS_NPC,
    }));
    const oldEvent = ledger[0]!;
    const evidence: EvidenceSelection = {
      entityIds: [FOCUS_NPC],
      eventIds: [oldEvent.eventId],
      historyIds: ["history:old-line"],
      ambiguousEntityIds: [],
      manifest: [{ ref: String(oldEvent.eventId), reason: "explicit_question", mandatory: true }],
    };

    const result = retrieveNarrativeMemory({
      memory: rebuildEpisodicMemory(ledger),
      ledger,
      storyEvidence: evidence,
      history: {
        entries: [{
          id: "history:old-line",
          segmentId: "segment:old",
          sequence: 0,
          actionId: "action:old",
          jobId: null,
          sceneId: "scene:old",
          revision: 1,
          turnNumber: 1,
          kind: "npc_line",
          text: "旧人说过的原话。",
          speakerId: FOCUS_NPC,
          audienceIds: ["player_0" as never],
          entityIds: [FOCUS_NPC],
          factIds: [],
          eventIds: [oldEvent.eventId],
          choiceToken: null,
        }],
      },
      maxEpisodes: 0,
    });

    expect(result.requiredEvents.map((entry) => entry.eventId)).toEqual([oldEvent.eventId]);
    expect(result.historyEntries.map((entry) => entry.id)).toEqual(["history:old-line"]);
  });
});
