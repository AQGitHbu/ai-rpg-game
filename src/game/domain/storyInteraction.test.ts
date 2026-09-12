import { describe, expect, it } from "vitest";
import { asFactId, asGenerationId, asItemId, asLocationId, asNpcId, PLAYER_ENTITY_ID } from "./worldEntity";
import { createWorldStateFixture, emptyProjection } from "./testing/worldStateFixture.testutil";
import { createEntityStore, getEntity, projectEntityStore } from "./entity";
import { parseStoryInteractionProposal, type StoryInteraction } from "./storyInteraction";
import { evaluateStoryCondition } from "../gameplay/rpg/storyInteraction";
import type { WorldState } from "./worldState";

const LOCATION = asLocationId("loc_temple");
const NPC = asNpcId("npc_messenger");
const ITEM = asItemId("item_letter");
const FACT = asFactId("fact_origin");

function world(): WorldState {
  const base = createWorldStateFixture({
    generation: { generationId: asGenerationId("gen-1"), seed: "seed", templateVersion: "v1", inputDigest: "", gameType: "wuxia" },
    projection: {
      ...emptyProjection({
        player: { name: "沈行", identity: "旅人", stats: { hp: 20, attack: 5, defense: 2 } },
        locations: [{ id: LOCATION, name: "破庙", description: "", kind: "main", connectedLocationIds: [], npcIds: [NPC], availableItemIds: [], tags: [] }],
        currentLocationId: LOCATION,
      }),
      npcs: [{
        id: NPC, name: "信使", role: "信使", description: "", locationId: LOCATION, isCompanion: false, tags: [], met: true,
        memory: { npcId: NPC, knownFactIds: [FACT], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
      }],
      items: [{ id: ITEM, name: "信筒", description: "", kind: "letter", tags: [] }],
      inventory: [ITEM],
      worldFacts: [{ factId: FACT, text: "信件来自旧友", source: "generated", discovered: true, locationId: LOCATION }],
    },
  });
  const npc = getEntity(base.entityStore, NPC);
  if (npc?.core.kind !== "npc") throw new Error("missing npc fixture");
  const interaction: StoryInteraction = {
    id: "interaction:verify",
    npcId: NPC,
    operation: "request_verification",
    condition: [{ kind: "has_item", itemId: ITEM, ownerId: PLAYER_ENTITY_ID }],
    factIds: [FACT],
    goalIds: [],
    promiseId: null,
    audienceIds: [PLAYER_ENTITY_ID],
    evidenceEventIds: [],
  };
  const store = createEntityStore(base.entityStore.records.map((record) => record.core.id === NPC
    ? { ...npc, interactions: [interaction] }
    : record));
  return { ...base, entityStore: store, ...projectEntityStore(store) };
}

describe("story interaction conditions", () => {
  it("evaluates item ownership from authoritative entity state", () => {
    const current = world();
    expect(evaluateStoryCondition(current, { kind: "has_item", itemId: ITEM, ownerId: PLAYER_ENTITY_ID })).toBe(true);
    expect(evaluateStoryCondition(current, { kind: "has_item", itemId: ITEM, ownerId: NPC })).toBe(false);
  });

  it("rejects a condition when the referenced fact is not known by the actor", () => {
    const current = world();
    expect(evaluateStoryCondition(current, { kind: "knows_fact", actorId: NPC, factId: FACT })).toBe(true);
    expect(evaluateStoryCondition(current, { kind: "knows_fact", actorId: PLAYER_ENTITY_ID, factId: asFactId("fact_unknown") })).toBe(false);
  });

  it("parses proposal keys separately from server-minted interaction ids", () => {
    const parsed = parseStoryInteractionProposal({
      proposalKey: "verify",
      npcId: String(NPC),
      operation: "request_verification",
      condition: [],
      factIds: [String(FACT)],
      goalIds: [],
      promiseId: null,
      audienceIds: [String(PLAYER_ENTITY_ID)],
      evidenceEventIds: [],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({ proposalKey: "verify", npcId: NPC });
    expect("id" in parsed.value).toBe(false);
  });

  it("rejects unknown proposal fields before approval", () => {
    const parsed = parseStoryInteractionProposal({
      proposalKey: "verify",
      npcId: String(NPC),
      operation: "request_verification",
      condition: [],
      factIds: [],
      goalIds: [],
      promiseId: null,
      audienceIds: [String(PLAYER_ENTITY_ID)],
      evidenceEventIds: [],
      id: "forged",
    });
    expect(parsed.ok).toBe(false);
  });
});
