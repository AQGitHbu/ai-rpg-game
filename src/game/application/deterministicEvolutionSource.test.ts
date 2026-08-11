import { describe, it, expect } from "vitest";
import { createDeterministicEvolutionSource, TRUST_ENDING_MIN_AFFINITY, DOUBT_ENDING_MAX_AFFINITY } from "./deterministicEvolutionSource";
import { createInitialWorldState, type NpcEntry, type WorldState } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/worldEntity";

function makeWorldWithNpc(affinity: number): WorldState {
  const base = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "林惊羽", identity: "外门弟子", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_0"), name: "听雨客栈", description: "山脚小镇的客栈。", kind: "main",
      connectedLocationIds: [], npcIds: [asNpcId("npc_0")], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
  const npc: NpcEntry = {
    id: asNpcId("npc_0"), name: "韩征", role: "掌柜", description: "听雨客栈的掌柜。",
    locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: true,
    memory: {
      npcId: asNpcId("npc_0"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
      relationship: { affinity }, emotion: "neutral", goals: [],
    },
  };
  return { ...base, npcs: [npc] };
}

describe("createDeterministicEvolutionSource ending_pair", () => {
  it("produces a requirement-bearing ending pair keyed to the first NPC's affinity", async () => {
    const source = createDeterministicEvolutionSource();
    const ws = makeWorldWithNpc(0);
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 } });
    const result = await source.propose({ worldState: ws, storyState: ss, need: { kind: "ending_pair", finalAct: 3 }, reason: "test" });
    expect(result.proposal).not.toBeNull();
    const pair = result.proposal!.endingPair;
    expect(pair).toHaveLength(2);
    const [trust, doubt] = pair!;

    expect(trust.themeKey).toBe("trust");
    expect(trust.requirements).toEqual([{ kind: "npc_affinity_at_least", npcId: asNpcId("npc_0"), value: TRUST_ENDING_MIN_AFFINITY }]);

    expect(doubt.themeKey).toBe("doubt");
    expect(doubt.requirements).toEqual([{ kind: "npc_affinity_at_most", npcId: asNpcId("npc_0"), value: DOUBT_ENDING_MAX_AFFINITY }]);

    // 两条要求阈值相邻且互斥：任何亲和度恰好命中其一（离线必有一个方向可达）。
    expect(DOUBT_ENDING_MAX_AFFINITY).toBe(TRUST_ENDING_MIN_AFFINITY - 1);
  });

  it("the affinity threshold splits a trust-leaning vs doubt-leaning play", async () => {
    const source = createDeterministicEvolutionSource();
    const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 } });

    const warm = await source.propose({ worldState: makeWorldWithNpc(20), storyState: ss, need: { kind: "ending_pair", finalAct: 3 }, reason: "warm" });
    const cold = await source.propose({ worldState: makeWorldWithNpc(-20), storyState: ss, need: { kind: "ending_pair", finalAct: 3 }, reason: "cold" });

    const warmTrust = warm.proposal!.endingPair![0]!.requirements![0]!;
    const coldDoubt = cold.proposal!.endingPair![1]!.requirements![0]!;
    // 亲暖互动（高亲和度）应满足信任要求；敌意互动（低亲和度）应满足质疑要求。
    expect(warmTrust.kind).toBe("npc_affinity_at_least");
    expect(coldDoubt.kind).toBe("npc_affinity_at_most");
    if (warmTrust.kind === "npc_affinity_at_least") expect(20).toBeGreaterThanOrEqual(warmTrust.value);
    if (coldDoubt.kind === "npc_affinity_at_most") expect(-20).toBeLessThanOrEqual(coldDoubt.value);
  });
});
