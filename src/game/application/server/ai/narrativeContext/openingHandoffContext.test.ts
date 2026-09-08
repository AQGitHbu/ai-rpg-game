import { describe, expect, it } from "vitest";
import { buildOpeningHandoffContext } from "./openingHandoffContext";
import { asEventId } from "@/game/domain/events";

const historyId = asEventId("init:g:history_public");
const threadId = asEventId("init:g:thread_problem");

function input(turnNumber = 1) {
  const event = (value: Record<string, unknown>) => value as never;
  return {
    worldState: {
      entityStore: { records: [] },
      eventLedger: [
        event({ eventId: asEventId("init:g:game_initialized"), sequence: 0, turnNumber: 0, kind: "game_initialized", actorIds: [], targetIds: [], factIds: [], questIds: [], causeEventIds: [], locationId: null, outcome: "neutral", payload: { type: "game_initialized", generation: {} } }),
        event({ eventId: historyId, sequence: 1, turnNumber: 0, kind: "opening_history_established", actorIds: [], targetIds: [], factIds: ["fact_public"], questIds: [], causeEventIds: [], locationId: null, outcome: "neutral", payload: { type: "opening_history_established", factIds: ["fact_public"] } }),
        event({ eventId: threadId, sequence: 2, turnNumber: 0, kind: "opening_thread_established", actorIds: [], targetIds: [], factIds: ["fact_problem", "fact_secret"], questIds: [], causeEventIds: [historyId], locationId: null, outcome: "neutral", payload: { type: "opening_thread_established", threadId: "thread_init_problem", questionFactId: "fact_problem", supportingFactIds: ["fact_secret"] } }),
      ],
    } as never,
    job: { turnNumber, selectedDialogue: { dialogueAct: "ask", topic: { kind: "thread", threadId: "thread_init_problem" } } } as never,
  };
}

describe("buildOpeningHandoffContext", () => {
  it("follows the selected opening thread causes without inventing public fact text", () => {
    const result = buildOpeningHandoffContext(input());
    expect(result?.requiredEventIds).toEqual([historyId, threadId]);
    expect(result?.publicText).toContain("dialogueAct=ask");
    expect(result?.publicText).not.toContain("fact_secret");
  });

  it("is first-turn only and requires initialization evidence", () => {
    expect(buildOpeningHandoffContext(input(2))).toBeNull();
    const missing = input();
    const worldState = missing.worldState as unknown as { readonly eventLedger: readonly never[] };
    expect(buildOpeningHandoffContext({ ...missing, worldState: { ...worldState, eventLedger: worldState.eventLedger.slice(1) } as never })).toBeNull();
  });
});
