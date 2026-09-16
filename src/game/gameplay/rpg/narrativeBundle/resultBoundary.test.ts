import { describe, expect, it } from "vitest";
import type { CommittedNarrativeEvent } from "@/game/domain/events";
import { asEventId, asEpisodeId, asTurnId } from "@/game/domain/events";
import type { NpcEntityRecord } from "@/game/domain/entity";
import { projectObserverEvidence } from "@/game/gameplay/rpg/narrativeMemory";
import type { StoryState } from "@/game/domain/storyState";
import { asNpcId, asFactId, asGenerationId, asLocationId, PLAYER_ENTITY_ID, type GenerationMetadata } from "@/game/domain/worldEntity";
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
    actorIds: [PLAYER_ENTITY_ID],
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

const story = { history: { entries: [] } } as unknown as StoryState;

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
    const changed = { ...event({
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
    }), sequence: 2 };

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

  it("uses visible changes committed before the return move and consumes them at the new scene", () => {
    const previousScene = event({
      eventId: "turn:old:scene", kind: "narrative_scene_presented", locationId: LOCATION,
      payload: { type: "narrative_scene_presented", sceneId: "scene:old", focusNpcId: null,
        pacing: "develop", beatIds: [], revealedFactIds: [] },
    });
    const changed = { ...event({
      eventId: "turn:earlier:discovery", kind: "fact_discovered", locationId: LOCATION,
      factIds: [FACT], payload: { type: "fact_discovered", factId: FACT },
    }), sequence: 2 };
    const move = { ...event({
      eventId: "turn:return:observed", kind: "location_observed", locationId: LOCATION,
      payload: { type: "location_observed", locationId: LOCATION },
    }), sequence: 3 };
    const input = {
      beforeWorld: world({ currentLocationId: OTHER_LOCATION, visitedLocationIds: [OTHER_LOCATION, LOCATION], discovered: true, eventLedger: [previousScene, changed] }),
      beforeStory: story,
      afterWorld: world({ currentLocationId: LOCATION, visitedLocationIds: [OTHER_LOCATION, LOCATION], discovered: true, eventLedger: [previousScene, changed, move] }),
      afterStory: story, action: { type: "move", locationId: LOCATION } as const, newEvents: [move],
    };
    expect(proveResultBoundary(input)).toMatchObject({ kind: "changed_revisit", sourceEventIds: [changed.eventId] });

    const presented = { ...previousScene, eventId: asEventId("turn:return:scene"), sequence: 4 };
    expect(proveResultBoundary({ ...input,
      beforeWorld: { ...input.beforeWorld, eventLedger: [previousScene, changed, move, presented] },
      afterWorld: { ...input.afterWorld, eventLedger: [previousScene, changed, move, presented] },
    })).toBeNull();
  });

  it("ignores earlier unrelated changes and private facts unknown to the player", () => {
    const previousScene = event({
      eventId: "turn:old:scene", kind: "narrative_scene_presented", locationId: LOCATION,
      payload: { type: "narrative_scene_presented", sceneId: "scene:old", focusNpcId: null,
        pacing: "develop", beatIds: [], revealedFactIds: [] },
    });
    const change = { ...event({
      eventId: "turn:earlier:discovery", kind: "fact_discovered", locationId: LOCATION,
      factIds: [FACT], payload: { type: "fact_discovered", factId: FACT },
    }), sequence: 2 };
    const input = {
      beforeStory: story, afterStory: story, action: { type: "move", locationId: LOCATION } as const, newEvents: [],
    };
    for (const [changed, discovered] of [[change, false], [{ ...change, locationId: OTHER_LOCATION }, true]] as const) {
      const ledger = [previousScene, changed];
      expect(proveResultBoundary({ ...input,
        beforeWorld: world({ currentLocationId: OTHER_LOCATION, visitedLocationIds: [OTHER_LOCATION, LOCATION], discovered, eventLedger: ledger }),
        afterWorld: world({ currentLocationId: LOCATION, visitedLocationIds: [OTHER_LOCATION, LOCATION], discovered, eventLedger: ledger }),
      })).toBeNull();
    }
  });
});


describe("external evidence revisit association", () => {
  const npcId = asNpcId("npc:archivist");
  const scene = event({ eventId: "turn:prior:scene", kind: "narrative_scene_presented", locationId: LOCATION,
    payload: { type: "narrative_scene_presented", sceneId: "prior", focusNpcId: npcId, pacing: "develop", beatIds: [], revealedFactIds: [] } });
  const discovery = { ...event({ eventId: "turn:outside:fact", kind: "fact_discovered", locationId: OTHER_LOCATION,
    factIds: [FACT], payload: { type: "fact_discovered", factId: FACT, approachId: "quiet", evidenceQuality: "clean" } }), sequence: 2 };
  function input(mode: "goal" | "cooperation" | "unrelated" = "goal", discovered = true) {
    const make = (currentLocationId: typeof LOCATION) => {
      const base = world({ currentLocationId, visitedLocationIds: [LOCATION, OTHER_LOCATION], discovered, eventLedger: [scene, discovery] });
      const npc: NpcEntityRecord = {
        core: { id: npcId, kind: "npc", name: "档案员", lifecycle: "active", createdAtTurn: 0 },
        position: { locationId: LOCATION, locationOrder: 0 },
        identity: { role: "档案员", description: "核对证据", tags: [], anchors: { selfConcept: "档案员", values: ["核验"], speechStyle: "简短", capabilityBoundaries: ["档案"], taboos: [] } },
        dynamicState: { isCompanion: false, met: true, emotion: "guarded", goals: [{ goalId: "goal:check", horizon: "short", description: "核对证据", priority: 3, status: "active", reason: "核验证据",
          ...(mode === "goal" ? { resolution: { completeWhen: [{ kind: "investigation_observed" as const, npcId, factId: FACT, evidenceQuality: "clean" as const }], blockWhen: [] } } : {}) }] },
        knowledge: { entries: [] }, relationships: { outgoing: [] }, history: { interactions: [] },
        ...(mode === "cooperation" ? { cooperationDefinitions: [{ operation: "request_verification" as const, requirements: [{ kind: "goal_status" as const, npcId, goalId: "goal:check", status: "completed" as const }, { kind: "knows_fact" as const, actorId: npcId, factId: FACT }], allowedFactIds: [FACT], allowedAudienceIds: [PLAYER_ENTITY_ID] }] } : {}),
      };
      return { ...base, entityStore: { ...base.entityStore, records: [...base.entityStore.records, npc] } };
    };
    return { beforeWorld: make(OTHER_LOCATION), afterWorld: make(LOCATION), beforeStory: story, afterStory: story,
      action: { type: "move" as const, locationId: LOCATION }, newEvents: [] };
  }
  it.each(["goal", "cooperation"] as const)("accepts player evidence explicitly referenced by approved %s without teaching the NPC", (mode) => {
    const value = input(mode);
    const before = JSON.stringify(value);
    expect(proveResultBoundary(value)).toMatchObject({ kind: "changed_revisit", sourceEventIds: [discovery.eventId] });
    expect(JSON.stringify(value)).toBe(before);
    expect(projectObserverEvidence({ worldState: value.afterWorld, storyState: story, observerId: npcId }).events.map((entry) => entry.eventId)).not.toContain(discovery.eventId);
  });
  it("rejects unrelated, unknown, absent and already acknowledged evidence", () => {
    expect(proveResultBoundary(input("unrelated"))).toBeNull();
    expect(proveResultBoundary(input("goal", false))).toBeNull();
    const value = input();
    const absent = { ...value.afterWorld, entityStore: { ...value.afterWorld.entityStore, records: value.afterWorld.entityStore.records.map((record) => record.core.id === npcId ? { ...record, position: { locationId: OTHER_LOCATION, locationOrder: 0 } } : record) } };
    expect(proveResultBoundary({ ...value, afterWorld: absent })).toBeNull();
    const inactive = { ...value.afterWorld, entityStore: { ...value.afterWorld.entityStore, records: value.afterWorld.entityStore.records.map((record) => record.core.id === npcId ? { ...(record as NpcEntityRecord), core: { ...(record as NpcEntityRecord).core, lifecycle: "inactive" as const } } : record) } };
    expect(proveResultBoundary({ ...value, afterWorld: inactive })).toBeNull();
    const latest = { ...scene, eventId: asEventId("turn:latest:scene"), sequence: 3 };
    expect(proveResultBoundary({ ...value, beforeWorld: { ...value.beforeWorld, eventLedger: [...value.beforeWorld.eventLedger, latest] } })).toBeNull();
  });
});
