import { describe, expect, it } from "vitest";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { asNarrativeJobId } from "@/game/domain/events";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import {
  asGenerationId,
  asLocationId,
  asQuestId,
} from "@/game/domain/worldEntity";
import type { PreparedContinuationState } from "@/game/domain/preparedContinuation";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import { createInitialWorldState } from "@/game/domain/worldState";
import { buildRuleOwnedScene } from "./ruleOwnedScene";

const locTown = asLocationId("loc_town");
const questId = asQuestId("quest_prepared");

function preparedContinuation(): PreparedContinuationState {
  return {
    originJobId: asNarrativeJobId("job_rule_owned_scene"),
    steps: [{
      stepId: "step_after_rule_scene",
      objectiveKey: `${questId}:1`,
      consumptionGroupKey: `${questId}:1:move`,
      trigger: { kind: "move", locationId: locTown },
      scene: {
        segments: [{ beatId: "next", text: "下一步仍已准备。" }],
        event: { kind: "travel", locationId: locTown },
        npcLine: null,
        objectiveLink: { questId, objectiveIndex: 1, mode: "progress" },
        choiceSeeds: [],
        source: "fixture",
      },
      nextStepIds: [],
    }],
    activeStepIds: ["step_after_rule_scene"],
  };
}

function storyState(prepared: PreparedContinuationState): StoryState {
  const base = createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 1, npcs: 0, quests: 1, events: 0 },
  });
  if (base.narrative.status !== "ready") throw new Error("fixture narrative must be ready");
  return {
    ...base,
    narrative: { ...base.narrative, preparedContinuation: prepared },
  };
}

function resolvedEvent(): ResolvedEvent {
  return {
    actionId: "action_rule_owned_explore",
    status: "success",
    eventKind: "observe",
    facts: [],
    stateChanges: [],
    costs: [],
    rewards: [],
    triggeredEvents: [],
    rejectedEffects: [],
  };
}

describe("buildRuleOwnedScene", () => {
  it("builds a rule-owned scene with no choices or NPC line and preserves prepared continuation", () => {
    const prepared = preparedContinuation();
    const story = storyState(prepared);
    const world = createInitialWorldState({
      generation: {
        generationId: asGenerationId("generation_rule_owned"),
        seed: "rule-owned-seed",
        templateVersion: "v1",
        inputDigest: "rule-owned-digest",
        gameType: "wuxia",
      },
      player: {
        name: "侠客",
        identity: "旅人",
        stats: { hp: 100, attack: 10, defense: 5 },
      },
      startingLocation: {
        id: locTown,
        name: "小镇",
        description: "山脚下的小镇。",
        kind: "main",
        connectedLocationIds: [],
        npcIds: [],
        availableItemIds: [],
        tags: [],
      },
      startingItemIds: [],
    });

    const result = buildRuleOwnedScene({
      action: { type: "explore" },
      resolvedEvent: resolvedEvent(),
      worldState: world,
      storyState: story,
      turn: 7,
    });

    const narrative = result.storyState.narrative;
    expect(narrative.status).toBe("ready");
    if (narrative.status !== "ready") return;

    expect(result.scene).toMatchObject({
      source: "rule",
      choices: [],
      npcLine: null,
      turn: 7,
    });
    expect(narrative.choiceRegistry).toEqual([]);
    expect(narrative.preparedContinuation).toEqual(prepared);
  });
});
