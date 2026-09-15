import { describe, expect, it } from "vitest";
import type { CommittedNarrativeEvent } from "@/game/domain/events";
import { asEventId, asEpisodeId, asTurnId } from "@/game/domain/events";
import type { StoryState } from "@/game/domain/storyState";
import { asFactId, asGenerationId, asLocationId, asPlayerEntityId, type GenerationMetadata } from "@/game/domain/worldEntity";
import type { LocationEntry, WorldFactEntry } from "@/game/domain/worldState";
import { createWorldStateFixtureWith, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { proveResultBoundary } from "./resultBoundary";

const LOCATION = asLocationId("loc:boundary");
const OTHER_LOCATION = asLocationId("loc:other");
const FACT = asFactId("fact:boundary");
const generation: GenerationMetadata = {
  generationId: asGenerationId("generation:boundary"),
  seed: "boundary-seed",
  templateVersion: "test",
  inputDigest: "boundary-digest",
  gameType: "wuxia",
};
const player = {
  name: "玩家",
  identity: "旅人",
  stats: { hp: 10, attack: 2, defense: 1 },
};
const locations: readonly LocationEntry[] = [
  {
    id: LOCATION,
    name: "旧档案室",
    description: "一间旧档案室。",
    kind: "main",
    connectedLocationIds: [OTHER_LOCATION],
    npcIds: [],
    availableItemIds: [],
    tags: [],
  },
  {
    id: OTHER_LOCATION,
    name: "门廊",
    description: "档案室外的门廊。",
    kind: "main",
    connectedLocationIds: [LOCATION],
    npcIds: [],
    availableItemIds: [],
    tags: [],
  },
];
const fact = (discovered: boolean): WorldFactEntry => ({
  factId: FACT,
  text: "档案柜后留有一枚旧印章。",
  source: "generated",
  discovered,
  discoveryMode: "investigation",
  locationId: LOCATION,
  investigationLabel: "翻查旧档案",
  investigationApproaches: [
    {
      approachId: "approach:careful",
      label: "仔细翻查",
      hint: "尽量不扰乱档案。",
      evidenceQuality: "clean",
      tensionDelta: 0,
    },
    {
      approachId: "approach:quick",
      label: "快速扫视",
      hint: "先找明显痕迹。",
      evidenceQuality: "noisy",
      tensionDelta: 2,
    },
  ],
});

function world(input: {
  readonly currentLocationId?: typeof LOCATION | typeof OTHER_LOCATION;
  readonly visitedLocationIds?: readonly (typeof LOCATION | typeof OTHER_LOCATION)[];
  readonly discovered?: boolean;
  readonly eventLedger?: readonly CommittedNarrativeEvent[];
}) {
  return createWorldStateFixtureWith(
    {
      generation,
      base: emptyProjection({
        player,
        locations,
        currentLocationId: input.currentLocationId ?? LOCATION,
        visitedLocationIds: input.visitedLocationIds ?? [LOCATION],
        unlockedLocationIds: [LOCATION, OTHER_LOCATION],
      }),
    },
    {
      worldFacts: [fact(input.discovered ?? false)],
      eventLedger: input.eventLedger ?? [],
    },
  );
}

function event(input: {
  readonly eventId: string;
  readonly kind: CommittedNarrativeEvent["kind"];
  readonly locationId: typeof LOCATION | typeof OTHER_LOCATION | null;
  readonly payload: CommittedNarrativeEvent["payload"];
  readonly factIds?: readonly typeof FACT[];
}): CommittedNarrativeEvent {
  const turnId = asTurnId(`turn:${input.eventId}`);
  return {
    eventId: asEventId(input.eventId),
    sequence: 1,
    turnId,
    turnNumber: 1,
    episodeId: asEpisodeId(`episode:${input.eventId}`),
    kind: input.kind,
    actorIds: [asPlayerEntityId("player")],
    targetIds: [],
    locationId: input.locationId,
    causeEventIds: [],
    factIds: input.factIds ?? [],
    questIds: [],
    outcome: "success",
    salience: 50,
    committedAt: "2026-09-15T00:00:00Z",
    payload: input.payload,
  };
}

const story = {} as StoryState;

describe("proveResultBoundary", () => {
  it("proves a successful explicit investigation only from the committed discovery event", () => {
    const discovery = event({
      eventId: "turn:investigation:fact",
      kind: "fact_discovered",
      locationId: LOCATION,
      factIds: [FACT],
      payload: {
        type: "fact_discovered",
        factId: FACT,
        approachId: "approach:careful",
        evidenceQuality: "clean",
      },
    });

    expect(proveResultBoundary({
      beforeWorld: world({ discovered: false }),
      beforeStory: story,
      afterWorld: world({ discovered: true, eventLedger: [discovery] }),
      afterStory: story,
      action: { type: "investigate", factId: FACT, approachId: "approach:careful" },
      newEvents: [discovery],
    })).toEqual({
      kind: "investigation_result",
      factId: FACT,
      approachId: "approach:careful",
      sourceEventIds: [discovery.eventId],
    });
  });

  it("rejects investigation without a selected approach or a matching discovery event", () => {
    const unrelated = event({
      eventId: "turn:investigation:unrelated",
      kind: "location_observed",
      locationId: LOCATION,
      payload: { type: "location_observed", locationId: LOCATION },
    });
    const input = {
      beforeWorld: world({ discovered: false }),
      beforeStory: story,
      afterWorld: world({ discovered: true, eventLedger: [unrelated] }),
      afterStory: story,
      newEvents: [unrelated],
    } as const;

    expect(proveResultBoundary({ ...input, action: { type: "investigate", factId: FACT } })).toBeNull();
    expect(proveResultBoundary({
      ...input,
      action: { type: "investigate", factId: FACT, approachId: "approach:careful" },
    })).toBeNull();
  });

  it("proves a changed revisit only after a real move to a visited location with a prior scene", () => {
    const previousScene = event({
      eventId: "turn:previous:scene",
      kind: "narrative_scene_presented",
      locationId: LOCATION,
      payload: {
        type: "narrative_scene_presented",
        sceneId: "scene:previous",
        focusNpcId: null,
        pacing: "develop",
        beatIds: [],
        revealedFactIds: [],
      },
    });
    const changed = event({
      eventId: "turn:revisit:goal",
      kind: "npc_goal_status_changed",
      locationId: LOCATION,
      payload: {
        type: "npc_goal_status_changed",
        npcId: "npc:archivist" as never,
        goalId: "goal:archivist",
        from: "blocked",
        to: "active",
        evidenceEventIds: [previousScene.eventId],
      },
    });

    expect(proveResultBoundary({
      beforeWorld: world({ currentLocationId: OTHER_LOCATION, visitedLocationIds: [OTHER_LOCATION, LOCATION], eventLedger: [previousScene] }),
      beforeStory: story,
      afterWorld: world({ currentLocationId: LOCATION, visitedLocationIds: [OTHER_LOCATION, LOCATION], eventLedger: [previousScene, changed] }),
      afterStory: story,
      action: { type: "move", locationId: LOCATION },
      newEvents: [changed],
    })).toEqual({
      kind: "changed_revisit",
      locationId: LOCATION,
      previousSceneEventId: previousScene.eventId,
      sourceEventIds: [changed.eventId],
    });
  });

  it("does not treat ordinary movement, first visits, or scene presentation as changed revisits", () => {
    const scene = event({
      eventId: "turn:ordinary:scene",
      kind: "narrative_scene_presented",
      locationId: LOCATION,
      payload: {
        type: "narrative_scene_presented",
        sceneId: "scene:ordinary",
        focusNpcId: null,
        pacing: "develop",
        beatIds: [],
        revealedFactIds: [],
      },
    });
    const input = {
      beforeStory: story,
      afterStory: story,
      action: { type: "move", locationId: LOCATION } as const,
      newEvents: [scene],
    };

    expect(proveResultBoundary({
      ...input,
      beforeWorld: world({ currentLocationId: OTHER_LOCATION, visitedLocationIds: [OTHER_LOCATION], eventLedger: [scene] }),
      afterWorld: world({ currentLocationId: LOCATION, visitedLocationIds: [OTHER_LOCATION, LOCATION], eventLedger: [scene] }),
    })).toBeNull();

    expect(proveResultBoundary({
      ...input,
      beforeWorld: world({ currentLocationId: OTHER_LOCATION, visitedLocationIds: [OTHER_LOCATION, LOCATION], eventLedger: [scene] }),
      afterWorld: world({ currentLocationId: LOCATION, visitedLocationIds: [OTHER_LOCATION, LOCATION], eventLedger: [scene] }),
    })).toBeNull();
  });
});
