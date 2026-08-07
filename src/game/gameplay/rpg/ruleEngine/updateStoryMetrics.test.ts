import { describe, it, expect } from "vitest";
import { updateStoryMetrics, TENSION_CHANGES } from "./updateStoryMetrics";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { GameEvent } from "@/game/domain/events";
import { asEnemyId, asQuestId } from "@/game/domain/scenarioBlueprint";

describe("updateStoryMetrics", () => {
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });

  it("battle_started increases tension by 15", () => {
    const events: GameEvent[] = [{ type: "battle_started", enemyId: asEnemyId("e1"), occurredAt: "t" }];
    const result = updateStoryMetrics(ss, events);
    expect(result.tension).toBe(45);
  });

  it("quest_completed increases tension by 8 and progress", () => {
    const events: GameEvent[] = [{ type: "quest_completed", questId: asQuestId("q1"), occurredAt: "t" }];
    const result = updateStoryMetrics(ss, events);
    expect(result.tension).toBe(38);
  });

  it("tension clamps to 100", () => {
    const highTension = { ...ss, tension: 95 };
    const events: GameEvent[] = [{ type: "battle_started", enemyId: asEnemyId("e1"), occurredAt: "t" }];
    const result = updateStoryMetrics(highTension, events);
    expect(result.tension).toBe(100);
  });
});
