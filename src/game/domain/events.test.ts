import { describe, expect, it } from "vitest";
import type { GameEvent, LocationObservedEvent, NpcMetEvent, FactDiscoveredEvent, LocationVisitedEvent, QuestCompletedEvent, QuestUnlockedEvent, ItemObtainedEvent, BattleStartedEvent, BattleRoundResolvedEvent, BattleResolvedEvent, EnemyDefeatedEvent, QuestFailedEvent, EndingReachedEvent, NarrativeScenePresentedEvent, CandidateEventProposedEvent, CandidateEventApprovedEvent, CandidateEventRejectedEvent, CandidateEventExpiredEvent, CandidateEventActivatedEvent } from "./events";
import { asLocationId, asNpcId, asFactId, asGenerationId, asItemId, asQuestId, asEnemyId, asEndingId, type GenerationMetadata } from "./scenarioBlueprint";

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

describe("GameEvent union (Phase 6 battle and ending events)", () => {
  it("accepts battle_started event with enemyId and timestamp", () => {
    const event: BattleStartedEvent = {
      type: "battle_started",
      enemyId: asEnemyId("enemy_boss"),
      occurredAt: "2026-07-28T10:00:00Z",
    };
    expect(event.type).toBe("battle_started");
    expect(event.enemyId).toBe("enemy_boss");
  });

  it("accepts battle_round_resolved event with full round data", () => {
    const event: BattleRoundResolvedEvent = {
      type: "battle_round_resolved",
      enemyId: asEnemyId("enemy_boss"),
      round: 1,
      playerHp: 28,
      enemyHp: 16,
      action: "attack",
      occurredAt: "2026-07-28T10:01:00Z",
    };
    expect(event.type).toBe("battle_round_resolved");
    expect(event.round).toBe(1);
    expect(event.playerHp).toBe(28);
    expect(event.enemyHp).toBe(16);
    expect(event.action).toBe("attack");
  });

  it("accepts battle_resolved event with victory outcome", () => {
    const event: BattleResolvedEvent = {
      type: "battle_resolved",
      enemyId: asEnemyId("enemy_boss"),
      outcome: "victory",
      occurredAt: "2026-07-28T10:05:00Z",
    };
    expect(event.type).toBe("battle_resolved");
    expect(event.outcome).toBe("victory");
  });

  it("accepts battle_resolved event with withdraw outcome", () => {
    const event: BattleResolvedEvent = {
      type: "battle_resolved",
      enemyId: asEnemyId("enemy_boss"),
      outcome: "withdraw",
      occurredAt: "2026-07-28T10:05:00Z",
    };
    expect(event.outcome).toBe("withdraw");
  });

  it("accepts enemy_defeated event with enemyId and timestamp", () => {
    const event: EnemyDefeatedEvent = {
      type: "enemy_defeated",
      enemyId: asEnemyId("enemy_boss"),
      occurredAt: "2026-07-28T10:06:00Z",
    };
    expect(event.type).toBe("enemy_defeated");
    expect(event.enemyId).toBe("enemy_boss");
  });

  it("accepts quest_failed event with questId and timestamp", () => {
    const event: QuestFailedEvent = {
      type: "quest_failed",
      questId: asQuestId("quest_m3"),
      occurredAt: "2026-07-28T10:07:00Z",
    };
    expect(event.type).toBe("quest_failed");
    expect(event.questId).toBe("quest_m3");
  });

  it("accepts ending_reached event with endingId, outcome and timestamp", () => {
    const event: EndingReachedEvent = {
      type: "ending_reached",
      endingId: asEndingId("ending_1"),
      outcome: "success",
      occurredAt: "2026-07-28T10:08:00Z",
    };
    expect(event.type).toBe("ending_reached");
    expect(event.endingId).toBe("ending_1");
    expect(event.outcome).toBe("success");
  });

  it("accepts ending_reached event with failure outcome", () => {
    const event: EndingReachedEvent = {
      type: "ending_reached",
      endingId: asEndingId("ending_2"),
      outcome: "failure",
      occurredAt: "2026-07-28T10:09:00Z",
    };
    expect(event.outcome).toBe("failure");
  });

  it("GameEvent union includes all Phase 6 type discriminators", () => {
    const events: GameEvent[] = [
      { type: "battle_started", enemyId: asEnemyId("e1"), occurredAt: "t1" },
      { type: "battle_round_resolved", enemyId: asEnemyId("e1"), round: 1, playerHp: 10, enemyHp: 5, action: "attack", occurredAt: "t2" },
      { type: "battle_resolved", enemyId: asEnemyId("e1"), outcome: "victory", occurredAt: "t3" },
      { type: "enemy_defeated", enemyId: asEnemyId("e1"), occurredAt: "t4" },
      { type: "quest_failed", questId: asQuestId("q1"), occurredAt: "t5" },
      { type: "ending_reached", endingId: asEndingId("ed1"), outcome: "success", occurredAt: "t6" },
    ];

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "battle_started",
      "battle_round_resolved",
      "battle_resolved",
      "enemy_defeated",
      "quest_failed",
      "ending_reached",
    ]);
  });
});

describe("GameEvent union (Phase 11 narrative scene presented)", () => {
  it("accepts narrative_scene_presented event carrying only structural indexes", () => {
    const event: NarrativeScenePresentedEvent = {
      type: "narrative_scene_presented",
      sceneId: "scene-1",
      locationId: asLocationId("loc_1"),
      focusNpcId: null,
      revealedFactIds: [],
      pacing: "develop",
      occurredAt: "2026-07-31T00:00:00.000Z"
    };
    expect(event.type).toBe("narrative_scene_presented");
    expect(event.focusNpcId).toBeNull();
    expect(event.pacing).toBe("develop");
    // 仅结构索引：不携带叙事文本、choiceToken、actionKey 或 provider 输出。
    const keys = Object.keys(event).sort();
    expect(keys).toEqual([
      "focusNpcId",
      "locationId",
      "occurredAt",
      "pacing",
      "revealedFactIds",
      "sceneId",
      "type"
    ]);
  });

  it("narrative_scene_presented narrows via type discriminator in the GameEvent union", () => {
    const event: GameEvent = {
      type: "narrative_scene_presented",
      sceneId: "scene-1",
      locationId: asLocationId("loc_1"),
      focusNpcId: null,
      revealedFactIds: [],
      pacing: "climax",
      occurredAt: "2026-07-31T00:00:00.000Z"
    };
    if (event.type === "narrative_scene_presented") {
      expect(event.sceneId).toBe("scene-1");
      expect(event.pacing).toBe("climax");
    } else {
      throw new Error("discriminator narrowing failed");
    }
  });
});

describe("GameEvent union (R4 candidate event audit events)", () => {
  it("accepts candidate_event_proposed carrying only structural indexes", () => {
    const event: CandidateEventProposedEvent = {
      type: "candidate_event_proposed",
      candidateId: "ce-1",
      kind: "enemy_appears",
      proposedAtTurn: 3,
      expiresAtTurn: 6,
      occurredAt: "2026-08-09T00:00:00.000Z",
    };
    expect(event.type).toBe("candidate_event_proposed");
    expect(event.candidateId).toBe("ce-1");
    expect(event.kind).toBe("enemy_appears");
    // 只携带结构索引，不携带 AI 原文或隐藏事实正文
    const keys = Object.keys(event).sort();
    expect(keys).toEqual([
      "candidateId", "expiresAtTurn", "kind", "occurredAt", "proposedAtTurn", "type",
    ]);
  });

  it("accepts candidate_event_approved with stable code", () => {
    const event: CandidateEventApprovedEvent = {
      type: "candidate_event_approved",
      candidateId: "ce-1",
      kind: "npc_reveals_fact",
      approvedAtTurn: 4,
      occurredAt: "t1",
    };
    expect(event.approvedAtTurn).toBe(4);
    const keys = Object.keys(event).sort();
    expect(keys).toEqual(["approvedAtTurn", "candidateId", "kind", "occurredAt", "type"]);
  });

  it("accepts candidate_event_rejected with reasonCode but no conflict body", () => {
    const event: CandidateEventRejectedEvent = {
      type: "candidate_event_rejected",
      candidateId: "ce-2",
      kind: "thread_complicates",
      reasonCode: "prerequisite_unmet",
      rejectedAtTurn: 4,
      occurredAt: "t2",
    };
    expect(event.reasonCode).toBe("prerequisite_unmet");
    expect("conflictText" in event).toBe(false);
  });

  it("accepts candidate_event_expired at expiry turn", () => {
    const event: CandidateEventExpiredEvent = {
      type: "candidate_event_expired",
      candidateId: "ce-3",
      kind: "location_state_changes",
      expiredAtTurn: 6,
      occurredAt: "t3",
    };
    expect(event.expiredAtTurn).toBe(6);
  });

  it("accepts candidate_event_activated when compiled to real domain event", () => {
    const event: CandidateEventActivatedEvent = {
      type: "candidate_event_activated",
      candidateId: "ce-1",
      kind: "npc_reveals_fact",
      activatedAtTurn: 4,
      occurredAt: "t4",
    };
    expect(event.type).toBe("candidate_event_activated");
    expect(event.candidateId).toBe("ce-1");
  });

  it("all five candidate audit discriminators appear in the GameEvent union", () => {
    const events: GameEvent[] = [
      { type: "candidate_event_proposed", candidateId: "ce-1", kind: "enemy_appears", proposedAtTurn: 3, expiresAtTurn: 6, occurredAt: "t1" },
      { type: "candidate_event_approved", candidateId: "ce-1", kind: "enemy_appears", approvedAtTurn: 4, occurredAt: "t2" },
      { type: "candidate_event_rejected", candidateId: "ce-2", kind: "thread_complicates", reasonCode: "budget", rejectedAtTurn: 4, occurredAt: "t3" },
      { type: "candidate_event_expired", candidateId: "ce-3", kind: "npc_reveals_fact", expiredAtTurn: 6, occurredAt: "t4" },
      { type: "candidate_event_activated", candidateId: "ce-1", kind: "npc_reveals_fact", activatedAtTurn: 4, occurredAt: "t5" },
    ];
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "candidate_event_proposed",
      "candidate_event_approved",
      "candidate_event_rejected",
      "candidate_event_expired",
      "candidate_event_activated",
    ]);
  });
});
