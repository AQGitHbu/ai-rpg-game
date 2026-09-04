import { describe, expect, it } from "vitest";
import { asEventId, asEpisodeId, asTurnId } from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { asFactId, asItemId, asLocationId, asNpcId } from "@/game/domain/worldEntity";
import { renderNarrativeMemory } from "./renderNarrativeMemory";
import { retrieveNarrativeMemory } from "./retrieveNarrativeMemory";
import type { EntityStore } from "@/game/domain/entity";

const OLD_LOCATION = asLocationId("location:old");
const CURRENT_LOCATION = asLocationId("location:current");
const NPC = asNpcId("npc:focus");
const PUBLIC_FACT = asFactId("fact:public");
const SECRET_FACT = asFactId("fact:secret");

const entityStore = {
  version: 2,
  records: [
    { core: { id: "player_0", kind: "player_character", name: "玩家", createdAtTurn: 0, lifecycle: "active" }, position: { locationId: CURRENT_LOCATION, locationOrder: 0 } },
    { core: { id: NPC, kind: "npc", name: "阿月", createdAtTurn: 0, lifecycle: "active" }, position: { locationId: CURRENT_LOCATION, locationOrder: 0 }, knowledge: { entries: [{ factId: SECRET_FACT, disclosure: "secret" }] } },
    { core: { id: OLD_LOCATION, kind: "location", name: "旧渡口", createdAtTurn: 0, lifecycle: "inactive" } },
    { core: { id: CURRENT_LOCATION, kind: "location", name: "新城门", createdAtTurn: 0, lifecycle: "active" } },
    { core: { id: PUBLIC_FACT, kind: "fact", name: "公开线索", createdAtTurn: 0, lifecycle: "active" }, fact: { discovered: true } },
    { core: { id: SECRET_FACT, kind: "fact", name: "私密线索", createdAtTurn: 0, lifecycle: "active" }, fact: { discovered: true } },
  ],
} as unknown as EntityStore;

describe("renderNarrativeMemory", () => {
  it("renders the exact historical item and source event from item-only recall", () => {
    const itemId = asItemId("item:keepsake");
    const ledger = [makeCommittedEvent({ type: "item_given", itemId, npcId: NPC, locationId: OLD_LOCATION }, {
      sequence: 0, actorIds: [], targetIds: [NPC], locationId: OLD_LOCATION,
    })];
    const retrieved = retrieveNarrativeMemory({
      memory: rebuildEpisodicMemory(ledger), ledger, relevantEntityIds: [itemId],
    });
    const rendered = renderNarrativeMemory({ retrieved, entityStore });
    expect(rendered.relevantEpisodesText).toContain(`itemId=${itemId}`);
    expect(rendered.relevantEpisodesText).toContain("kind=item_given");
    expect(rendered.manifestRefs.eventIds).toContain(ledger[0]!.eventId);
  });

  it("renders bounded cards with current-state precedence and no private fact text", () => {
    const ledger = [makeCommittedEvent({ type: "fact_discovered", factId: SECRET_FACT } as never, {
      eventId: asEventId("event:secret"),
      turnId: asTurnId("turn:old"),
      episodeId: asEpisodeId("episode:old"),
      sequence: 0,
      turnNumber: 2,
      actorIds: [NPC],
      locationId: OLD_LOCATION,
      factIds: [SECRET_FACT, PUBLIC_FACT],
      causeEventIds: [asEventId("event:cause")],
    })];
    const retrieved = retrieveNarrativeMemory({
      memory: rebuildEpisodicMemory(ledger),
      ledger,
      requiredEventIds: [asEventId("event:secret")],
      relevantEntityIds: [String(NPC)],
      currentLocationId: CURRENT_LOCATION,
    });
    const rendered = renderNarrativeMemory({ retrieved, entityStore });

    expect(rendered.relevantEventsText).toContain("kind=fact_discovered");
    expect(rendered.relevantEventsText).toContain("thenLocation=旧渡口");
    expect(rendered.relevantEventsText).toContain("currentLocation=新城门");
    expect(rendered.relevantEventsText).toContain("阿月");
    expect(rendered.relevantEventsText).not.toContain(String(SECRET_FACT));
    expect(rendered.relevantEventsText).not.toContain("私密线索");
    expect(rendered.manifestRefs.eventIds).toEqual([asEventId("event:secret")]);
    expect(rendered.manifestRefs.episodeIds).toEqual([asEpisodeId("episode:old")]);
  });
});
