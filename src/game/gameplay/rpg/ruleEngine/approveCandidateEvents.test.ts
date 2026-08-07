import { describe, it, expect } from "vitest";
import { approveCandidateEvents } from "./approveCandidateEvents";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { EventCandidate } from "@/game/domain/storyState";

describe("approveCandidateEvents", () => {
  const ss = createInitialStoryState({
    gameLength: "short",
    initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 },
  });

  it("approves events when budget allows", () => {
    const candidates: EventCandidate[] = [
      { id: "c1", description: "有人跟踪玩家", proposedAtTurn: 1 },
    ];
    const result = approveCandidateEvents(ss, candidates);
    expect(result.approvedEvents.length).toBe(1);
    expect(result.nextStoryState.candidateEventPool.length).toBe(0);
    expect(result.nextStoryState.budget.events.expanded).toBe(1);
  });

  it("rejects events when budget exhausted", () => {
    const exhaustedSs = {
      ...ss,
      budget: {
        ...ss.budget,
        events: { ...ss.budget.events, expanded: 6, max: 6 },
      },
    };
    const candidates: EventCandidate[] = [
      { id: "c1", description: "新事件", proposedAtTurn: 1 },
    ];
    const result = approveCandidateEvents(exhaustedSs, candidates);
    expect(result.approvedEvents.length).toBe(0);
    expect(result.rejectedEvents.length).toBe(1);
    expect(result.nextStoryState.budget.events.expanded).toBe(6);
  });

  it("empty pool returns same state", () => {
    const result = approveCandidateEvents(ss, []);
    expect(result.approvedEvents.length).toBe(0);
    expect(result.nextStoryState).toBe(ss);
  });

  it("approves at most 1 event per turn", () => {
    const candidates: EventCandidate[] = [
      { id: "c1", description: "事件A", proposedAtTurn: 1 },
      { id: "c2", description: "事件B", proposedAtTurn: 1 },
    ];
    const result = approveCandidateEvents(ss, candidates);
    expect(result.approvedEvents.length).toBe(1);
    expect(result.nextStoryState.candidateEventPool.length).toBe(1);
  });

  it("approved event increases tension", () => {
    const candidates: EventCandidate[] = [
      { id: "c1", description: "冲突事件", proposedAtTurn: 1 },
    ];
    const result = approveCandidateEvents(ss, candidates);
    expect(result.nextStoryState.tension).toBe(ss.tension + 10);
  });
});
