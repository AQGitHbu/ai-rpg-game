import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { updateStoryMetrics } from "./updateStoryMetrics";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { NarrativeEventDraft, NarrativeEventPayload } from "@/game/domain/events";
import { asEnemyId, asQuestId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

describe("updateStoryMetrics", () => {
  const ss = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 } });

  it("battle_started increases tension by 15", () => {
    const drafts: NarrativeEventDraft[] = [{ eventKey: "battle_started", episodeKey: "turn", actorIds: [PLAYER_ENTITY_ID], targetIds: [asEnemyId("e1")], locationId: null, causeKeys: [], factIds: [], questIds: [], outcome: "success", salience: 60, payload: { type: "battle_started", enemyId: asEnemyId("e1") } as unknown as NarrativeEventPayload }];
    const result = updateStoryMetrics(ss, drafts);
    expect(result.tension).toBe(45);
  });

  it("quest_completed increases tension by 8 and progress", () => {
    const drafts: NarrativeEventDraft[] = [{ eventKey: "quest_completed", episodeKey: "turn", actorIds: [PLAYER_ENTITY_ID], targetIds: [PLAYER_ENTITY_ID], locationId: null, causeKeys: [], factIds: [], questIds: [asQuestId("q1")], outcome: "success", salience: 80, payload: { type: "quest_completed", questId: asQuestId("q1") } as unknown as NarrativeEventPayload }];
    const result = updateStoryMetrics(ss, drafts);
    expect(result.tension).toBe(38);
  });

  it("tension clamps to 100", () => {
    const highTension = { ...ss, tension: 95 };
    const drafts: NarrativeEventDraft[] = [{ eventKey: "battle_started", episodeKey: "turn", actorIds: [PLAYER_ENTITY_ID], targetIds: [asEnemyId("e1")], locationId: null, causeKeys: [], factIds: [], questIds: [], outcome: "success", salience: 60, payload: { type: "battle_started", enemyId: asEnemyId("e1") } as unknown as NarrativeEventPayload }];
    const result = updateStoryMetrics(highTension, drafts);
    expect(result.tension).toBe(100);
  });

  // -------------------------------------------------------------------------
  // Task 16 Step 2：确定性张力指标（Spec §13.2/§13.5）
  // -------------------------------------------------------------------------

  it("quest_completed 不再固定推 storyProgress（Spec §13.2）", () => {
    const drafts: NarrativeEventDraft[] = [{ eventKey: "quest_completed", episodeKey: "turn", actorIds: [PLAYER_ENTITY_ID], targetIds: [PLAYER_ENTITY_ID], locationId: null, causeKeys: [], factIds: [], questIds: [asQuestId("q1")], outcome: "success", salience: 80, payload: { type: "quest_completed", questId: asQuestId("q1") } as unknown as NarrativeEventPayload }];
    const result = updateStoryMetrics({ ...ss, storyProgress: 40 }, drafts);
    expect(result.storyProgress).toBe(40); // 不变，由 advanceStoryProgression 按主线 stage 推导
  });

  it("battle_resolved 正确区分 victory / defeat / withdraw 张力", () => {
    const victory = updateStoryMetrics(ss, [{ eventKey: "battle_resolved", episodeKey: "battle", actorIds: [PLAYER_ENTITY_ID], targetIds: [asEnemyId("e1")], locationId: null, causeKeys: [], factIds: [], questIds: [], outcome: "success", salience: 70, payload: { type: "battle_resolved", enemyId: asEnemyId("e1"), outcome: "victory" } as unknown as NarrativeEventPayload }]);
    expect(victory.tension).toBe(50); // 30 + 20

    const defeat = updateStoryMetrics(ss, [{ eventKey: "battle_resolved", episodeKey: "battle", actorIds: [PLAYER_ENTITY_ID], targetIds: [asEnemyId("e1")], locationId: null, causeKeys: [], factIds: [], questIds: [], outcome: "failure", salience: 70, payload: { type: "battle_resolved", enemyId: asEnemyId("e1"), outcome: "defeat" } as unknown as NarrativeEventPayload }]);
    expect(defeat.tension).toBe(18); // 30 - 12

    const withdraw = updateStoryMetrics(ss, [{ eventKey: "battle_resolved", episodeKey: "battle", actorIds: [PLAYER_ENTITY_ID], targetIds: [asEnemyId("e1")], locationId: null, causeKeys: [], factIds: [], questIds: [], outcome: "neutral", salience: 70, payload: { type: "battle_resolved", enemyId: asEnemyId("e1"), outcome: "withdraw" } as unknown as NarrativeEventPayload }]);
    expect(withdraw.tension).toBe(18); // 30 - 12（与 defeat 一致，明确使用 withdraw 分支）
  });

});
