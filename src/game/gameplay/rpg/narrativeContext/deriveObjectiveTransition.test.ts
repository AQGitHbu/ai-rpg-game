import { describe, expect, it } from "vitest";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asQuestId } from "@/game/domain/worldEntity";
import {
  baseWorld, quest, withQuest, withMet, LOC_1_ID, NPC_1_ID, NPC_2_ID, ITEM_SEAL_ID, withNextAct,
} from "./narrativeContext.testutil";
import { deriveObjectiveTransition, currentObjectiveOf } from "./deriveObjectiveTransition";

function story() {
  return createInitialStoryState({
    gameLength: "short",
    initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 },
  });
}

describe("deriveObjectiveTransition（Task 4）", () => {
  it("authoritative 目标 = 当前幕第一个 active 主线任务的首个未完成目标", () => {
    const ws = withQuest(baseWorld(), quest([{ kind: "talk_to_npc", npcId: NPC_1_ID }]));
    expect(currentObjectiveOf(ws, story())).toEqual({
      questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈",
    });
  });

  it("无 active 任务时返回 null", () => {
    expect(currentObjectiveOf(baseWorld(), story())).toBeNull();
  });

  it("当前幕无主线时回退到第一个 active 任务", () => {
    const ws = withQuest(baseWorld(), quest([{ kind: "visit_location", locationId: LOC_1_ID }], { stage: 5 }));
    expect(currentObjectiveOf(ws, story())).toEqual({
      questId: asQuestId("quest_0"), objectiveIndex: 0, label: "前往客栈",
    });
  });

  it("unchanged：目标未变、无完成、无幕推进 → mode unchanged 且 before===after", () => {
    const ws = withQuest(baseWorld(), quest([{ kind: "talk_to_npc", npcId: NPC_1_ID }]));
    const ss = story();
    const t = deriveObjectiveTransition({
      beforeWorldState: ws, beforeStoryState: ss, afterWorldState: ws, afterStoryState: ss,
    });
    expect(t).toEqual({
      before: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" },
      completed: [],
      after: { questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" },
      mode: "unchanged",
    });
  });

  it("progressed：完成一个目标但当前幕未推进", () => {
    const before = withQuest(baseWorld(), quest([
      { kind: "talk_to_npc", npcId: NPC_1_ID },
      { kind: "obtain_item", itemId: ITEM_SEAL_ID },
    ]));
    const after = withMet(before);
    const ss = story();
    const t = deriveObjectiveTransition({
      beforeWorldState: before, beforeStoryState: ss, afterWorldState: after, afterStoryState: ss,
    });
    expect(t.completed).toEqual([{ questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" }]);
    expect(t.after).toEqual({ questId: asQuestId("quest_0"), objectiveIndex: 1, label: "获取盟誓印谱" });
    expect(t.mode).toBe("progressed");
  });

  it("advanced_act：completed 记录旧目标，after 为新具象化的下一幕任务目标", () => {
    const before = withQuest(baseWorld(), quest([{ kind: "talk_to_npc", npcId: NPC_1_ID }]));
    const afterWorld = withNextAct(before);
    const ssBefore = story();
    const ssAfter = { ...ssBefore, currentAct: 2 };
    const t = deriveObjectiveTransition({
      beforeWorldState: before, beforeStoryState: ssBefore,
      afterWorldState: afterWorld, afterStoryState: ssAfter,
    });
    expect(t.before).toEqual({ questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" });
    expect(t.completed).toEqual([{ questId: asQuestId("quest_0"), objectiveIndex: 0, label: "与老板交谈" }]);
    expect(t.after).toEqual({ questId: asQuestId("quest_dyn_1"), objectiveIndex: 0, label: "与信使交谈" });
    expect(t.mode).toBe("advanced_act");
  });

  it("ready_for_ending：endingAllowed 或 evolution.status === needs_ending_pair", () => {
    const ws = withQuest(baseWorld(), quest([{ kind: "talk_to_npc", npcId: NPC_1_ID }]));
    const ssEnd = { ...story(), endingAllowed: true };
    expect(deriveObjectiveTransition({
      beforeWorldState: ws, beforeStoryState: ssEnd, afterWorldState: ws, afterStoryState: ssEnd,
    }).mode).toBe("ready_for_ending");

    const ssPair = { ...story(), evolution: { ...story().evolution, status: "needs_ending_pair" as const } };
    expect(deriveObjectiveTransition({
      beforeWorldState: ws, beforeStoryState: ssPair, afterWorldState: ws, afterStoryState: ssPair,
    }).mode).toBe("ready_for_ending");
  });

  it("lookup 未命中实体时标签安全降级（不炸、不含未知实体名）", () => {
    const ws = withQuest(baseWorld(), quest([{ kind: "obtain_item", itemId: asQuestId("missing_x") as never }]));
    expect(currentObjectiveOf(ws, story())?.label).toBe("获取某物");
  });
});
