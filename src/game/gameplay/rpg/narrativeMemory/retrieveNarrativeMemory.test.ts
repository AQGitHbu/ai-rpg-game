import { describe, expect, it } from "vitest";
import {
  asEpisodeId,
  asEventId,
  asTurnId,
} from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import {
  asFactId,
  asLocationId,
  asNpcId,
  asQuestId,
} from "@/game/domain/worldEntity";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { retrieveNarrativeMemory } from "./retrieveNarrativeMemory";

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
    expect(result.relevantEpisodes[0]!.episode.episodeId).toBe("episode:old-focus");
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
});
