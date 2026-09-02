import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { createDeterministicEvolutionSource, TRUST_ENDING_MIN_AFFINITY, DOUBT_ENDING_MAX_AFFINITY } from "./deterministicEvolutionSource";
import type { LocationEntry, NpcEntry, WorldState } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asQuestId, asGenerationId, type GenerationMetadata } from "@/game/domain/worldEntity";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import {
  createWorldStateFixtureWith,
  type WorldStateFixtureOverrides,
} from "@/game/domain/testing/worldStateFixture.testutil";

const LOC_0 = asLocationId("loc_0");
const NPC_0 = asNpcId("npc_0");
const NPC_1 = asNpcId("npc_1");

const innLocation: LocationEntry = {
  id: LOC_0, name: "听雨客栈", description: "山脚小镇的客栈。", kind: "main",
  connectedLocationIds: [], npcIds: [NPC_0], availableItemIds: [], tags: [],
};

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia",
};

function shopkeeper(affinity: number): NpcEntry {
  return {
    id: NPC_0, name: "韩征", role: "掌柜", description: "听雨客栈的掌柜。",
    locationId: LOC_0, isCompanion: false, tags: [], met: true,
    memory: {
      npcId: NPC_0, knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
      relationship: { affinity }, emotion: "neutral", goals: [],
    },
  };
}

const BASE_PROJECTION: EntityCompatibilityProjection = {
  player: { name: "林惊羽", identity: "外门弟子", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [innLocation],
  currentLocationId: LOC_0,
  unlockedLocationIds: [LOC_0],
  visitedLocationIds: [LOC_0],
  npcs: [shopkeeper(0)],
  items: [],
  inventory: [],
  worldFacts: [],
  quests: [],
  enemies: [],
  defeatedEnemyIds: [],
  factions: [],
};

function makeWorldWithNpc(affinity: number, overrides: WorldStateFixtureOverrides = {}): WorldState {
  return createWorldStateFixtureWith(
    { generation: GENERATION, base: BASE_PROJECTION },
    { npcs: [shopkeeper(affinity)], ...overrides },
  );
}

describe("createDeterministicEvolutionSource ending_pair", () => {
  it("produces a requirement-bearing ending pair keyed to the final main-quest talk npc", async () => {
    const source = createDeterministicEvolutionSource();
    // 终幕主线的交谈目标必须在场：任务目标引用只能解析到真实实体。
    // 断言仍然要求锚点取自目标 npc_9，而不是首位 NPC npc_0。
    const finalTalkNpc: NpcEntry = {
      id: asNpcId("npc_9"), name: "旧友", role: "证人", description: "终幕要交谈的人。",
      locationId: LOC_0, isCompanion: false, tags: [], met: true,
      memory: {
        npcId: asNpcId("npc_9"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
        relationship: { affinity: 0 }, emotion: "neutral", goals: [],
      },
    };
    const ws = makeWorldWithNpc(0, {
      locations: [{ ...innLocation, npcIds: [NPC_0, finalTalkNpc.id] }],
      npcs: [shopkeeper(0), finalTalkNpc],
      quests: [{
        id: asQuestId("quest_final"), name: "终局", description: "d",
        objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_9") }],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 9, status: "active",
      }],
    });
    const ss = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 } });
    const result = await source.propose({ worldState: ws, storyState: ss, need: { kind: "ending_pair", finalAct: 3 }, reason: "test" });
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal).not.toBeNull();
    const pair = result.proposal!.endingPair;
    expect(pair).toHaveLength(2);
    const [trust, doubt] = pair!;

    expect(trust.themeKey).toBe("trust");
    expect(trust.requirements).toEqual([{ kind: "npc_affinity_at_least", npcId: asNpcId("npc_9"), value: TRUST_ENDING_MIN_AFFINITY }]);

    expect(doubt.themeKey).toBe("doubt");
    expect(doubt.requirements).toEqual([{ kind: "npc_affinity_at_most", npcId: asNpcId("npc_9"), value: DOUBT_ENDING_MAX_AFFINITY }]);

    // 两条要求阈值相邻且互斥：任何亲和度恰好命中其一（离线必有一个方向可达）。
    expect(DOUBT_ENDING_MAX_AFFINITY).toBe(TRUST_ENDING_MIN_AFFINITY - 1);
    expect(trust.description).toContain("已核对的证据");
    expect(doubt.description).toContain("责任归属");
  });

  it("the affinity threshold splits a trust-leaning vs doubt-leaning play", async () => {
    const source = createDeterministicEvolutionSource();
    const ss = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 } });

    const warm = await source.propose({ worldState: makeWorldWithNpc(20), storyState: ss, need: { kind: "ending_pair", finalAct: 3 }, reason: "warm" });
    const cold = await source.propose({ worldState: makeWorldWithNpc(-20), storyState: ss, need: { kind: "ending_pair", finalAct: 3 }, reason: "cold" });

    if (!warm.ok || !cold.ok) throw new Error("expected success");
    const warmTrust = warm.proposal!.endingPair![0]!.requirements![0]!;
    const coldDoubt = cold.proposal!.endingPair![1]!.requirements![0]!;
    // 亲暖互动（高亲和度）应满足信任要求；敌意互动（低亲和度）应满足质疑要求。
    expect(warmTrust.kind).toBe("npc_affinity_at_least");
    expect(coldDoubt.kind).toBe("npc_affinity_at_most");
    if (warmTrust.kind === "npc_affinity_at_least") expect(20).toBeGreaterThanOrEqual(warmTrust.value);
    if (coldDoubt.kind === "npc_affinity_at_most") expect(-20).toBeLessThanOrEqual(coldDoubt.value);
  });

  it("keeps scripted later-act NPCs and quests unique when their names already exist", async () => {
    const source = createDeterministicEvolutionSource();
    // 克隆出的既有 NPC 的 memory 由投影器按 core.id 重建，npcId 对齐只为可读；
    // store 侧的归属不变量现在是关系边自指禁令（relationships 不得指向自身）。
    const existingNpc: NpcEntry = {
      ...shopkeeper(0),
      id: NPC_1,
      name: "苏绾",
      memory: { ...shopkeeper(0).memory, npcId: NPC_1 },
    };
    const ws = makeWorldWithNpc(0, {
      locations: [{ ...innLocation, npcIds: [NPC_0, NPC_1] }],
      npcs: [shopkeeper(0), existingNpc],
      quests: [{
        id: asQuestId("quest_dyn_1"), name: "追问断碑谷", description: "上一幕。", objectives: [],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" }, tags: ["dynamic"],
        kind: "main", stage: 2, status: "completed",
      }],
    });
    const ss = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 2, quests: 2, events: 0 } });

    const result = await source.propose({ worldState: ws, storyState: ss, need: { kind: "next_act", act: 3 }, reason: "test" });
    if (!result.ok) throw new Error("expected success");

    expect(result.proposal?.newNpc?.name).toBe("苏绾·3");
    expect(result.proposal?.nextMainQuest?.name).toBe("追问断碑谷·第3幕");
    expect(result.proposal?.nextMainQuest?.objectiveText).toBe("与苏绾·3交谈");
  });

  it("seeds a later act with an item and enemy for the complete playable loop", async () => {
    const source = createDeterministicEvolutionSource();
    const result = await source.propose({
      worldState: makeWorldWithNpc(0),
      storyState: createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "medium", initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 } }),
      need: { kind: "next_act", act: 2 },
      reason: "medium-playtest",
    });
    if (!result.ok) throw new Error("expected success");

    expect(result.proposal?.newItem).toMatchObject({
      name: "染血腰牌",
      locationRef: "new_location",
    });
    expect(result.proposal?.newEnemy).toMatchObject({
      name: "黑衣追兵",
      tier: "normal",
      locationRef: "new_location",
    });
  });

  it("把带新地点的幕拍人物与物品、敌人放在同一条主线地点上", async () => {
    const source = createDeterministicEvolutionSource();
    const storyState = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(),
      gameLength: "medium",
      initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 },
    });
    const result = await source.propose({
      worldState: makeWorldWithNpc(0),
      storyState,
      need: { kind: "next_act", act: 3 },
      reason: "medium-story-coherence",
    });
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal?.newLocation?.name).toBe("断碑谷");
    expect(result.proposal?.newNpc?.locationRef).toEqual({ kind: "new_location" });
    expect(result.proposal?.newItem?.locationRef).toBe("new_location");
    expect(result.proposal?.newEnemy?.locationRef).toBe("new_location");
    expect(result.proposal?.nextMainQuest?.description).toContain("前往断碑谷");
  });
});
