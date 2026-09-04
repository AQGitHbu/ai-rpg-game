import { describe, expect, it } from "vitest";
import {
  createEmptyEpisodicMemory,
  rebuildEpisodicMemory,
  reconcileEpisodicMemory,
} from "./episodicMemory";
import type { CommittedNarrativeEvent } from "./events";
import {
  asEpisodeId,
  asEventId,
  asTurnId,
  episodeIdForBattle,
} from "./events";
import { makeCommittedEvent } from "./testing/committedEventFactory";
import {
  asFactId,
  asLocationId,
  asNpcId,
  asQuestId,
  PLAYER_ENTITY_ID,
} from "./worldEntity";

const LOC_A = asLocationId("loc_a");
const LOC_B = asLocationId("loc_b");
const NPC_A = asNpcId("npc_a");
const NPC_B = asNpcId("npc_b");
const FACT_A = asFactId("fact_a");
const QUEST_A = asQuestId("quest_a");

function event(
  sequence: number,
  input: Parameters<typeof makeCommittedEvent>[0],
  overrides: Partial<CommittedNarrativeEvent> = {},
): CommittedNarrativeEvent {
  const turnId = overrides.turnId ?? asTurnId(`turn:${sequence}`);
  return makeCommittedEvent(input, {
    sequence,
    turnId,
    eventId: overrides.eventId ?? asEventId(`${turnId}:event_${sequence}`),
    episodeId: overrides.episodeId ?? asEpisodeId(`episode:${turnId}`),
    ...overrides,
  });
}

describe("EpisodicMemory", () => {
  it("creates an empty memory with a sequence cursor before the ledger", () => {
    expect(createEmptyEpisodicMemory()).toEqual({
      version: 1,
      reducedThroughSequence: -1,
      episodes: [],
      recentScenes: [],
      npcContacts: [],
    });
  });

  it("aggregates a turn, its scene write-back and world expansion into one episode", () => {
    const turnId = asTurnId("turn:one");
    const episodeId = asEpisodeId("episode:turn:one");
    const ledger = [
      event(0, { type: "game_initialized", generation: { generationId: "g1" } as never }, {
        turnId: asTurnId("init:g1"),
        episodeId: asEpisodeId("episode:init:g1"),
        eventId: asEventId("init:g1:game_initialized"),
        turnNumber: 0,
      }),
      event(1, { type: "fact_discovered", factId: FACT_A }, {
        turnId,
        episodeId,
        turnNumber: 1,
        actorIds: [PLAYER_ENTITY_ID, NPC_A],
        targetIds: [NPC_A],
        locationId: LOC_A,
        factIds: [FACT_A],
        questIds: [QUEST_A],
        causeEventIds: [asEventId("init:g1:game_initialized")],
        outcome: "success",
        salience: 65,
      }),
      event(2, { type: "narrative_scene_presented", sceneId: "scene_1", focusNpcId: NPC_A, pacing: "develop", beatIds: ["fact_discovered"], revealedFactIds: [FACT_A] }, {
        turnId,
        episodeId,
        turnNumber: 1,
        actorIds: [NPC_A],
        targetIds: [PLAYER_ENTITY_ID],
        locationId: LOC_A,
        factIds: [FACT_A],
        questIds: [QUEST_A],
        causeEventIds: [asEventId("turn:one:fact_discovered")],
        outcome: "neutral",
        salience: 40,
        eventId: asEventId("turn:one:narrative_scene_presented:scene_1"),
      }),
      event(3, { type: "blueprint_expanded", expansionKind: "location" } as never, {
        turnId,
        episodeId,
        turnNumber: 1,
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [NPC_A],
        locationId: LOC_B,
        factIds: [FACT_A],
        questIds: [QUEST_A],
        causeEventIds: [asEventId("turn:one:fact_discovered")],
        outcome: "success",
        salience: 20,
      }),
    ];

    const memory = rebuildEpisodicMemory(ledger);
    expect(memory.reducedThroughSequence).toBe(3);
    expect(memory.episodes).toHaveLength(2);
    expect(memory.episodes[1]).toMatchObject({
      episodeId,
      kind: "turn",
      fromSequence: 1,
      toSequenceInclusive: 3,
      fromTurn: 1,
      toTurn: 1,
      eventIds: [ledger[1]!.eventId, ledger[2]!.eventId, ledger[3]!.eventId],
      participantEntityIds: [PLAYER_ENTITY_ID, NPC_A],
      locationIds: [LOC_A, LOC_B],
      factIds: [FACT_A],
      questIds: [QUEST_A],
      causeEventIds: [asEventId("init:g1:game_initialized"), asEventId("turn:one:fact_discovered")],
      outcome: "success",
      salience: 65,
      summaryVersion: 1,
      summaryKeys: expect.arrayContaining([
        "fact_discovered",
        "narrative_scene_presented",
        "blueprint_expanded",
        "outcome:success",
      ]),
    });
    expect(memory.recentScenes).toEqual([{
      sceneEventId: ledger[2]!.eventId,
      sceneId: "scene_1",
      turnNumber: 1,
      locationId: LOC_A,
      focusNpcId: NPC_A,
      pacing: "develop",
      beatIds: ["fact_discovered"],
      referencedEntityIds: [NPC_A, PLAYER_ENTITY_ID],
      revealedFactIds: [FACT_A],
    }]);
  });

  it("keeps every action of one battleKey in one battle episode", () => {
    const battleEpisode = episodeIdForBattle("battle:started");
    const ledger = [
      event(0, { type: "battle_started", enemyId: "enemy_a" as never }, {
        turnId: asTurnId("turn:start"), episodeId: battleEpisode, turnNumber: 2,
        locationId: LOC_A, actorIds: [PLAYER_ENTITY_ID], targetIds: ["enemy_a" as never],
      }),
      event(1, { type: "battle_round_resolved", enemyId: "enemy_a" as never, round: 1, outcome: "hit" } as never, {
        turnId: asTurnId("turn:round"), episodeId: battleEpisode, turnNumber: 3,
        locationId: LOC_A, actorIds: [PLAYER_ENTITY_ID], targetIds: ["enemy_a" as never],
        causeEventIds: [asEventId("turn:start:battle_started")], outcome: "success", salience: 30,
      }),
      event(2, { type: "battle_resolved", enemyId: "enemy_a" as never, outcome: "victory" } as never, {
        turnId: asTurnId("turn:end"), episodeId: battleEpisode, turnNumber: 4,
        locationId: LOC_A, actorIds: [PLAYER_ENTITY_ID], targetIds: ["enemy_a" as never],
        causeEventIds: [asEventId("turn:round:battle_round_resolved")], outcome: "success", salience: 80,
      }),
    ];

    const [episode] = rebuildEpisodicMemory(ledger).episodes;
    expect(episode).toMatchObject({
      kind: "battle",
      eventIds: ledger.map((entry) => entry.eventId),
      fromTurn: 2,
      toTurn: 4,
      salience: 80,
    });
  });

  it("caps recent scenes at eight and incremental reconciliation equals a full rebuild", () => {
    const ledger = Array.from({ length: 10 }, (_, index) => event(index, {
      type: "narrative_scene_presented",
      sceneId: `scene_${index}`,
      focusNpcId: index % 2 === 0 ? NPC_A : null,
      pacing: "develop",
      beatIds: [`beat_${index}`],
      revealedFactIds: [],
    }, {
      turnNumber: index + 1,
      locationId: LOC_A,
      actorIds: index % 2 === 0 ? [NPC_A] : [PLAYER_ENTITY_ID],
      targetIds: [PLAYER_ENTITY_ID],
      eventId: asEventId(`turn:${index}:scene:${index}`),
    }));
    const first = reconcileEpisodicMemory({ previous: createEmptyEpisodicMemory(), ledger: ledger.slice(0, 5) });
    const second = reconcileEpisodicMemory({ previous: first, ledger });
    const repeated = reconcileEpisodicMemory({ previous: second, ledger });
    expect(second).toEqual(rebuildEpisodicMemory(ledger));
    expect(repeated).toEqual(second);
    expect(second.recentScenes.map((scene) => scene.sceneId)).toEqual([
      "scene_2", "scene_3", "scene_4", "scene_5", "scene_6", "scene_7", "scene_8", "scene_9",
    ]);
  });

  it("tracks the latest NPC contact from the committed envelope location", () => {
    const ledger = [
      event(0, { type: "npc_met", npcId: NPC_A }, { turnNumber: 1, locationId: LOC_A, targetIds: [NPC_A] }),
      event(1, { type: "npc_met", npcId: NPC_A }, { turnNumber: 3, locationId: LOC_B, targetIds: [NPC_A] }),
      event(2, { type: "npc_met", npcId: NPC_B }, { turnNumber: 2, locationId: LOC_A, targetIds: [NPC_B] }),
    ];
    expect(rebuildEpisodicMemory(ledger).npcContacts).toEqual([
      { npcId: NPC_A, lastContactTurn: 3, lastLocationId: LOC_B },
      { npcId: NPC_B, lastContactTurn: 2, lastLocationId: LOC_A },
    ]);
  });
});
