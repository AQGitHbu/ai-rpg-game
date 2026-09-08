import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect, vi } from "vitest";
import {
  parseWorldDeltaProposal,
  filterProposalRefs,
  createLiveWorldEvolutionSource,
  buildWorldEvolutionPrompt,
  LIVE_WORLD_EVOLUTION_MAX_TOKENS,
  LIVE_WORLD_EVOLUTION_TIMEOUT_MS,
} from "./liveWorldEvolutionSource";
import { createInitialWorldState } from "@/game/domain/worldState";
import { projectEntityStore, type EntityCompatibilityProjection } from "@/game/domain/entity";
import { asFactId, asLocationId, asGenerationId, asNpcId, asQuestId } from "@/game/domain/worldEntity";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { AiTransport } from "@ai-game/ai-transport";
import type { WorldState } from "@/game/domain/worldState";
import type { EvolutionNeed } from "@/game/domain/worldDelta";
import type { WorldEvolutionSourceContext } from "../../worldEvolutionSource";
import { bindNpcToTownSlot, createTownRuntime } from "@/game/gameplay/rpg/town";
import { createWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";

function makeWorld(): WorldState {
  return createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_a"), name: "客栈", description: "t", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
}

function withProjection(base: WorldState, overrides: Partial<EntityCompatibilityProjection>): WorldState {
  return createWorldStateFixture({
    generation: base.generation,
    projection: { ...projectEntityStore(base.entityStore), ...overrides },
    battle: base.battle,
    endings: base.endings,
    ending: base.ending,
    eventLedger: base.eventLedger,
  });
}

const NPC_CREATION = {
  anchors: {
    selfConcept: "守信的传讯人",
    values: ["守信"],
    speechStyle: "谨慎而直接",
    capabilityBoundaries: ["不超出自身所知"],
    taboos: [],
  },
  goals: [{ horizon: "short", description: "送达密信", priority: 3, reason: "必须完成传递" }],
  relationshipSeeds: [],
};

const pacingNeed: EvolutionNeed = { kind: "pacing", pacingNeed: "complicate" };

describe("parseWorldDeltaProposal", () => {
  it.each(["scene", "npc_gift"])("preserves structured item acquisition %s", (acquisition) => {
    const parsed = parseWorldDeltaProposal({
      beatSummary: "一件证物等待交接",
      newItem: { name: "铜令牌", description: "刻着印记的令牌。", locationRef: "current", acquisition },
    });
    expect(parsed?.proposal.newItem).toEqual({ name: "铜令牌", description: "刻着印记的令牌。", locationRef: "current", acquisition });
  });

  it.each(["automatic", "take_item", null, { kind: "npc_gift" }])("rejects unknown item acquisition %j", (acquisition) => {
    expect(parseWorldDeltaProposal({
      beatSummary: "非法获取方式",
      newItem: { name: "铜令牌", description: "刻着印记的令牌。", locationRef: "current", acquisition },
    })).toBeNull();
  });

  it("keeps older scene items without acquisition and never infers a gift from prose", () => {
    const parsed = parseWorldDeltaProposal({
      beatSummary: "老人说送给你一枚令牌",
      newItem: { name: "铜令牌", description: "老人说送给你的令牌。", locationRef: "current" },
    });
    expect(parsed?.proposal.newItem).toEqual({ name: "铜令牌", description: "老人说送给你的令牌。", locationRef: "current" });
  });

  it.each(["giftFromNpcId", "owner"])("rejects provider-authored possession authority %s", (field) => {
    expect(parseWorldDeltaProposal({
      beatSummary: "未经批准的物品转移",
      newItem: { name: "铜令牌", description: "一枚令牌。", locationRef: "current", acquisition: "npc_gift", [field]: "npc_1" },
    })).toBeNull();
  });

  it("parses a valid npc repair proposal", () => {
    const parsed = parseWorldDeltaProposal({
      beatSummary: "补给一名在场人物",
      newNpc: {
        ...NPC_CREATION,
        name: "新来客", role: "过客", description: "路过的旅人。",
        locationRef: { kind: "existing", id: "loc_a" },
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.proposal.newNpc?.name).toBe("新来客");
    expect(parsed?.proposal.newNpc?.locationRef).toEqual({ kind: "existing", id: "loc_a" });
  });

  it("accepts a dynamic NPC with an explicitly empty relationshipSeeds array", () => {
    const parsed = parseWorldDeltaProposal({
      beatSummary: "补充一名暂未与他人建立关系的信使",
      newNpc: {
        ...NPC_CREATION,
        name: "新来客", role: "过客", description: "路过的旅人。",
        locationRef: { kind: "existing", id: "loc_a" },
        relationshipSeeds: [],
      },
    });
    expect(parsed?.proposal.newNpc?.relationshipSeeds).toEqual([]);
  });

  it("rejects a world-delta NPC that omits relationshipSeeds", () => {
    const { relationshipSeeds: _omitted, ...legacyCreation } = NPC_CREATION;
    expect(parseWorldDeltaProposal({
      beatSummary: "缺少关系种子的 NPC",
      newNpc: {
        ...legacyCreation,
        name: "新来客", role: "过客", description: "路过的旅人。",
        locationRef: { kind: "existing", id: "loc_a" },
      },
    })).toBeNull();
  });

  it("parses bounded directed relationship seeds and fails closed for AI-owned fields", () => {
    const parsed = parseWorldDeltaProposal({
      beatSummary: "补充一名与掌柜有旧交的信使",
      newNpc: {
        ...NPC_CREATION,
        name: "新来客", role: "过客", description: "路过的旅人。",
        locationRef: { kind: "existing", id: "loc_a" },
        relationshipSeeds: [{ targetNpcId: "npc_0", stance: "ally", reason: "曾共同守护一封密信" }],
      },
    });
    expect(parsed?.proposal.newNpc?.relationshipSeeds).toEqual([
      { targetNpcId: "npc_0", stance: "ally", reason: "曾共同守护一封密信" },
    ]);

    const invalidSeeds = [
      [{ targetNpcId: "npc_0", stance: "unknown", reason: "不应接受" }],
      [{ targetNpcId: "npc_0", stance: "ally", reason: "" }],
      [{ targetNpcId: "npc_0", stance: "ally", reason: "有效", stage: "trusted" }],
      [{ targetNpcId: "npc_0", stance: "ally", reason: "有效", affinity: 90 }],
      [{ targetNpcId: "npc_0", stance: "ally", reason: "有效", evidence: [] }],
      [{ targetNpcId: "npc_0", stance: "ally", reason: "有效", actionId: "action_1" }],
      [{ targetNpcId: "npc_0", stance: "ally", reason: "有效", extra: true }],
      [
        { targetNpcId: "npc_0", stance: "ally", reason: "重复" },
        { targetNpcId: "npc_0", stance: "rival", reason: "重复" },
      ],
    ];
    for (const relationshipSeeds of invalidSeeds) {
      expect(parseWorldDeltaProposal({
        beatSummary: "非法关系种子",
        newNpc: {
          ...NPC_CREATION,
          name: "新来客", role: "过客", description: "路过的旅人。",
          locationRef: { kind: "existing", id: "loc_a" },
          relationshipSeeds,
        },
      })).toBeNull();
    }
  });

  it("rejects unknown world-delta keys instead of silently dropping them", () => {
    expect(parseWorldDeltaProposal({
      beatSummary: "带有未知字段的提案",
      newNpc: {
        ...NPC_CREATION,
        name: "新来客", role: "过客", description: "路过的旅人。",
        locationRef: { kind: "existing", id: "loc_a" },
      },
      serverOnly: true,
    })).toBeNull();
    expect(parseWorldDeltaProposal({
      beatSummary: "带有未知地点字段的提案",
      newLocation: {
        name: "新地点", description: "一处新的地点。", scale: "scene", placement: "world",
        connectFromLocationId: "loc_a", serverOnly: true,
      },
    })).toBeNull();
    expect(parseWorldDeltaProposal({
      beatSummary: "带有未知事实字段的提案",
      newFact: { text: "一条新事实。", visibility: "public", provenance: "provider" },
    })).toBeNull();
  });

  it("rejects unknown keys in locationRef and investigation approaches", () => {
    expect(parseWorldDeltaProposal({
      beatSummary: "地点引用带未知字段",
      newNpc: {
        ...NPC_CREATION,
        name: "新来客", role: "过客", description: "路过的旅人。",
        locationRef: { kind: "existing", id: "loc_a", extra: true },
      },
    })).toBeNull();

    expect(parseWorldDeltaProposal({
      beatSummary: "调查方式带未知字段",
      newFact: {
        text: "井沿留有新鲜绳痕。",
        visibility: "public",
        investigationApproaches: [
          { approachId: "inspect", label: "检查井沿", evidenceQuality: "clean", tensionDelta: 1, extra: true },
          { approachId: "ask", label: "询问路人", evidenceQuality: "noisy", tensionDelta: 0 },
        ],
      },
    })).toBeNull();
  });

  it("drops proposals with illegal name length or missing fields", () => {
    expect(parseWorldDeltaProposal({ beatSummary: "", newNpc: null })).toBeNull();
    expect(parseWorldDeltaProposal({
      beatSummary: "坏名字",
      newNpc: { name: "X", role: "过客", description: "太短的名字。", locationRef: { kind: "existing", id: "loc_a" }, goals: [] },
    })).toBeNull();
    expect(parseWorldDeltaProposal({ beatSummary: "空实体", newLocation: null, newNpc: null, newItem: null, newEnemy: null, newFact: null, nextMainQuest: null, endingPair: null })).toBeNull();
  });

  it("requires an explicit placement for generated locations", () => {
    expect(parseWorldDeltaProposal({
      beatSummary: "缺少空间归属",
      newLocation: { name: "青山别院", description: "独立别院。", scale: "scene", connectFromLocationId: "loc_a" },
    })).toBeNull();
    const townBuilding = parseWorldDeltaProposal({
      beatSummary: "城镇内部场所",
      newLocation: {
        name: "青石镇茶馆", description: "临街茶馆。", scale: "scene", placement: "town_building",
        connectFromLocationId: "loc_a",
      },
      newNpc: {
        ...NPC_CREATION,
        name: "茶馆线人", role: "传讯人", description: "等候交信的线人。",
        locationRef: { kind: "new_location" },
      },
    });
    expect(townBuilding?.proposal.newLocation?.placement).toBe("town_building");
  });

  it("validates an ending pair shape but allows trust/doubt", () => {
    const parsed = parseWorldDeltaProposal({
      beatSummary: "终幕结局对",
      endingPair: [
        { name: "共担真相", description: "公开一切。", themeKey: "trust" },
        { name: "独自揭露", description: "独自承担。", themeKey: "doubt" },
      ],
    });
    expect(parsed?.proposal.endingPair).toHaveLength(2);
  });

  it("解析新事实的 investigationApproaches 并原样保留合法条目", () => {
    const parsed = parseWorldDeltaProposal({
      beatSummary: "调查线索",
      newFact: {
        text: "密道入口在井下。",
        visibility: "public",
        investigationApproaches: [
          { approachId: "a", label: "检查井沿", evidenceQuality: "clean", tensionDelta: 2 },
          { approachId: "b", label: "细听井底动静", evidenceQuality: "noisy", tensionDelta: 4 },
        ],
      },
    });
    expect(parsed?.proposal.newFact?.investigationApproaches).toEqual([
      { approachId: "a", label: "检查井沿", evidenceQuality: "clean", tensionDelta: 2 },
      { approachId: "b", label: "细听井底动静", evidenceQuality: "noisy", tensionDelta: 4 },
    ]);
    expect(parsed?.logCategories).toEqual([]);
  });

  it("允许调查方式复用事实中的地点或 NPC 关键词", () => {
    const parsed = parseWorldDeltaProposal({
      beatSummary: "追查黑剑客去向",
      newFact: {
        text: "赵四爷私下告诉沈青崖，黑剑客从醉月楼后门离开，往枯井坊方向去了。",
        visibility: "npc_private",
        investigationApproaches: [
          { approachId: "tail_zhao", label: "尾随赵四爷", hint: "观察赵四爷是否再次前往枯井坊。", evidenceQuality: "clean", tensionDelta: 5 },
          { approachId: "search_tavern", label: "搜查醉月楼", hint: "检查黑剑客曾经落脚的房间。", evidenceQuality: "noisy", tensionDelta: 3 },
        ],
      },
    });

    expect(parsed?.proposal.newFact?.investigationApproaches).toEqual([
      { approachId: "tail_zhao", label: "尾随赵四爷", hint: "观察赵四爷是否再次前往枯井坊。", evidenceQuality: "clean", tensionDelta: 5 },
      { approachId: "search_tavern", label: "搜查醉月楼", hint: "检查黑剑客曾经落脚的房间。", evidenceQuality: "noisy", tensionDelta: 3 },
    ]);
  });

  it("investigationApproaches 非数组时拒绝整条世界提案", () => {
    const parsed = parseWorldDeltaProposal({
      beatSummary: "调查线索",
      newFact: { text: "密道入口在井下。", visibility: "public", investigationApproaches: "nope" },
    });
    expect(parsed).toBeNull();
  });

  it("任一调查方式条目非法时拒绝整条世界提案，不保留部分响应", () => {
    const parsed = parseWorldDeltaProposal({
      beatSummary: "调查线索",
      newFact: {
        text: "密道入口在井下。",
        visibility: "public",
        investigationApproaches: [
          { approachId: "a", label: "检查井沿", evidenceQuality: "clean", tensionDelta: 2 },
          { approachId: "b", label: "细听井底动静", evidenceQuality: "noisy", tensionDelta: 4 },
          { approachId: "c", label: "询问井边挑水人", evidenceQuality: "clean", tensionDelta: -3 },
          { approachId: "a", label: "重复 id", evidenceQuality: "noisy", tensionDelta: 4 },
          { approachId: "d", label: "", evidenceQuality: "clean", tensionDelta: 2 },
          { approachId: "e", label: "非枚举质量", evidenceQuality: "mixed", tensionDelta: 2 },
          { approachId: "f", label: "越界张力", evidenceQuality: "noisy", tensionDelta: 40 },
        ],
      },
    });
    expect(parsed).toBeNull();
  });

  it("合法数量不足或超过 3 时拒绝整条世界提案", () => {
    for (const approaches of [
      [{ approachId: "a", label: "检查井沿", evidenceQuality: "clean", tensionDelta: 2 }],
      [
        { approachId: "a", label: "检查井沿", evidenceQuality: "clean", tensionDelta: 2 },
        { approachId: "b", label: "细听井底动静", evidenceQuality: "noisy", tensionDelta: 4 },
        { approachId: "c", label: "询问井边挑水人", evidenceQuality: "clean", tensionDelta: -3 },
        { approachId: "d", label: "翻看井台砖缝", evidenceQuality: "noisy", tensionDelta: 5 },
      ],
    ]) {
      const parsed = parseWorldDeltaProposal({
        beatSummary: "调查线索",
        newFact: { text: "密道入口在井下。", visibility: "public", investigationApproaches: approaches },
      });
      expect(parsed).toBeNull();
    }
  });

  it("完整事实正文泄漏时拒绝整条世界提案", () => {
    const parsed = parseWorldDeltaProposal({
      beatSummary: "调查线索",
      newFact: {
        text: "密道入口在井下。",
        visibility: "public",
        investigationApproaches: [
          { approachId: "a", label: "密道入口在井下。", evidenceQuality: "clean", tensionDelta: 2 },
          { approachId: "b", label: "密道外的杂声", hint: "顺着密道方向", evidenceQuality: "noisy", tensionDelta: 4 },
          { approachId: "c", label: "检查井沿", evidenceQuality: "clean", tensionDelta: 2 },
        ],
      },
    }, "wuxia");
    expect(parsed).toBeNull();
  });
});

describe("filterProposalRefs", () => {
  it("rejects connectFromLocationId or existing npc refs not in the world", () => {
    const ws = makeWorld();
    const loc = parseWorldDeltaProposal({
      beatSummary: "新地点",
      newLocation: { name: "青山别院", description: "独立别院。", scale: "scene", placement: "world", connectFromLocationId: "loc_missing" },
    })!.proposal;
    expect(filterProposalRefs(loc, ws)).toBeNull();

    const npc = parseWorldDeltaProposal({
      beatSummary: "新人物",
      newNpc: { ...NPC_CREATION, name: "新来客", role: "过客", description: "路过的旅人。", locationRef: { kind: "existing", id: "loc_missing" } },
    })!.proposal;
    expect(filterProposalRefs(npc, ws)).toBeNull();
  });

  it("keeps proposals whose refs exist", () => {
    const ws = makeWorld();
    const proposal = parseWorldDeltaProposal({
      beatSummary: "新人物",
      newNpc: { ...NPC_CREATION, name: "新来客", role: "过客", description: "路过的旅人。", locationRef: { kind: "existing", id: "loc_a" } },
    })!.proposal;
    expect(filterProposalRefs(proposal, ws)).not.toBeNull();
  });

  it("drops a duplicate newNpc declaration while retaining the AI-proposed next-act content", () => {
    const ws = {
      ...makeWorld(),
      npcs: [{ name: "韩征" } as WorldState["npcs"][number]],
    };
    const proposal = parseWorldDeltaProposal({
      beatSummary: "旧角色指出了新的去处",
      newLocation: { name: "潮痕深处", description: "裂隙尽头的能量空腔。", scale: "scene", placement: "world", connectFromLocationId: "loc_a" },
      newNpc: { ...NPC_CREATION, name: "韩征", role: "掌柜", description: "已经在客栈中的掌柜。", locationRef: { kind: "existing", id: "loc_a" } },
      nextMainQuest: { name: "进入潮痕深处", description: "沿着裂隙深入。", objectiveText: "前往潮痕深处。" },
    })!.proposal;

    const filtered = filterProposalRefs(proposal, ws);
    expect(filtered).not.toBeNull();
    expect(filtered?.newLocation?.name).toBe("潮痕深处");
    expect(filtered?.nextMainQuest?.name).toBe("进入潮痕深处");
    expect(filtered?.newNpc).toBeNull();
  });

  it("drops optional event expansions when the shared events budget is exhausted", () => {
    const story = createInitialStoryState({
      initialNarrative: createFixtureNarrativeRuntimeState(),
      gameLength: "short",
      initialEntityCounts: { locations: 1, npcs: 0, quests: 1, events: 0 },
    });
    const exhaustedStory = {
      ...story,
      budget: {
        ...story.budget,
        events: { ...story.budget.events, expanded: story.budget.events.max },
      },
    };
    const proposal = parseWorldDeltaProposal({
      beatSummary: "通往新地点的路在眼前展开",
      newLocation: { name: "潮痕深处", description: "裂隙尽头的能量空腔。", scale: "scene", placement: "world", connectFromLocationId: "loc_a" },
      newItem: { name: "多余的符石", description: "已经没有事件预算承载的符石。", locationRef: "new_location" },
      newFact: { text: "已经没有事件预算承载的新事实。", visibility: "public" },
      nextMainQuest: { name: "进入潮痕深处", description: "沿着裂隙深入。", objectiveText: "前往潮痕深处。" },
    })!.proposal;

    const filtered = filterProposalRefs(proposal, makeWorld(), exhaustedStory);
    expect(filtered?.newLocation?.name).toBe("潮痕深处");
    expect(filtered?.nextMainQuest?.name).toBe("进入潮痕深处");
    expect(filtered?.newItem).toBeNull();
    expect(filtered?.newFact).toBeNull();
  });
});

describe("createLiveWorldEvolutionSource", () => {
  it("reserves enough completion budget for provider reasoning and evolution JSON", () => {
    expect(LIVE_WORLD_EVOLUTION_MAX_TOKENS).toBeGreaterThanOrEqual(3_200);
    expect(LIVE_WORLD_EVOLUTION_TIMEOUT_MS).toBe(45_000);
  });

  it("明确区分下一幕与终幕结局对字段，避免模型重复输出非法 endingPair", async () => {
    let prompt = "";
    const aiClient = {
      complete: vi.fn(async (_role: "world", messages: readonly { readonly role: string; readonly content: string }[]) => {
        prompt = messages[0]?.content ?? "";
        return { ok: false as const, code: "empty_response" as const, retryable: false, latencyMs: 1 };
      }),
      policy: () => ({
        thinking: "off" as const,
        timeoutMs: 45_000,
        maxTokens: 3_200,
        jsonMode: "prompt_only" as const,
        maxAttempts: 1,
      }),
    };
    const source = createLiveWorldEvolutionSource({ aiClient });
    const ctx: WorldEvolutionSourceContext = {
      worldState: makeWorld(),
      storyState: createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: { kind: "next_act", act: 2 },
      reason: "scene_evolution",
    };

    await source.propose(ctx);

    expect(prompt).toContain("本次是下一幕需求");
    expect(prompt).toContain("禁止输出 endingPair");
    expect(prompt).toContain("endingPair 字段必须完全省略");
    expect(prompt).toContain("placement");
    expect(prompt).toContain("label/hint 可以引用事实中的地点、人物或线索关键词");
    expect(prompt).not.toContain("终局={");
  });

  it("returns a typed failure without a transport", async () => {
    const source = createLiveWorldEvolutionSource({});
    const ctx: WorldEvolutionSourceContext = {
      worldState: makeWorld(),
      storyState: createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: pacingNeed,
      action: { type: "move", locationId: asLocationId("loc_b") },
      reason: "UNKNOWN_LOCATION",
    };
    const result = await source.propose(ctx);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.kind).toBe("AI_CALL_FAILED");
  });

  it("returns AI_RESPONSE_INVALID when the AI output is invalid JSON", async () => {
    const transport: AiTransport = {
      complete: async () => ({ ok: true as const, content: "not json", latencyMs: 1 }),
      stream: async () => ({ ok: false as const, code: "network_error" as const, retryable: true, message: "unused", latencyMs: 1 }),
    };
    const source = createLiveWorldEvolutionSource({
      transport,
      config: { apiKey: "k", baseUrl: "http://x", model: "m" },
    });
    const ctx: WorldEvolutionSourceContext = {
      worldState: makeWorld(),
      storyState: createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: pacingNeed,
      action: { type: "talk", npcId: asNpcId("npc_new"), dialogueAct: "ask" },
      reason: "UNKNOWN_NPC",
    };
    const result = await source.propose(ctx);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.kind).toBe("AI_RESPONSE_INVALID");
  });

  it("accepts fenced JSON and records normalization", async () => {
    const logger = { warn: vi.fn() };
    const transport: AiTransport = {
      complete: async () => ({
        ok: true as const,
        content: "```json\n{\"proposal\":{\"beatSummary\":\"补足线索\",\"newFact\":{\"text\":\"井沿留有新鲜绳痕。\",\"visibility\":\"public\"}}}\n```",
        latencyMs: 1,
      }),
      stream: async () => ({ ok: false as const, code: "network_error" as const, retryable: true, message: "unused", latencyMs: 1 }),
    };
    const source = createLiveWorldEvolutionSource({
      transport,
      config: { apiKey: "k", baseUrl: "http://x", model: "m" },
      logger: logger as never,
    });
    const ctx: WorldEvolutionSourceContext = {
      worldState: makeWorld(),
      storyState: createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: pacingNeed,
      action: { type: "talk", npcId: asNpcId("npc_new"), dialogueAct: "ask" },
      reason: "UNKNOWN_NPC",
    };

    const result = await source.propose(ctx);
    expect(result.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith("world_evolution_json_fence_normalized");
  });

  it("uses JSON object mode when explicitly enabled", async () => {
    const complete = vi.fn(async () => ({ ok: false as const, code: "empty_response" as const, retryable: false, latencyMs: 1 }));
    const transport: AiTransport = {
      complete,
      stream: async () => ({ ok: false as const, code: "network_error" as const, retryable: true, message: "unused", latencyMs: 1 }),
    };
    const source = createLiveWorldEvolutionSource({
      transport,
      config: { apiKey: "k", baseUrl: "http://x", model: "m" },
      jsonMode: "json_object",
    });
    const ctx: WorldEvolutionSourceContext = {
      worldState: makeWorld(),
      storyState: createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: pacingNeed,
      action: { type: "talk", npcId: asNpcId("npc_new"), dialogueAct: "ask" },
      reason: "UNKNOWN_NPC",
    };

    await source.propose(ctx);

    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({ extraBody: expect.objectContaining({ response_format: { type: "json_object" } }) }),
    );
  });

  it("does not repeat an empty AI response and returns a typed failure", async () => {
    let attempts = 0;
    const transport: AiTransport = {
      complete: vi.fn(async () => {
        attempts += 1;
        return { ok: false as const, code: "empty_response" as const, retryable: false, latencyMs: 1 };
      }),
      stream: async () => ({ ok: false as const, code: "network_error" as const, retryable: true, message: "unused", latencyMs: 1 }),
    };
    const source = createLiveWorldEvolutionSource({
      transport,
      config: { apiKey: "k", baseUrl: "http://x", model: "m" },
    });
    const ctx: WorldEvolutionSourceContext = {
      worldState: makeWorld(),
      storyState: createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: pacingNeed,
      action: { type: "talk", npcId: asNpcId("npc_new"), dialogueAct: "ask" },
      reason: "UNKNOWN_NPC",
    };

    const result = await source.propose(ctx);

    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.kind).toBe("AI_CALL_FAILED");
  });

  it("成功生成合法世界演化提案时只调用一次 AI complete", async () => {
    const complete = vi.fn(async () => ({
      ok: true as const,
      content: JSON.stringify({
        proposal: {
          beatSummary: "补足一条调查线索",
          newFact: { text: "井沿留有新鲜绳痕。", visibility: "public" },
        },
      }),
      latencyMs: 1,
    }));
    const aiClient = {
      complete,
      policy: () => ({
        thinking: "off" as const,
        timeoutMs: 45_000,
        maxTokens: 3_200,
        jsonMode: "prompt_only" as const,
        maxAttempts: 1,
      }),
    };
    const source = createLiveWorldEvolutionSource({ aiClient });

    const result = await source.propose({
      worldState: makeWorld(),
      storyState: createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: { kind: "pacing", pacingNeed: "complicate" },
      reason: "scene_evolution",
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.proposal).toEqual({
      beatSummary: "补足一条调查线索",
      newLocation: null,
      newNpc: null,
      newItem: null,
      newEnemy: null,
      newFact: { text: "井沿留有新鲜绳痕。", visibility: "public" },
      nextMainQuest: null,
      endingPair: null,
    });
  });

  it("accepts a no-seed dynamic NPC through the live source", async () => {
    let prompt = "";
    const complete = vi.fn(async (_role: "world", messages: readonly { readonly content?: string }[]) => {
      prompt = messages[0]?.content ?? "";
      return {
        ok: true as const,
        content: JSON.stringify({
          proposal: {
            beatSummary: "补充一名暂未与他人建立关系的信使",
            newNpc: {
              ...NPC_CREATION,
              name: "新来客", role: "过客", description: "路过的旅人。",
              locationRef: { kind: "existing", id: "loc_a" },
              relationshipSeeds: [],
            },
          },
        }),
        latencyMs: 1,
      };
    });
    const source = createLiveWorldEvolutionSource({
      aiClient: {
        complete,
        policy: () => ({ thinking: "off" as const, timeoutMs: 45_000, maxTokens: 3_200, jsonMode: "prompt_only" as const, maxAttempts: 1 }),
      },
    });

    const result = await source.propose({
      worldState: makeWorld(),
      storyState: createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: pacingNeed,
      reason: "scene_evolution",
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.proposal !== null) expect(result.proposal.newNpc?.relationshipSeeds).toEqual([]);
    expect(prompt).toContain("relationshipSeeds 必须出现");
    expect(prompt).toContain("无关系时必须输出 []");
  });

  it("rejects an unknown proposal wrapper key before parsing the world delta", async () => {
    const complete = vi.fn(async () => ({
      ok: true as const,
      content: JSON.stringify({
        proposal: {
          beatSummary: "补足一条调查线索",
          newFact: { text: "井沿留有新鲜绳痕。", visibility: "public" },
        },
        extra: true,
      }),
      latencyMs: 1,
    }));
    const source = createLiveWorldEvolutionSource({
      aiClient: {
        complete,
        policy: () => ({ thinking: "off" as const, timeoutMs: 45_000, maxTokens: 3_200, jsonMode: "prompt_only" as const, maxAttempts: 1 }),
      },
    });
    const result = await source.propose({
      worldState: makeWorld(),
      storyState: createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: pacingNeed,
      reason: "scene_evolution",
    });
    expect(result).toMatchObject({ ok: false, repairReason: "invalid_schema" });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("world source 内容修复契约", () => {
  function makeCtx(overrides?: Partial<WorldEvolutionSourceContext>): WorldEvolutionSourceContext {
    return {
      worldState: makeWorld(),
      storyState: createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: pacingNeed,
      reason: "scene_evolution",
      ...overrides,
    };
  }

  /** 只带 source 需要的 complete/policy 的最小 live client mock，捕获第 3 个审计参数。 */
  function makeClient(body: string) {
    const complete = vi.fn(async (_role: "world", _messages: readonly unknown[], _ctx?: unknown) =>
      ({ ok: true as const, content: body, latencyMs: 1 }));
    const policy = () => ({
      thinking: "off" as const, timeoutMs: 45_000, maxTokens: 3_200,
      jsonMode: "prompt_only" as const, maxAttempts: 3,
    });
    return { complete, policy };
  }

  it("passes the exact compiled narrative manifest to AI text audit without private text", async () => {
    const secretFactId = asFactId("fact_secret");
    const base = makeCtx();
    const ctx: WorldEvolutionSourceContext = {
      ...base,
      worldState: withProjection(base.worldState, {
        worldFacts: [{
          factId: secretFactId,
          text: "私密正文",
          source: "generated",
          discovered: false,
        }],
      }),
    };
    const ai = makeClient("not json");

    await createLiveWorldEvolutionSource({ aiClient: ai }).propose(ctx);

    const auditContext = ai.complete.mock.calls[0]?.[2] as { readonly narrativeContext?: unknown };
    expect(auditContext.narrativeContext).toEqual(expect.objectContaining({
      compilerVersion: 1,
      maxEstimatedTokens: 8_000,
      selectedEstimatedTokens: expect.any(Number),
      overflowEstimatedTokens: expect.any(Number),
      selected: expect.arrayContaining([
        expect.objectContaining({ id: "world:rules" }),
        expect.objectContaining({ id: "world:output-contract" }),
      ]),
      dropped: expect.any(Array),
    }));
    expect(JSON.stringify(auditContext.narrativeContext)).not.toContain("私密正文");
    expect(JSON.stringify(auditContext.narrativeContext)).not.toContain("fact_secret");
  });

  it("buildWorldEvolutionPrompt keeps the complete compiled world contract", () => {
    const base = makeCtx({ need: { kind: "next_act", act: 2 } });
    const prompt = buildWorldEvolutionPrompt({
      ...base,
      worldState: withProjection(base.worldState, {
        quests: [{
          id: asQuestId("quest_1"),
          name: "追查失踪商队",
          description: "确认商队最后的落脚处。",
          objectives: [],
          onSuccess: { kind: "advance_story" },
          onFailure: { kind: "closed" },
          tags: [],
          kind: "main",
          stage: 1,
          status: "active",
        }],
      }),
      storyState: {
        ...base.storyState,
        nextPacingNeed: "complicate",
        memory: rebuildEpisodicMemory([
          makeCommittedEvent({ type: "npc_met", npcId: asNpcId("npc_1") }, {
            turnNumber: 1,
            locationId: asLocationId("loc_a"),
            targetIds: [asNpcId("npc_1")],
          }),
        ]),
        contract: { ...base.storyState.contract, centralConflict: "商队失踪牵出内应" },
      },
    });

    expect(prompt).toContain("中心冲突=商队失踪牵出内应");
    expect(prompt).toContain("nextPacingNeed=complicate");
    expect(prompt).toContain("npc_met");
    expect(prompt).toContain("追查失踪商队");
    for (const field of ["newItem", "newEnemy", "newFact"]) expect(prompt).toContain(field);
    expect(prompt).not.toContain("eventLedger");
    expect(prompt).not.toContain("hiddenFactIds");
    expect(prompt).not.toContain("interactionHistory");
  });

  it("非法 JSON：单次 propose 只调用 complete 一次，并返回 invalid_json 修复原因", async () => {
    const ai = makeClient("not json");
    const source = createLiveWorldEvolutionSource({ aiClient: ai });
    const result = await source.propose(makeCtx(
      { contentRepair: { attempt: 1, reason: "invalid_json" } },
    ));
    expect(ai.complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, repairReason: "invalid_json" });
    if (!result.ok) expect(result.failure.kind).toBe("AI_RESPONSE_INVALID");
  });

  it("非法 schema：解析失败只调用 complete 一次，返回 invalid_schema 修复原因", async () => {
    const ai = makeClient(JSON.stringify({ proposal: { beatSummary: "" } }));
    const source = createLiveWorldEvolutionSource({ aiClient: ai });
    const result = await source.propose(makeCtx(
      { contentRepair: { attempt: 1, reason: "invalid_schema" } },
    ));
    expect(ai.complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, repairReason: "invalid_schema" });
  });

  it("非法引用：引用越权只调用 complete 一次，返回 invalid_reference 修复原因", async () => {
    const ai = makeClient(JSON.stringify({
      proposal: {
        beatSummary: "新地点",
        newLocation: { name: "青山别院", description: "独立别院。", scale: "scene", placement: "world", connectFromLocationId: "loc_missing" },
      },
    }));
    const source = createLiveWorldEvolutionSource({ aiClient: ai });
    const result = await source.propose(makeCtx(
      { contentRepair: { attempt: 1, reason: "invalid_reference" } },
    ));
    expect(ai.complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, repairReason: "invalid_reference" });
  });

  it("修复 prompt 明确只修复上一轮稳定原因，并把 contentRepair 写入审计 retry", async () => {
    const ai = makeClient("not json");
    const source = createLiveWorldEvolutionSource({ aiClient: ai });
    let prompt = "";
    ai.complete.mockImplementation(async (_role: "world", messages: readonly unknown[], _ctx?: unknown) => {
      prompt = (messages[0] as { readonly content?: string } | undefined)?.content ?? "";
      return { ok: true as const, content: "not json", latencyMs: 1 };
    });
    await source.propose(makeCtx(
      { auditLink: { traceId: "t1" }, contentRepair: { attempt: 1, reason: "invalid_json" } },
    ));
    expect(prompt).toContain("content repair");
    expect(prompt).toContain("invalid_json");
    // 审计上下文把 content repair 标记为 content_repair，attempt/reason 来自契约。
    const auditContext = ai.complete.mock.calls[0]?.[2] as { readonly retry?: unknown };
    expect(auditContext.retry).toMatchObject({
      origin: "normal", mechanism: "content_repair", attempt: 1, reason: "invalid_json",
    });
  });

  it("手动失败 job 的内容修复保留 auditLink 中的 retry origin", async () => {
    const ai = makeClient("not json");
    const source = createLiveWorldEvolutionSource({ aiClient: ai });

    const result = await source.propose(makeCtx({
      auditLink: {
        traceId: "t-manual-retry",
        retry: { origin: "manual_failed_job", mechanism: "initial", attempt: 0 },
      },
      contentRepair: { attempt: 1, reason: "invalid_json" },
    }));

    expect(result).toMatchObject({ ok: false, repairReason: "invalid_json" });
    const auditContext = ai.complete.mock.calls[0]?.[2] as { readonly retry?: unknown };
    expect(auditContext.retry).toEqual({
      origin: "manual_failed_job", mechanism: "content_repair", attempt: 1, reason: "invalid_json",
    });
  });

  it("审批拒绝修复会把稳定审批 code 并入修复 prompt 与审计 reason", async () => {
    const ai = makeClient("not json");
    const source = createLiveWorldEvolutionSource({ aiClient: ai });
    let prompt = "";
    ai.complete.mockImplementation(async (_role: "world", messages: readonly unknown[], _ctx?: unknown) => {
      prompt = (messages[0] as { readonly content?: string } | undefined)?.content ?? "";
      return { ok: true as const, content: "not json", latencyMs: 1 };
    });
    await source.propose(makeCtx({
      contentRepair: { attempt: 1, reason: "approval_rejected", approvalCode: "duplicate_name" },
    }));
    expect(prompt).toContain("duplicate_name");
    const auditContext = ai.complete.mock.calls[0]?.[2] as { readonly retry?: { readonly reason?: string } };
    expect(auditContext.retry?.reason).toBe("approval_rejected:duplicate_name");
  });

  it("满槽城镇把世界地点容量与新地点 NPC 归属明确写入 prompt", () => {
    const base = makeCtx({ need: { kind: "next_act", act: 2 } });
    let town = createTownRuntime({ locationId: asLocationId("loc_a"), seed: "s#town#loc_a" });
    const occupantId = asNpcId("npc_occupant");
    for (let i = 0; i < town.slots.length; i += 1) {
      town = bindNpcToTownSlot(town, occupantId).town;
    }
    const worldState = withProjection(base.worldState, {
      locations: base.worldState.locations.map((location) => location.id === asLocationId("loc_a")
        ? { ...location, scale: "town" as const, town, npcIds: [occupantId] }
        : location),
      npcs: [{
        id: occupantId, name: "常住店主", role: "店主", description: "占用既有建筑的店主。",
        locationId: asLocationId("loc_a"), isCompanion: false, tags: [], met: true,
        memory: {
          npcId: occupantId, knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
          relationship: { affinity: 0 }, emotion: "neutral", goals: [],
        },
      }],
    });
    const prompt = buildWorldEvolutionPrompt({ ...base, worldState });
    expect(prompt).toContain("剧情建筑槽位已满（可用槽位=0/");
    expect(prompt).toContain("本次禁止使用 placement=town_building");
    expect(prompt).toContain("placement=world");
    expect(prompt).toContain("newNpc.locationRef 必须是 {\"kind\":\"new_location\"}");

    const repairPrompt = buildWorldEvolutionPrompt({
      ...base,
      worldState,
      contentRepair: { attempt: 1, reason: "approval_rejected", approvalCode: "town_capacity" },
    });
    expect(repairPrompt).toContain("当前城镇建筑槽位已满：必须把新地点改为 placement=world");
    expect(repairPrompt).toContain("必须把其 locationRef 改为 {\"kind\":\"new_location\"}");
  });

  it("source 自身不递归：即使传输失败也不重复相同请求", async () => {
    const complete = vi.fn(async () =>
      ({ ok: false as const, code: "empty_response" as const, retryable: false, latencyMs: 1 }));
    const source = createLiveWorldEvolutionSource({
      aiClient: { complete, policy: () => ({ thinking: "off" as const, timeoutMs: 45_000, maxTokens: 3_200, jsonMode: "prompt_only" as const, maxAttempts: 3 }) },
    });
    const result = await source.propose(makeCtx({
      contentRepair: { attempt: 1, reason: "invalid_json" },
    }));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.repairReason).toBeUndefined();
  });

  it("世界 prompt 收紧 world 新地点与其 NPC 的 locationRef 可达性约束并只列出已有地点摘要", async () => {
    const ai = makeClient("not json");
    const source = createLiveWorldEvolutionSource({ aiClient: ai });
    let prompt = "";
    ai.complete.mockImplementation(async (_role, messages, _ctx) => {
      prompt = (messages[0] as { readonly content?: string } | undefined)?.content ?? "";
      return { ok: true as const, content: "not json", latencyMs: 1 };
    });
    await source.propose(makeCtx({ need: { kind: "next_act", act: 2 } }));
    expect(prompt).toContain("newNpc.locationRef 必须为 {\"kind\":\"new_location\"}");
    expect(prompt).toContain("新地点名称不得与现有地点名称重复");
    // 只提供已批准地点的安全名称/ID 摘要，不序列化完整存档或私密事实。
    expect(prompt).toContain("客栈");
    expect(prompt).toContain("loc_a");
    expect(prompt).not.toContain("worldFacts");
  });

  it("world-evolution prompt declares typed NPC anchors, goals, and directed seed boundaries", async () => {
    const ai = makeClient("not json");
    const source = createLiveWorldEvolutionSource({ aiClient: ai });
    let prompt = "";
    ai.complete.mockImplementation(async (_role, messages, _ctx) => {
      prompt = (messages[0] as { readonly content?: string } | undefined)?.content ?? "";
      return { ok: true as const, content: "not json", latencyMs: 1 };
    });
    await source.propose(makeCtx({ need: pacingNeed }));
    expect(prompt).toContain('"relationshipSeeds":[{"targetNpcId"');
    expect(prompt).toContain('"targetNpcId"');
    expect(prompt).toContain("relationshipSeeds 必须出现");
    expect(prompt).toContain("无关系时必须输出 []");
    expect(prompt).toContain("只能引用实体规则闭包中的既有 active NPC");
    expect(prompt).toContain("不得提交 affinity、stage、evidence 或 actionId");
  });
});
