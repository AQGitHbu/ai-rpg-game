import { describe, expect, it } from "vitest";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { asGenerationId, asItemId, asLocationId, asNpcId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { applyEntityMutations } from "@/game/gameplay/rpg/entityWorld";
import { updateWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import { isStoryDeliveryComplete } from "./index";

describe("story delivery completion", () => {
  const itemId = asItemId("item_letter");
  const recipient = asNpcId("npc_receiver");
  const locationId = asLocationId("loc_0");
  const story = { ...createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 }, initialNarrative: createFixtureNarrativeRuntimeState() }),
    delivery: { itemId, giverNpcId: asNpcId("npc_giver"), recipientNpcId: recipient } };
  const initial = createInitialWorldState({ generation: { generationId: asGenerationId("g"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" }, player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } }, startingLocation: { id: locationId, name: "l", description: "l", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] }, startingItemIds: [] });
  const base = updateWorldStateFixture(initial, { items: [{ id: itemId, name: "letter", description: "letter", kind: "quest", tags: [] }], inventory: [itemId],
    npcs: [{ id: recipient, name: "receiver", role: "contact", description: "contact", locationId, isCompanion: false, tags: [], met: true, memory: { npcId: recipient, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } }],
    locations: initial.locations.map(location => ({ ...location, npcIds: [recipient] })),
  });
  const event = makeCommittedEvent({ type: "item_given", itemId, npcId: recipient, locationId }, { outcome: "success", actorIds: [PLAYER_ENTITY_ID], targetIds: [recipient] });
  it("requires binding, actual delivery evidence and matching current owner", () => {
    expect(isStoryDeliveryComplete(base, story)).toBe(false);
    expect(isStoryDeliveryComplete({ ...base, eventLedger: [event] }, story)).toBe(false);
    const transferred = applyEntityMutations(base, [{ kind: "transfer_item", itemId, owner: { kind: "npc", npcId: recipient } }]);
    expect(transferred.ok).toBe(true);
    if (!transferred.ok) throw new Error(transferred.code);
    expect(isStoryDeliveryComplete(transferred.worldState, story)).toBe(false);
    expect(isStoryDeliveryComplete({ ...transferred.worldState, eventLedger: [event] }, story)).toBe(true);
    const returned = applyEntityMutations(transferred.worldState, [{ kind: "transfer_item", itemId, owner: { kind: "player", playerId: PLAYER_ENTITY_ID } }]);
    expect(returned.ok && isStoryDeliveryComplete({ ...returned.worldState, eventLedger: [event] }, story)).toBe(false);
    expect(isStoryDeliveryComplete(base, { ...story, delivery: { ...story.delivery, recipientNpcId: null } })).toBe(false);
  });
});
