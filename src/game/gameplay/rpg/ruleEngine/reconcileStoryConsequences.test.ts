import { describe, expect, it } from "vitest";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { createInitialStoryState } from "@/game/domain/storyState";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { asEventId, asTurnId } from "@/game/domain/events";
import { FACT_1_ID, baseWorld, quest, withDiscoveredFact, withQuest } from "@/game/gameplay/rpg/narrativeContext/narrativeContext.testutil";
import { reconcileStoryConsequences } from "./reconcileStoryConsequences";

describe("reconcileStoryConsequences", () => {
  it("从已提交的事实事件推进任务、reveal 和 Thread，而不重新执行调查 Action", () => {
    const event = makeCommittedEvent({
      type: "fact_discovered",
      factId: FACT_1_ID,
      approachId: "careful",
      evidenceQuality: "clean",
      tensionDelta: 4,
    }, {
      eventId: asEventId("turn:investigate:fact_discovered"),
      turnId: asTurnId("turn:investigate"),
      factIds: [FACT_1_ID],
      outcome: "success",
    });
    const q = quest([{ kind: "discover_fact", factId: FACT_1_ID }]);
    const worldState = withDiscoveredFact(withQuest(baseWorld({ eventLedger: [event] }), q));
    const initial = createInitialStoryState({
      initialNarrative: createFixtureNarrativeRuntimeState(),
      gameLength: "short",
      initialEntityCounts: { locations: 2, npcs: 1, quests: 1, events: 1 },
    });
    const storyState = {
      ...initial,
      reveal: { questId: q.id, visibleObjectiveIndex: 0 },
      threads: [{
        ...initial.threads[0]!,
        questIds: [q.id],
        causeEventIds: [event.eventId],
        question: "事实之后的主线",
      }],
    };

    const result = reconcileStoryConsequences({
      worldState,
      storyState,
      triggerEvents: [event],
      source: { actionId: "action:investigate", turnId: asTurnId("turn:investigate"), turnNumber: 1 },
    });

    expect(result.worldState.quests.find((entry) => entry.id === q.id)?.status).toBe("completed");
    expect(result.storyState.reveal).toBeNull();
    expect(result.storyState.threads[0]?.evidenceEventIds).toContain(event.eventId);
    expect(result.drafts.map((draft) => draft.payload.type)).toContain("quest_completed");
    expect(result.drafts.filter((draft) => draft.payload.type === "fact_discovered")).toHaveLength(0);

    const retry = reconcileStoryConsequences({
      worldState: result.worldState,
      storyState: result.storyState,
      triggerEvents: [event],
      source: { actionId: "action:investigate", turnId: asTurnId("turn:investigate"), turnNumber: 1 },
    });
    expect(retry.drafts).toEqual([]);
  });

  it("接受尚未进入最终账本的本批事件预览，但不把预览事件写入 worldState", () => {
    const event = makeCommittedEvent({
      type: "fact_discovered",
      factId: FACT_1_ID,
      approachId: "quiet",
      evidenceQuality: "clean",
      tensionDelta: 1,
    }, {
      eventId: asEventId("turn:preview:fact_discovered"),
      turnId: asTurnId("turn:preview"),
      factIds: [FACT_1_ID],
      outcome: "success",
    });
    const q = quest([{ kind: "discover_fact", factId: FACT_1_ID }]);
    const worldState = withDiscoveredFact(withQuest(baseWorld({ eventLedger: [] }), q));
    const initial = createInitialStoryState({
      initialNarrative: createFixtureNarrativeRuntimeState(),
      gameLength: "short",
      initialEntityCounts: { locations: 2, npcs: 1, quests: 1, events: 0 },
    });
    const storyState = {
      ...initial,
      threads: [{
        ...initial.threads[0]!,
        causeEventIds: [event.eventId],
        question: "待提交事件的 Thread",
      }],
    };

    const result = reconcileStoryConsequences({
      worldState,
      storyState,
      triggerEvents: [event],
      source: { actionId: "action:preview", turnId: asTurnId("turn:preview"), turnNumber: 2 },
    });

    expect(result.worldState.eventLedger).toEqual([]);
    expect(result.storyState.threads[0]?.evidenceEventIds).toContain(event.eventId);
  });
});
