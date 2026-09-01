import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, expect, it } from "vitest";
import type {
  ApprovedWorldDelta,
  EvolutionNeed,
  StoryEvolutionState,
  WorldDeltaProposal,
} from "./worldDelta";
import {
  asEndingId,
  asFactId,
  asGenerationId,
  asLocationId,
  asNpcId,
  asQuestId,
} from "./worldEntity";
import { createInitialStoryState } from "./storyState";
import { createInitialWorldState } from "./worldState";

const baseEvolution: StoryEvolutionState = {
  nextLocationOrdinal: 0,
  nextNpcOrdinal: 0,
  nextItemOrdinal: 0,
  nextEnemyOrdinal: 0,
  nextFactOrdinal: 0,
  nextQuestOrdinal: 0,
  nextEndingOrdinal: 0,
  status: "stable",
};

describe("StoryEvolutionState", () => {
  it("defaults every materialization ordinal to zero and status to stable", () => {
    expect(baseEvolution.nextLocationOrdinal).toBe(0);
    expect(baseEvolution.nextNpcOrdinal).toBe(0);
    expect(baseEvolution.nextItemOrdinal).toBe(0);
    expect(baseEvolution.nextEnemyOrdinal).toBe(0);
    expect(baseEvolution.nextFactOrdinal).toBe(0);
    expect(baseEvolution.status).toBe("stable");
  });

  it("accepts the two non-stable statuses", () => {
    expect(({ ...baseEvolution, status: "needs_next_act" } satisfies StoryEvolutionState).status)
      .toBe("needs_next_act");
    expect(({ ...baseEvolution, status: "needs_ending_pair" } satisfies StoryEvolutionState).status)
      .toBe("needs_ending_pair");
  });
});

describe("EvolutionNeed", () => {
  it("discriminates all four kinds with their payloads", () => {
    const needs: readonly EvolutionNeed[] = [
      { kind: "none" },
      { kind: "next_act", act: 2 },
      { kind: "pacing", pacingNeed: "complicate" },
      { kind: "pacing", pacingNeed: "escalate" },
      { kind: "ending_pair", finalAct: 3 },
    ];
    expect(needs.map((n) => n.kind)).toEqual([
      "none",
      "next_act",
      "pacing",
      "pacing",
      "ending_pair",
    ]);
    expect(needs.find((n) => n.kind === "next_act")).toEqual({ kind: "next_act", act: 2 });
    expect(needs.find((n) => n.kind === "ending_pair")).toEqual({
      kind: "ending_pair",
      finalAct: 3,
    });
  });
});

describe("WorldDeltaProposal", () => {
  it("keeps every optional slot nullable when nothing changes", () => {
    const quiet: WorldDeltaProposal = {
      beatSummary: "平静的一轮",
      newLocation: null,
      newNpc: null,
      newItem: null,
      newEnemy: null,
      newFact: null,
      nextMainQuest: null,
      endingPair: null,
    };
    expect(quiet.newLocation).toBeNull();
    expect(quiet.newNpc).toBeNull();
    expect(quiet.newItem).toBeNull();
    expect(quiet.newEnemy).toBeNull();
    expect(quiet.newFact).toBeNull();
    expect(quiet.nextMainQuest).toBeNull();
    expect(quiet.endingPair).toBeNull();
  });

  it("carries proposal-local plain-string references when populated", () => {
    const proposal: WorldDeltaProposal = {
      beatSummary: "新的威胁浮现",
      newLocation: {
        name: "迷雾林",
        description: "常年雾气笼罩的林地。",
        scale: "scene",
        placement: "world",
        connectFromLocationId: "loc_1",
      },
      newNpc: {
        name: "信使",
        role: "传话人",
        description: "风尘仆仆的赶路人。",
        locationRef: { kind: "new_location" },
        anchors: { selfConcept: "替人传话的信使", values: ["守信"], speechStyle: "谨慎而直接", capabilityBoundaries: ["只知道亲身见闻"], taboos: [] },
        goals: [{ horizon: "short", description: "送达密信", priority: 3, reason: "必须完成传递" }],
        relationshipSeeds: [],
      },
      newItem: null,
      newEnemy: { name: "山贼", tier: "normal", locationRef: "current" },
      newFact: { text: "盟约已有裂痕。", visibility: "public" },
      nextMainQuest: { name: "追查密信", description: "找到密信的下落。", objectiveText: "与信使交谈" },
      endingPair: [
        { name: "共担真相", description: "公开一切。", themeKey: "trust" },
        { name: "独自揭露", description: "独自承担。", themeKey: "doubt" },
      ],
    };
    expect(proposal.newLocation?.connectFromLocationId).toBe("loc_1");
    expect(proposal.newNpc?.locationRef).toEqual({ kind: "new_location" });
    expect(proposal.endingPair).toHaveLength(2);
    expect(proposal.endingPair?.map((e) => e.themeKey)).toEqual(["trust", "doubt"]);
  });
});

describe("ApprovedWorldDelta", () => {
  it("carries server-minted branded IDs plus a preview state reference", () => {
    const delta: ApprovedWorldDelta = {
      mintedLocationIds: [asLocationId("loc_dyn_1")],
      mintedNpcIds: [asNpcId("npc_dyn_1")],
      mintedItemIds: [],
      mintedEnemyIds: [],
      mintedFactIds: [asFactId("fact_dyn_1")],
      mintedQuestIds: [asQuestId("quest_dyn_1")],
      mintedEndingIds: [asEndingId("ending_dyn_1")],
      previewWorldState: createInitialWorldState({
        generation: {
          generationId: asGenerationId("g1"),
          seed: "s",
          templateVersion: "v1",
          inputDigest: "",
          gameType: "wuxia",
        },
        player: { name: "林惊羽", identity: "外门弟子", stats: { hp: 20, attack: 5, defense: 3 } },
        startingLocation: {
          id: asLocationId("loc_dyn_1"),
          name: "青石村",
          description: "山脚下的小村。",
          kind: "main",
          connectedLocationIds: [],
          npcIds: [],
          availableItemIds: [],
          tags: [],
        },
        startingItemIds: [],
      }),
      previewStoryState: createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(),
        gameLength: "short",
        initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 },
      }),
    };
    expect(delta.mintedNpcIds[0]).toBe("npc_dyn_1");
    expect(delta.mintedLocationIds[0]).toBe("loc_dyn_1");
    expect(delta.mintedEndingIds[0]).toBe("ending_dyn_1");
    expect(delta.previewWorldState.locations).toHaveLength(1);
    expect(delta.previewStoryState.contract.targetActs).toBe(3);
  });
});
