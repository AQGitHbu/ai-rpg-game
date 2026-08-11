import { describe, it, expect } from "vitest";
import { updateStoryMetrics } from "./updateStoryMetrics";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { GameEvent } from "@/game/domain/events";
import { asEnemyId, asQuestId } from "@/game/domain/worldEntity";

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

  // -------------------------------------------------------------------------
  // Task 16 Step 2：确定性张力指标（Spec §13.2/§13.5）
  // -------------------------------------------------------------------------

  it("quest_completed 不再固定推 storyProgress（Spec §13.2）", () => {
    const events: GameEvent[] = [{ type: "quest_completed", questId: asQuestId("q1"), occurredAt: "t" }];
    const result = updateStoryMetrics({ ...ss, storyProgress: 40 }, events);
    expect(result.storyProgress).toBe(40); // 不变，由 advanceStoryProgression 按主线 stage 推导
  });

  it("battle_resolved 正确区分 victory / defeat / withdraw 张力", () => {
    const victory = updateStoryMetrics(ss, [{ type: "battle_resolved", enemyId: asEnemyId("e1"), outcome: "victory", occurredAt: "t" }]);
    expect(victory.tension).toBe(50); // 30 + 20

    const defeat = updateStoryMetrics(ss, [{ type: "battle_resolved", enemyId: asEnemyId("e1"), outcome: "defeat", occurredAt: "t" }]);
    expect(defeat.tension).toBe(18); // 30 - 12

    const withdraw = updateStoryMetrics(ss, [{ type: "battle_resolved", enemyId: asEnemyId("e1"), outcome: "withdraw", occurredAt: "t" }]);
    expect(withdraw.tension).toBe(18); // 30 - 12（与 defeat 一致，明确使用 withdraw 分支）
  });

});
