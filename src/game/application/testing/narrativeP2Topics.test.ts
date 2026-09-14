import { describe, expect, it } from "vitest";
import { NARRATIVE_P2_TOPICS, selectNarrativeP2Topic, commitNarrativeP2Topic, stopNarrativeP2Topics, type P2TopicState } from "./narrativeP2Topics";
const empty = (): P2TopicState => ({ committed: [], stoppedActs: [] });
const view = { currentAct: 1, formalResponseCount: 0, focus: [{ npcId: "public-npc", freeInputEnabled: true }] };
describe("bounded P2 topics", () => {
  it("uses only a current enabled focus and fixed ordered text", () => {
    const first = selectNarrativeP2Topic(view, empty());
    expect(selectNarrativeP2Topic({ ...view, focus: [
      { npcId: "disabled", freeInputEnabled: false },
      { npcId: "first-enabled", freeInputEnabled: true },
      { npcId: "second-enabled", freeInputEnabled: true },
    ] }, empty())).toEqual({ kind: "topic", topic: NARRATIVE_P2_TOPICS[0], npcId: "first-enabled" });
    expect(selectNarrativeP2Topic({ ...view, focus: [] }, empty())).toEqual({ kind: "failure", code: "P2_TOPIC_FOCUS_MISSING" });
    expect(first).toEqual({ kind: "topic", topic: NARRATIVE_P2_TOPICS[0], npcId: "public-npc" });
    expect(selectNarrativeP2Topic({ ...view, focus: [{ npcId: "private", freeInputEnabled: false }] }, empty())).toEqual({ kind: "failure", code: "P2_TOPIC_FOCUS_MISSING" });
  });
  it("commits only successful unique actions, resumes in order, and stops after three", () => {
    let state = empty();
    for (let index = 0; index < 3; index++) {
      const topic = NARRATIVE_P2_TOPICS[index];
      state = commitNarrativeP2Topic(state, { act: 1, topicId: topic.topicId, actionId: `action-${index}`, npcId: "public-npc" }, true);
    }
    expect(selectNarrativeP2Topic(view, JSON.parse(JSON.stringify(state)))).toEqual({ kind: "formal" });
    expect(() => commitNarrativeP2Topic(state, state.committed[0], true)).toThrow("P2_TOPIC_DUPLICATE");
    expect(commitNarrativeP2Topic(empty(), { act: 1, topicId: "1-reason", actionId: "failed", npcId: "public-npc" }, false)).toEqual(empty());
  });
  it("does not replace stopped topics or recover a missed formal window", () => {
    expect(selectNarrativeP2Topic(view, { ...empty(), stoppedActs: [1] })).toEqual({ kind: "formal" });
    expect(selectNarrativeP2Topic({ ...view, formalResponseCount: 1 }, empty())).toEqual({ kind: "failure", code: "P2_TOPIC_WINDOW_MISSED" });
    expect(() => commitNarrativeP2Topic(empty(), { act: 1, topicId: "1-cost", actionId: "a", npcId: "n" }, true)).toThrow("P2_TOPIC_ORDER_INVALID");
  });
  it("never moves unanswered topics to another act and caps total topics at fifteen", () => {
    expect(NARRATIVE_P2_TOPICS).toHaveLength(15);
    expect(selectNarrativeP2Topic({ ...view, currentAct: 2 }, empty())).toEqual({ kind: "topic", topic: NARRATIVE_P2_TOPICS[3], npcId: "public-npc" });
    expect(selectNarrativeP2Topic({ ...view, currentAct: 6 }, empty())).toEqual({ kind: "formal" });
  });
  it("requires grounded review evidence for an early stop, without replacing questions", () => {
    const state = commitNarrativeP2Topic(empty(), { act: 1, topicId: "1-reason", actionId: "a", npcId: "public-npc" }, true);
    const review = { topicId: "1-reason", actionId: "a", reviewer: "human", reviewedAt: "2026-09-14T10:00:00Z", historyQuotes: [{ historyId: "h1", quote: "原话" }], candidateIds: ["c1"], reason: "same content as opening", verdict: "repeated" as const };
    expect(() => stopNarrativeP2Topics(state, { ...review, candidateIds: [] })).toThrow("P2_TOPIC_REVIEW_INVALID");
    expect(() => stopNarrativeP2Topics(state, { ...review, candidateIds: ["   "] })).toThrow("P2_TOPIC_REVIEW_INVALID");
    expect(() => stopNarrativeP2Topics(state, { ...review, candidateIds: ["c1", ""] })).toThrow("P2_TOPIC_REVIEW_INVALID");
    const stopped = stopNarrativeP2Topics(state, review);
    expect(selectNarrativeP2Topic(view, stopped)).toEqual({ kind: "formal" });
    expect(() => stopNarrativeP2Topics(state, { ...review, historyQuotes: [] })).toThrow("P2_TOPIC_REVIEW_INVALID");
    expect(() => commitNarrativeP2Topic(stopped, { act: 1, topicId: "1-cost", actionId: "b", npcId: "n" }, true)).toThrow("P2_TOPIC_ACT_STOPPED");
  });

});
