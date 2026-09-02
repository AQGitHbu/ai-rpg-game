import { describe, expect, it } from "vitest";
import type {
  NarrativeEventPayload,
  CommittedNarrativeEvent,
  NarrativeEventDraft,
  GameInitializedPayload,
  LocationObservedPayload,
  NpcMetPayload,
  NpcDialogueCompletedPayload,
  FactDiscoveredPayload,
  LocationVisitedPayload,
  QuestCompletedPayload,
  QuestUnlockedPayload,
  ItemObtainedPayload,
  ItemGivenPayload,
  BattleStartedPayload,
  BattleRoundResolvedPayload,
  BattleResolvedPayload,
  EnemyDefeatedPayload,
  QuestFailedPayload,
  EndingReachedPayload,
  NarrativeScenePresentedPayload,
  CandidateEventApprovedPayload,
  CandidateEventRejectedPayload,
  CandidateEventExpiredPayload,
  CandidateEventActivatedPayload,
} from "./events";
import {
  asEventId, asTurnId, asEpisodeId, eventIdFor, episodeIdForTurn,
  parseCommittedEventLedger,
} from "./events";
import {
  asLocationId, asNpcId, asFactId, asGenerationId, asItemId, asQuestId, asEnemyId, asEndingId,
  type GenerationMetadata,
} from "./worldEntity";

function buildGeneration(): GenerationMetadata {
  return {
    generationId: asGenerationId("gen-0001"),
    seed: "seed-1",
    templateVersion: "tpl-1",
    inputDigest: "digest-abc",
    gameType: "wuxia",
  };
}

function buildCommittedEvent(overrides: Partial<CommittedNarrativeEvent> = {}): CommittedNarrativeEvent {
  const turnId = asTurnId("turn:1");
  return {
    eventId: eventIdFor(turnId, "test_event"),
    sequence: 0,
    turnId,
    turnNumber: 1,
    episodeId: episodeIdForTurn(turnId),
    kind: "fact_discovered",
    actorIds: [],
    targetIds: [],
    locationId: asLocationId("loc_1"),
    causeEventIds: [],
    factIds: [asFactId("fact_1")],
    questIds: [],
    outcome: "success",
    salience: 50,
    committedAt: "2026-09-02T00:00:00Z",
    payload: { type: "fact_discovered", factId: asFactId("fact_1") },
    ...overrides,
  };
}

describe("NarrativeEventPayload union", () => {
  it("accepts game_initialized payload", () => {
    const payload: GameInitializedPayload = {
      type: "game_initialized",
      generation: buildGeneration(),
    };
    expect(payload.type).toBe("game_initialized");
  });

  it("accepts location_observed payload", () => {
    const payload: LocationObservedPayload = {
      type: "location_observed",
      locationId: asLocationId("loc_1"),
    };
    expect(payload.type).toBe("location_observed");
  });

  it("accepts npc_met payload", () => {
    const payload: NpcMetPayload = {
      type: "npc_met",
      npcId: asNpcId("npc_1"),
    };
    expect(payload.npcId).toBe("npc_1");
  });

  it("accepts npc_dialogue_completed payload", () => {
    const payload: NpcDialogueCompletedPayload = {
      type: "npc_dialogue_completed",
      npcId: asNpcId("npc_1"),
    };
    expect(payload.type).toBe("npc_dialogue_completed");
  });

  it("accepts fact_discovered payload with approach metadata", () => {
    const payload: FactDiscoveredPayload = {
      type: "fact_discovered",
      factId: asFactId("fact_trace"),
      approachId: "follow",
      evidenceQuality: "clean",
      tensionDelta: 4,
    };
    expect(payload.evidenceQuality).toBe("clean");
    expect(payload.approachId).toBe("follow");
    expect(payload.tensionDelta).toBe(4);
  });

  it("fact_discovered stays valid when approach metadata is omitted", () => {
    const payload: FactDiscoveredPayload = {
      type: "fact_discovered",
      factId: asFactId("fact_trace"),
    };
    expect(payload.approachId).toBeUndefined();
    expect(payload.evidenceQuality).toBeUndefined();
    expect(payload.tensionDelta).toBeUndefined();
  });

  it("accepts location_visited payload", () => {
    const payload: LocationVisitedPayload = {
      type: "location_visited",
      locationId: asLocationId("loc_2"),
    };
    expect(payload.type).toBe("location_visited");
  });

  it("accepts quest_completed payload", () => {
    const payload: QuestCompletedPayload = {
      type: "quest_completed",
      questId: asQuestId("m1"),
    };
    expect(payload.questId).toBe("m1");
  });

  it("accepts quest_unlocked payload", () => {
    const payload: QuestUnlockedPayload = {
      type: "quest_unlocked",
      questId: asQuestId("m2"),
    };
    expect(payload.type).toBe("quest_unlocked");
  });

  it("accepts item_obtained payload", () => {
    const payload: ItemObtainedPayload = {
      type: "item_obtained",
      itemId: asItemId("item_key"),
      locationId: asLocationId("loc_3"),
    };
    expect(payload.itemId).toBe("item_key");
  });

  it("accepts item_given payload", () => {
    const payload: ItemGivenPayload = {
      type: "item_given",
      itemId: asItemId("item_key"),
      npcId: asNpcId("npc_1"),
      locationId: asLocationId("loc_3"),
    };
    expect(payload.type).toBe("item_given");
  });

  it("accepts battle_started payload", () => {
    const payload: BattleStartedPayload = {
      type: "battle_started",
      enemyId: asEnemyId("enemy_boss"),
    };
    expect(payload.enemyId).toBe("enemy_boss");
  });

  it("accepts battle_round_resolved payload", () => {
    const payload: BattleRoundResolvedPayload = {
      type: "battle_round_resolved",
      enemyId: asEnemyId("enemy_boss"),
      round: 1,
      playerHp: 28,
      enemyHp: 16,
      action: "attack",
    };
    expect(payload.round).toBe(1);
    expect(payload.playerHp).toBe(28);
  });

  it("accepts battle_resolved payload with victory outcome", () => {
    const payload: BattleResolvedPayload = {
      type: "battle_resolved",
      enemyId: asEnemyId("enemy_boss"),
      outcome: "victory",
    };
    expect(payload.outcome).toBe("victory");
  });

  it("accepts enemy_defeated payload", () => {
    const payload: EnemyDefeatedPayload = {
      type: "enemy_defeated",
      enemyId: asEnemyId("enemy_boss"),
    };
    expect(payload.type).toBe("enemy_defeated");
  });

  it("accepts quest_failed payload", () => {
    const payload: QuestFailedPayload = {
      type: "quest_failed",
      questId: asQuestId("quest_m3"),
    };
    expect(payload.questId).toBe("quest_m3");
  });

  it("accepts ending_reached payload with success outcome", () => {
    const payload: EndingReachedPayload = {
      type: "ending_reached",
      endingId: asEndingId("ending_1"),
      outcome: "success",
    };
    expect(payload.endingId).toBe("ending_1");
    expect(payload.outcome).toBe("success");
  });

  it("accepts ending_reached payload with failure outcome", () => {
    const payload: EndingReachedPayload = {
      type: "ending_reached",
      endingId: asEndingId("ending_2"),
      outcome: "failure",
    };
    expect(payload.outcome).toBe("failure");
  });

  it("accepts narrative_scene_presented payload with minimal structure", () => {
    const payload: NarrativeScenePresentedPayload = {
      type: "narrative_scene_presented",
      sceneId: "scene-1",
      focusNpcId: null,
      pacing: "develop",
      beatIds: [],
      revealedFactIds: [],
    };
    expect(payload.type).toBe("narrative_scene_presented");
    expect(payload.focusNpcId).toBeNull();
    expect(payload.pacing).toBe("develop");
  });

  it("accepts candidate_event_approved payload", () => {
    const payload: CandidateEventApprovedPayload = {
      type: "candidate_event_approved",
      candidateId: "ce-1",
      kind: "npc_reveals_fact",
      approvedAtTurn: 4,
    };
    expect(payload.approvedAtTurn).toBe(4);
  });

  it("accepts candidate_event_rejected payload with reasonCode", () => {
    const payload: CandidateEventRejectedPayload = {
      type: "candidate_event_rejected",
      candidateId: "ce-2",
      kind: "thread_complicates",
      reasonCode: "prerequisite_unmet",
      rejectedAtTurn: 4,
    };
    expect(payload.reasonCode).toBe("prerequisite_unmet");
  });

  it("accepts candidate_event_expired payload", () => {
    const payload: CandidateEventExpiredPayload = {
      type: "candidate_event_expired",
      candidateId: "ce-3",
      kind: "location_state_changes",
      expiredAtTurn: 6,
    };
    expect(payload.expiredAtTurn).toBe(6);
  });

  it("accepts candidate_event_activated payload", () => {
    const payload: CandidateEventActivatedPayload = {
      type: "candidate_event_activated",
      candidateId: "ce-1",
      kind: "npc_reveals_fact",
      activatedAtTurn: 4,
    };
    expect(payload.type).toBe("candidate_event_activated");
  });
});

describe("CommittedNarrativeEvent envelope", () => {
  it("builds a valid committed event", () => {
    const event = buildCommittedEvent();
    expect(event.eventId).toBeDefined();
    expect(event.sequence).toBe(0);
    expect(event.kind).toBe("fact_discovered");
    expect(event.committedAt).toBe("2026-09-02T00:00:00Z");
    expect((event.payload as { type: string }).type).toBe("fact_discovered");
  });

  it("parseCommittedEventLedger accepts valid ledger", () => {
    const event = buildCommittedEvent();
    const result = parseCommittedEventLedger([event]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
    }
  });

  it("parseCommittedEventLedger rejects non-array", () => {
    const result = parseCommittedEventLedger(null);
    expect(result.ok).toBe(false);
  });

  it("parseCommittedEventLedger rejects wrong sequence", () => {
    const event = buildCommittedEvent({ sequence: 5 });
    const result = parseCommittedEventLedger([event]);
    expect(result.ok).toBe(false);
  });

  it("parseCommittedEventLedger rejects mismatched kind and payload type", () => {
    const event = buildCommittedEvent({
      kind: "npc_met",
      payload: { type: "fact_discovered", factId: asFactId("fact_1") },
    });
    const result = parseCommittedEventLedger([event]);
    expect(result.ok).toBe(false);
  });

  it("eventIdFor is deterministic", () => {
    const turnId = asTurnId("turn:1");
    const id1 = eventIdFor(turnId, "fact_discovered:fact_1");
    const id2 = eventIdFor(turnId, "fact_discovered:fact_1");
    expect(id1).toBe(id2);
  });

  it("episodeIdForTurn is deterministic", () => {
    const turnId = asTurnId("turn:1");
    const id1 = episodeIdForTurn(turnId);
    const id2 = episodeIdForTurn(turnId);
    expect(id1).toBe(id2);
  });
});
