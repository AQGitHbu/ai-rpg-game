import { describe, it, expect } from "vitest";
import { compileWorldGenerationCandidate } from "./compileWorldGenerationCandidate";
import type { WorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import { asGenerationId, asLocationId, asNpcId, asFactId, asQuestId, asEndingId } from "@/game/domain/worldEntity";
import { findNpc, findQuest } from "@/game/domain/worldState";

// ---------------------------------------------------------------------------
// Task 14：编译候选为 World/Story State 的确定性契约。
// ---------------------------------------------------------------------------

function fixture(): WorldGenerationCandidate {
  return {
    world: {
      summary: "江湖世界",
      tone: "沧桑",
      themes: ["复仇"],
      publicFacts: [{ id: "fact_guild", text: "城中有镖局。" }],
      hiddenFacts: [{ id: "fact_sword", text: "祖传宝剑在客栈地下。" }],
      tags: ["武侠"],
    },
    player: {
      name: "陆小凤", identity: "游侠", backgroundSummary: "行走江湖",
      startingLocationId: "loc_inn", startingItemIds: ["item_sword"],
      baseStats: { hp: 100, attack: 12, defense: 6 },
    },
    startAnchor: { locationId: "loc_inn", npcId: "npc_innkeeper", startQuestId: "quest_main", mainThreadId: "thread_main" },
    locations: [
      { id: "loc_inn", name: "客栈", description: "客栈", kind: "main", connectedLocationIds: ["loc_street"], npcIds: ["npc_innkeeper"], availableItemIds: ["item_sword"], tags: [] },
      { id: "loc_street", name: "街道", description: "街道", kind: "main", connectedLocationIds: ["loc_inn"], npcIds: [], availableItemIds: [], tags: [] },
    ],
    npcs: [
      { id: "npc_innkeeper", name: "老板", role: "线索人", description: "知道消息", locationId: "loc_inn", isCompanion: false, knownFactIds: ["fact_guild"], hiddenFactIds: ["fact_sword"], goals: ["打听镖队"], tags: [] },
    ],
    items: [{ id: "item_sword", name: "宝剑", description: "锋利的剑", kind: "weapon", tags: [] }],
    enemies: [],
    factions: [{ factionId: "faction_guild", name: "镖局", attitudeToPlayer: 0 }],
    quests: [
      { id: "quest_main", name: "寻剑", description: "找回宝剑", kind: "main", stage: 1, objectives: [{ kind: "talk_to_npc", npcId: "npc_innkeeper" }], onSuccess: { kind: "reach_ending", endingId: "ending_hero" }, onFailure: { kind: "closed" }, tags: ["main"] },
      { id: "quest_side", name: "帮镖局", description: "帮忙", kind: "side", objectives: [{ kind: "visit_location", locationId: "loc_street" }], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: ["side"] },
    ],
    endings: [
      { id: "ending_hero", name: "英雄", description: "归来", requirements: [{ kind: "quest_completed", questId: "quest_main" }, { kind: "npc_affinity_at_least", npcId: "npc_innkeeper", value: 10 }] },
      { id: "ending_wanderer", name: "归隐", description: "归隐山林", requirements: [{ kind: "fact_discovered", factId: "fact_sword" }] },
    ],
    openingBudget: { locationsCount: 2, npcsCount: 1, sideQuestsCount: 1, endingsCount: 2, townLocationsCount: 0 },
  };
}

function generation(seed = "s1") {
  return {
    generationId: asGenerationId(`gen_${seed}`),
    seed,
    templateVersion: "v2" as const,
    inputDigest: "",
    gameType: "wuxia" as const,
  };
}

describe("compileWorldGenerationCandidate", () => {
  it("candidate 定义与 runtime 正确进入单一 World State", () => {
    const { worldState } = compileWorldGenerationCandidate({
      candidate: fixture(),
      generation: generation(),
      gameType: "wuxia",
      gameLength: "medium",
    });
    expect(worldState.locations).toHaveLength(2);
    expect(worldState.npcs).toHaveLength(1);
    expect(worldState.items).toHaveLength(1);
    expect(worldState.quests).toHaveLength(2);
    expect(worldState.endings).toHaveLength(2);
    expect(worldState.factions).toHaveLength(1);
    expect(worldState.worldFacts).toHaveLength(2);
  });

  it("starting/unlocked/visited 集合正确：只有起始地点", () => {
    const { worldState } = compileWorldGenerationCandidate({
      candidate: fixture(), generation: generation(), gameType: "wuxia", gameLength: "medium",
    });
    expect(worldState.currentLocationId).toBe(asLocationId("loc_inn"));
    expect(worldState.unlockedLocationIds).toEqual([asLocationId("loc_inn")]);
    expect(worldState.visitedLocationIds).toEqual([asLocationId("loc_inn")]);
  });

  it("NPC memory 初始知识与 goals 正确", () => {
    const { worldState } = compileWorldGenerationCandidate({
      candidate: fixture(), generation: generation(), gameType: "wuxia", gameLength: "medium",
    });
    const npc = findNpc(worldState, asNpcId("npc_innkeeper"));
    expect(npc?.memory.knownFactIds).toEqual([asFact("fact_guild")]);
    expect(npc?.memory.hiddenFactIds).toEqual([asFact("fact_sword")]);
    expect(npc?.memory.goals).toEqual(["打听镖队"]);
    expect(npc?.met).toBe(false);
  });

  it("main thread、targetActs、budget opening、tension 初值正确", () => {
    const { storyState } = compileWorldGenerationCandidate({
      candidate: fixture(), generation: generation(), gameType: "wuxia", gameLength: "medium",
    });
    expect(storyState.unresolvedThreads).toContain("thread_main");
    expect(storyState.targetActs).toBe(5); // medium 预算
    expect(storyState.tension).toBe(30);
    expect(storyState.currentAct).toBe(1);
  });

  it("第一幕 main quest active，其余任务按图 locked", () => {
    const { worldState } = compileWorldGenerationCandidate({
      candidate: fixture(), generation: generation(), gameType: "wuxia", gameLength: "medium",
    });
    const main = findQuest(worldState, asQuest("quest_main"));
    const side = findQuest(worldState, asQuest("quest_side"));
    expect(main?.status).toBe("active");
    expect(side?.status).toBe("active"); // 独立 side quest 初始可接
  });

  it("两个结局 requirements 保留", () => {
    const { worldState } = compileWorldGenerationCandidate({
      candidate: fixture(), generation: generation(), gameType: "wuxia", gameLength: "medium",
    });
    const hero = worldState.endings.find((e) => e.id === asEnding("ending_hero"));
    const wanderer = worldState.endings.find((e) => e.id === asEnding("ending_wanderer"));
    expect(hero?.requirements).toEqual([
      { kind: "quest_completed", questId: asQuest("quest_main") },
      { kind: "npc_affinity_at_least", npcId: asNpcId("npc_innkeeper"), value: 10 },
    ]);
    expect(wanderer?.requirements).toEqual([{ kind: "fact_discovered", factId: asFact("fact_sword") }]);
  });

  it("相同 candidate 编译结果完全相同（确定性、无时间/随机）", () => {
    const opts = { candidate: fixture(), generation: generation("fixed"), gameType: "wuxia" as const, gameLength: "medium" as const };
    const a = compileWorldGenerationCandidate(opts);
    const b = compileWorldGenerationCandidate(opts);
    expect(JSON.stringify(a.worldState)).toBe(JSON.stringify(b.worldState));
    expect(JSON.stringify(a.storyState)).toBe(JSON.stringify(b.storyState));
  });

  it("generation metadata 由调用方显式传入", () => {
    const { worldState } = compileWorldGenerationCandidate({
      candidate: fixture(), generation: generation("custom_seed"), gameType: "wuxia", gameLength: "medium",
    });
    expect(worldState.generation.seed).toBe("custom_seed");
    expect(worldState.generation.generationId).toBe(asGenerationId("gen_custom_seed"));
  });
});

function asFact(id: string) { return asFactId(id); }
function asQuest(id: string) { return asQuestId(id); }
function asEnding(id: string) { return asEndingId(id); }
