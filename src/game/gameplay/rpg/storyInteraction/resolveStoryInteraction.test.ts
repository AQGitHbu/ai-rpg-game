import { describe, expect, it } from "vitest";
import {
  asFactId,
  asGenerationId,
  asItemId,
  asLocationId,
  asNpcId,
  PLAYER_ENTITY_ID,
} from "@/game/domain/worldEntity";
import { asEventId } from "@/game/domain/events";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { createEntityStore, getEntity, projectEntityStore, type EntityRecord, type NpcEntityRecord, type PlayerEntityRecord } from "@/game/domain/entity";
import type { StoryInteraction } from "@/game/domain/storyInteraction";
import type { WorldState } from "@/game/domain/worldState";
import { resolveStoryInteraction } from "./resolveStoryInteraction";

const LOCATION = asLocationId("loc_temple");
const MESSENGER = asNpcId("npc_messenger");
const WITNESS = asNpcId("npc_witness");
const ITEM = asItemId("item_letter");
const FACT = asFactId("fact_origin");

function npcRecord(record: EntityRecord | undefined): NpcEntityRecord {
  if (record?.core.kind !== "npc") throw new Error("missing npc fixture");
  return record as NpcEntityRecord;
}

function interaction(overrides: Partial<StoryInteraction> = {}): StoryInteraction {
  return {
    id: "interaction:share",
    npcId: MESSENGER,
    operation: "share_known_fact",
    condition: [],
    factIds: [FACT],
    goalIds: [],
    promiseId: null,
    audienceIds: [PLAYER_ENTITY_ID, WITNESS],
    evidenceEventIds: [],
    ...overrides,
  };
}

function world(definition: StoryInteraction = interaction()): WorldState {
  const base = createWorldStateFixture({
    generation: {
      generationId: asGenerationId("gen-1"),
      seed: "seed",
      templateVersion: "v1",
      inputDigest: "",
      gameType: "wuxia",
    },
    projection: {
      ...emptyProjection({
        player: { name: "沈行", identity: "旅人", stats: { hp: 20, attack: 5, defense: 2 } },
        locations: [{
          id: LOCATION,
          name: "破庙",
          description: "",
          kind: "main",
          connectedLocationIds: [],
          npcIds: [MESSENGER, WITNESS],
          availableItemIds: [],
          tags: [],
        }],
        currentLocationId: LOCATION,
      }),
      npcs: [
        {
          id: MESSENGER,
          name: "信使",
          role: "信使",
          description: "",
          locationId: LOCATION,
          isCompanion: false,
          tags: [],
          met: true,
          memory: {
            npcId: MESSENGER,
            knownFactIds: [FACT],
            hiddenFactIds: [],
            interactionHistory: [],
            relationship: { affinity: 0 },
            emotion: "neutral",
            goals: [],
          },
        },
        {
          id: WITNESS,
          name: "见证人",
          role: "见证人",
          description: "",
          locationId: LOCATION,
          isCompanion: false,
          tags: [],
          met: true,
          memory: {
            npcId: WITNESS,
            knownFactIds: [],
            hiddenFactIds: [],
            interactionHistory: [],
            relationship: { affinity: 0 },
            emotion: "neutral",
            goals: [],
          },
        },
      ],
      items: [{ id: ITEM, name: "信筒", description: "", kind: "letter", tags: [] }],
      inventory: [ITEM],
      worldFacts: [{ factId: FACT, text: "信件来自旧友", source: "generated", discovered: false, locationId: LOCATION }],
    },
  });
  const npc = getEntity(base.entityStore, MESSENGER);
  if (npc?.core.kind !== "npc") throw new Error("missing messenger fixture");
  const store = createEntityStore(base.entityStore.records.map((record) => record.core.id === MESSENGER
    ? { ...npc, interactions: [definition] }
    : record));
  return { ...base, entityStore: store, ...projectEntityStore(store) };
}

const deps = {
  now: () => "2026-09-12T00:00:00.000Z",
  actionId: "act:interaction",
  turnNumber: 1,
  turnId: "turn:1" as never,
};

describe("resolveStoryInteraction", () => {
  it("fails a condition without changing state or emitting an event", () => {
    const current = world(interaction({
      id: "interaction:needs-key",
      condition: [{ kind: "has_item", itemId: ITEM, ownerId: WITNESS }],
    }));
    const result = resolveStoryInteraction(current, {
      type: "talk",
      npcId: MESSENGER,
      interactionId: "interaction:needs-key",
      dialogueAct: "ask",
    }, deps);

    expect(result).toMatchObject({ ok: true, status: "blocked", drafts: [], nextWorldState: current });
  });

  it("shares facts only with the interaction's explicit audience", () => {
    const current = world();
    const result = resolveStoryInteraction(current, {
      type: "talk",
      npcId: MESSENGER,
      interactionId: "interaction:share",
      dialogueAct: "ask",
    }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextWorldState.worldFacts.find((fact) => fact.factId === FACT)?.discovered).toBe(true);
    const witness = getEntity(result.nextWorldState.entityStore, WITNESS);
    const witnessNpc = npcRecord(witness);
    expect(witnessNpc.knowledge.entries.some((entry) => entry.factId === FACT)).toBe(true);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.payload).toMatchObject({
      type: "story_interaction_resolved",
      interactionId: "interaction:share",
      audienceIds: [PLAYER_ENTITY_ID, WITNESS],
    });
  });

  it("does not discover a fact globally when only another NPC hears it", () => {
    const current = world(interaction({ audienceIds: [WITNESS] }));
    const result = resolveStoryInteraction(current, {
      type: "talk",
      npcId: MESSENGER,
      interactionId: "interaction:share",
      dialogueAct: "ask",
    }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextWorldState.worldFacts.find((fact) => fact.factId === FACT)?.discovered).toBe(false);
    const player = getEntity(result.nextWorldState.entityStore, PLAYER_ENTITY_ID) as PlayerEntityRecord | undefined;
    if (player?.core.kind !== "player_character") throw new Error("missing player fixture");
    expect(player.knowledge.knownFactIds).not.toContain(FACT);
    const witness = getEntity(result.nextWorldState.entityStore, WITNESS);
    expect(npcRecord(witness).knowledge.entries.some((entry) => entry.factId === FACT)).toBe(true);
  });

  it("opens a confidentiality promise through the relationship mutation", () => {
    const current = world(interaction({
      id: "interaction:promise",
      operation: "promise_confidentiality",
      factIds: [],
      audienceIds: [PLAYER_ENTITY_ID],
    }));
    const result = resolveStoryInteraction(current, {
      type: "talk",
      npcId: MESSENGER,
      interactionId: "interaction:promise",
      dialogueAct: "ask",
    }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const messenger = getEntity(result.nextWorldState.entityStore, MESSENGER);
    const messengerNpc = npcRecord(messenger);
    expect(messengerNpc.relationships.outgoing.some((edge) => edge.commitments.some((commitment) => commitment.status === "open"))).toBe(true);
    expect(result.drafts[0]?.causeKeys).toEqual([]);
  });

  it("requires existing evidence for verification", () => {
    const current = world(interaction({
      id: "interaction:verify",
      operation: "request_verification",
      audienceIds: [PLAYER_ENTITY_ID],
      evidenceEventIds: [asEventId("event:missing")],
    }));
    const result = resolveStoryInteraction(current, {
      type: "talk",
      npcId: MESSENGER,
      interactionId: "interaction:verify",
      dialogueAct: "ask",
    }, deps);

    expect(result).toEqual({ ok: false, feedback: "核验依据尚未成立。" });
  });

  it("rejects an interaction with no actual audience", () => {
    const current = world(interaction({ audienceIds: [] }));
    const result = resolveStoryInteraction(current, {
      type: "talk",
      npcId: MESSENGER,
      interactionId: "interaction:share",
      dialogueAct: "ask",
    }, deps);

    expect(result).toEqual({ ok: false, feedback: "互动听众无效。" });
  });
});
