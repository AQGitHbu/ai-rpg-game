import { describe, it, expect } from "vitest";
import { reconcileMaterializedView, createEmptyMaterializedView, type MaterializedView } from "./materializedView";
import type { GameEvent } from "./events";
import { asLocationId, asNpcId, asQuestId } from "./scenarioBlueprint";

describe("MaterializedView", () => {
  it("empty view has zero cursor", () => {
    const v = createEmptyMaterializedView();
    expect(v.reducedThroughEventCount).toBe(0);
    expect(v.recentBeats).toEqual([]);
    expect(v.npcContacts).toEqual([]);
  });

  it("reconciles from empty ledger", () => {
    const v = createEmptyMaterializedView();
    const result = reconcileMaterializedView(v, [], asLocationId("loc_1"));
    expect(result.recentBeats).toEqual([]);
  });

  it("extracts quest_completed as a beat", () => {
    const events: GameEvent[] = [
      { type: "quest_completed", questId: asQuestId("q1"), occurredAt: "2026-01-01" },
    ];
    const v = createEmptyMaterializedView();
    const result = reconcileMaterializedView(v, events, asLocationId("loc_1"));
    expect(result.recentBeats.length).toBe(1);
    expect(result.reducedThroughEventCount).toBe(1);
  });

  it("npc_met records contact location (from currentLocationId at commit time)", () => {
    const events: GameEvent[] = [
      { type: "npc_met", npcId: asNpcId("npc_1"), occurredAt: "t1" },
    ];
    const v = createEmptyMaterializedView();
    const result = reconcileMaterializedView(v, events, asLocationId("loc_1"));
    expect(result.npcContacts[0]?.lastLocationId).toBe(asLocationId("loc_1"));
  });

  it("incremental: only processes new events since cursor", () => {
    const events: GameEvent[] = [
      { type: "quest_completed", questId: asQuestId("q1"), occurredAt: "t1" },
      { type: "location_visited", locationId: asLocationId("loc1"), occurredAt: "t2" },
    ];
    const v = createEmptyMaterializedView();
    const r1 = reconcileMaterializedView(v, events, asLocationId("loc_1"));
    const r2 = reconcileMaterializedView(r1, events, asLocationId("loc_1")); // idempotent
    expect(r2.reducedThroughEventCount).toBe(2);
    expect(r2.recentBeats.length).toBe(r1.recentBeats.length);
  });
});
