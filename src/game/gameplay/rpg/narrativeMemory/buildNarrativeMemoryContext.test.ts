import { describe, expect, it } from "vitest";
import { asEventId, asEpisodeId, asTurnId } from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import type { HistoryEntry } from "@/game/domain/narrativeHistory";
import { asNpcId, asPlayerEntityId } from "@/game/domain/worldEntity";
import type { ObserverEvidence } from "./projectObserverEvidence";
import type { EvidenceSelection } from "./retrieveStoryEvidence";
import { buildNarrativeMemoryContext } from "./buildNarrativeMemoryContext";

const PLAYER = asPlayerEntityId("player_0");
const NPC = asNpcId("npc:old");
const EVENT = asEventId("story:old");

function history(id: string, sequence: number, speakerId: typeof NPC, audienceIds: readonly typeof PLAYER[]): HistoryEntry {
  return {
    id,
    segmentId: `segment:${id}`,
    sequence,
    actionId: `action:${id}`,
    jobId: null,
    sceneId: `scene:${id}`,
    revision: 1,
    turnNumber: sequence + 1,
    kind: "npc_line",
    text: `原话${sequence}`,
    speakerId,
    audienceIds,
    entityIds: [PLAYER, NPC],
    factIds: [],
    eventIds: [EVENT],
    choiceToken: null,
  };
}

function evidence(): ObserverEvidence {
  const old = history("history:old", 1, NPC, [PLAYER]);
  const later = history("history:later", 2, NPC, [PLAYER]);
  const event = makeCommittedEvent({ type: "npc_interaction_recorded", npcId: NPC, dialogueAct: "support" }, {
    eventId: EVENT,
    episodeId: asEpisodeId("episode:old"),
    turnId: asTurnId("turn:old"),
    sequence: 1,
    actorIds: [NPC],
    targetIds: [PLAYER],
    turnNumber: 2,
  });
  return { observerId: PLAYER, history: [old, later], events: [event], knownEntityIds: [PLAYER, NPC] };
}

function selection(): EvidenceSelection {
  return {
    entityIds: [NPC],
    eventIds: [EVENT],
    historyIds: ["history:old"],
    ambiguousEntityIds: [],
    manifest: [
      { ref: "history:old", reason: "explicit_question", mandatory: true },
      { ref: String(EVENT), reason: "explicit_question", mandatory: true },
    ],
  };
}

describe("buildNarrativeMemoryContext", () => {
  it("preserves distinct mandatory events and source payloads in overview events", () => {
    const first = evidence().events[0]!;
    const second = { ...first, eventId: asEventId("story:second"), sequence: 8 };
    const result = buildNarrativeMemoryContext({
      evidence: { ...evidence(), events: [first, second] },
      selection: { ...selection(), eventIds: [first.eventId, second.eventId, first.eventId],
        manifest: [first, second].map(event => ({ ref: String(event.eventId), reason: "active_promise", mandatory: true })) },
      coveredThroughSequence: 1, overviewHistoryIds: ["history:old"], overviewEventIds: [second.eventId],
    });
    expect(result.requiredEvents).toEqual([first, second]);
    expect(result).toMatchObject({ overviewEvents: [second] });
    expect(result.manifest).toContainEqual({ ref: "history:later", reason: "uncovered_history", mandatory: true });
  });
  it("keeps every visible source uncovered when there is no valid overview", () => {
    const result = buildNarrativeMemoryContext({
      evidence: evidence(), selection: selection(), coveredThroughSequence: -1,
      overviewHistoryIds: [], overviewEventIds: [],
    });

    expect(result.uncovered.map((entry) => entry.id)).toEqual(["history:old", "history:later"]);
    expect(result.recalled).toEqual([]);
    expect(result.requiredEvents.map((event) => event.eventId)).toEqual([EVENT]);
    expect(result.referencedEntityIds).toEqual(expect.arrayContaining([PLAYER, NPC]));
  });

  it("only recalls covered references that belong to the observer projection and never duplicates them", () => {
    const result = buildNarrativeMemoryContext({
      evidence: evidence(), selection: selection(), coveredThroughSequence: 1,
      overviewHistoryIds: ["history:old"], overviewEventIds: [EVENT],
    });

    expect(result.uncovered.map((entry) => entry.id)).toEqual(["history:later"]);
    expect(result.recalled.map((entry) => entry.id)).toEqual(["history:old"]);
    expect(new Set([...result.uncovered, ...result.recalled].map((entry) => entry.id)).size).toBe(2);
    expect(result.overviewHistoryIds).toEqual(["history:old"]);
    expect(result.overviewEventIds).toEqual([EVENT]);
  });
});
