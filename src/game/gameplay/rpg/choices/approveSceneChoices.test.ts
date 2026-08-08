import { describe, expect, it } from "vitest";
import { approveSceneChoices } from "./approveSceneChoices";
import type { ChoiceProposal, ApprovedChoice } from "@/game/domain/approvedChoice";
import { deriveChoiceToken } from "@/game/domain/approvedChoice";
import {
  createInitialWorldState,
  appendLocation,
  appendNpc,
  appendEnemy,
  appendItem,
  type LocationEntry,
  type NpcEntry,
  type EnemyEntry,
  type ItemEntry,
  type WorldState,
} from "@/game/domain/worldState";
import { asEnemyId, asGenerationId, asItemId, asLocationId, asNpcId } from "@/game/domain/scenarioBlueprint";
import type { Action } from "@/game/domain/action";

// ---------------------------------------------------------------------------
// Fixture：雾谷村(loc_1) 有铁匠(在场)与灰狼(在场)，街道(loc_2) 连通且解锁，
// 客栈后巷(loc_3) 连通但锁定；井边钥匙在 loc_1 可拾取。
// ---------------------------------------------------------------------------

const loc1: LocationEntry = {
  id: asLocationId("loc_1"), name: "雾谷村", description: "d", kind: "main",
  connectedLocationIds: [asLocationId("loc_2"), asLocationId("loc_3")],
  npcIds: [], availableItemIds: [asItemId("item_well_key")], tags: [],
};
const loc2: LocationEntry = {
  id: asLocationId("loc_2"), name: "街道", description: "d", kind: "main",
  connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
};
const loc3: LocationEntry = {
  id: asLocationId("loc_3"), name: "客栈后巷", description: "d", kind: "main",
  connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
};
const smith: NpcEntry = {
  id: asNpcId("npc_smith"), name: "铁匠老王", role: "铁匠", description: "d",
  locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
  memory: {
    npcId: asNpcId("npc_smith"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
    relationship: { affinity: 0 }, emotion: "neutral", goals: [],
  },
};
const absentNpc: NpcEntry = {
  id: asNpcId("npc_lost_maiden"), name: "迷路少女", role: "村民", description: "d",
  locationId: asLocationId("loc_3"), isCompanion: false, tags: [], met: false,
  memory: {
    npcId: asNpcId("npc_lost_maiden"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
    relationship: { affinity: 0 }, emotion: "neutral", goals: [],
  },
};
const wolf: EnemyEntry = {
  id: asEnemyId("enemy_wolf"), name: "灰狼", tier: "normal",
  stats: { hp: 30, attack: 8, defense: 2 }, locationId: asLocationId("loc_1"), tags: [],
};
const farEnemy: EnemyEntry = {
  id: asEnemyId("enemy_troll"), name: "山岭巨魔", tier: "normal",
  stats: { hp: 80, attack: 15, defense: 5 }, locationId: asLocationId("loc_3"), tags: [],
};
const wellKey: ItemEntry = {
  id: asItemId("item_well_key"), name: "井边钥匙", description: "d", kind: "key", tags: [],
};

function buildWorld(): WorldState {
  let ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  ws = appendLocation(ws, loc2);
  ws = appendLocation(ws, loc3);
  ws = appendNpc(ws, smith);
  ws = appendNpc(ws, absentNpc);
  ws = appendItem(ws, wellKey);
  ws = appendEnemy(ws, wolf);
  ws = appendEnemy(ws, farEnemy);
  return {
    ...ws,
    unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")],
  };
}

const talkSmith: Action = { type: "talk", npcId: asNpcId("npc_smith"), dialogueAct: "ask" };
const talkMaiden: Action = { type: "talk", npcId: asNpcId("npc_lost_maiden"), dialogueAct: "ask" };
const moveStreet: Action = { type: "move", locationId: asLocationId("loc_2") };
const moveAlley: Action = { type: "move", locationId: asLocationId("loc_3") };
const attackWolf: Action = { type: "attack", enemyId: asEnemyId("enemy_wolf") };
const attackTroll: Action = { type: "attack", enemyId: asEnemyId("enemy_troll") };
const takeKey: Action = { type: "take_item", itemId: asItemId("item_well_key") };
const explore: Action = { type: "explore" };
const rest: Action = { type: "rest" };

const CANDIDATES: readonly Action[] = [
  talkSmith, moveStreet, attackWolf, takeKey, explore, rest,
];

const CTX = { sceneId: "scene-abc", basedOnRevision: 7 };

describe("approveSceneChoices", () => {
  it("合法 talk（在场 NPC + 候选 + label 含目标名）被批准并逐字段绑定", () => {
    const result = approveSceneChoices({
      ...CTX,
      proposals: [{ label: "向铁匠老王打听消息", action: talkSmith }],
      legalActionCandidates: CANDIDATES,
      worldState: buildWorld(),
    });

    expect(result.approved).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    const choice = result.approved[0];
    expect(choice.sceneId).toBe("scene-abc");
    expect(choice.basedOnRevision).toBe(7);
    expect(choice.label).toBe("向铁匠老王打听消息");
    expect(choice.action).toEqual(talkSmith);
    expect(choice.semanticSummary).toBe("talk:npc_smith:ask");
    expect(choice.choiceToken).toBe(deriveChoiceToken({ ...CTX, action: talkSmith }));
  });

  it("批准对象逐字段重建，不返回提案原引用", () => {
    const proposal: ChoiceProposal = { label: "向铁匠老王打听消息", action: talkSmith };
    const result = approveSceneChoices({
      ...CTX,
      proposals: [proposal],
      legalActionCandidates: CANDIDATES,
      worldState: buildWorld(),
    });
    expect(result.approved[0].action).not.toBe(proposal.action);
    expect(result.approved[0]).not.toBe(proposal as unknown as ApprovedChoice);
  });

  it("两个语义重复选择：首个批准，重复的被拒绝", () => {
    const result = approveSceneChoices({
      ...CTX,
      proposals: [
        { label: "向铁匠老王打听消息", action: talkSmith },
        { label: "铁匠老王有什么线索吗", action: talkSmith },
      ],
      legalActionCandidates: CANDIDATES,
      worldState: buildWorld(),
    });
    expect(result.approved).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("semantic_duplicate");
    expect(result.rejected[0].label).toBe("铁匠老王有什么线索吗");
  });

  it("label 与 action 明显不一致被拒绝（label 不含目标名）", () => {
    const result = approveSceneChoices({
      ...CTX,
      proposals: [
        { label: "去客栈后巷歇脚", action: moveStreet },
        { label: "救下迷路少女", action: explore },
      ],
      legalActionCandidates: CANDIDATES,
      worldState: buildWorld(),
    });
    expect(result.approved).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["mismatched_label", "mismatched_label"]);
  });

  it("不在场/不可达目标被拒绝", () => {
    const result = approveSceneChoices({
      ...CTX,
      proposals: [
        { label: "与迷路少女交谈", action: talkMaiden },
        { label: "前往客栈后巷", action: moveAlley },
        { label: "攻击山岭巨魔", action: attackTroll },
      ],
      legalActionCandidates: [...CANDIDATES, talkMaiden, moveAlley, attackTroll],
      worldState: buildWorld(),
    });
    expect(result.approved).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "unreachable_target", "unreachable_target", "unreachable_target",
    ]);
  });

  it("不在合法候选集合的 action 被拒绝", () => {
    const result = approveSceneChoices({
      ...CTX,
      proposals: [{ label: "与铁匠老王交谈", action: talkSmith }],
      legalActionCandidates: [explore, rest],
      worldState: buildWorld(),
    });
    expect(result.approved).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("illegal_action");
  });

  it("空白 label 被拒绝", () => {
    const result = approveSceneChoices({
      ...CTX,
      proposals: [{ label: "  ", action: explore }],
      legalActionCandidates: CANDIDATES,
      worldState: buildWorld(),
    });
    expect(result.approved).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("invalid_label");
  });

  it("混合批次：合法项批准，非法项逐条拒绝", () => {
    const result = approveSceneChoices({
      ...CTX,
      proposals: [
        { label: "前往街道", action: moveStreet },
        { label: "取走井边钥匙", action: takeKey },
        { label: "探索周围", action: explore },
        { label: "前往客栈后巷", action: moveAlley },
        { label: "与迷路少女交谈", action: talkMaiden },
        { label: "休息", action: rest },
      ],
      legalActionCandidates: [...CANDIDATES, moveAlley, talkMaiden],
      worldState: buildWorld(),
    });
    expect(result.approved.map((c) => c.semanticSummary)).toEqual([
      "move:loc_2", "take_item:item_well_key", "explore", "rest",
    ]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "unreachable_target", "unreachable_target",
    ]);
  });

  it("批准结果经 JSON 往返后仍可解析相同 Action（registry 持久化）", () => {
    const result = approveSceneChoices({
      ...CTX,
      proposals: [{ label: "攻击灰狼", action: attackWolf }],
      legalActionCandidates: CANDIDATES,
      worldState: buildWorld(),
    });
    const revived = JSON.parse(JSON.stringify(result.approved)) as readonly ApprovedChoice[];
    expect(revived[0].action).toEqual(attackWolf);
    expect(revived[0].choiceToken).toBe(deriveChoiceToken({ ...CTX, action: attackWolf }));
  });
});