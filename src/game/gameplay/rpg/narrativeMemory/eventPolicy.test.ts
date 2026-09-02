import { describe, it, expect } from "vitest";
import { EVENT_POLICY, getEventPolicy } from "./eventPolicy";
import type { NarrativeEventPayload } from "@/game/domain/events";

describe("eventPolicy", () => {
  it("has an entry for every payload type", () => {
    const allTypes: NarrativeEventPayload["type"][] = [
      "game_initialized", "location_observed", "npc_met", "npc_dialogue_completed",
      "fact_discovered", "location_visited", "location_explored", "quest_completed",
      "quest_unlocked", "location_unlocked", "item_obtained", "item_given",
      "battle_started", "battle_round_resolved", "battle_resolved", "enemy_defeated",
      "quest_failed", "ending_reached", "blueprint_expanded", "narrative_scene_presented",
      "player_intent_expressed", "candidate_event_approved", "candidate_event_rejected",
      "candidate_event_expired", "candidate_event_activated",
      "npc_interaction_recorded", "npc_knowledge_changed", "npc_relationship_changed",
    ];
    for (const kind of allTypes) {
      const policy = getEventPolicy(kind);
      expect(policy).toBeDefined();
      expect(Number.isInteger(policy.defaultSalience)).toBe(true);
      expect(policy.defaultSalience).toBeGreaterThanOrEqual(0);
      expect(policy.defaultSalience).toBeLessThanOrEqual(100);
      expect(policy.summaryKeys.length).toBeGreaterThan(0);
    }
  });

  it("has ending at salience 100", () => {
    expect(getEventPolicy("ending_reached").defaultSalience).toBe(100);
  });

  it("has quest/battle resolved at salience 80", () => {
    expect(getEventPolicy("quest_completed").defaultSalience).toBe(80);
    expect(getEventPolicy("battle_resolved").defaultSalience).toBe(80);
  });

  it("has fact discovered at salience 65", () => {
    expect(getEventPolicy("fact_discovered").defaultSalience).toBe(65);
  });

  it("has scene presented at salience 40", () => {
    expect(getEventPolicy("narrative_scene_presented").defaultSalience).toBe(40);
  });

  it("has travel at salience 20", () => {
    expect(getEventPolicy("location_visited").defaultSalience).toBe(20);
  });
});
