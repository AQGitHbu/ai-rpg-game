import { describe, it, expect } from "vitest";
import { parseWorldGenerationCandidate, type WorldGenerationCandidate } from "./worldGenerationCandidate";

// ---------------------------------------------------------------------------
// Task 12：WorldGenerationCandidate 完整领域契约。
// AI 原始 unknown 必须先经 schema parser（parseWorldGenerationCandidate），
// 不能直接断言成 Entry 数组。parser 只做形状/枚举/长度检查；引用和可达性
// 留给 gameplay validator（Task 13）。
// ---------------------------------------------------------------------------

// 三个最小合法 fixture：wuxia / scifi / urban。
function wuxiaCandidate() {
  return {
    world: {
      summary: "一个江湖恩怨交织的世界。",
      tone: "江湖沧桑",
      themes: ["复仇", "忠诚"],
      publicFacts: [
        { id: "fact_north", text: "北方有个强盛的王朝。" },
        { id: "fact_guild", text: "城中有一家镖局。" },
      ],
      hiddenFacts: [
        { id: "fact_sword", text: "祖传宝剑藏在客栈地下。" },
      ],
      tags: ["武侠"],
    },
    player: {
      name: "陆小凤",
      identity: "游侠",
      backgroundSummary: "自幼习武，行走江湖。",
      startingLocationId: "loc_inn",
      startingItemIds: ["item_sword"],
      baseStats: { hp: 100, attack: 12, defense: 6 },
    },
    startAnchor: {
      locationId: "loc_inn",
      npcId: "npc_innkeeper",
      startQuestId: "quest_main",
      mainThreadId: "thread_main",
    },
    locations: [
      {
        id: "loc_inn", name: "客栈", description: "一间简朴的客栈", kind: "main",
        connectedLocationIds: ["loc_street"], npcIds: ["npc_innkeeper"], availableItemIds: ["item_sword"], tags: [],
      },
      {
        id: "loc_street", name: "街道", description: "热闹的街道", kind: "main",
        connectedLocationIds: ["loc_inn"], npcIds: [], availableItemIds: [], tags: [],
      },
    ],
    npcs: [
      {
        id: "npc_innkeeper", name: "客栈老板", role: "线索人", description: "知道很多江湖消息",
        locationId: "loc_inn", isCompanion: false,
        knownFactIds: ["fact_north"], hiddenFactIds: ["fact_sword"],
        goals: ["打听失踪的镖队"], tags: [],
      },
    ],
    items: [
      { id: "item_sword", name: "祖传宝剑", description: "一把锋利的宝剑", kind: "weapon", tags: [] },
    ],
    enemies: [],
    factions: [],
    quests: [
      {
        id: "quest_main", name: "寻剑", description: "找回祖传宝剑", kind: "main", stage: 1,
        objectives: [{ kind: "talk_to_npc", npcId: "npc_innkeeper" }],
        onSuccess: { kind: "reach_ending", endingId: "ending_hero" },
        onFailure: { kind: "closed" },
        tags: ["main"],
      },
      {
        id: "quest_side", name: "帮镖局", description: "帮助镖局运送货物", kind: "side",
        objectives: [{ kind: "visit_location", locationId: "loc_street" }],
        onSuccess: { kind: "closed" },
        onFailure: { kind: "closed" },
        tags: ["side"],
      },
    ],
    endings: [
      { id: "ending_hero", name: "英雄归来", description: "寻回宝剑，名扬江湖", requirements: [{ kind: "quest_completed", questId: "quest_main" }] },
      { id: "ending_wanderer", name: "隐姓埋名", description: "放下一切，归隐山林", requirements: [{ kind: "fact_discovered", factId: "fact_sword" }] },
    ],
    openingBudget: {
      locationsCount: 2,
      npcsCount: 1,
      sideQuestsCount: 1,
      endingsCount: 2,
      townLocationsCount: 0,
    },
  };
}

function scifiCandidate() {
  return {
    world: {
      summary: "一艘殖民船正在驶向新的星系。",
      tone: "冰冷务实",
      themes: ["生存", "责任"],
      publicFacts: [{ id: "fact_hull", text: "船体有未知损伤。" }],
      hiddenFacts: [{ id: "fact_sabotage", text: "损伤是人为破坏。" }],
      tags: ["科幻"],
    },
    player: {
      name: "指挥官",
      identity: "副舰长",
      backgroundSummary: "负责船员调度。",
      startingLocationId: "loc_bridge",
      startingItemIds: [],
      baseStats: { hp: 80, attack: 8, defense: 10 },
    },
    startAnchor: {
      locationId: "loc_bridge",
      npcId: "npc_engineer",
      startQuestId: "quest_main",
      mainThreadId: "thread_main",
    },
    locations: [
      {
        id: "loc_bridge", name: "舰桥", description: "控制中心", kind: "main",
        connectedLocationIds: ["loc_engine"], npcIds: ["npc_engineer"], availableItemIds: [], tags: [],
      },
      {
        id: "loc_engine", name: "引擎室", description: "动力核心", kind: "main",
        connectedLocationIds: ["loc_bridge"], npcIds: [], availableItemIds: [], tags: [],
      },
    ],
    npcs: [
      {
        id: "npc_engineer", name: "机械师", role: "工程师", description: "负责船体维护",
        locationId: "loc_bridge", isCompanion: false,
        knownFactIds: ["fact_hull"], hiddenFactIds: [],
        goals: ["修复动力系统"], tags: [],
      },
    ],
    items: [],
    enemies: [],
    factions: [],
    quests: [
      {
        id: "quest_main", name: "检修船体", description: "查明船体损伤", kind: "main", stage: 1,
        objectives: [{ kind: "talk_to_npc", npcId: "npc_engineer" }],
        onSuccess: { kind: "reach_ending", endingId: "ending_repair" },
        onFailure: { kind: "closed" },
        tags: ["main"],
      },
    ],
    endings: [
      { id: "ending_repair", name: "修复完成", description: "船体修复，继续航程", requirements: [{ kind: "quest_completed", questId: "quest_main" }] },
      { id: "ending_abandon", name: "弃船逃生", description: "弃船逃离", requirements: [{ kind: "quest_failed", questId: "quest_main" }] },
    ],
    openingBudget: {
      locationsCount: 2,
      npcsCount: 1,
      sideQuestsCount: 0,
      endingsCount: 2,
      townLocationsCount: 0,
    },
  };
}

function urbanCandidate() {
  return {
    world: {
      summary: "现代都市里隐藏着超自然力量。",
      tone: "都市暗流",
      themes: ["真相", "代价"],
      publicFacts: [{ id: "fact_market", text: "旧城区有个秘密市场。" }],
      hiddenFacts: [{ id: "fact_sect", text: "市政府被一个秘密教派渗透。" }],
      tags: ["都市"],
    },
    player: {
      name: "侦探",
      identity: "私家侦探",
      backgroundSummary: "专接灵异案件。",
      startingLocationId: "loc_office",
      startingItemIds: [],
      baseStats: { hp: 90, attack: 6, defense: 8 },
    },
    startAnchor: {
      locationId: "loc_office",
      npcId: "npc_client",
      startQuestId: "quest_main",
      mainThreadId: "thread_main",
    },
    locations: [
      {
        id: "loc_office", name: "侦探事务所", description: "小小的办公室", kind: "main",
        connectedLocationIds: ["loc_street"], npcIds: ["npc_client"], availableItemIds: [], tags: [],
      },
      {
        id: "loc_street", name: "旧城区", description: "霓虹闪烁的街道", kind: "main",
        connectedLocationIds: ["loc_office"], npcIds: [], availableItemIds: [], tags: [],
      },
    ],
    npcs: [
      {
        id: "npc_client", name: "委托人", role: "委托人", description: "委托调查灵异事件",
        locationId: "loc_office", isCompanion: false,
        knownFactIds: [], hiddenFactIds: [],
        goals: ["查明亲人失踪真相"], tags: [],
      },
    ],
    items: [],
    enemies: [],
    factions: [],
    quests: [
      {
        id: "quest_main", name: "失踪案", description: "调查失踪案", kind: "main", stage: 1,
        objectives: [{ kind: "talk_to_npc", npcId: "npc_client" }],
        onSuccess: { kind: "reach_ending", endingId: "ending_reveal" },
        onFailure: { kind: "closed" },
        tags: ["main"],
      },
    ],
    endings: [
      { id: "ending_reveal", name: "真相大白", description: "揭露教派", requirements: [{ kind: "fact_discovered", factId: "fact_sect" }] },
      { id: "ending_leave", name: "离开城市", description: "远走他乡", requirements: [{ kind: "quest_completed", questId: "quest_main" }] },
    ],
    openingBudget: {
      locationsCount: 2,
      npcsCount: 1,
      sideQuestsCount: 0,
      endingsCount: 2,
      townLocationsCount: 0,
    },
  };
}

describe("parseWorldGenerationCandidate", () => {
  it("解析合法 wuxia fixture", () => {
    const result = parseWorldGenerationCandidate(wuxiaCandidate());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const c = result.value;
    expect(c.world.publicFacts).toHaveLength(2);
    expect(c.world.hiddenFacts).toHaveLength(1);
    expect(c.npcs[0]?.hiddenFactIds).toContain("fact_sword");
    expect(c.npcs[0]?.goals).toHaveLength(1);
    expect(c.quests.length).toBeGreaterThanOrEqual(1);
    expect(c.quests.length).toBeLessThanOrEqual(3);
    expect(c.endings.length).toBeGreaterThanOrEqual(2);
    for (const e of c.endings) expect(e.requirements.length).toBeGreaterThan(0);
  });

  it("解析合法 scifi 与 urban fixture", () => {
    expect(parseWorldGenerationCandidate(scifiCandidate()).ok).toBe(true);
    expect(parseWorldGenerationCandidate(urbanCandidate()).ok).toBe(true);
  });

  it("world.facts 是 unknown 时拒绝", () => {
    const bad = { ...wuxiaCandidate(), world: { ...wuxiaCandidate().world, publicFacts: "nope" } };
    expect(parseWorldGenerationCandidate(bad).ok).toBe(false);
  });

  it("引用断裂（npcId 指向不存在地点）允许通过 parser（留给 validator 校验）", () => {
    const bad = wuxiaCandidate();
    (bad as { npcs: { locationId: string }[] }).npcs[0].locationId = "loc_missing";
    // parser 只做形状检查，引用校验在 Task 13
    expect(parseWorldGenerationCandidate(bad).ok).toBe(true);
  });

  it("空结局列表拒绝", () => {
    const bad = { ...wuxiaCandidate(), endings: [] };
    expect(parseWorldGenerationCandidate(bad).ok).toBe(false);
  });

  it("结局 requirements 为空数组时拒绝", () => {
    const bad = wuxiaCandidate();
    (bad as { endings: { requirements: unknown[] }[] }).endings[0].requirements = [];
    expect(parseWorldGenerationCandidate(bad).ok).toBe(false);
  });

  it("支线数量超过 2 拒绝", () => {
    const bad = wuxiaCandidate();
    const extras = [
      { id: "q_s1", name: "s1", description: "d", kind: "side", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [] },
      { id: "q_s2", name: "s2", description: "d", kind: "side", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [] },
      { id: "q_s3", name: "s3", description: "d", kind: "side", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [] },
    ];
    (bad as { quests: { kind: string }[] }).quests.push(...extras);
    expect(parseWorldGenerationCandidate(bad).ok).toBe(false);
  });

  it("非对象输入拒绝", () => {
    expect(parseWorldGenerationCandidate(null).ok).toBe(false);
    expect(parseWorldGenerationCandidate(42).ok).toBe(false);
    expect(parseWorldGenerationCandidate("x").ok).toBe(false);
  });
});

describe("WorldGenerationCandidate 类型契约", () => {
  it("符合 main thread 锚点", () => {
    const result = parseWorldGenerationCandidate(wuxiaCandidate());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const c: WorldGenerationCandidate = result.value;
    expect(c.startAnchor).toBeTypeOf("object");
    expect(c.startAnchor.mainThreadId).toBeTypeOf("string");
    expect(c.startAnchor.startQuestId).toBeTypeOf("string");
    // 玩家、地点、NPC、任务、结局与预算计数齐全
    expect(c.player.name).toBeTypeOf("string");
    expect(c.locations.length).toBeGreaterThan(0);
    expect(c.npcs.length).toBeGreaterThan(0);
    expect(c.quests.length).toBeGreaterThan(0);
    expect(c.endings.length).toBeGreaterThan(0);
    expect(c.openingBudget.locationsCount).toBeTypeOf("number");
  });
});
