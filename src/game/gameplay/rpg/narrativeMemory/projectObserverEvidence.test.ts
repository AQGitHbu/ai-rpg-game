import { describe, expect, it } from "vitest";
import { asEventId, asTurnId } from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { asFactId } from "@/game/domain/worldEntity";
import { asNpcId, asPlayerEntityId } from "@/game/domain/worldEntity";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { projectObserverEvidence } from "./projectObserverEvidence";

const PLAYER = asPlayerEntityId("player_0");
const KNOWN_NPC = asNpcId("npc:known");
const UNKNOWN_NPC = asNpcId("npc:unknown");
const VISIBLE_EVENT = asEventId("story:visible");
const HIDDEN_EVENT = asEventId("story:hidden");

function makeState(): { readonly worldState: WorldState; readonly storyState: StoryState } {
  return {
    worldState: {
      entityStore: {
        version: 3,
        records: [
          { core: { id: PLAYER, kind: "player_character", name: "玩家", createdAtTurn: 0, lifecycle: "active" } },
          { core: { id: KNOWN_NPC, kind: "npc", name: "已知的人", createdAtTurn: 0, lifecycle: "active" } },
          { core: { id: UNKNOWN_NPC, kind: "npc", name: "未见之人", createdAtTurn: 0, lifecycle: "active" } },
        ],
      },
      eventLedger: [],
    } as unknown as WorldState,
    storyState: {
      history: {
        entries: [
          {
            id: "history:visible",
            segmentId: "segment:visible",
            sequence: 0,
            actionId: "action:visible",
            jobId: null,
            sceneId: "scene:visible",
            revision: 1,
            turnNumber: 1,
            kind: "npc_line",
            text: "已知的人说过这句话。",
            speakerId: KNOWN_NPC,
            audienceIds: [PLAYER],
            entityIds: [PLAYER, KNOWN_NPC],
            factIds: [],
            eventIds: [VISIBLE_EVENT],
            choiceToken: null,
          },
          {
            id: "history:choice",
            segmentId: "segment:choice",
            sequence: 1,
            actionId: null,
            jobId: null,
            sceneId: "scene:choice",
            revision: 1,
            turnNumber: 1,
            kind: "shown_choice",
            text: "未见之人将在下一幕出现",
            speakerId: null,
            audienceIds: [PLAYER],
            entityIds: [PLAYER, UNKNOWN_NPC],
            factIds: [],
            eventIds: [HIDDEN_EVENT],
            choiceToken: "choice:not-selected",
          },
          {
            id: "history:private",
            segmentId: "segment:private",
            sequence: 2,
            actionId: "action:private",
            jobId: null,
            sceneId: "scene:private",
            revision: 1,
            turnNumber: 2,
            kind: "npc_line",
            text: "未见之人的私密话。",
            speakerId: UNKNOWN_NPC,
            audienceIds: [UNKNOWN_NPC],
            entityIds: [UNKNOWN_NPC],
            factIds: [],
            eventIds: [HIDDEN_EVENT],
            choiceToken: null,
          },
        ],
      },
    },
  } as unknown as { readonly worldState: WorldState; readonly storyState: StoryState };
}

describe("projectObserverEvidence", () => {
  it("projects only actually observed expressions and excludes shown choices/private lines", () => {
    const { worldState, storyState } = makeState();
    const result = projectObserverEvidence({ worldState, storyState, observerId: PLAYER });

    expect(result.history.map((entry) => entry.id)).toEqual(["history:visible"]);
    expect(result.events.map((event) => event.eventId)).toEqual([]);
    expect(result.knownEntityIds).toEqual(expect.arrayContaining([PLAYER, KNOWN_NPC]));
    expect(result.knownEntityIds).not.toContain(UNKNOWN_NPC);
  });

  it("does not let a visible history reference authorize an event's unknown facts", () => {
    const { worldState, storyState } = makeState();
    const secretEvent = makeCommittedEvent({
      type: "fact_discovered",
      factId: asFactId("fact:secret"),
    }, {
      eventId: VISIBLE_EVENT,
      turnId: asTurnId("turn:secret"),
      actorIds: [KNOWN_NPC],
      targetIds: [PLAYER],
      factIds: [asFactId("fact:secret")],
    });
    const result = projectObserverEvidence({
      worldState: { ...worldState, eventLedger: [secretEvent] },
      storyState,
      observerId: PLAYER,
    });

    expect(result.history.map((entry) => entry.id)).toEqual(["history:visible"]);
    expect(result.events).toEqual([]);
  });
});
