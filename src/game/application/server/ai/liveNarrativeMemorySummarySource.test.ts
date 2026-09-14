import { describe, expect, it, vi } from "vitest";
import { asNpcId, asPlayerEntityId } from "@/game/domain/worldEntity";
import type { HistoryEntry } from "@/game/domain/narrativeHistory";
import { createLiveNarrativeMemorySummarySource } from "./liveNarrativeMemorySummarySource";
import type { NarrativeRequestClient } from "./narrativeRequestClient";

const PLAYER = asPlayerEntityId("player_0");
const NPC = asNpcId("npc:summary");
const entry: HistoryEntry = {
  id: "history:one", segmentId: "segment:one", sequence: 0, actionId: "action:one", jobId: null,
  sceneId: "scene:one", revision: 1, turnNumber: 1, kind: "npc_line", text: "原句不能由模型改写",
  speakerId: NPC, audienceIds: [PLAYER], entityIds: [PLAYER, NPC], factIds: [], eventIds: [], choiceToken: null,
};

function request(content: string): NarrativeRequestClient {
  return { completeNarrativeRequest: vi.fn(async () => ({ ok: true as const, content, latencyMs: 1 })) };
}

describe("liveNarrativeMemorySummarySource", () => {
  it("requests source IDs and returns a validated selection without accepting model text", async () => {
    const source = createLiveNarrativeMemorySummarySource({ requestClient: request(JSON.stringify({ historyIds: [entry.id], eventIds: [] })) });
    const result = await source.select({ kind: "batch", observerId: PLAYER, history: [entry], events: [], signal: new AbortController().signal, reserveHttpAttempt: vi.fn(async () => true) });
    expect(result).toEqual({ ok: true, selection: { historyIds: [entry.id], eventIds: [] } });
  });

  it("rejects invented references", async () => {
    const source = createLiveNarrativeMemorySummarySource({ requestClient: request(JSON.stringify({ historyIds: ["history:invented"], eventIds: [] })) });
    const result = await source.select({ kind: "batch", observerId: PLAYER, history: [entry], events: [], signal: new AbortController().signal, reserveHttpAttempt: vi.fn(async () => true) });
    expect(result).toMatchObject({ ok: false, repairReason: "invalid_reference" });
  });
});
