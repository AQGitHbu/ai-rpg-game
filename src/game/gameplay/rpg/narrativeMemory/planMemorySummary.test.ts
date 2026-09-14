import { describe, expect, it } from "vitest";
import { asNpcId, asPlayerEntityId } from "@/game/domain/worldEntity";
import type { ObserverEvidence } from "./projectObserverEvidence";
import { planMemorySummary } from "./planMemorySummary";

const PLAYER = asPlayerEntityId("player_0");
const NPC = asNpcId("npc:summary");

function evidence(count: number): ObserverEvidence {
  return {
    observerId: PLAYER,
    events: [],
    knownEntityIds: [PLAYER, NPC],
    history: Array.from({ length: count }, (_, sequence) => ({
      id: `history:${sequence}`, segmentId: `segment:${sequence}`, sequence,
      actionId: `action:${sequence}`, jobId: null, sceneId: `scene:${sequence}`, revision: 1,
      turnNumber: sequence + 1, kind: "npc_line" as const, text: `原话${sequence}`,
      speakerId: NPC, audienceIds: [PLAYER], entityIds: [PLAYER, NPC], factIds: [], eventIds: [], choiceToken: null,
    })),
  };
}

describe("planMemorySummary", () => {
  it("uses valid visible History count and the earliest ten sequence values", () => {
    expect(planMemorySummary({ evidence: evidence(49), previous: null, forceForLength: false })).toEqual({ kind: "none" });
    expect(planMemorySummary({ evidence: evidence(50), previous: null, forceForLength: false })).toEqual({
      kind: "batch", sourceHistoryIds: Array.from({ length: 10 }, (_, index) => `history:${index}`), throughSequence: 9,
    });
    const next = planMemorySummary({
      evidence: evidence(60),
      previous: { formatVersion: 1, observerId: PLAYER, policyVersion: "memory-p2/1", summaryRevision: 1, coveredThroughSequence: 9, coveredSourceFingerprint: "x", batches: [], overview: { historyIds: [], eventIds: [] } },
      forceForLength: false,
    });
    expect(next).toMatchObject({ kind: "batch", throughSequence: 19 });
  });

  it("does not force a partial batch smaller than ten", () => {
    expect(planMemorySummary({ evidence: evidence(9), previous: null, forceForLength: true })).toEqual({ kind: "none" });
    expect(planMemorySummary({ evidence: evidence(10), previous: null, forceForLength: true })).toMatchObject({ kind: "batch", throughSequence: 9 });
  });

  it("rejects duplicate History IDs even when one duplicate is before the watermark", () => {
    const source = evidence(60);
    const duplicate = { ...source.history[10]!, id: source.history[0]!.id, text: "被改写的旧原话" };
    const withDuplicate = { ...source, history: [...source.history.slice(0, 10), duplicate, ...source.history.slice(11)] };

    expect(planMemorySummary({
      evidence: withDuplicate,
      previous: { formatVersion: 1, observerId: PLAYER, policyVersion: "memory-p2/1", summaryRevision: 1, coveredThroughSequence: 9, coveredSourceFingerprint: "x", batches: [], overview: { historyIds: [], eventIds: [] } },
      forceForLength: false,
    })).toEqual({ kind: "none" });
  });
});
