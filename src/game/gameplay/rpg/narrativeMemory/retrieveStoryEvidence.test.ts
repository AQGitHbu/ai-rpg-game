import { describe, expect, it } from "vitest";
import { asEpisodeId, asEventId, asTurnId } from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { createEntityStore, type EntityRecord } from "@/game/domain/entity";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import {
  asLocationId,
  asGenerationId,
  asNpcId,
  asPlayerEntityId,
} from "@/game/domain/worldEntity";
import type { WorldState } from "@/game/domain/worldState";
import { retrieveStoryEvidence } from "./retrieveStoryEvidence";

const LOCATION = asLocationId("location:gate");
const HELPER_A = asNpcId("npc:helper-a");
const HELPER_B = asNpcId("npc:helper-b");
const PLAYER = asPlayerEntityId("player_0");
const OLD_EVENT = asEventId("story:shielding-blow");
const OLD_HISTORY_ID = "scene:old:line:0";

const GENERATION = {
  generationId: asGenerationId("generation:evidence-test"),
  seed: "evidence-test",
  templateVersion: "test-v1",
  inputDigest: "evidence-digest",
  gameType: "wuxia" as const,
};

function makeWorld(): WorldState {
  const world = createWorldStateFixture({
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
          npcIds: [HELPER_A, HELPER_B],
          availableItemIds: [],
          tags: [],
        }],
        currentLocationId: LOCATION,
      }),
      npcs: [
        {
          id: HELPER_A,
          name: "顾砚",
          role: "护送人",
          description: "沉默的护送人。",
          locationId: LOCATION,
          isCompanion: false,
          tags: [],
          met: true,
          memory: { npcId: HELPER_A, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
        },
        {
          id: HELPER_B,
          name: "林照",
          role: "护送人",
          description: "谨慎的护送人。",
          locationId: LOCATION,
          isCompanion: false,
          tags: [],
          met: true,
          memory: { npcId: HELPER_B, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
        },
      ],
    },
    eventLedger: [makeCommittedEvent({
      type: "npc_interaction_recorded", npcId: HELPER_A, dialogueAct: "support",
    }, {
      sequence: 0,
      turnId: asTurnId("turn:old"),
      eventId: OLD_EVENT,
      episodeId: asEpisodeId("episode:old"),
      actorIds: [HELPER_A],
      targetIds: [PLAYER],
      locationId: LOCATION,
      turnNumber: 1,
      committedAt: "2026-09-12T00:00:00.000Z",
    })],
  });
  const aliases = new Map([
    [String(HELPER_A), "帮手"],
    [String(HELPER_B), "帮手"],
  ]);
  const entityStore = createEntityStore(world.entityStore.records.map((record) => {
    const alias = aliases.get(String(record.core.id));
    return alias === undefined
      ? record
      : {
          ...record,
          core: {
            ...record.core,
            aliases: [{ text: alias, observerIds: [], evidenceEventIds: [OLD_EVENT] }],
          },
        };
  }) as EntityRecord[]);
  return { ...world, entityStore };
}

function makeStoryState(world: WorldState, focusNpcId = HELPER_A): StoryState {
  const base = createInitialStoryState({
    gameLength: "short",
    initialEntityCounts: { locations: 1, npcs: 2, quests: 0, events: 1 },
    initialNarrative: createFixtureNarrativeRuntimeState(),
  });
  return {
    ...base,
    memory: {
      ...base.memory,
      episodes: [],
    },
    history: {
      entries: [{
        id: OLD_HISTORY_ID,
        segmentId: "segment:old",
        sequence: 0,
        actionId: "old-action",
        jobId: null,
        sceneId: "old-scene",
        revision: 1,
        turnNumber: 1,
        kind: "npc_line",
        text: "那一刀落下时，是我替你挡过一刀。",
        speakerId: focusNpcId,
        audienceIds: [PLAYER],
        entityIds: [PLAYER, focusNpcId],
        factIds: [],
        eventIds: [OLD_EVENT],
        choiceToken: null,
      }],
    },
    dialogueFocus: {
      npcId: focusNpcId,
      entityIds: [PLAYER, focusNpcId],
      eventIds: [OLD_EVENT],
    },
  };
}

describe("retrieveStoryEvidence", () => {
  it("round-robins optional history without charging already present or mandatory sources", () => {
    const world = makeWorld();
    const base = makeStoryState(world);
    const entries = [HELPER_A, HELPER_B, LOCATION, PLAYER].flatMap((entityId, group) =>
      Array.from({ length: 6 }, (_, index) => ({ ...base.history.entries[0]!,
        id: `optional:${group}:${index}`, sequence: group * 6 + index, speakerId: null,
        entityIds: [entityId], eventIds: [], text: `不同的经历片段${group}-${index}` })));
    const storyState = { ...base, dialogueFocus: null, history: { entries } };
    const result = retrieveStoryEvidence({ worldState: world, storyState, observerId: PLAYER,
      text: "接下来怎么办", actionEntityIds: [], focusEntityIds: [], contextEntityIds: [HELPER_A, HELPER_B, LOCATION, PLAYER],
      presentHistoryIds: ["optional:0:5"] });
    expect(result.historyIds).toHaveLength(10);
    expect(result.historyIds).not.toContain("optional:0:5");
    for (let group = 0; group < 4; group += 1) {
      const count = result.historyIds.filter(id => id.startsWith(`optional:${group}:`)).length;
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(3);
    }
    const mandatory = retrieveStoryEvidence({ worldState: world, storyState: base, observerId: PLAYER,
      text: "之前替我挡过一刀的人是谁", actionEntityIds: [], focusEntityIds: [], presentHistoryIds: [OLD_HISTORY_ID] });
    expect(mandatory.manifest).toContainEqual(expect.objectContaining({ ref: OLD_HISTORY_ID, mandatory: true }));
  });
  it("resolves a registered alias to the entity and its supporting event", () => {
    const world = makeWorld();
    const selection = retrieveStoryEvidence({
      worldState: world,
      storyState: makeStoryState(world),
      observerId: PLAYER,
      text: "我想找那位帮手。",
      actionEntityIds: [],
      focusEntityIds: [],
    });

    expect(selection.entityIds).toContain(HELPER_A);
    expect(selection.eventIds).toContain(OLD_EVENT);
  });

  it("finds a helper from an experience description without putting the name in the query", () => {
    const world = makeWorld();
    const selection = retrieveStoryEvidence({
      worldState: world,
      storyState: makeStoryState(world),
      observerId: PLAYER,
      text: "之前替我挡过一刀的人是谁？",
      actionEntityIds: [],
      focusEntityIds: [],
    });

    expect(selection.entityIds).toContain(HELPER_A);
    expect(selection.historyIds).toContain(OLD_HISTORY_ID);
    expect(selection.manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: OLD_HISTORY_ID, mandatory: true }),
    ]));
  });

  it("uses the persisted dialogue focus for a pronoun and keeps the old line available", () => {
    const world = makeWorld();
    const selection = retrieveStoryEvidence({
      worldState: world,
      storyState: makeStoryState(world),
      observerId: PLAYER,
      text: "他当时说了什么？",
      actionEntityIds: [],
      focusEntityIds: [],
    });

    expect(selection.entityIds).toEqual(expect.arrayContaining([HELPER_A]));
    expect(selection.historyIds).toContain(OLD_HISTORY_ID);
  });

  it("returns both similar helpers for a generic or negated description", () => {
    const world = makeWorld();
    const generic = retrieveStoryEvidence({
      worldState: world,
      storyState: makeStoryState(world),
      observerId: PLAYER,
      text: "帮手",
      actionEntityIds: [],
      focusEntityIds: [],
    });
    const negated = retrieveStoryEvidence({
      worldState: world,
      storyState: makeStoryState(world),
      observerId: PLAYER,
      text: "两人都不是老板。",
      actionEntityIds: [],
      focusEntityIds: [HELPER_A, HELPER_B],
    });

    expect(generic.ambiguousEntityIds).toEqual(expect.arrayContaining([HELPER_A, HELPER_B]));
    expect(generic.ambiguousEntityIds).toHaveLength(2);
    expect(negated.entityIds).toEqual(expect.arrayContaining([HELPER_A, HELPER_B]));
  });

  it("does not use an unselected choice or an unobserved NPC name as knowledge", () => {
    const world = makeWorld();
    const unobservedId = asNpcId("npc:unobserved");
    const source = world.entityStore.records.find((record) => String(record.core.id) === String(HELPER_B));
    if (source === undefined) throw new Error("fixture NPC missing");
    const unobservedWorld = {
      ...world,
      entityStore: createEntityStore([
        ...world.entityStore.records,
        {
          ...source,
          core: {
            ...source.core,
            id: unobservedId,
            name: "未选中的人",
            aliases: [{ text: "私密称呼", observerIds: [HELPER_B], evidenceEventIds: [] }],
          },
        } as EntityRecord,
      ]),
    };
    const story = {
      ...makeStoryState(unobservedWorld),
      history: {
        entries: [
          ...makeStoryState(unobservedWorld).history.entries,
          {
            id: "choice:unselected",
            segmentId: "segment:choice",
            sequence: 1,
            actionId: null,
            jobId: null,
            sceneId: "scene:choice",
            revision: 1,
            turnNumber: 1,
            kind: "shown_choice" as const,
            text: "未选中的人会在之后出现",
            speakerId: null,
            audienceIds: [PLAYER],
            entityIds: [PLAYER, unobservedId],
            factIds: [],
            eventIds: [],
            choiceToken: "choice:unselected",
          },
        ],
      },
    };

    const selection = retrieveStoryEvidence({
      worldState: unobservedWorld,
      storyState: story,
      observerId: PLAYER,
      text: "未选中的人 私密称呼",
      actionEntityIds: [],
      focusEntityIds: [],
    });

    expect(selection.entityIds).not.toContain(unobservedId);
    expect(selection.historyIds).not.toContain("choice:unselected");
  });

  it("does not use an unknown entity's core name even when its public alias is known", () => {
    const world = makeWorld();
    const source = world.entityStore.records.find((record) => String(record.core.id) === String(HELPER_B));
    if (source === undefined) throw new Error("fixture NPC missing");
    const unknownId = asNpcId("npc:unknown-with-alias");
    const unknownWorld = {
      ...world,
      entityStore: createEntityStore([
        ...world.entityStore.records,
        {
          ...source,
          core: {
            ...source.core,
            id: unknownId,
            name: "隐秘真名",
            aliases: [{ text: "公开外号", observerIds: [], evidenceEventIds: [] }],
          },
        } as EntityRecord,
      ]),
    };

    const selection = retrieveStoryEvidence({
      worldState: unknownWorld,
      storyState: makeStoryState(unknownWorld),
      observerId: PLAYER,
      text: "隐秘真名",
      actionEntityIds: [],
      focusEntityIds: [],
    });

    expect(selection.entityIds).not.toContain(unknownId);
  });

  it("keeps same-name entities distinct and does not let the current focus erase an old person", () => {
    const world = makeWorld();
    const sameNameWorld = {
      ...world,
      entityStore: createEntityStore(world.entityStore.records.map((record) =>
        String(record.core.id) === String(HELPER_B)
          ? { ...record, core: { ...record.core, name: "顾砚" } }
          : record,
      ) as EntityRecord[]),
    };
    const selection = retrieveStoryEvidence({
      worldState: sameNameWorld,
      storyState: makeStoryState(sameNameWorld, HELPER_B),
      observerId: PLAYER,
      text: "顾砚之前替我挡过一刀的人是谁？",
      actionEntityIds: [],
      focusEntityIds: [HELPER_B],
    });

    expect(selection.entityIds).toEqual(expect.arrayContaining([HELPER_A, HELPER_B]));
    expect(new Set(selection.entityIds.map(String)).size).toBe(selection.entityIds.length);
  });
});
