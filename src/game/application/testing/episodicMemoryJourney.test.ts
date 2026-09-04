/** @vitest-environment node */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  asEpisodeId,
  asEventId,
  asTurnId,
  episodeIdForBattle,
  type CommittedNarrativeEvent,
  type EpisodeId,
  type NarrativeEventPayload,
} from "@/game/domain/events";
import { makeCommittedEvent, resetTestEventSequence } from "@/game/domain/testing/committedEventFactory";
import {
  asEnemyId,
  asEndingId,
  asFactId,
  asGenerationId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
  PLAYER_ENTITY_ID,
} from "@/game/domain/worldEntity";
import { createFixtureNarrativeRuntimeState, createFixtureNarrativeScene } from "@/game/domain/narrativeTestFixture.testutil";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { projectEntityStore } from "@/game/domain/entity";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { type BattleState, type EndingState, type WorldState } from "@/game/domain/worldState";
import { createSqliteClient } from "@/game/application/server/persistence/sqliteClient";
import { createSqliteGameRepository, type SqliteGameRepository } from "@/game/application/server/persistence/sqliteGameRepository";
import { asGameId, type GameRecord } from "@/game/application/server/persistence/gameRepository";
import { retrieveNarrativeMemory } from "@/game/gameplay/rpg/narrativeMemory/retrieveNarrativeMemory";
import { renderNarrativeMemory } from "@/game/gameplay/rpg/narrativeMemory/renderNarrativeMemory";

const OLD_LOCATION = asLocationId("location:old");
const CURRENT_LOCATION = asLocationId("location:new");
const FOCUS_NPC = asNpcId("npc:focus");
const OTHER_NPC = asNpcId("npc:other");
const PUBLIC_FACT = asFactId("fact:public");
const SECRET_FACT = asFactId("fact:secret");
const ITEM = asItemId("item:gift");
const QUEST = asQuestId("quest:main");
const ENEMY = asEnemyId("enemy:guard");
const ENDING = asEndingId("ending:success");
const OLD_EPISODE = asEpisodeId("episode:old-investigation");
const BATTLE_EPISODE = episodeIdForBattle("winning-chain");

const GENERATION = {
  generationId: asGenerationId("generation:episodic-journey"),
  seed: "episodic-memory-journey",
  templateVersion: "journey-v1",
  inputDigest: "journey-digest",
  gameType: "wuxia" as const,
};

const PLAYER = {
  name: "沈青崖",
  identity: "查案人",
  stats: { hp: 100, attack: 12, defense: 6 },
};

function openRepository(dbPath: string): SqliteGameRepository {
  return createSqliteGameRepository({
    clientFactory: () => createSqliteClient(dbPath),
    logError: () => {},
  });
}

function appendEvent(
  ledger: readonly CommittedNarrativeEvent[],
  payload: NarrativeEventPayload,
  input: Readonly<{
    key: string;
    turn: number;
    episodeId: EpisodeId;
    actorIds?: CommittedNarrativeEvent["actorIds"];
    targetIds?: CommittedNarrativeEvent["targetIds"];
    locationId?: CommittedNarrativeEvent["locationId"];
    causeEventIds?: CommittedNarrativeEvent["causeEventIds"];
    factIds?: CommittedNarrativeEvent["factIds"];
    questIds?: CommittedNarrativeEvent["questIds"];
    outcome?: CommittedNarrativeEvent["outcome"];
    salience?: number;
    actionId?: string;
  }>,
): readonly CommittedNarrativeEvent[] {
  const event = makeCommittedEvent(payload, {
    eventId: asEventId(`journey:${input.key}`),
    sequence: ledger.length,
    turnId: asTurnId(`turn:${input.turn}`),
    turnNumber: input.turn,
    episodeId: input.episodeId,
    actorIds: input.actorIds ?? [PLAYER_ENTITY_ID],
    targetIds: input.targetIds ?? [],
    locationId: input.locationId ?? CURRENT_LOCATION,
    causeEventIds: input.causeEventIds ?? [],
    factIds: input.factIds ?? [],
    questIds: input.questIds ?? [],
    outcome: input.outcome ?? "neutral",
    salience: input.salience ?? 30,
    committedAt: `2026-09-04T00:${String(input.turn).padStart(2, "0")}:00.000Z`,
    ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
  });
  return [...ledger, event];
}

function createBaseWorld(): WorldState {
  return createWorldStateFixture({
    generation: GENERATION,
    projection: {
      ...emptyProjection({
        player: PLAYER,
        locations: [
          {
            id: OLD_LOCATION,
            name: "旧渡口",
            description: "案件最初留下痕迹的渡口。",
            kind: "main",
            connectedLocationIds: [CURRENT_LOCATION],
            npcIds: [],
            availableItemIds: [],
            tags: ["old"],
          },
          {
            id: CURRENT_LOCATION,
            name: "新城门",
            description: "NPC 搬迁后守候的新城门。",
            kind: "main",
            connectedLocationIds: [OLD_LOCATION],
            npcIds: [FOCUS_NPC, OTHER_NPC],
            availableItemIds: [],
            tags: ["current"],
          },
        ],
        currentLocationId: CURRENT_LOCATION,
        unlockedLocationIds: [OLD_LOCATION, CURRENT_LOCATION],
        visitedLocationIds: [OLD_LOCATION, CURRENT_LOCATION],
      }),
      npcs: [
        {
          id: FOCUS_NPC,
          name: "顾砚",
          role: "旧案传讯人",
          description: "已经迁到新城门的传讯人。",
          locationId: CURRENT_LOCATION,
          isCompanion: false,
          tags: ["focus"],
          met: true,
          memory: {
            npcId: FOCUS_NPC,
            knownFactIds: [SECRET_FACT],
            hiddenFactIds: [SECRET_FACT],
            interactionHistory: [],
            relationship: { affinity: 73 },
            emotion: "guarded",
            goals: ["守住旧案线索"],
          },
        },
        {
          id: OTHER_NPC,
          name: "旁观者",
          role: "路人",
          description: "不参与本次召回的旁观者。",
          locationId: CURRENT_LOCATION,
          isCompanion: false,
          tags: ["unrelated"],
          met: false,
          memory: {
            npcId: OTHER_NPC,
            knownFactIds: [],
            hiddenFactIds: [],
            interactionHistory: [],
            relationship: { affinity: 0 },
            emotion: "neutral",
            goals: [],
          },
        },
      ],
      items: [{ id: ITEM, name: "信物", description: "可交给顾砚的信物。", kind: "quest", tags: ["gift"] }],
      inventory: [ITEM],
      worldFacts: [
        {
          factId: PUBLIC_FACT,
          text: "公开线索正文不应直接进入记忆 prompt。",
          source: "generated",
          discovered: true,
          locationId: OLD_LOCATION,
          investigationLabel: "渡口的车辙",
        },
        {
          factId: SECRET_FACT,
          text: "SECRET_PRIVATE_FACT_TEXT",
          source: "generated",
          discovered: true,
          locationId: OLD_LOCATION,
          investigationLabel: "不可公开的线索",
        },
      ],
      quests: [{
        id: QUEST,
        name: "追查旧案",
        description: "追查渡口留下的线索。",
        objectives: [{ kind: "talk_to_npc", npcId: FOCUS_NPC }],
        onSuccess: { kind: "advance_story" },
        onFailure: { kind: "closed" },
        tags: ["main"],
        kind: "main",
        stage: 2,
        status: "completed",
      }],
      enemies: [{
        id: ENEMY,
        name: "城门守卫",
        tier: "normal",
        stats: { hp: 30, attack: 5, defense: 2 },
        locationId: CURRENT_LOCATION,
        tags: ["battle"],
      }],
      defeatedEnemyIds: [],
    },
    endings: [{
      id: ENDING,
      name: "真相得见",
      description: "旧案终于水落石出。",
      requirements: [{ kind: "quest_completed", questId: QUEST }],
    }],
    eventLedger: [],
  });
}

function worldAt(
  base: WorldState,
  ledger: readonly CommittedNarrativeEvent[],
  overrides: Readonly<{
    battle?: BattleState;
    ending?: EndingState;
    defeatedEnemyIds?: readonly typeof ENEMY[];
  }> = {},
): WorldState {
  const projection = projectEntityStore(base.entityStore);
  return createWorldStateFixture({
    generation: base.generation,
    previousStore: base.entityStore,
    projection: {
      ...projection,
      ...(overrides.defeatedEnemyIds === undefined ? {} : { defeatedEnemyIds: overrides.defeatedEnemyIds }),
    },
    battle: overrides.battle ?? { status: "idle" },
    endings: base.endings,
    ending: overrides.ending ?? null,
    eventLedger: ledger,
  });
}

function storyAt(base: StoryState, ledger: readonly CommittedNarrativeEvent[], turnNumber: number): StoryState {
  return {
    ...base,
    turnNumber,
    memory: rebuildEpisodicMemory(ledger),
  };
}

describe("episodic memory long-gap journey", () => {
  it("recalls old structure after 24 successful rounds and repeated SQLite reloads", async () => {
    resetTestEventSequence();
    const dbRoot = mkdtempSync(join(tmpdir(), "ai-rpg-episodic-memory-"));
    const dbPath = join(dbRoot, "journey.sqlite");
    const gameId = asGameId("episodic_memory_journey");
    const baseWorld = createBaseWorld();
    const initialLedger = appendEvent([], { type: "game_initialized", generation: GENERATION }, {
      key: "initialization",
      turn: 0,
      episodeId: asEpisodeId("episode:initialization"),
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [PLAYER_ENTITY_ID],
      locationId: OLD_LOCATION,
      outcome: "neutral",
      salience: 100,
    });
    const initialStory = createInitialStoryState({
      gameLength: "medium",
      initialEntityCounts: {
        locations: baseWorld.locations.length,
        npcs: baseWorld.npcs.length,
        quests: baseWorld.quests.length,
        events: 0,
      },
      initialNarrative: createFixtureNarrativeRuntimeState(
        createFixtureNarrativeScene({ event: { kind: "observe", locationId: OLD_LOCATION } }),
      ),
    });
    let ledger = initialLedger;
    let worldState = worldAt(baseWorld, ledger);
    let storyState = storyAt(initialStory, ledger, 0);
    let repo = openRepository(dbPath);
    let revision = 0;
    let reloads = 0;
    const successfulRoundEventIds: string[] = [];
    const savedEventIds: string[] = [];
    const recentSceneEventIds: string[] = [];

    try {
      await repo.initializeSchema();
      const created = await repo.createInitialGame({
        gameId,
        worldState,
        storyState,
        createdAt: "2026-09-04T00:00:00.000Z",
      });
      expect(created).toEqual({ ok: true });

      for (let turn = 1; turn <= 24; turn += 1) {
        const beforeTurn = ledger;
        if (turn === 2) {
          ledger = appendEvent(ledger, { type: "fact_discovered", factId: PUBLIC_FACT, witnessNpcIds: [FOCUS_NPC] }, {
            key: "turn-2-public-fact",
            turn,
            episodeId: OLD_EPISODE,
            actorIds: [PLAYER_ENTITY_ID, FOCUS_NPC],
            targetIds: [FOCUS_NPC],
            locationId: OLD_LOCATION,
            factIds: [PUBLIC_FACT, SECRET_FACT],
            questIds: [QUEST],
            outcome: "success",
            salience: 65,
          });
          savedEventIds.push(String(ledger.at(-1)!.eventId));
          ledger = appendEvent(ledger, {
            type: "narrative_scene_presented",
            sceneId: "scene:old-investigation",
            focusNpcId: FOCUS_NPC,
            pacing: "develop",
            beatIds: ["beat:old-clue"],
            revealedFactIds: [PUBLIC_FACT, SECRET_FACT],
          }, {
            key: "turn-2-old-scene",
            turn,
            episodeId: OLD_EPISODE,
            actorIds: [PLAYER_ENTITY_ID],
            targetIds: [FOCUS_NPC],
            locationId: OLD_LOCATION,
            causeEventIds: [ledger.at(-1)!.eventId],
            factIds: [PUBLIC_FACT, SECRET_FACT],
            questIds: [QUEST],
            salience: 60,
          });
          savedEventIds.push(String(ledger.at(-1)!.eventId));
        }
        if (turn === 3) {
          ledger = appendEvent(ledger, { type: "npc_met", npcId: FOCUS_NPC, interactionKind: "ask_main_quest" }, {
            key: "turn-3-npc-met",
            turn,
            episodeId: OLD_EPISODE,
            actorIds: [PLAYER_ENTITY_ID],
            targetIds: [FOCUS_NPC],
            locationId: OLD_LOCATION,
            causeEventIds: [ledger.at(-1)!.eventId],
            questIds: [QUEST],
            outcome: "success",
            salience: 55,
          });
          savedEventIds.push(String(ledger.at(-1)!.eventId));
        }
        if (turn === 4) {
          ledger = appendEvent(ledger, { type: "npc_interaction_recorded", npcId: FOCUS_NPC, dialogueAct: "ask" }, {
            key: "turn-4-npc-interaction",
            turn,
            episodeId: OLD_EPISODE,
            actorIds: [FOCUS_NPC],
            targetIds: [PLAYER_ENTITY_ID],
            locationId: OLD_LOCATION,
            causeEventIds: [ledger.at(-1)!.eventId],
            questIds: [QUEST],
            outcome: "success",
            salience: 55,
          });
        }
        if (turn === 5) {
          ledger = appendEvent(ledger, { type: "npc_knowledge_changed", npcId: FOCUS_NPC, factId: SECRET_FACT, change: "learned" }, {
            key: "turn-5-private-knowledge",
            turn,
            episodeId: OLD_EPISODE,
            actorIds: [FOCUS_NPC],
            targetIds: [PLAYER_ENTITY_ID],
            locationId: OLD_LOCATION,
            causeEventIds: [ledger.at(-1)!.eventId],
            factIds: [SECRET_FACT],
            questIds: [QUEST],
            outcome: "success",
            salience: 60,
          });
        }
        if (turn === 6) {
          ledger = appendEvent(ledger, { type: "item_given", itemId: ITEM, npcId: FOCUS_NPC, locationId: OLD_LOCATION }, {
            key: "turn-6-gift",
            turn,
            episodeId: OLD_EPISODE,
            actorIds: [PLAYER_ENTITY_ID, FOCUS_NPC],
            targetIds: [FOCUS_NPC],
            locationId: OLD_LOCATION,
            causeEventIds: [ledger.at(-1)!.eventId],
            questIds: [QUEST],
            outcome: "success",
            salience: 55,
          });
          ledger = appendEvent(ledger, {
            type: "npc_relationship_changed",
            fromNpcId: FOCUS_NPC,
            targetId: PLAYER_ENTITY_ID,
            signal: "kept_promise",
          }, {
            key: "turn-6-commitment",
            turn,
            episodeId: OLD_EPISODE,
            actorIds: [FOCUS_NPC],
            targetIds: [PLAYER_ENTITY_ID],
            locationId: OLD_LOCATION,
            causeEventIds: [ledger.at(-1)!.eventId],
            questIds: [QUEST],
            outcome: "success",
            salience: 65,
          });
        }
        if (turn === 10) {
          ledger = appendEvent(ledger, { type: "location_visited", locationId: CURRENT_LOCATION }, {
            key: "turn-10-new-location",
            turn,
            episodeId: asEpisodeId("episode:turn:10"),
            actorIds: [PLAYER_ENTITY_ID],
            locationId: CURRENT_LOCATION,
            outcome: "success",
            salience: 20,
          });
        }
        if (turn === 12) {
          ledger = appendEvent(ledger, { type: "quest_unlocked", questId: QUEST }, {
            key: "turn-12-quest",
            turn,
            episodeId: asEpisodeId("episode:turn:12"),
            actorIds: [PLAYER_ENTITY_ID],
            locationId: CURRENT_LOCATION,
            questIds: [QUEST],
            outcome: "success",
            salience: 40,
          });
        }

        if (turn >= 21) {
          const sceneEvent = appendEvent(ledger, {
            type: "narrative_scene_presented",
            sceneId: `scene:current:${turn}`,
            focusNpcId: null,
            pacing: turn === 24 ? "climax" : "develop",
            beatIds: [`beat:current:${turn}`],
            revealedFactIds: [],
          }, {
            key: `turn-${turn}-recent-scene`,
            turn,
            episodeId: asEpisodeId(`episode:scene:${turn}`),
            actorIds: [PLAYER_ENTITY_ID],
            targetIds: [],
            locationId: CURRENT_LOCATION,
            salience: 40,
          });
          ledger = sceneEvent;
          recentSceneEventIds.push(String(ledger.at(-1)!.eventId));
        }

        ledger = appendEvent(ledger, { type: "player_intent_expressed", intentCode: "unmapped_freeform" }, {
          key: `turn-${turn}-success`,
          turn,
          episodeId: asEpisodeId(`episode:turn:${turn}`),
          actorIds: [PLAYER_ENTITY_ID],
          targetIds: [],
          locationId: turn <= 6 ? OLD_LOCATION : CURRENT_LOCATION,
          actionId: `round:${turn}`,
          outcome: "success",
          salience: 15,
        });
        successfulRoundEventIds.push(String(ledger.at(-1)!.eventId));

        expect(ledger.length).toBeGreaterThan(beforeTurn.length);
        worldState = worldAt(baseWorld, ledger);
        storyState = storyAt(initialStory, ledger, turn);
        const applied = await repo.applyState({
          gameId,
          expectedRevision: revision,
          nextWorldState: worldState,
          nextStoryState: storyState,
        });
        expect(applied.ok).toBe(true);
        if (!applied.ok) throw new Error(`journey turn ${turn} failed: ${applied.code}`);
        revision = applied.record.revision;

        if (turn % 6 === 0) {
          await repo.close();
          repo = openRepository(dbPath);
          await repo.initializeSchema();
          reloads += 1;
          const reloaded = await repo.getCurrentGame();
          expect(reloaded.ok && reloaded.status === "active").toBe(true);
        }
      }

      const failedBattleStartId = asEventId("journey:failed-battle-start");
      const failedBattleResolveId = asEventId("journey:failed-battle-resolve");
      const failedTimeline = [
        ...ledger,
        makeCommittedEvent({ type: "battle_started", enemyId: ENEMY }, {
          eventId: failedBattleStartId,
          sequence: ledger.length,
          turnId: asTurnId("turn:failed"),
          turnNumber: 25,
          episodeId: episodeIdForBattle("failed-chain"),
          actorIds: [PLAYER_ENTITY_ID],
          targetIds: [ENEMY],
          locationId: CURRENT_LOCATION,
          outcome: "neutral",
        }),
        makeCommittedEvent({ type: "battle_resolved", enemyId: ENEMY, outcome: "defeat" }, {
          eventId: failedBattleResolveId,
          sequence: ledger.length + 1,
          turnId: asTurnId("turn:failed"),
          turnNumber: 25,
          episodeId: episodeIdForBattle("failed-chain"),
          actorIds: [PLAYER_ENTITY_ID],
          targetIds: [ENEMY],
          locationId: CURRENT_LOCATION,
          causeEventIds: [failedBattleStartId],
          questIds: [QUEST],
          outcome: "failure",
        }),
      ];
      expect(rebuildEpisodicMemory(failedTimeline).episodes.some((episode) => episode.episodeId === episodeIdForBattle("failed-chain"))).toBe(true);

      ledger = appendEvent(ledger, { type: "quest_completed", questId: QUEST }, {
        key: "turn-24-quest-completed",
        turn: 24,
        episodeId: asEpisodeId("episode:quest:completed"),
        actorIds: [PLAYER_ENTITY_ID, FOCUS_NPC],
        targetIds: [FOCUS_NPC],
        locationId: CURRENT_LOCATION,
        causeEventIds: [asEventId("journey:turn-6-commitment")],
        questIds: [QUEST],
        outcome: "success",
        salience: 80,
      });
      const questCompletedId = ledger.at(-1)!.eventId;
      let battleStartedId: CommittedNarrativeEvent["eventId"];
      ledger = appendEvent(ledger, { type: "battle_started", enemyId: ENEMY }, {
        key: "turn-24-battle-start",
        turn: 24,
        episodeId: BATTLE_EPISODE,
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [ENEMY],
        locationId: CURRENT_LOCATION,
        causeEventIds: [questCompletedId],
        questIds: [QUEST],
        outcome: "neutral",
        salience: 70,
      });
      battleStartedId = ledger.at(-1)!.eventId;
      ledger = appendEvent(ledger, { type: "battle_round_resolved", enemyId: ENEMY, round: 1, playerHp: 90, enemyHp: 18, action: "attack", results: [] }, {
        key: "turn-24-battle-round-1",
        turn: 24,
        episodeId: BATTLE_EPISODE,
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [ENEMY],
        locationId: CURRENT_LOCATION,
        causeEventIds: [battleStartedId],
        questIds: [QUEST],
        outcome: "success",
        salience: 50,
      });
      const battleRoundOneId = ledger.at(-1)!.eventId;
      ledger = appendEvent(ledger, { type: "battle_round_resolved", enemyId: ENEMY, round: 2, playerHp: 84, enemyHp: 0, action: "attack", results: [] }, {
        key: "turn-24-battle-round-2",
        turn: 24,
        episodeId: BATTLE_EPISODE,
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [ENEMY],
        locationId: CURRENT_LOCATION,
        causeEventIds: [battleRoundOneId],
        questIds: [QUEST],
        outcome: "success",
        salience: 55,
      });
      const battleRoundTwoId = ledger.at(-1)!.eventId;
      ledger = appendEvent(ledger, { type: "battle_resolved", enemyId: ENEMY, outcome: "victory" }, {
        key: "turn-24-battle-victory",
        turn: 24,
        episodeId: BATTLE_EPISODE,
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [ENEMY],
        locationId: CURRENT_LOCATION,
        causeEventIds: [battleRoundTwoId],
        questIds: [QUEST],
        outcome: "success",
        salience: 80,
      });
      const battleVictoryId = ledger.at(-1)!.eventId;
      ledger = appendEvent(ledger, { type: "enemy_defeated", enemyId: ENEMY }, {
        key: "turn-24-enemy-defeated",
        turn: 24,
        episodeId: BATTLE_EPISODE,
        actorIds: [PLAYER_ENTITY_ID],
        targetIds: [ENEMY],
        locationId: CURRENT_LOCATION,
        causeEventIds: [battleVictoryId],
        questIds: [QUEST],
        outcome: "success",
        salience: 80,
      });
      const enemyDefeatedId = ledger.at(-1)!.eventId;
      ledger = appendEvent(ledger, { type: "ending_reached", endingId: ENDING, outcome: "success" }, {
        key: "turn-24-ending",
        turn: 24,
        episodeId: asEpisodeId("episode:ending:success"),
        actorIds: [PLAYER_ENTITY_ID, FOCUS_NPC],
        targetIds: [FOCUS_NPC],
        locationId: CURRENT_LOCATION,
        causeEventIds: [enemyDefeatedId],
        questIds: [QUEST],
        outcome: "success",
        salience: 100,
      });

      worldState = worldAt(baseWorld, ledger, {
        battle: { status: "resolved", enemyId: ENEMY, outcome: "victory", battleKey: "winning-chain" },
        ending: { endingId: ENDING, outcome: "success" },
        defeatedEnemyIds: [ENEMY],
      });
      storyState = storyAt(initialStory, ledger, 24);
      const finalApplied = await repo.applyState({
        gameId,
        expectedRevision: revision,
        nextWorldState: worldState,
        nextStoryState: storyState,
      });
      expect(finalApplied.ok).toBe(true);
      if (!finalApplied.ok) throw new Error(`final journey write failed: ${finalApplied.code}`);
      revision = finalApplied.record.revision;
      await repo.close();
      repo = openRepository(dbPath);
      await repo.initializeSchema();
      reloads += 1;

      const current = await repo.getCurrentGame();
      expect(current.ok && current.status === "active").toBe(true);
      if (!current.ok || current.status !== "active") throw new Error("final journey record unavailable");
      const record: GameRecord = current.record;
      const finalLedger = record.worldState.eventLedger;
      expect(successfulRoundEventIds).toHaveLength(24);
      expect(successfulRoundEventIds.every((eventId) => finalLedger.some((event) => String(event.eventId) === eventId))).toBe(true);
      expect(savedEventIds.every((eventId) => finalLedger.some((event) => String(event.eventId) === eventId))).toBe(true);
      expect(reloads).toBeGreaterThanOrEqual(4);
      expect(finalLedger.some((event) => event.eventId === failedBattleResolveId)).toBe(false);
      expect(finalLedger.some((event) => event.eventId === failedBattleStartId)).toBe(false);
      expect(finalLedger.some((event) => event.eventId === battleVictoryId)).toBe(true);
      expect(finalLedger.some((event) => event.eventId === enemyDefeatedId)).toBe(true);
      expect(record.storyState.memory).toEqual(rebuildEpisodicMemory(finalLedger));

      const retrieved = retrieveNarrativeMemory({
        memory: record.storyState.memory,
        ledger: finalLedger,
        requiredEventIds: savedEventIds.map(asEventId),
        relevantEntityIds: [String(FOCUS_NPC)],
        relevantQuestIds: [QUEST],
        relevantFactIds: [PUBLIC_FACT],
        currentLocationId: CURRENT_LOCATION,
        focusNpcId: FOCUS_NPC,
        maxEpisodes: 6,
        maxRecentScenes: 4,
      });
      expect(retrieved.requiredEvents.map((event) => String(event.eventId))).toEqual(savedEventIds);
      expect(retrieved.relevantEpisodes.some((match) => match.episode.episodeId === OLD_EPISODE)).toBe(true);
      expect(retrieved.relevantEpisodes.some((match) => match.episode.episodeId === BATTLE_EPISODE)).toBe(true);
      expect(retrieved.relevantEpisodes.some((match) => match.episode.episodeId === episodeIdForBattle("failed-chain"))).toBe(false);
      expect(retrieved.recentScenes.map((scene) => String(scene.sceneEventId))).toEqual(recentSceneEventIds);

      const rendered = renderNarrativeMemory({ retrieved, entityStore: record.worldState.entityStore });
      const renderedText = [
        rendered.requiredEventsText,
        rendered.relevantEpisodesText,
        rendered.relevantEventsText,
        rendered.recentScenesText,
      ].join("\n");
      expect(renderedText).toContain("thenLocation=旧渡口");
      expect(renderedText).toContain("currentLocation=新城门");
      expect(renderedText).toContain("顾砚");
      expect(renderedText).toContain("journey:turn-24-battle-victory");
      expect(renderedText).not.toContain("SECRET_PRIVATE_FACT_TEXT");
      expect(renderedText).not.toContain(String(SECRET_FACT));
      expect(renderedText).not.toContain("raw player text");
      expect(renderedText).not.toContain("旁观者");
      expect(renderedText).not.toContain("affinity");
      expect(renderedText).not.toContain(String(failedBattleResolveId));
      expect(record.worldState.npcs.find((npc) => npc.id === FOCUS_NPC)?.locationId).toBe(CURRENT_LOCATION);
      expect(record.worldState.quests.find((quest) => quest.id === QUEST)?.status).toBe("completed");
      expect(record.worldState.ending).toEqual({ endingId: ENDING, outcome: "success" });
    } finally {
      await repo.close();
    }
  });
});
