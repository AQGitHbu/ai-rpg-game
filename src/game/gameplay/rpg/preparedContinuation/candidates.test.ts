import { describe, expect, it } from "vitest";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
import { createInitialWorldState, type WorldState } from "@/game/domain/worldState";
import {
  asEnemyId,
  asFactId,
  asGenerationId,
  asLocationId,
  asNpcId,
  asQuestId,
} from "@/game/domain/worldEntity";
import {
  buildPreparedStepDescriptors,
  preparedTriggerKey,
  type PreparedStepDescriptor,
} from "@/game/gameplay/rpg/preparedContinuation";

const locTown = asLocationId("loc_town");
const locTemple = asLocationId("loc_temple");
const npcBeggar = asNpcId("npc_beggar");
const questId = asQuestId("quest_1");
const factTracks = asFactId("fact_tracks");
const enemyWolf = asEnemyId("enemy_wolf");

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
      connectedLocationIds: [locTemple],
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
        id: locTemple,
        name: "镇外破庙",
        description: "断墙后的破庙。",
        kind: "main",
        connectedLocationIds: [locTown],
        npcIds: [npcBeggar],
        availableItemIds: [],
        tags: [],
      },
    ],
    npcs: [{
      id: npcBeggar,
      name: "老乞丐",
      role: "破庙守夜人",
      description: "常年借宿镇外破庙",
      locationId: locTemple,
      isCompanion: false,
      tags: [],
      met: false,
      memory: {
        npcId: npcBeggar,
        knownFactIds: [],
        hiddenFactIds: [],
        interactionHistory: [],
        relationship: { affinity: 0 },
        emotion: "neutral",
        goals: ["确认来者是否可信"],
      },
    }],
    worldFacts: [{
      factId: factTracks,
      text: "破庙后留有狼爪印。",
      source: "generated",
      discovered: false,
      locationId: locTown,
      investigationLabel: "查看山路旁的痕迹",
      investigationApproaches: [
        { approachId: "quiet", label: "安静观察", evidenceQuality: "clean", tensionDelta: 0 },
        { approachId: "forceful", label: "翻找残迹", evidenceQuality: "noisy", tensionDelta: 3 },
      ],
    }],
    enemies: [{
      id: enemyWolf,
      name: "野狼",
      tier: "normal",
      stats: { hp: 30, attack: 6, defense: 2 },
      locationId: locTemple,
      tags: [],
    }],
    ...overrides,
  };
}

function quest(objectives: WorldState["quests"][number]["objectives"]): WorldState["quests"][number] {
  return {
    id: questId,
    name: "查明破庙异状",
    description: "追查破庙留下的痕迹。",
    objectives,
    onSuccess: { kind: "advance_story" },
    onFailure: { kind: "closed" },
    tags: [],
    kind: "main",
    stage: 1,
    status: "active",
  };
}

function transition(after: ObjectiveTransition["after"]): ObjectiveTransition {
  return { before: null, completed: [], after, mode: "unchanged" };
}

describe("prepared continuation candidate projection", () => {
  it("projects a move to the next NPC decision with authoritative arrival context and two choices", () => {
    const ws = worldState({
      quests: [quest([
        { kind: "visit_location", locationId: locTemple },
        { kind: "talk_to_npc", npcId: npcBeggar },
      ])],
    });

    const result = buildPreparedStepDescriptors({
      worldState: ws,
      storyState: storyState(),
      transition: transition({ questId, objectiveIndex: 0, label: "前往镇外破庙" }),
    });

    expect(result.activeStepIds).toHaveLength(1);
    const move = result.descriptors.find((descriptor) => descriptor.trigger.kind === "move");
    expect(move).toMatchObject({
      trigger: { kind: "move", locationId: locTemple },
      arrivalNpc: {
        id: npcBeggar,
        name: "老乞丐",
        role: "破庙守夜人",
        publicProfile: "常年借宿镇外破庙",
        knownFactCards: [],
        sceneVisibleFactIds: [],
        goals: ["确认来者是否可信"],
      },
      choiceCandidates: [
        { candidateId: "prepared_1_choice_1", action: { type: "talk", npcId: npcBeggar, dialogueAct: "support" } },
        { candidateId: "prepared_1_choice_2", action: { type: "talk", npcId: npcBeggar, dialogueAct: "challenge" } },
      ],
    });
    expect(move?.nextStepIds).toEqual([]);
  });

  it("skips investigation approaches and prepares the next move directly", () => {
    const ws = worldState({
      quests: [quest([
        { kind: "discover_fact", factId: factTracks },
        { kind: "visit_location", locationId: locTemple },
        { kind: "talk_to_npc", npcId: npcBeggar },
        { kind: "visit_location", locationId: locTown },
      ])],
    });
    const result = buildPreparedStepDescriptors({
      worldState: ws,
      storyState: storyState(),
      transition: transition({ questId, objectiveIndex: 0, label: "调查现场线索" }),
    });

    const investigations = result.descriptors.filter((descriptor) => descriptor.trigger.kind === "investigate");
    expect(investigations).toHaveLength(0);
    const move = result.descriptors.find((descriptor) => descriptor.trigger.kind === "move");
    expect(move?.trigger).toEqual({ kind: "move", locationId: locTemple });
    expect(move?.arrivalNpc?.id).toBe(npcBeggar);
    expect(move?.nextStepIds).toEqual([]);

    expect(result.descriptors.some((descriptor) => (
      descriptor.trigger.kind === "move" && descriptor.trigger.locationId === locTown
    ))).toBe(false);
  });

  it("keeps all battle outcomes reachable behind one battle-start descriptor", () => {
    const ws = worldState({
      quests: [quest([
        { kind: "defeat_enemy", enemyId: enemyWolf },
        { kind: "talk_to_npc", npcId: npcBeggar },
      ])],
    });
    const result = buildPreparedStepDescriptors({
      worldState: ws,
      storyState: storyState(),
      transition: transition({ questId, objectiveIndex: 0, label: "击败野狼" }),
    });
    const started = result.descriptors.find((descriptor) => descriptor.trigger.kind === "battle_started");
    expect(started).toBeDefined();
    if (started === undefined) throw new Error("battle_started descriptor is missing");
    expect(started.nextStepIds).toHaveLength(3);

    const outcomes = started.nextStepIds.map((id) => result.descriptors.find((descriptor) => descriptor.stepId === id));
    expect(outcomes.map((descriptor) => descriptor?.trigger)).toEqual([
      { kind: "battle_resolved", enemyId: enemyWolf, outcome: "victory" },
      { kind: "battle_resolved", enemyId: enemyWolf, outcome: "defeat" },
      { kind: "battle_resolved", enemyId: enemyWolf, outcome: "withdraw" },
    ]);
    expect(new Set(outcomes.map((descriptor) => descriptor?.consumptionGroupKey)).size).toBe(1);
  });

  it("provides a canonical trigger key for descriptor matching", () => {
    const descriptor: PreparedStepDescriptor = {
      stepId: "prepared_1",
      objectiveKey: `${questId}:0`,
      consumptionGroupKey: `${questId}:0:move`,
      trigger: { kind: "move", locationId: locTemple },
      authority: { questId, objectiveIndex: 0, allowedEntityIds: [String(locTemple)], visibleFactIds: [] },
      choiceCandidates: [],
      nextStepIds: [],
    };
    expect(preparedTriggerKey(descriptor.trigger)).toBe(`move:${locTemple}`);
  });
});
