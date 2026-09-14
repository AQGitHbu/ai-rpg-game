import { describe, expect, it } from "vitest";
import { asEventId } from "./events";
import { parseMemorySummaryState, parseMemorySummarySelection } from "./narrativeMemorySummary";
import type { HistoryEntry } from "./narrativeHistory";
import { asNpcId, asPlayerEntityId } from "./worldEntity";

const NPC = asNpcId("npc:memory");
const PLAYER = asPlayerEntityId("player_0");
const EVENT = asEventId("story:event");

const history: HistoryEntry = {
  id: "history:one", segmentId: "segment:one", sequence: 0, actionId: "action:one", jobId: null,
  sceneId: "scene:one", revision: 1, turnNumber: 1, kind: "npc_line", text: "原始原话",
  speakerId: NPC, audienceIds: [PLAYER], entityIds: [PLAYER, NPC], factIds: [], eventIds: [EVENT], choiceToken: null,
};

describe("narrativeMemorySummary", () => {
  it("accepts only source IDs and rejects invented text or references", () => {
    expect(parseMemorySummarySelection({ historyIds: [history.id], eventIds: [] }, { history: [history], events: [] })).toEqual({
      ok: true, value: { historyIds: [history.id], eventIds: [] },
    });
    expect(parseMemorySummarySelection({ historyIds: ["invented"], eventIds: [] }, { history: [history], events: [] }).ok).toBe(false);
    expect(parseMemorySummarySelection({ historyIds: [history.id], eventIds: [], text: "已经交付" }, { history: [history], events: [] }).ok).toBe(false);
    expect(parseMemorySummarySelection({ historyIds: [], eventIds: [] }, { history: [history], events: [] }).ok).toBe(false);
  });

  it("parses a versioned state and rejects an unsupported format", () => {
    const state = {
      formatVersion: 1,
      observerId: PLAYER,
      policyVersion: "memory-p2/1",
      summaryRevision: 1,
      coveredThroughSequence: 0,
      coveredSourceFingerprint: "fingerprint",
      batches: [{ id: "batch:1", fromSequence: 0, throughSequence: 0, sourceHistoryIds: [history.id], sourceFingerprint: "fingerprint", selection: { historyIds: [history.id], eventIds: [EVENT] } }],
      overview: { historyIds: [history.id], eventIds: [EVENT] },
    };
    expect(parseMemorySummaryState(state)).toMatchObject({ ok: true, value: state });
    expect(parseMemorySummaryState({ ...state, formatVersion: 2 })).toMatchObject({ ok: false, code: "UNSUPPORTED_FORMAT" });
  });
});
