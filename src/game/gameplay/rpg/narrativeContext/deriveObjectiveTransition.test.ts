import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import type { CommittedNarrativeEvent, NarrativeEventPayload } from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { describe, expect, it } from "vitest";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asQuestId } from "@/game/domain/worldEntity";
import {
  baseWorld, quest, withQuest, withMet, withInventoryItem, LOC_1_ID, LOC_2_ID, NPC_1_ID, NPC_2_ID, ITEM_SEAL_ID, ENEMY_WOLF_ID, withNextAct,
  makeNpc, withAddedNpc, withEntityProjection,
} from "./narrativeContext.testutil";
import type { LocationEntry, WorldState } from "@/game/domain/worldState";
import { deriveObjectiveTransition, currentObjectiveOf } from "./deriveObjectiveTransition";
import { objectiveLabel } from "./objectiveRules";
import { asItemId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { isObjectiveSatisfied } from "./objectiveRules";

function story() {
  return createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 },
  });
}

describe("deriveObjectiveTransition（Task 4）", () => {
  it("带 completionConditions 的交谈目标不被普通 met 或对白计数越过", () => {
    const objective = {
      kind: "talk_to_npc" as const,
      npcId: NPC_1_ID,
      completionConditions: [{ kind: "has_item" as const, itemId: ITEM_SEAL_ID, ownerId: PLAYER_ENTITY_ID }],
    };
    expect(isObjectiveSatisfied(withMet(baseWorld()), objective)).toBe(false);
    expect(isObjectiveSatisfied(withMet(withInventoryItem(baseWorld())), objective)).toBe(true);
  });

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
    // 断碑谷就是起始投影里的 loc_2：改写同一条地点条目，而不是再追加一个同 id 地点；
    // 名册与 npc.locationId 必须同批出现，否则投影校验判定 membership mismatch。
    const valley: LocationEntry = {
      id: LOC_2_ID, name: "断碑谷", description: "荒碑夹着一线山谷。", kind: "main",
      connectedLocationIds: [LOC_1_ID], npcIds: [NPC_2_ID], availableItemIds: [], tags: [],
    };
    const ws = withQuest(withEntityProjection(initial, {
      locations: initial.locations.map((loc) => (loc.id === LOC_2_ID ? valley : loc)),
      npcs: [...initial.npcs, { ...makeNpc(NPC_2_ID, "苏绾", "失踪镖队幸存者"), locationId: LOC_2_ID }],
    }), quest([{ kind: "talk_to_npc", npcId: NPC_2_ID }]));
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

  it("两轮对话第一轮只记录 met，不得把 talk_to_npc 目标判定为完成", () => {
    const before = withQuest(baseWorld(), quest([
      { kind: "talk_to_npc", npcId: NPC_1_ID },
      { kind: "obtain_item", itemId: ITEM_SEAL_ID },
    ]));
    const after = withMet(before);
    const beforeStory = story();
    const afterStory = {
      ...beforeStory,
      narrative: {
        ...beforeStory.narrative,
        dialogueSession: {
          npcId: NPC_1_ID,
          turnCount: 1,
          requiredTurns: 2,
          completed: false,
        },
      },
    };

    const t = deriveObjectiveTransition({
      beforeWorldState: before,
      beforeStoryState: beforeStory,
      afterWorldState: after,
      afterStoryState: afterStory,
    });

    expect(t.completed).toEqual([]);
    expect(t.after).toEqual({
      questId: asQuestId("quest_0"),
      objectiveIndex: 0,
      label: "与老板交谈",
    });
    expect(t.mode).toBe("unchanged");
  });

  it("目标 NPC 的 ask 只建立 turnCount=0 会话，不得被 met 提前判定完成", () => {
    const before = withQuest(baseWorld(), quest([{ kind: "talk_to_npc", npcId: NPC_1_ID }]));
    const after = withMet(before);
    const beforeStory = story();
    const afterStory = {
      ...beforeStory,
      narrative: {
        ...beforeStory.narrative,
        dialogueSession: {
          npcId: NPC_1_ID,
          turnCount: 0,
          requiredTurns: 2,
          completed: false,
        },
      },
    };

    const transition = deriveObjectiveTransition({
      beforeWorldState: before,
      beforeStoryState: beforeStory,
      afterWorldState: after,
      afterStoryState: afterStory,
    });

    expect(transition.completed).toEqual([]);
    expect(transition.after?.label).toBe("与老板交谈");
    expect(transition.mode).toBe("unchanged");
  });

  it("旧 NPC 的已完成会话不能让新 NPC 的 met 标记跳过两轮对白", () => {
    const before = withQuest(
      withAddedNpc(baseWorld(), makeNpc(NPC_2_ID, "信使", "传信人")),
      quest([{ kind: "talk_to_npc", npcId: NPC_2_ID }]),
    );
    const beforeStory = {
      ...story(),
      narrative: {
        ...story().narrative,
        dialogueSession: {
          npcId: NPC_1_ID,
          turnCount: 2,
          requiredTurns: 2,
          completed: true,
        },
      },
    };
    const after = withMet(before, NPC_2_ID);
    const t = deriveObjectiveTransition({
      beforeWorldState: before,
      beforeStoryState: beforeStory,
      afterWorldState: after,
      afterStoryState: beforeStory,
    });

    expect(t.completed).toEqual([]);
    expect(t.after?.label).toBe("与信使交谈");
    expect(t.mode).toBe("unchanged");
  });

  it("物品已拾取后即使交给 NPC，当前目标也不会退回获取该物品", () => {
    const before = withQuest(baseWorld(), quest([
      { kind: "talk_to_npc", npcId: NPC_1_ID },
      { kind: "obtain_item", itemId: ITEM_SEAL_ID },
      { kind: "defeat_enemy", enemyId: ENEMY_WOLF_ID },
    ]));
    const after = withMet({
      ...before,
      eventLedger: [makeCommittedEvent({ type: "item_obtained", itemId: ITEM_SEAL_ID, locationId: LOC_1_ID } as unknown as NarrativeEventPayload, { committedAt: "2026-01-01" })],
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
    // corruption case：目标指向未具象化的物品已经无法合法构造
    // （unknown_quest_objective_ref 在组装期即拒），只能深拷贝 helper 返回值后篡改兼容投影，
    // 复现旧存档里悬空的 obtain_item 目标。
    const legal = withQuest(baseWorld(), quest([{ kind: "obtain_item", itemId: ITEM_SEAL_ID }]));
    const corrupted: WorldState = structuredClone({
      ...legal,
      quests: legal.quests.map((entry) => ({
        ...entry,
        objectives: [{ kind: "obtain_item" as const, itemId: asItemId("missing_x") }],
      })),
    });
    expect(currentObjectiveOf(corrupted, story())?.label).toBe("获取某物");
  });
});
