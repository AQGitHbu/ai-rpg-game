/** @vitest-environment node */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { asEpisodeId, asEventId, asTurnId } from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { asGenerationId, asLocationId, asNpcId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { createInitialStoryState } from "@/game/domain/storyState";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { createSqliteClient } from "@/game/application/server/persistence/sqliteClient";
import { createSqliteGameRepository } from "@/game/application/server/persistence/sqliteGameRepository";
import { asGameId } from "@/game/application/server/persistence/gameRepository";
import { retrieveNarrativeMemory, retrieveStoryEvidence, renderNarrativeMemory } from "@/game/gameplay/rpg/narrativeMemory";

const LOCATION = asLocationId("location:evidence-journey");
const NPC = asNpcId("npc:evidence-journey");
const EVENT = asEventId("journey:historical-line");
const GENERATION = {
  generationId: asGenerationId("generation:evidence-journey"),
  seed: "evidence-journey",
  templateVersion: "journey-v1",
  inputDigest: "journey-digest",
  gameType: "wuxia" as const,
};

function createJourneyState() {
  const worldState = createWorldStateFixture({
    generation: GENERATION,
    projection: {
      ...emptyProjection({
        player: { name: "沈青崖", identity: "查案人", stats: { hp: 10, attack: 2, defense: 1 } },
        locations: [{
          id: LOCATION,
          name: "北门渡口",
          description: "城门边的渡口。",
          kind: "main",
          connectedLocationIds: [],
          npcIds: [NPC],
          availableItemIds: [],
          tags: [],
        }],
        currentLocationId: LOCATION,
      }),
      npcs: [{
        id: NPC,
        name: "顾砚",
        role: "护送人",
        description: "沉默的护送人。",
        locationId: LOCATION,
        isCompanion: false,
        tags: [],
        met: true,
        memory: { npcId: NPC, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
      }],
    },
    eventLedger: [makeCommittedEvent({
      type: "narrative_scene_presented",
      sceneId: "old-scene",
      focusNpcId: NPC,
      pacing: "develop",
      beatIds: ["dialogue"],
      revealedFactIds: [],
    }, {
      eventId: EVENT,
      episodeId: asEpisodeId("episode:old-evidence"),
      turnId: asTurnId("turn:old-evidence"),
      sequence: 0,
      turnNumber: 1,
      actorIds: [PLAYER_ENTITY_ID],
      targetIds: [NPC],
      locationId: LOCATION,
      committedAt: "2026-09-12T00:00:00.000Z",
    })],
  });
  const baseStory = createInitialStoryState({
    gameLength: "short",
    initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 1 },
    initialNarrative: createFixtureNarrativeRuntimeState(),
  });
  const storyState = {
    ...baseStory,
    memory: rebuildEpisodicMemory(worldState.eventLedger),
    history: {
      entries: [{
        id: "scene:old-scene:npc:0",
        segmentId: "segment:old-scene",
        sequence: 0,
        actionId: "old-action",
        jobId: null,
        sceneId: "old-scene",
        revision: 1,
        turnNumber: 1,
        kind: "npc_line" as const,
        text: "我替你挡过一刀，后来一直守着这条路。",
        speakerId: NPC,
        audienceIds: [PLAYER_ENTITY_ID],
        entityIds: [PLAYER_ENTITY_ID, NPC],
        factIds: [],
        eventIds: [EVENT],
        choiceToken: null,
      }],
    },
    dialogueFocus: { npcId: NPC, entityIds: [PLAYER_ENTITY_ID, NPC], eventIds: [EVENT] },
  };
  return { worldState, storyState };
}

describe("story evidence journey", () => {
  it("reloads focus and recalls original History prose after the event leaves recent context", async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "story-evidence-")), "journey.sqlite");
    const firstRepository = createSqliteGameRepository({
      clientFactory: () => createSqliteClient(databasePath),
      logError: () => {},
    });
    await firstRepository.initializeSchema();
    const initial = createJourneyState();
    const created = await firstRepository.createInitialGame({
      gameId: asGameId("evidence-journey"),
      worldState: initial.worldState,
      storyState: initial.storyState,
      createdAt: "2026-09-12T00:00:00.000Z",
    });
    expect(created.ok).toBe(true);
    await firstRepository.close();

    const repository = createSqliteGameRepository({
      clientFactory: () => createSqliteClient(databasePath),
      logError: () => {},
    });
    await repository.initializeSchema();
    const current = await repository.getCurrentGame();
    expect(current.ok && current.status === "active").toBe(true);
    if (!current.ok || current.status !== "active") return;

    const oldHistoryId = current.record.storyState.history.entries[0]!.id;
    const selection = retrieveStoryEvidence({
      worldState: current.record.worldState,
      storyState: current.record.storyState,
      observerId: PLAYER_ENTITY_ID,
      text: "他当时说了什么？",
      actionEntityIds: [],
      focusEntityIds: [],
    });
    const retrieved = retrieveNarrativeMemory({
      memory: current.record.storyState.memory,
      ledger: current.record.worldState.eventLedger,
      storyEvidence: selection,
      history: current.record.storyState.history,
      maxEpisodes: 0,
      maxRecentScenes: 0,
    });
    const rendered = renderNarrativeMemory({ retrieved, entityStore: current.record.worldState.entityStore });

    expect(selection.historyIds).toContain(oldHistoryId);
    expect(selection.entityIds).toContain(NPC);
    expect(rendered.historyText).toContain("我替你挡过一刀");
    expect(rendered.historyText).toContain(oldHistoryId);
    expect(current.record.storyState.dialogueFocus?.npcId).toBe(NPC);
    await repository.close();
  });
});
