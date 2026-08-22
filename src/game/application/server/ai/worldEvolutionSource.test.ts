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
        name: "茶馆线人", role: "传讯人", description: "等候交信的线人。",
        locationRef: { kind: "new_location" }, goals: [],
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

  it("完整正文或软重合泄漏时拒绝整条世界提案，不用题材词库修补", () => {
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
      storyState: createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: { kind: "next_act", act: 2 },
      reason: "scene_evolution",
    };

    await source.propose(ctx);

    expect(prompt).toContain("本次是下一幕需求");
    expect(prompt).toContain("禁止输出 endingPair");
    expect(prompt).toContain("endingPair 字段必须完全省略");
    expect(prompt).toContain("placement");
    expect(prompt).not.toContain("终局={");
  });

  it("returns a typed failure without a transport", async () => {
    const source = createLiveWorldEvolutionSource({});
    const ctx: WorldEvolutionSourceContext = {
      worldState: makeWorld(),
      storyState: createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
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
      storyState: createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: pacingNeed,
      action: { type: "talk", npcId: asNpcId("npc_new"), dialogueAct: "ask" },
      reason: "UNKNOWN_NPC",
    };
    const result = await source.propose(ctx);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.kind).toBe("AI_RESPONSE_INVALID");
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
      storyState: createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
      need: pacingNeed,
      action: { type: "talk", npcId: asNpcId("npc_new"), dialogueAct: "ask" },
      reason: "UNKNOWN_NPC",
    };

    const result = await source.propose(ctx);

    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.kind).toBe("AI_CALL_FAILED");
  });
});

describe("world source 内容修复契约", () => {
  function makeCtx(overrides?: Partial<WorldEvolutionSourceContext>): WorldEvolutionSourceContext {
    return {
      worldState: makeWorld(),
      storyState: createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } }),
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
});
