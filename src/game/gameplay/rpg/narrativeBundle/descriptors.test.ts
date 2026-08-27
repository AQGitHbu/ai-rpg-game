import { describe, expect, it } from "vitest";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
import { createInitialWorldState, type WorldState } from "@/game/domain/worldState";
import {
  asEnemyId,
  asFactId,
  asGenerationId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
} from "@/game/domain/worldEntity";
import {
  buildNarrativeBundleDescriptors,
  narrativeBundleTriggerKey,
} from "./descriptors";

const locTown = asLocationId("loc_town");
const locDyn1 = asLocationId("loc_dyn_1");
const npcDyn1 = asNpcId("npc_dyn_1");
const questId = asQuestId("quest_1");
const factTracks = asFactId("fact_tracks");
const enemyWolf = asEnemyId("enemy_wolf");
const itemSeal = asItemId("item_seal");

function storyState() {
  return createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 2, npcs: 1, quests: 1, events: 0 },
  });
}

function worldState(overrides: Partial<WorldState> = {}): WorldState {
  const base = createInitialWorldState({
    generation: {
      generationId: asGenerationId("generation_1"),
      seed: "seed",
      templateVersion: "v1",
      inputDigest: "digest",
      gameType: "wuxia",
    },
    player: { name: "侠客", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: locTown,
      name: "小镇",
      description: "山脚下的小镇。",
      kind: "main",
      connectedLocationIds: [locDyn1],
      npcIds: [],
      availableItemIds: [],
      tags: [],
    },
    startingItemIds: [],
  });
  return {
    ...base,
    locations: [
      base.locations[0]!,
      {
        id: locDyn1,
        name: "破庙",
        description: "一座破败的庙宇。",
        kind: "main",
        connectedLocationIds: [locTown],
        npcIds: [npcDyn1],
        availableItemIds: [],
        tags: [],
      },
    ],
    npcs: [{
      id: npcDyn1,
      name: "老乞丐",
      role: "破庙守夜人",
      description: "一个白发苍苍的老乞丐。",
      locationId: locDyn1,
      isCompanion: false,
      tags: [],
      met: false,
      memory: {
        npcId: npcDyn1,
        knownFactIds: [],
        hiddenFactIds: [],
        interactionHistory: [],
        relationship: { affinity: 0 },
        emotion: "neutral",
        goals: [],
      },
    }],
    worldFacts: [{
      factId: factTracks,
      text: "泥地上有杂乱的脚印。",
      source: "generated",
      discovered: false,
      locationId: locDyn1,
      investigationLabel: "查看脚印",
      investigationApproaches: [
        { approachId: "quiet", label: "安静观察", evidenceQuality: "clean", tensionDelta: 0 },
      ],
    }],
    ...overrides,
  };
}

function transition(objectiveIndex: number): ObjectiveTransition {
  return {
    before: null,
    completed: [],
    after: { questId, objectiveIndex, label: "test" },
    mode: "progressed",
  };
}

function quest(objectives: WorldState["quests"][number]["objectives"]): WorldState["quests"][number] {
  return {
    id: questId,
    name: "主线",
    description: "追查破庙异状。",
    objectives,
    onSuccess: { kind: "advance_story" },
    onFailure: { kind: "closed" },
    tags: [],
    kind: "main",
    stage: 1,
    status: "active",
  };
}

describe("buildNarrativeBundleDescriptors", () => {
  it("folds visit→discover→talk into one step with absorbed objectives", () => {
    const ws = worldState({
      quests: [quest([
        { kind: "visit_location", locationId: locDyn1 },
        { kind: "discover_fact", factId: factTracks },
        { kind: "talk_to_npc", npcId: npcDyn1 },
      ])],
    });

    const graph = buildNarrativeBundleDescriptors({
      worldState: ws,
      storyState: storyState(),
      transition: transition(0),
    });

    expect(graph.activeStepKeys).toEqual(["move:loc_dyn_1"]);
    expect(graph.currentChoiceCandidates).toEqual([]);
    expect(graph.steps).toHaveLength(1);
    expect(graph.steps[0]?.absorbedObjectiveIndexes).toEqual([0, 1, 2]);
    expect(graph.steps[0]?.arrivalNpc?.id).toBe(npcDyn1);
    expect(graph.steps[0]?.choiceCandidates).toHaveLength(2);
    expect(graph.terminal).toEqual({
      kind: "next_decision",
      target: { kind: "continuation_step", stepKey: "move:loc_dyn_1" },
    });
  });

  it("produces canonical step keys using narrativeBundleTriggerKey", () => {
    const ws = worldState({
      quests: [quest([
        { kind: "visit_location", locationId: locDyn1 },
        { kind: "talk_to_npc", npcId: npcDyn1 },
      ])],
    });

    const graph = buildNarrativeBundleDescriptors({
      worldState: ws,
      storyState: storyState(),
      transition: transition(0),
    });

    expect(graph.steps[0]?.stepKey).toBe(
      narrativeBundleTriggerKey({ kind: "move", locationId: locDyn1 }),
    );
  });

  it("stops at obtain_item because it requires a player action", () => {
    const ws = worldState({
      items: [{
        id: itemSeal,
        name: "盟誓印谱",
        description: "一份古老的印谱。",
        kind: "quest",
        tags: [],
      }],
      quests: [quest([
        { kind: "visit_location", locationId: locDyn1 },
        { kind: "obtain_item", itemId: itemSeal },
        { kind: "talk_to_npc", npcId: npcDyn1 },
      ])],
    });

    const graph = buildNarrativeBundleDescriptors({
      worldState: ws,
      storyState: storyState(),
      transition: transition(0),
    });

    expect(graph.steps).toHaveLength(2);
    expect(graph.steps[0]?.stepKey).toBe("move:loc_dyn_1");
    expect(graph.steps[1]?.stepKey).toBe("take_item:item_seal");
  });

  it("generates battle_started followed only by battle_resolved:victory", () => {
    const ws = worldState({
      enemies: [{
        id: enemyWolf,
        name: "野狼",
        tier: "normal",
        stats: { hp: 30, attack: 8, defense: 2 },
        locationId: locTown,
        tags: [],
      }],
      quests: [quest([
        { kind: "defeat_enemy", enemyId: enemyWolf },
      ])],
    });

    const graph = buildNarrativeBundleDescriptors({
      worldState: ws,
      storyState: storyState(),
      transition: transition(0),
    });

    expect(graph.steps).toHaveLength(2);
    expect(graph.steps[0]?.stepKey).toBe("battle_started:enemy_wolf");
    expect(graph.steps[1]?.stepKey).toBe("battle_resolved:victory:enemy_wolf");
    expect(graph.steps[0]?.nextStepKeys).toEqual(["battle_resolved:victory:enemy_wolf"]);
  });

  it("returns empty graph when transition.after is null", () => {
    const graph = buildNarrativeBundleDescriptors({
      worldState: worldState(),
      storyState: storyState(),
      transition: { before: null, completed: [], after: null, mode: "unchanged" },
    });

    expect(graph.steps).toEqual([]);
    expect(graph.activeStepKeys).toEqual([]);
  });
});
