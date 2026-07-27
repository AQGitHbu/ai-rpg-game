import { describe, expect, it } from "vitest";
import type { GameEvent, LocationObservedEvent, NpcMetEvent, FactDiscoveredEvent } from "./events";
import { asLocationId, asNpcId, asFactId, asGenerationId, type GenerationMetadata } from "./scenarioBlueprint";

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

  it("GameEvent union narrows on all Phase 3 type discriminators", () => {
    const events: GameEvent[] = [
      { type: "game_initialized", generation: buildGeneration() },
      { type: "location_observed", locationId: asLocationId("loc_1"), occurredAt: "t1" },
      { type: "npc_met", npcId: asNpcId("npc_1"), occurredAt: "t2" },
      { type: "fact_discovered", factId: asFactId("fact_1"), occurredAt: "t3" },
    ];

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "game_initialized",
      "location_observed",
      "npc_met",
      "fact_discovered",
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
