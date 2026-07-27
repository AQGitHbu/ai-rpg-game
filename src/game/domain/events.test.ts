import { describe, expect, it } from "vitest";
import type { GameEvent, LocationObservedEvent, NpcMetEvent, FactDiscoveredEvent, LocationVisitedEvent, QuestCompletedEvent, QuestUnlockedEvent, ItemObtainedEvent } from "./events";
import { asLocationId, asNpcId, asFactId, asGenerationId, asItemId, asQuestId, type GenerationMetadata } from "./scenarioBlueprint";

function buildGeneration(): GenerationMetadata {
  return {
    generationId: asGenerationId("gen-0001"),
    seed: "seed-1",
    templateVersion: "tpl-1",
    inputDigest: "digest-abc",
    gameType: "wuxia",
  };
}

describe("GameEvent union (Phase 3 action events)", () => {
  it("accepts location_observed event with injected timestamp", () => {
    const event: LocationObservedEvent = {
      type: "location_observed",
      locationId: asLocationId("loc_1"),
      occurredAt: "2026-07-27T10:00:00Z",
    };
    expect(event.type).toBe("location_observed");
    expect(event.locationId).toBe("loc_1");
    expect(event.occurredAt).toBe("2026-07-27T10:00:00Z");
  });

  it("accepts npc_met event with injected timestamp", () => {
    const event: NpcMetEvent = {
      type: "npc_met",
      npcId: asNpcId("npc_1"),
      occurredAt: "2026-07-27T10:01:00Z",
    };
    expect(event.type).toBe("npc_met");
    expect(event.npcId).toBe("npc_1");
  });

  it("accepts fact_discovered event with injected timestamp", () => {
    const event: FactDiscoveredEvent = {
      type: "fact_discovered",
      factId: asFactId("fact_gen_1"),
      occurredAt: "2026-07-27T10:02:00Z",
    };
    expect(event.type).toBe("fact_discovered");
    expect(event.factId).toBe("fact_gen_1");
  });

  it("accepts location_visited event with injected timestamp (Phase 4 move)", () => {
    const event: LocationVisitedEvent = {
      type: "location_visited",
      locationId: asLocationId("loc_2"),
      occurredAt: "2026-07-27T10:03:00Z",
    };
    expect(event.type).toBe("location_visited");
    expect(event.locationId).toBe("loc_2");
    expect(event.occurredAt).toBe("2026-07-27T10:03:00Z");
  });

  it("accepts quest_completed event with injected timestamp (Phase 4 reconciliation)", () => {
    const event: QuestCompletedEvent = {
      type: "quest_completed",
      questId: asQuestId("m1"),
      occurredAt: "2026-07-27T10:04:00Z",
    };
    expect(event.type).toBe("quest_completed");
    expect(event.questId).toBe("m1");
    expect(event.occurredAt).toBe("2026-07-27T10:04:00Z");
  });

  it("accepts quest_unlocked event with injected timestamp (Phase 4 reconciliation)", () => {
    const event: QuestUnlockedEvent = {
      type: "quest_unlocked",
      questId: asQuestId("m2"),
      occurredAt: "2026-07-27T10:05:00Z",
    };
    expect(event.type).toBe("quest_unlocked");
    expect(event.questId).toBe("m2");
    expect(event.occurredAt).toBe("2026-07-27T10:05:00Z");
  });

  it("accepts item_obtained event with injected timestamp (Phase 5 take_item)", () => {
    const event: ItemObtainedEvent = {
      type: "item_obtained",
      itemId: asItemId("item_key"),
      locationId: asLocationId("loc_3"),
      occurredAt: "2026-07-27T10:06:00Z",
    };
    expect(event.type).toBe("item_obtained");
    expect(event.itemId).toBe("item_key");
    expect(event.locationId).toBe("loc_3");
    expect(event.occurredAt).toBe("2026-07-27T10:06:00Z");
  });

  it("GameEvent union narrows on all Phase 3 type discriminators", () => {
    const events: GameEvent[] = [
      { type: "game_initialized", generation: buildGeneration() },
      { type: "location_observed", locationId: asLocationId("loc_1"), occurredAt: "t1" },
      { type: "npc_met", npcId: asNpcId("npc_1"), occurredAt: "t2" },
      { type: "fact_discovered", factId: asFactId("fact_1"), occurredAt: "t3" },
      { type: "location_visited", locationId: asLocationId("loc_2"), occurredAt: "t4" },
      { type: "quest_completed", questId: asQuestId("m1"), occurredAt: "t5" },
      { type: "quest_unlocked", questId: asQuestId("m2"), occurredAt: "t6" },
      { type: "item_obtained", itemId: asItemId("item_1"), locationId: asLocationId("loc_3"), occurredAt: "t7" },
    ];

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "game_initialized",
      "location_observed",
      "npc_met",
      "fact_discovered",
      "location_visited",
      "quest_completed",
      "quest_unlocked",
      "item_obtained",
    ]);
  });

  it("rejects unknown event types at compile time", () => {
    // @ts-expect-error only declared event types are allowed
    const unknownEvent: GameEvent = { type: "combat_resolved" };
    expect(unknownEvent).toBeDefined();
  });

  it("rejects raw strings for branded id fields at compile time", () => {
    // @ts-expect-error locationId requires a branded LocationId
    const badEvent: LocationObservedEvent = { type: "location_observed", locationId: "loc_1", occurredAt: "t" };
    expect(badEvent).toBeDefined();
  });
});
