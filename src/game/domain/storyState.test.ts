import { describe, it, expect } from "vitest";
import {
  STORY_STATE_SCHEMA_VERSION,
  classifyStoryStateSchemaVersion,
  createInitialStoryState,
  derivePacingNeed,
} from "./storyState";

describe("StoryState", () => {
  it("initializes the v4 schema at turn zero", () => {
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });

    expect(STORY_STATE_SCHEMA_VERSION).toBe(4);
    expect(ss.version).toBe(4);
    expect(ss.turnNumber).toBe(0);
  });

  it("classifies legacy v2/v3 without silently migrating them", () => {
    expect(classifyStoryStateSchemaVersion(2)).toEqual({
      ok: false,
      code: "UNSUPPORTED_RECORD",
    });
    expect(classifyStoryStateSchemaVersion(3)).toEqual({
      ok: false,
      code: "UNSUPPORTED_RECORD",
    });
    expect(classifyStoryStateSchemaVersion(4)).toEqual({
      ok: true,
      version: 4,
    });
    expect(classifyStoryStateSchemaVersion(5)).toEqual({
      ok: false,
      code: "UNSUPPORTED_STORY_STATE_VERSION",
    });
  });

  it("createInitialStoryState sets act=1, tension=30, reveal", () => {
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });
    expect(ss.currentAct).toBe(1);
    expect(ss.tension).toBe(30);
    expect(ss.nextPacingNeed).toBe("reveal");
    expect(ss.budget.locations.opening).toBe(4);
    expect(ss.budget.locations.expanded).toBe(0);
    expect(ss.candidateEventPool).toEqual([]);
    expect(ss.unresolvedThreads).toEqual(["main_thread"]);
  });

  it("populates a default story contract and a stable evolution state", () => {
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });
    expect(ss.contract.version).toBe(1);
    expect(ss.contract.targetActs).toBe(3);
    expect(ss.contract.endingDirections.map((d) => d.key)).toEqual(["trust", "doubt"]);
    expect(ss.evolution.nextLocationOrdinal).toBe(0);
    expect(ss.evolution.nextNpcOrdinal).toBe(0);
    expect(ss.evolution.nextItemOrdinal).toBe(0);
    expect(ss.evolution.nextEnemyOrdinal).toBe(0);
    expect(ss.evolution.nextFactOrdinal).toBe(0);
    expect(ss.evolution.status).toBe("stable");
  });

  it("derivePacingNeed returns reveal in act 1", () => {
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });
    expect(derivePacingNeed(ss)).toBe("reveal");
  });

  it("derivePacingNeed returns resolve when endingAllowed and no threads", () => {
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });
    const ss2 = { ...ss, currentAct: 3, endingAllowed: true, unresolvedThreads: [] };
    expect(derivePacingNeed(ss2)).toBe("resolve");
  });

  it("derivePacingNeed returns climax at final act with high progress", () => {
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });
    const ss2 = { ...ss, currentAct: 3, targetActs: 3, storyProgress: 90, endingAllowed: false, unresolvedThreads: ["t1"] };
    expect(derivePacingNeed(ss2)).toBe("climax");
  });

  it("derivePacingNeed returns develop by default", () => {
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });
    const ss2 = { ...ss, currentAct: 2, tension: 50, storyProgress: 40, endingAllowed: false, unresolvedThreads: ["t1"] };
    expect(derivePacingNeed(ss2)).toBe("develop");
  });
});
