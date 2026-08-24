import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { deriveEvolutionNeed } from "./deriveEvolutionNeed";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createInitialWorldState } from "@/game/domain/worldState";
import { asLocationId, asGenerationId } from "@/game/domain/worldEntity";

function makeWorld(): WorldState {
  return createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "林惊羽", identity: "外门弟子", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_0"), name: "听雨客栈", description: "山脚小镇的客栈。", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
}

function makeStory(overrides?: Partial<StoryState>): StoryState {
  const base = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 } });
  return { ...base, ...overrides };
}

describe("deriveEvolutionNeed", () => {
  it("returns next_act with the current act when evolution.status is needs_next_act", () => {
    const ss = makeStory({
      currentAct: 2,
      targetActs: 3,
      evolution: { ...makeStory().evolution, status: "needs_next_act" },
    });
    expect(deriveEvolutionNeed(makeWorld(), ss)).toEqual({ kind: "next_act", act: 2 });
  });

  it("returns ending_pair at the final act when evolution.status is needs_ending_pair", () => {
    const ss = makeStory({
      currentAct: 3,
      targetActs: 3,
      evolution: { ...makeStory().evolution, status: "needs_ending_pair" },
    });
    expect(deriveEvolutionNeed(makeWorld(), ss)).toEqual({ kind: "ending_pair", finalAct: 3 });
  });

  it("returns none for a normal stable conversation in act 1", () => {
    const ss = makeStory({ currentAct: 1, targetActs: 3, tension: 30 });
    expect(deriveEvolutionNeed(makeWorld(), ss)).toEqual({ kind: "none" });
  });

  it("returns a pacing need when stable but tension is low in a later act", () => {
    const ss = makeStory({ currentAct: 2, targetActs: 3, tension: 15, nextPacingNeed: "complicate" });
    expect(deriveEvolutionNeed(makeWorld(), ss)).toEqual({ kind: "pacing", pacingNeed: "complicate" });
  });

  it("returns none when the story is closing (climax) even with low tension", () => {
    const ss = makeStory({ currentAct: 3, targetActs: 3, tension: 10, nextPacingNeed: "climax" });
    expect(deriveEvolutionNeed(makeWorld(), ss)).toEqual({ kind: "none" });
  });

  it("returns an escalate pacing need when the pacing hint is escalate and story is ascending", () => {
    const ss = makeStory({ currentAct: 2, targetActs: 3, tension: 60, nextPacingNeed: "escalate" });
    expect(deriveEvolutionNeed(makeWorld(), ss)).toEqual({ kind: "pacing", pacingNeed: "escalate" });
  });

  it("returns none for a develop pacing hint even with budget available", () => {
    const ss = makeStory({ currentAct: 2, targetActs: 3, tension: 40, nextPacingNeed: "develop" });
    expect(deriveEvolutionNeed(makeWorld(), ss)).toEqual({ kind: "none" });
  });

  it("returns none when no budget remains for any pacing entity", () => {
    const base = makeStory({ currentAct: 2, targetActs: 3, tension: 10 });
    const ss: StoryState = {
      ...base,
      budget: {
        locations: { opening: 1, expanded: 8, max: 8 },
        npcs: { opening: 1, expanded: 10, max: 10 },
        quests: { opening: 1, expanded: 4, max: 4 },
        events: { opening: 0, expanded: 6, max: 6 },
        hardLimit: { locations: 40, npcs: 30 },
      },
    };
    expect(deriveEvolutionNeed(makeWorld(), ss)).toEqual({ kind: "none" });
  });
});
