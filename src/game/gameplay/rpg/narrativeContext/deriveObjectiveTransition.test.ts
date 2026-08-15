import { describe, expect, it } from "vitest";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asQuestId } from "@/game/domain/worldEntity";
import {
  baseWorld, quest, withQuest, withMet, LOC_1_ID, NPC_1_ID, NPC_2_ID, ITEM_SEAL_ID, ENEMY_WOLF_ID, withNextAct,
  makeNpc, withAddedNpc,
} from "./narrativeContext.testutil";
import { deriveObjectiveTransition, currentObjectiveOf } from "./deriveObjectiveTransition";
import { objectiveLabel } from "./objectiveRules";
import { asLocationId } from "@/game/domain/worldEntity";

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

  it("目标 NPC 不在当前地点时，交谈目标不再吞掉独立的前往步骤", () => {
    const initial = baseWorld();
    const ws = withQuest(withAddedNpc({
      ...initial,
      locations: [...initial.locations, {
        id: asLocationId("loc_2"), name: "断碑谷", description: "荒碑夹着一线山谷。", kind: "main",
        connectedLocationIds: [LOC_1_ID], npcIds: [NPC_2_ID], availableItemIds: [], tags: [],
      }],
    }, { ...makeNpc(NPC_2_ID, "苏绾", "失踪镖队幸存者"), locationId: asLocationId("loc_2") }),
      quest([{ kind: "talk_to_npc", npcId: NPC_2_ID }]));
    expect(objectiveLabel(ws, ws.quests[0]?.objectives[0])).toBe("与苏绾交谈");
    expect(currentObjectiveOf(ws, story())?.label).toBe("与苏绾交谈");
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

  it("物品已拾取后即使交给 NPC，当前目标也不会退回获取该物品", () => {
    const before = withQuest(baseWorld(), quest([
      { kind: "talk_to_npc", npcId: NPC_1_ID },
      { kind: "obtain_item", itemId: ITEM_SEAL_ID },
      { kind: "defeat_enemy", enemyId: ENEMY_WOLF_ID },
    ]));
    const after = withMet({
      ...before,
      eventLedger: [{
        type: "item_obtained",
        itemId: ITEM_SEAL_ID,
        locationId: LOC_1_ID,
        occurredAt: "2026-01-01",
      }],
    });
    expect(currentObjectiveOf(after, story())?.label).toBe("击败野狼");
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
