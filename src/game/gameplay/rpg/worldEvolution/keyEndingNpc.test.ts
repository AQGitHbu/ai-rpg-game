import { describe, expect, it } from "vitest";
import { asNpcId, asQuestId, asLocationId, asGenerationId } from "@/game/domain/worldEntity";
import { createInitialWorldState, type WorldState } from "@/game/domain/worldState";
import type { QuestEntry } from "@/game/domain/worldState";
import { deriveKeyEndingNpcId } from "./keyEndingNpc";

function baseWorld(npcIds: readonly string[], quests: readonly QuestEntry[] = []): WorldState {
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_0"), name: "客栈", description: "一间客栈", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [], scale: "scene",
    },
    startingItemIds: [],
  });
  return {
    ...ws,
    quests: [...quests],
    npcs: npcIds.map((id) => ({
      id: asNpcId(id), name: `人物${id}`, role: "路人", description: "d",
      locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId(id), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    })),
  };
}

const QUEST_TALK_N9: QuestEntry = {
  id: asQuestId("q_final"), name: "终幕", description: "d",
  objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_9") }],
  onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
  tags: [], kind: "main", stage: 5, status: "active",
};

describe("deriveKeyEndingNpcId", () => {
  it("优先取 stage 最大的主线任务的 talk_to_npc 目标", () => {
    const earlierTalk: QuestEntry = {
      id: asQuestId("q_mid"), name: "中幕", description: "d",
      objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_2") }],
      onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
      tags: [], kind: "main", stage: 3, status: "closed",
    };
    const ws = baseWorld(["npc_0", "npc_9"], [earlierTalk, QUEST_TALK_N9]);
    expect(String(deriveKeyEndingNpcId(ws))).toBe("npc_9");
  });

  it("stage 并列时优先 active 任务（失败重铸的同 stage 旧任务不抢占锚点）", () => {
    const failedTalk: QuestEntry = {
      id: asQuestId("q_failed"), name: "失败幕", description: "d",
      objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_3") }],
      onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
      tags: [], kind: "main", stage: 5, status: "failed",
    };
    const remintedTalk: QuestEntry = {
      id: asQuestId("q_reminted"), name: "重铸幕", description: "d",
      objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_8") }],
      onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
      tags: [], kind: "main", stage: 5, status: "active",
    };
    // 数组序旧任务在前，tie-break 后 active 任务胜出。
    const ws = baseWorld(["npc_0", "npc_3", "npc_8"], [failedTalk, remintedTalk]);
    expect(String(deriveKeyEndingNpcId(ws))).toBe("npc_8");
  });

  it("主线任务没有交谈目标时回退到开局首位 NPC（与旧行为一致）", () => {
    const noTalk: QuestEntry = {
      id: asQuestId("q_no_talk"), name: "无交谈", description: "d",
      objectives: [{ kind: "obtain_item", itemId: "item_1" as never }],
      onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
      tags: [], kind: "main", stage: 5, status: "active",
    };
    const ws = baseWorld(["npc_0", "npc_9"], [noTalk]);
    expect(String(deriveKeyEndingNpcId(ws))).toBe("npc_0");
  });

  it("无主线任务与 NPC 时返回 undefined", () => {
    const ws = baseWorld([]);
    expect(deriveKeyEndingNpcId(ws)).toBeUndefined();
  });
});
