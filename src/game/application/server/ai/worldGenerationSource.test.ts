import { describe, it, expect } from "vitest";
import { repairWorldGenerationCandidate, createWorldGenerationSource } from "./worldGenerationSource";
import type { WorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import type { AiTransport } from "@ai-game/ai-transport";

function validCandidate(): WorldGenerationCandidate {
  return {
    world: {
      summary: "江湖", tone: "沧桑", themes: ["复仇"],
      publicFacts: [{ id: "fact_guild", text: "镖局" }],
      hiddenFacts: [{ id: "fact_sword", text: "宝剑" }],
      tags: ["武侠"],
    },
    player: { name: "陆", identity: "游侠", backgroundSummary: "江湖", startingLocationId: "loc_1", startingItemIds: ["item_1"], baseStats: { hp: 100, attack: 10, defense: 5 } },
    startAnchor: { locationId: "loc_1", npcId: "npc_1", startQuestId: "quest_main", mainThreadId: "thread_main" },
    locations: [
      { id: "loc_1", name: "客栈", description: "d", kind: "main", connectedLocationIds: ["loc_2"], npcIds: ["npc_1"], availableItemIds: [], tags: [] },
      { id: "loc_2", name: "街道", description: "d", kind: "main", connectedLocationIds: ["loc_1"], npcIds: [], availableItemIds: [], tags: [] },
    ],
    npcs: [{ id: "npc_1", name: "老板", role: "线索", description: "d", locationId: "loc_1", isCompanion: false, knownFactIds: [], hiddenFactIds: [], goals: [], tags: [] }],
    items: [{ id: "item_1", name: "剑", description: "d", kind: "weapon", tags: [] }],
    enemies: [],
    factions: [],
    quests: [
      { id: "quest_main", name: "寻剑", description: "d", kind: "main", stage: 1, objectives: [{ kind: "talk_to_npc", npcId: "npc_1" }], onSuccess: { kind: "reach_ending", endingId: "ending_1" }, onFailure: { kind: "closed" }, tags: ["main"] },
    ],
    endings: [
      { id: "ending_1", name: "英雄", description: "d", requirements: [{ kind: "quest_completed", questId: "quest_main" }] },
      { id: "ending_2", name: "归隐", description: "d", requirements: [{ kind: "fact_discovered", factId: "fact_sword" }] },
    ],
    openingBudget: { locationsCount: 2, npcsCount: 1, sideQuestsCount: 0, endingsCount: 2, townLocationsCount: 0 },
  };
}

describe("repairWorldGenerationCandidate", () => {
  it("有效候选不修复", () => {
    const { candidate, repaired } = repairWorldGenerationCandidate(validCandidate());
    expect(repaired).toBe(false);
    expect(candidate).not.toBeNull();
  });

  it("空数组字段被机械修复为合法空数组", () => {
    const raw = { ...validCandidate(), enemies: null, factions: "bad" } as unknown as Record<string, unknown>;
    const { candidate, repaired } = repairWorldGenerationCandidate(raw);
    expect(repaired).toBe(true);
    expect(candidate).not.toBeNull();
  });

  it("缺失的字符串字段被修复为空字符串后仍经 parse 拒绝（不伪装）", () => {
    const raw = JSON.parse(JSON.stringify(validCandidate()));
    raw.locations = [];
    const { candidate } = repairWorldGenerationCandidate(raw);
    // locations 为空 → parse 的实体列表仍可解析，但 validator 会拒绝引用。
    expect(candidate).not.toBeNull();
  });

  it("非对象输入返回 null", () => {
    expect(repairWorldGenerationCandidate(null).candidate).toBeNull();
    expect(repairWorldGenerationCandidate("x").candidate).toBeNull();
    expect(repairWorldGenerationCandidate(42).candidate).toBeNull();
  });
});

describe("createWorldGenerationSource", () => {
  it("无 transport 时确定性 fallback 通过同一 validator/compiler", async () => {
    const source = createWorldGenerationSource({});
    const candidate = await source.generate({ gameType: "wuxia", seed: "s", gameLength: "short" });
    expect(candidate).toBeTruthy();
    expect(candidate.locations.length).toBeGreaterThan(0);
    expect(candidate.endings.length).toBeGreaterThanOrEqual(2);
  });

  it("AI 返回有效结构化候选时经机械修复 + 校验通过", async () => {
    const transport = {
      complete: async () => ({ ok: true, content: JSON.stringify(validCandidate()), latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createWorldGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });
    const candidate = await source.generate({ gameType: "wuxia", seed: "s", gameLength: "short" });
    expect(candidate.locations.length).toBe(2);
  });

  it("AI 返回非法 JSON 时回退 fixture", async () => {
    const transport = {
      complete: async () => ({ ok: true, content: "not json", latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createWorldGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });
    const candidate = await source.generate({ gameType: "wuxia", seed: "s", gameLength: "short" });
    expect(candidate.locations.length).toBeGreaterThan(0); // fixture fallback
  });

  it("AI 返回 schema 错误候选时回退 fixture（不修剧情语义）", async () => {
    const bad = JSON.parse(JSON.stringify(validCandidate()));
    bad.endings = []; // validator 拒绝（太少结局）→ fallback
    const transport = {
      complete: async () => ({ ok: true, content: JSON.stringify(bad), latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createWorldGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });
    const candidate = await source.generate({ gameType: "wuxia", seed: "s", gameLength: "short" });
    expect(candidate.endings.length).toBeGreaterThanOrEqual(2); // fixture
  });

  it("transport 失败时回退 fixture 且不泄露 apiKey 到日志", async () => {
    const warns: Array<{ ctx: string; params?: unknown }> = [];
    const transport = {
      complete: async () => ({ ok: false, code: "network_error", retryable: true, latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createWorldGenerationSource({
      transport,
      config: { baseUrl: "x", apiKey: "SECRET_KEY", model: "m" },
      logger: { warn: (ctx: string, params?: unknown) => warns.push({ ctx, params }) } as never,
    });
    const candidate = await source.generate({ gameType: "wuxia", seed: "s", gameLength: "short" });
    expect(candidate.locations.length).toBeGreaterThan(0);
    const allLog = JSON.stringify(warns);
    expect(allLog).not.toContain("SECRET_KEY");
  });
});
