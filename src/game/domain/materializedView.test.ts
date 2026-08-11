import { describe, it, expect } from "vitest";
import { reconcileMaterializedView, createEmptyMaterializedView } from "./materializedView";
import type { GameEvent } from "./events";
import { asLocationId, asNpcId, asQuestId, asFactId } from "./worldEntity";

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

describe("MaterializedView candidate reaction visibility (Task 20)", () => {
  it("approved candidate reaction (fact_discovered) appears in recentBeats without AI text", () => {
    const events: GameEvent[] = [
      { type: "candidate_event_proposed", candidateId: "ce-1", kind: "npc_reveals_fact", proposedAtTurn: 3, expiresAtTurn: 6, occurredAt: "t1" },
      { type: "candidate_event_approved", candidateId: "ce-1", kind: "npc_reveals_fact", approvedAtTurn: 4, occurredAt: "t2" },
      { type: "fact_discovered", factId: asFactId("fact_2"), occurredAt: "t3" },
      { type: "candidate_event_activated", candidateId: "ce-1", kind: "npc_reveals_fact", activatedAtTurn: 4, occurredAt: "t4" },
    ];
    const v = createEmptyMaterializedView();
    const result = reconcileMaterializedView(v, events, asLocationId("loc_1"));
    // 编译后的真实领域事件进入 recentBeats（无 AI 原文）
    expect(result.recentBeats.some((b) => b.kind === "fact_discovered")).toBe(true);
    expect(result.recentBeats.some((b) => b.summary.includes("fact_2"))).toBe(true);
    // 审计事件（proposed/approved/activated）不成为 beat，也不携带 AI 原文
    expect(result.recentBeats.some((b) => b.kind === "candidate_event_activated")).toBe(false);
    // 任何 beat 摘要都不含隐藏事实正文或 AI 原文（只含结构化 ID）
    for (const beat of result.recentBeats) {
      expect(beat.summary).not.toMatch(/秘密|hidden|原文/);
    }
  });
});
