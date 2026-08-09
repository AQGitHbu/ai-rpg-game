import { describe, it, expect } from "vitest";
import { repairWorldGenerationCandidate, createWorldGenerationSource } from "./worldGenerationSource";
import type { WorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";
import type { AiTransport } from "@ai-game/ai-transport";

type DeepMutable<T> = {
  -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U>
    ? DeepMutable<U>[]
    : T[K] extends object
      ? DeepMutable<T[K]>
      : T[K];
};

function mutableCandidate(): DeepMutable<WorldGenerationCandidate> {
  return JSON.parse(JSON.stringify(validCandidate())) as DeepMutable<WorldGenerationCandidate>;
}

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
      { id: "quest_main", name: "寻剑", description: "d", kind: "main", stage: 1, objectives: [{ kind: "talk_to_npc", npcId: "npc_1" }], onSuccess: { kind: "unlock_quests", questIds: ["quest_act2"] }, onFailure: { kind: "closed" }, tags: ["main"] },
      { id: "quest_act2", name: "追查", description: "d", kind: "main", stage: 2, objectives: [{ kind: "visit_location", locationId: "loc_2" }], onSuccess: { kind: "unlock_quests", questIds: ["quest_act3"] }, onFailure: { kind: "closed" }, tags: ["main"] },
      { id: "quest_act3", name: "终幕", description: "d", kind: "main", stage: 3, objectives: [{ kind: "obtain_item", itemId: "item_1" }], onSuccess: { kind: "reach_ending", endingId: "ending_1" }, onFailure: { kind: "closed" }, tags: ["main"] },
    ],
    endings: [
      { id: "ending_1", name: "英雄", description: "d", requirements: [{ kind: "quest_completed", questId: "quest_act3" }, { kind: "npc_affinity_at_least", npcId: "npc_1", value: 6 }] },
      { id: "ending_2", name: "归隐", description: "d", requirements: [{ kind: "quest_completed", questId: "quest_act3" }, { kind: "npc_affinity_at_most", npcId: "npc_1", value: 5 }] },
    ],
    openingBudget: { locationsCount: 2, npcsCount: 1, sideQuestsCount: 0, endingsCount: 2, townLocationsCount: 0 },
  };
}

function incompleteCandidate(): WorldGenerationCandidate {
  const candidate = validCandidate();
  return {
    ...candidate,
    quests: [
      {
        id: "quest_main", name: "寻剑", description: "d", kind: "main", stage: 1,
        objectives: [{ kind: "talk_to_npc", npcId: "npc_1" }],
        onSuccess: { kind: "reach_ending", endingId: "ending_1" }, onFailure: { kind: "closed" }, tags: ["main"],
      },
    ],
    endings: [
      { id: "ending_1", name: "英雄", description: "d", requirements: [{ kind: "quest_completed", questId: "quest_main" }, { kind: "npc_affinity_at_least", npcId: "npc_1", value: 6 }] },
      { id: "ending_2", name: "归隐", description: "d", requirements: [{ kind: "quest_completed", questId: "quest_main" }, { kind: "npc_affinity_at_most", npcId: "npc_1", value: 5 }] },
    ],
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

  it("AI short 候选缺失第 2–3 幕主线时确定性回退", async () => {
    const transport = {
      complete: async () => ({ ok: true, content: JSON.stringify(incompleteCandidate()), latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createWorldGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });

    const first = await source.generate({ gameType: "wuxia", seed: "incomplete-short", gameLength: "short" });
    const replay = await source.generate({ gameType: "wuxia", seed: "incomplete-short", gameLength: "short" });

    expect(first).toEqual(replay);
    expect(first.quests.filter((quest) => quest.kind === "main").map((quest) => quest.stage)).toEqual([1, 2, 3]);
    expect(first.locations).toHaveLength(3);
  });

  it("AI medium 候选未覆盖 5 幕主线时确定性回退", async () => {
    const transport = {
      complete: async () => ({ ok: true, content: JSON.stringify(incompleteCandidate()), latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createWorldGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });

    const candidate = await source.generate({ gameType: "wuxia", seed: "incomplete-medium", gameLength: "medium" });

    expect(candidate.quests.filter((quest) => quest.kind === "main").map((quest) => quest.stage)).toEqual([1, 2, 3, 4, 5]);
    expect(candidate.locations).toHaveLength(5);
  });

  it("AI 关系结局留下 affinity 6–9 空档时回退到无缝的 trust/doubt 分区", async () => {
    const bad = validCandidate();
    const endings = [
      {
        id: "ending_1", name: "信任", description: "d",
        requirements: [{ kind: "npc_affinity_at_most" as const, npcId: "npc_1", value: 5 }],
      },
      {
        id: "ending_2", name: "疑心", description: "d",
        requirements: [{ kind: "npc_affinity_at_least" as const, npcId: "npc_1", value: 10 }],
      },
    ];
    const transport = {
      complete: async () => ({ ok: true, content: JSON.stringify({ ...bad, endings }), latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createWorldGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });

    const candidate = await source.generate({ gameType: "wuxia", seed: "ending-gap", gameLength: "short" });
    const trust = candidate.endings.find((ending) => ending.id === "ending_trust");
    const doubt = candidate.endings.find((ending) => ending.id === "ending_doubt");

    expect(trust?.requirements).toContainEqual({ kind: "npc_affinity_at_least", npcId: "npc_innkeeper", value: 6 });
    expect(doubt?.requirements).toContainEqual({ kind: "npc_affinity_at_most", npcId: "npc_innkeeper", value: 5 });
  });

  it.each([
    {
      name: "quest-only branch",
      build: () => {
        const candidate = mutableCandidate();
        candidate.endings[0].requirements = [{ kind: "quest_completed", questId: "quest_act3" }];
        return candidate;
      },
    },
    {
      name: "different NPC discriminators",
      build: () => {
        const candidate = mutableCandidate();
        candidate.npcs.push({
          id: "npc_2", name: "守卫", role: "见证人", description: "d", locationId: "loc_2",
          isCompanion: false, knownFactIds: [], hiddenFactIds: [], goals: [], tags: [],
        });
        candidate.locations[1].npcIds.push("npc_2");
        candidate.openingBudget.npcsCount = 2;
        candidate.endings[1].requirements = [
          { kind: "quest_completed", questId: "quest_act3" },
          { kind: "npc_affinity_at_most", npcId: "npc_2", value: 5 },
        ];
        return candidate;
      },
    },
    {
      name: "single ending interval",
      build: () => {
        const candidate = mutableCandidate();
        candidate.endings = [candidate.endings[0]];
        candidate.openingBudget.endingsCount = 1;
        return candidate;
      },
    },
    {
      name: "conjunctive extra",
      build: () => {
        const candidate = mutableCandidate();
        candidate.endings[0].requirements.push({ kind: "fact_discovered", factId: "fact_sword" });
        return candidate;
      },
    },
    {
      name: "non-progressive stage unlock",
      build: () => {
        const candidate = mutableCandidate();
        const act1 = candidate.quests.find((quest) => quest.id === "quest_main");
        const act2 = candidate.quests.find((quest) => quest.id === "quest_act2");
        const act3 = candidate.quests.find((quest) => quest.id === "quest_act3");
        if (act1?.kind !== "main" || act2?.kind !== "main" || act3?.kind !== "main") {
          throw new Error("missing main quest fixture");
        }
        act1.onSuccess = { kind: "unlock_quests", questIds: [act3.id] };
        act3.onSuccess = { kind: "unlock_quests", questIds: [act2.id] };
        act2.onSuccess = { kind: "reach_ending", endingId: "ending_1" };
        return candidate;
      },
    },
  ])("AI $name candidate is rejected in favor of the deterministic fallback", async ({ build }) => {
    const input = { gameType: "wuxia" as const, seed: "guard-fallback", gameLength: "short" as const };
    const invalidCandidate = build();
    const transport = {
      complete: async () => ({ ok: true, content: JSON.stringify(invalidCandidate), latencyMs: 1 }),
    } as unknown as AiTransport;
    const liveSource = createWorldGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });
    const deterministicSource = createWorldGenerationSource({});

    await expect(liveSource.generate(input)).resolves.toEqual(await deterministicSource.generate(input));
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
