// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { asGenerationId, asLocationId } from "@/game/domain/worldEntity";
import { createInitialWorldState } from "@/game/domain/worldState";
import { battleVictoryRequiresWorldEvolution } from "./battleScenePrewarm";

function recordWithEvolutionStatus(
  status: StoryState["evolution"]["status"],
): Parameters<typeof battleVictoryRequiresWorldEvolution>[0] {
  const worldState = createInitialWorldState({
    generation: {
      generationId: asGenerationId("gen_test"),
      seed: "seed_test",
      templateVersion: "v2",
      inputDigest: "",
      gameType: "wuxia",
    },
    player: {
      name: "测试玩家",
      identity: "测试身份",
      stats: { hp: 100, attack: 10, defense: 5 },
    },
    startingLocation: {
      id: asLocationId("loc_test"),
      name: "测试地点",
      description: "用于回归测试的地点。",
      kind: "main",
      connectedLocationIds: [],
      npcIds: [],
      availableItemIds: [],
      tags: [],
    },
    startingItemIds: [],
  });
  const initialStoryState = createInitialStoryState({
    gameLength: "short",
    initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 },
  });
  return {
    worldState,
    storyState: {
      ...initialStoryState,
      evolution: { ...initialStoryState.evolution, status },
    },
  };
}

describe("battle victory scene prewarm handoff", () => {
  it.each(["needs_next_act", "needs_ending_pair"] as const)(
    "requires normal generation when evolution status is %s",
    (status) => {
      expect(battleVictoryRequiresWorldEvolution(recordWithEvolutionStatus(status))).toBe(true);
    },
  );

  it("keeps the prewarm fast path when no world evolution is pending", () => {
    expect(battleVictoryRequiresWorldEvolution(recordWithEvolutionStatus("stable"))).toBe(false);
  });
});
