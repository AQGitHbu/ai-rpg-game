import { describe, expect, it } from "vitest";
import { asEventId, asNarrativeJobId } from "./events";
import { asFactId, asNpcId, PLAYER_ENTITY_ID } from "./worldEntity";
import {
  appendHistory,
  narrativeSceneHistoryEntries,
  playerActionHistoryEntry,
  parseNarrativeHistory,
  type HistoryEntry,
} from "./narrativeHistory";
import type { NarrativeHistory } from "./narrativeHistory";

const npcA = asNpcId("npc_a");
const npcB = asNpcId("npc_b");

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "job-1:scene-1:narration:0",
    segmentId: "segment-1",
    sequence: 1,
    actionId: "action-1",
    jobId: asNarrativeJobId("job-1"),
    sceneId: "scene-1",
    revision: 2,
    turnNumber: 1,
    kind: "narration",
    text: "破庙的雨声压过了远处的马蹄声。",
    speakerId: null,
    audienceIds: [PLAYER_ENTITY_ID],
    entityIds: [npcA],
    factIds: [asFactId("fact_letter")],
    eventIds: [asEventId("turn-1:narrative_scene_presented")],
    choiceToken: null,
    ...overrides,
  };
}

describe("appendHistory", () => {
  it("keeps an empty history unchanged", () => {
    expect(appendHistory({ entries: [] }, [])).toEqual({ entries: [] });
  });

  it("deduplicates an idempotent retry without reordering entries", () => {
    const first = entry();
    const second = entry({ id: "job-1:scene-1:npc_line:1", kind: "npc_line", text: "来人可是沈行？" });

    const result = appendHistory({ entries: [first] }, [first, second]);

    expect(result.entries).toEqual([first, second]);
  });

  it("rejects the same id when its content is changed", () => {
    const first = entry();

    expect(() => appendHistory({ entries: [first] }, [{ ...first, text: "被改写的历史。" }]))
      .toThrow("HISTORY_ID_CONFLICT");
  });

  it("does not merge audiences from different NPC expressions", () => {
    const privateLine = entry({
      id: "job-1:scene-1:npc_line:1",
      kind: "npc_line",
      speakerId: npcA,
      audienceIds: [PLAYER_ENTITY_ID, npcA],
      entityIds: [npcA],
      text: "这句话只对你说。",
    });
    const otherLine = entry({
      id: "job-1:scene-1:npc_line:2",
      kind: "npc_line",
      speakerId: npcB,
      audienceIds: [PLAYER_ENTITY_ID, npcB],
      entityIds: [npcB],
      text: "另一人没有听见前一句。",
    });

    const result = appendHistory({ entries: [] }, [privateLine, otherLine]);

    expect(result.entries[0]?.audienceIds).toEqual([PLAYER_ENTITY_ID, npcA]);
    expect(result.entries[1]?.audienceIds).toEqual([PLAYER_ENTITY_ID, npcB]);
  });

  it("records the exact player text and keeps shown choices out of player speech", () => {
    const history: NarrativeHistory = { entries: [] };
    const action = { type: "talk" as const, npcId: npcA, dialogueAct: "ask" as const };
    const player = playerActionHistoryEntry({
      history,
      action,
      actionId: "action-2",
      text: "先核实接应人的身份。",
      sceneId: "scene-1",
      revision: 3,
      turnNumber: 2,
      eventIds: [asEventId("turn-2:interaction")],
      jobId: asNarrativeJobId("job-action-2"),
    });
    const sceneEntries = narrativeSceneHistoryEntries({
      history: { entries: [player] },
      scene: {
        sceneId: "scene-2",
        turn: 3,
        narration: "信使压低了声音。",
        usedFactIds: [],
        npcLine: {
          npcId: npcA,
          text: "那就先验明身份。",
          emotion: "guarded",
          usedFactIds: [],
          usedEventIds: [],
        },
        choices: [{ choiceToken: "opaque-1", label: "继续核验" }, { choiceToken: "opaque-2", label: "现在交付" }],
        source: "generated",
      },
      actionId: "action-2",
      jobId: asNarrativeJobId("job-action-2"),
      revision: 3,
      turnNumber: 2,
      eventIds: [asEventId("turn-2:interaction")],
    });

    expect(player.kind).toBe("player_choice");
    expect(player.text).toBe("先核实接应人的身份。");
    expect(sceneEntries.map((entry) => entry.kind)).toEqual(["narration", "npc_line", "shown_choice", "shown_choice"]);
    expect(sceneEntries.slice(2).every((entry) => entry.kind === "shown_choice")).toBe(true);
  });

  it("rejects blank persisted identity and event references", () => {
    expect(parseNarrativeHistory({ entries: [{ ...entry(), id: "" }] }).ok).toBe(false);
    expect(parseNarrativeHistory({ entries: [{ ...entry(), eventIds: ["not-an-event"] }] }).ok).toBe(false);
  });

  it("records an NPC-only continuation without manufacturing empty narration", () => {
    const entries = narrativeSceneHistoryEntries({
      history: { entries: [] },
      scene: { sceneId: "npc-only", turn: 1, narration: "", usedFactIds: [],
        npcLine: { npcId: npcA, text: "信筒已经收妥。", emotion: "neutral", usedFactIds: [], usedEventIds: [] },
        choices: [], source: "generated" },
      actionId: "delivery", jobId: null, revision: 1, turnNumber: 1, eventIds: [],
    });
    expect(entries.map(value => value.kind)).toEqual(["npc_line"]);
    expect(parseNarrativeHistory({ entries }).ok).toBe(true);
  });
});
