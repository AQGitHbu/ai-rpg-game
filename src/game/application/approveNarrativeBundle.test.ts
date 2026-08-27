import { describe, expect, it } from "vitest";
import { approveNarrativeBundle } from "./approveNarrativeBundle";
import type { ApproveNarrativeBundleInput } from "./approveNarrativeBundle";
import type { NarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
import type { WorldState, NpcEntry } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import {
  asLocationId,
  asNpcId,
  asGenerationId,
  asQuestId,
  asFactId,
} from "@/game/domain/worldEntity";
import { asNarrativeJobId } from "@/game/domain/events";

const locTown = asLocationId("loc_0");
const locDyn1 = asLocationId("loc_dyn_1");
const npcDyn1 = asNpcId("npc_dyn_1");
const questId = asQuestId("quest_1");
const factTracks = asFactId("fact_tracks");

function storyState(): StoryState {
  return createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 2, npcs: 1, quests: 1, events: 0 },
  });
}

function worldState(): WorldState {
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
  const npc: NpcEntry = {
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
  };
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
    npcs: [npc],
    quests: [{
      id: questId,
      name: "主线",
      description: "追查破庙异状。",
      objectives: [
        { kind: "visit_location", locationId: locDyn1 },
        { kind: "discover_fact", factId: factTracks },
        { kind: "talk_to_npc", npcId: npcDyn1 },
      ],
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: [],
      kind: "main",
      stage: 1,
      status: "active",
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

function validProposal(): NarrativeBundleProposal {
  return {
    worldDelta: null,
    currentScene: {
      segments: [{ beatId: "atmosphere", text: "你沿着山路走向破庙。" }],
      npcLine: null,
      objectiveLink: null,
      choices: [],
    },
    continuationScenes: [
      {
        stepKey: "move:loc_dyn_1",
        scene: {
          segments: [
            { beatId: "atmosphere", text: "破庙前，一个老乞丐坐在台阶上。" },
          ],
          npcLine: {
            npcId: String(npcDyn1),
            text: "后生，这里不是你该来的地方。",
            emotion: "guarded",
            answeredBeatIds: [],
            usedFactIds: [],
            usedInteractionActionIds: [],
          },
          objectiveLink: { questId: String(questId), objectiveIndex: 0, mode: "hint" },
          choices: [
            { candidateId: "move:loc_dyn_1_choice_1", label: "老丈，昨夜来的是谁？" },
            { candidateId: "move:loc_dyn_1_choice_2", label: "你若隐瞒，我只能自己搜。" },
          ],
        },
      },
    ],
    terminal: {
      kind: "next_decision",
      target: { kind: "continuation_step", stepKey: "move:loc_dyn_1" },
    },
  };
}

function baseInput(overrides: Partial<ApproveNarrativeBundleInput> = {}): ApproveNarrativeBundleInput {
  return {
    proposal: validProposal(),
    worldState: worldState(),
    storyState: storyState(),
    transition: transition(0),
    evolutionNeed: { kind: "none" },
    jobId: asNarrativeJobId("job_1"),
    basedOnRevision: 1,
    now: () => "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("approveNarrativeBundle", () => {
  it("approves a valid bundle with continuation_step terminal", () => {
    const result = approveNarrativeBundle(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.bundle.steps).toHaveLength(1);
    expect(result.approved.bundle.steps[0]?.stepId).toBe("move:loc_dyn_1");
    expect(result.approved.bundle.activeStepIds).toEqual(["move:loc_dyn_1"]);
    expect(result.approved.choiceRegistry).toHaveLength(2);
    expect(result.approved.currentScene.source).toBe("generated");
  });

  it("rejects an unknown step key not in the descriptor graph", () => {
    const base = validProposal();
    const proposal: NarrativeBundleProposal = {
      ...base,
      continuationScenes: [
        { ...base.continuationScenes[0]!, stepKey: "move:nonexistent" },
      ],
      terminal: {
        kind: "next_decision",
        target: { kind: "continuation_step", stepKey: "move:nonexistent" },
      },
    };
    const result = approveNarrativeBundle(baseInput({ proposal }));
    expect(result).toEqual({ ok: false, code: "bundle_unknown_step" });
  });

  it("rejects a missing continuation scene", () => {
    const proposal: NarrativeBundleProposal = {
      ...validProposal(),
      continuationScenes: [],
    };
    const result = approveNarrativeBundle(baseInput({ proposal }));
    expect(result.ok).toBe(false);
  });

  it("rejects a duplicate step key", () => {
    const base = validProposal();
    const proposal: NarrativeBundleProposal = {
      ...base,
      continuationScenes: [base.continuationScenes[0]!, { ...base.continuationScenes[0]! }],
    };
    const result = approveNarrativeBundle(baseInput({ proposal }));
    expect(result.ok).toBe(false);
  });

  it("does not expose partial result on failure", () => {
    const base = validProposal();
    const proposal: NarrativeBundleProposal = {
      ...base,
      continuationScenes: [
        { ...base.continuationScenes[0]!, stepKey: "move:nonexistent" },
      ],
      terminal: {
        kind: "next_decision",
        target: { kind: "continuation_step", stepKey: "move:nonexistent" },
      },
    };
    const result = approveNarrativeBundle(baseInput({ proposal }));
    expect(result.ok).toBe(false);
    expect("approved" in result).toBe(false);
    expect("nextWorldState" in result).toBe(false);
  });
});
