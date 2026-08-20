import { describe, it, expect, vi } from "vitest";
import {
  parseWorldDeltaProposal,
  filterProposalRefs,
  createLiveWorldEvolutionSource,
  LIVE_WORLD_EVOLUTION_MAX_TOKENS,
  LIVE_WORLD_EVOLUTION_TIMEOUT_MS,
} from "./liveWorldEvolutionSource";
import { createInitialWorldState } from "@/game/domain/worldState";
import { asLocationId, asGenerationId, asNpcId } from "@/game/domain/worldEntity";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { AiTransport } from "@ai-game/ai-transport";
import type { WorldState } from "@/game/domain/worldState";
import type { EvolutionNeed } from "@/game/domain/worldDelta";
import type { WorldEvolutionSourceContext } from "../../worldEvolutionSource";

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

const pacingNeed: EvolutionNeed = { kind: "pacing", pacingNeed: "complicate" };

describe("parseWorldDeltaProposal", () => {
  it("parses a valid npc repair proposal", () => {
    const parsed = parseWorldDeltaProposal({
      beatSummary: "补给一名在场人物",
      newNpc: {
        name: "新来客", role: "过客", description: "路过的旅人。",
        locationRef: { kind: "existing", id: "loc_a" }, goals: ["随缘"],
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.proposal.newNpc?.name).toBe("新来客");
    expect(parsed?.proposal.newNpc?.locationRef).toEqual({ kind: "existing", id: "loc_a" });
  });

  it("drops proposals with illegal name length or missing fields", () => {
    expect(parseWorldDeltaProposal({ beatSummary: "", newNpc: null })).toBeNull();
    expect(parseWorldDeltaProposal({
      beatSummary: "坏名字",
      newNpc: { name: "X", role: "过客", description: "太短的名字。", locationRef: { kind: "existing", id: "loc_a" }, goals: [] },
    })).toBeNull();
    expect(parseWorldDeltaProposal({ beatSummary: "空实体", newLocation: null, newNpc: null, newItem: null, newEnemy: null, newFact: null, nextMainQuest: null, endingPair: null })).toBeNull();
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

  it("investigationApproaches 非数组时丢弃字段，保持自动揭示且无日志", () => {
    const parsed = parseWorldDeltaProposal({
      beatSummary: "调查线索",
      newFact: { text: "密道入口在井下。", visibility: "public", investigationApproaches: "nope" },
    });
    expect(parsed?.proposal.newFact?.investigationApproaches).toBeUndefined();
    expect(parsed?.logCategories).toEqual([]);
  });

  it("丢弃重复 id、空 label、非 clean|noisy、越界张力的条目，其余合法条目保留", () => {
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
    expect(parsed?.proposal.newFact?.investigationApproaches).toEqual([
      { approachId: "a", label: "检查井沿", evidenceQuality: "clean", tensionDelta: 2 },
      { approachId: "b", label: "细听井底动静", evidenceQuality: "noisy", tensionDelta: 4 },
      { approachId: "c", label: "询问井边挑水人", evidenceQuality: "clean", tensionDelta: -3 },
    ]);
    expect(parsed?.logCategories).toEqual([]);
  });

  it("合法数量不足或超过 3 时降为空列表并记录 investigation_approach_invalid", () => {
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
      expect(parsed?.proposal.newFact?.investigationApproaches).toEqual([]);
      expect(parsed?.logCategories).toContain("investigation_approach_invalid");
    }
  });

  it("完整正文子串泄漏的条目被硬拒绝丢弃；软重合条目替换为题材词库 label、丢弃 hint 并记录 investigation_label_overlap", () => {
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
    expect(parsed?.proposal.newFact?.investigationApproaches).toEqual([
      { approachId: "b", label: expect.any(String), evidenceQuality: "noisy", tensionDelta: 4 },
      { approachId: "c", label: "检查井沿", evidenceQuality: "clean", tensionDelta: 2 },
    ]);
    const repaired = parsed!.proposal.newFact!.investigationApproaches![0]!;
    expect(repaired.label).not.toContain("密道入口在井下。");
    expect(repaired.hint).toBeUndefined();
    expect(parsed?.logCategories).toContain("investigation_label_overlap");
  });
});

describe("filterProposalRefs", () => {
  it("rejects connectFromLocationId or existing npc refs not in the world", () => {
    const ws = makeWorld();
    const loc = parseWorldDeltaProposal({
      beatSummary: "新地点",
      newLocation: { name: "青山别院", description: "独立别院。", scale: "scene", connectFromLocationId: "loc_missing" },
    })!.proposal;
    expect(filterProposalRefs(loc, ws)).toBeNull();

    const npc = parseWorldDeltaProposal({
      beatSummary: "新人物",
      newNpc: { name: "新来客", role: "过客", description: "路过的旅人。", locationRef: { kind: "existing", id: "loc_missing" }, goals: [] },
    })!.proposal;
    expect(filterProposalRefs(npc, ws)).toBeNull();
  });

  it("keeps proposals whose refs exist", () => {
    const ws = makeWorld();
    const proposal = parseWorldDeltaProposal({
      beatSummary: "新人物",
      newNpc: { name: "新来客", role: "过客", description: "路过的旅人。", locationRef: { kind: "existing", id: "loc_a" }, goals: [] },
    })!.proposal;
    expect(filterProposalRefs(proposal, ws)).not.toBeNull();
  });
});

describe("createLiveWorldEvolutionSource", () => {
  it("reserves enough completion budget for provider reasoning and evolution JSON", () => {
    expect(LIVE_WORLD_EVOLUTION_MAX_TOKENS).toBeGreaterThanOrEqual(3_200);
    expect(LIVE_WORLD_EVOLUTION_TIMEOUT_MS).toBe(45_000);
  });

  it("falls back to the deterministic source without a transport", async () => {
    const source = createLiveWorldEvolutionSource({});
    const ctx: WorldEvolutionSourceContext = {
      worldState: makeWorld(),
      storyState: createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: pacingNeed,
      action: { type: "move", locationId: asLocationId("loc_b") },
      reason: "UNKNOWN_LOCATION",
    };
    const result = await source.propose(ctx);
    expect(result.proposal).not.toBeNull();
    expect(result.proposal?.newLocation).not.toBeNull();
  });

  it("falls back to deterministic when the AI output is invalid JSON", async () => {
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
      storyState: createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: pacingNeed,
      action: { type: "talk", npcId: asNpcId("npc_new"), dialogueAct: "ask" },
      reason: "UNKNOWN_NPC",
    };
    const result = await source.propose(ctx);
    expect(result.proposal?.newNpc).not.toBeNull();
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
      storyState: createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
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

  it("does not repeat an empty AI response and falls back deterministically", async () => {
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
      storyState: createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: pacingNeed,
      action: { type: "talk", npcId: asNpcId("npc_new"), dialogueAct: "ask" },
      reason: "UNKNOWN_NPC",
    };

    const result = await source.propose(ctx);

    expect(attempts).toBe(1);
    expect(result.proposal).not.toBeNull();
  });
});
