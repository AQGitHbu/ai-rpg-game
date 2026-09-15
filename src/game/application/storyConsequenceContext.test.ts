import { describe, expect, it } from "vitest";
import { PLAYER_ENTITY_ID, asNpcId } from "@/game/domain/worldEntity";
import { asEventId } from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { applyEntityMutations } from "@/game/gameplay/rpg/entityWorld";
import { baseWorld, NPC_1_ID, FACT_1_ID } from "@/game/gameplay/rpg/narrativeContext/narrativeContext.testutil";
import type { StoryInteraction } from "@/game/domain/storyInteraction";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { projectStoryConsequences } from "./storyConsequenceContext";

const EVENT_ID = asEventId("turn:investigate");

function story() {
  return createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 },
  });
}

describe("projectStoryConsequences", () => {
  it("只投影实际触发事件关联的 goal/thread/interaction 引用，不把私密目标正文带入公开上下文", () => {
    const event = makeCommittedEvent({
      type: "fact_discovered",
      factId: FACT_1_ID,
      witnessNpcIds: [NPC_1_ID],
      approachId: "careful",
      evidenceQuality: "clean",
      tensionDelta: 4,
    }, {
      eventId: EVENT_ID,
      actorIds: [PLAYER_ENTITY_ID, NPC_1_ID],
      targetIds: [PLAYER_ENTITY_ID, NPC_1_ID],
      factIds: [FACT_1_ID],
    });
    const interaction: StoryInteraction = {
      id: "interaction:npc_1:verify",
      npcId: NPC_1_ID,
      operation: "request_verification",
      condition: [],
      factIds: [FACT_1_ID],
      goalIds: ["goal_private"],
      promiseId: null,
      audienceIds: [PLAYER_ENTITY_ID],
      evidenceEventIds: [EVENT_ID],
    };
    const installed = applyEntityMutations(baseWorld({ eventLedger: [event] }), [
      { kind: "install_story_interaction", npcId: NPC_1_ID, interaction },
    ]);
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const projectedStory = {
      ...story(),
      threads: [{
        ...story().threads[0]!,
        id: "thread:investigation",
        participantIds: [NPC_1_ID],
        causeEventIds: [EVENT_ID],
        goalRefs: [{ npcId: NPC_1_ID, goalId: "goal_private" }],
        question: "调查后的合作条件",
      }],
    };

    const result = projectStoryConsequences({
      worldState: installed.worldState,
      storyState: projectedStory,
      observerId: PLAYER_ENTITY_ID,
      eventIds: [EVENT_ID],
    });

    expect(result.requiredEventIds).toEqual([EVENT_ID]);
    expect(result.currentGoalRefs).toEqual([{ npcId: NPC_1_ID, goalId: "goal_private" }]);
    expect(result.activeThreadIds).toEqual(["thread:investigation"]);
    expect(result.availableInteractionIds).toEqual([interaction.id]);
    expect(JSON.stringify(result)).not.toContain("私密");
    expect(JSON.stringify(result)).not.toContain("description");
  });

  it("忽略不存在、无关或已结束 Thread 的事件引用", () => {
    const result = projectStoryConsequences({
      worldState: baseWorld(),
      storyState: story(),
      observerId: asNpcId("npc_unrelated"),
      eventIds: [asEventId("turn:missing")],
    });
    expect(result).toEqual({
      observerId: asNpcId("npc_unrelated"),
      requiredEventIds: [],
      currentGoalRefs: [],
      activeThreadIds: [],
      availableInteractionIds: [],
    });
  });
});
