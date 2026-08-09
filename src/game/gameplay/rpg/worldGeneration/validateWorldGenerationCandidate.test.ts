import { describe, it, expect } from "vitest";
import { validateWorldGenerationCandidate, type WorldGenerationIssueCode } from "./validateWorldGenerationCandidate";
import type { WorldGenerationCandidate } from "@/game/domain/worldGenerationCandidate";

// ---------------------------------------------------------------------------
// Task 13：validator 测试矩阵——按稳定错误码覆盖。
// 测试需要构造"非法"候选，故用深度可变类型以允许原地修改。
// ---------------------------------------------------------------------------

type DeepMutable<T> = {
  -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U>
    ? DeepMutable<U>[]
    : T[K] extends object
      ? DeepMutable<T[K]>
      : T[K];
};

function baseCandidate(): DeepMutable<WorldGenerationCandidate> {
  return {
    world: {
      summary: "江湖世界",
      tone: "沧桑",
      themes: ["复仇"],
      publicFacts: [{ id: "fact_guild", text: "城中有镖局。" }, { id: "fact_north", text: "北方有王朝。" }],
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
    factions: [],
    quests: [
      { id: "quest_main", name: "寻剑", description: "找回宝剑", kind: "main", stage: 1, objectives: [{ kind: "talk_to_npc", npcId: "npc_innkeeper" }], onSuccess: { kind: "unlock_quests", questIds: ["quest_act2"] }, onFailure: { kind: "closed" }, tags: ["main"] },
      { id: "quest_act2", name: "追查", description: "追查宝剑去向", kind: "main", stage: 2, objectives: [{ kind: "visit_location", locationId: "loc_street" }], onSuccess: { kind: "unlock_quests", questIds: ["quest_act3"] }, onFailure: { kind: "closed" }, tags: ["main"] },
      { id: "quest_act3", name: "终幕", description: "找回宝剑", kind: "main", stage: 3, objectives: [{ kind: "obtain_item", itemId: "item_sword" }], onSuccess: { kind: "reach_ending", endingId: "ending_hero" }, onFailure: { kind: "closed" }, tags: ["main"] },
      { id: "quest_side", name: "帮镖局", description: "帮忙", kind: "side", objectives: [{ kind: "visit_location", locationId: "loc_street" }], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: ["side"] },
    ],
    endings: [
      { id: "ending_hero", name: "英雄", description: "归来", requirements: [{ kind: "quest_completed", questId: "quest_act3" }, { kind: "npc_affinity_at_least", npcId: "npc_innkeeper", value: 6 }] },
      { id: "ending_wanderer", name: "归隐", description: "归隐山林", requirements: [{ kind: "quest_completed", questId: "quest_act3" }, { kind: "npc_affinity_at_most", npcId: "npc_innkeeper", value: 5 }] },
    ],
    openingBudget: { locationsCount: 2, npcsCount: 1, sideQuestsCount: 1, endingsCount: 2, townLocationsCount: 0 },
  };
}

function issues(candidate: DeepMutable<WorldGenerationCandidate>): WorldGenerationIssueCode[] {
  const result = validateWorldGenerationCandidate(
    candidate as unknown as WorldGenerationCandidate,
    { gameLength: "short", targetActs: 3 },
  );
  if (result.ok) return [];
  return result.issues.map((i) => i.code);
}

describe("validateWorldGenerationCandidate 合法候选", () => {
  it("合法候选通过", () => {
    const result = validateWorldGenerationCandidate(baseCandidate(), { gameLength: "short", targetActs: 3 });
    expect(result.ok).toBe(true);
  });
});

describe("validateWorldGenerationCandidate 错误矩阵", () => {
  it("rejects a short candidate whose reachable main chain does not cover acts 1 through 3", () => {
    const c = baseCandidate();
    c.quests = c.quests.filter((quest) => quest.kind !== "main" || quest.stage === 1);
    const first = c.quests.find((quest) => quest.id === "quest_main");
    if (first?.kind !== "main") throw new Error("missing main quest fixture");
    first.onSuccess = { kind: "reach_ending", endingId: "ending_hero" };
    c.endings = [
      { id: "ending_hero", name: "英雄", description: "归来", requirements: [{ kind: "quest_completed", questId: "quest_main" }, { kind: "npc_affinity_at_least", npcId: "npc_innkeeper", value: 6 }] },
      { id: "ending_wanderer", name: "归隐", description: "归隐山林", requirements: [{ kind: "quest_completed", questId: "quest_main" }, { kind: "npc_affinity_at_most", npcId: "npc_innkeeper", value: 5 }] },
    ];

    const result = validateWorldGenerationCandidate(
      c as unknown as WorldGenerationCandidate,
      { gameLength: "short", targetActs: 3 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain("main_act_gap");
  });

  it("rejects a medium candidate whose reachable main chain stops at act 3", () => {
    const c = baseCandidate();

    const result = validateWorldGenerationCandidate(
      c as unknown as WorldGenerationCandidate,
      { gameLength: "medium", targetActs: 5 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain("main_act_gap");
  });

  it("duplicate_id", () => {
    const c = baseCandidate();
    c.items.push({ id: "item_sword", name: "重复剑", description: "x", kind: "weapon", tags: [] });
    expect(issues(c)).toContain("duplicate_id");
  });

  it("missing_reference", () => {
    const c = baseCandidate();
    c.locations[0].connectedLocationIds.push("loc_ghost");
    expect(issues(c)).toContain("missing_reference");
  });

  it("starting_location_missing", () => {
    const c = baseCandidate();
    c.startAnchor.locationId = "loc_missing";
    expect(issues(c)).toContain("starting_location_missing");
  });

  it("unreachable_location", () => {
    const c = baseCandidate();
    c.locations.push({ id: "loc_orphan", name: "孤岛", description: "x", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] });
    expect(issues(c)).toContain("unreachable_location");
  });

  it("locked_location_without_unlock_path", () => {
    const c = baseCandidate();
    c.locations.push({ id: "loc_hidden", name: "密室", description: "x", kind: "hidden", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] });
    expect(issues(c)).toContain("locked_location_without_unlock_path");
  });

  it("main_act_gap", () => {
    const c = baseCandidate();
    c.quests = c.quests.filter((quest) => quest.id !== "quest_act2");
    const first = c.quests.find((quest) => quest.id === "quest_main");
    if (first?.kind === "main") first.onSuccess = { kind: "unlock_quests", questIds: ["quest_act3"] };
    expect(issues(c)).toContain("main_act_gap");
  });

  it("first_act_not_actionable", () => {
    const c = baseCandidate();
    const main = c.quests.find((q) => q.id === "quest_main");
    if (main && main.kind === "main") main.stage = 2;
    expect(issues(c)).toContain("first_act_not_actionable");
  });

  it("quest_cycle", () => {
    const c = baseCandidate();
    // quest_a 解锁 quest_b，quest_b 解锁 quest_a，均无 reach_ending/closed 关闭。
    c.quests = [
      { id: "q_a", name: "A", description: "x", kind: "side", objectives: [], onSuccess: { kind: "unlock_quests", questIds: ["q_b"] }, onFailure: { kind: "closed" }, tags: [] },
      { id: "q_b", name: "B", description: "x", kind: "side", objectives: [], onSuccess: { kind: "unlock_quests", questIds: ["q_a"] }, onFailure: { kind: "closed" }, tags: [] },
    ];
    expect(issues(c)).toContain("quest_cycle");
  });

  it("objective_unreachable", () => {
    const c = baseCandidate();
    c.quests[0].objectives.push({ kind: "visit_location", locationId: "loc_orphan" });
    c.locations.push({ id: "loc_orphan", name: "孤岛", description: "x", kind: "main", connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [] });
    expect(issues(c)).toContain("objective_unreachable");
  });

  it("ending_requirement_empty", () => {
    const c = baseCandidate();
    c.endings[0].requirements = [];
    expect(issues(c)).toContain("ending_requirement_empty");
  });

  it("ending_unreachable", () => {
    const c = baseCandidate();
    // 加入一个被自引用环锁死的 side quest（不可达），结局引用它 → 不可达。
    c.quests.push({ id: "quest_locked", name: "锁", description: "x", kind: "side", objectives: [], onSuccess: { kind: "unlock_quests", questIds: ["quest_locked"] }, onFailure: { kind: "closed" }, tags: [] });
    c.endings.push({ id: "ending_ghost", name: "幽灵", description: "x", requirements: [{ kind: "quest_completed", questId: "quest_locked" }] });
    expect(issues(c)).toContain("ending_unreachable");
  });

  it("insufficient_distinct_endings", () => {
    const c = baseCandidate();
    c.endings[1].requirements = [...c.endings[0].requirements];
    expect(issues(c)).toContain("insufficient_distinct_endings");
  });

  it("rejects overlapping affinity predicates for the same NPC", () => {
    const c = baseCandidate();
    c.endings[0].requirements = [
      { kind: "npc_affinity_at_least", npcId: "npc_innkeeper", value: 0 },
    ];
    c.endings[1].requirements = [
      { kind: "npc_affinity_at_least", npcId: "npc_innkeeper", value: 10 },
    ];

    expect(issues(c)).toContain("overlapping_ending_predicates");
  });

  it("rejects affinity endings that leave reachable values without an ending", () => {
    const c = baseCandidate();
    c.endings[0].requirements = [
      { kind: "npc_affinity_at_most", npcId: "npc_innkeeper", value: 5 },
    ];
    c.endings[1].requirements = [
      { kind: "npc_affinity_at_least", npcId: "npc_innkeeper", value: 10 },
    ];

    const result = validateWorldGenerationCandidate(
      c as unknown as WorldGenerationCandidate,
      { gameLength: "short", targetActs: 3 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain("non_exhaustive_ending_predicates");
  });

  it("npc_fact_reference_invalid", () => {
    const c = baseCandidate();
    c.npcs[0].knownFactIds.push("fact_missing");
    expect(issues(c)).toContain("npc_fact_reference_invalid");
  });

  it("budget_exceeded", () => {
    const c = baseCandidate();
    c.openingBudget.locationsCount = 1; // 实际 2
    expect(issues(c)).toContain("budget_exceeded");
  });

  it("invalid_starting_inventory", () => {
    const c = baseCandidate();
    c.player.startingItemIds.push("item_ghost");
    expect(issues(c)).toContain("invalid_starting_inventory");
  });

  it("invalid_starting_npc", () => {
    const c = baseCandidate();
    c.startAnchor.npcId = "npc_ghost";
    expect(issues(c)).toContain("invalid_starting_npc");
  });

  it("rejects an affinity ending that references an unknown NPC", () => {
    const c = baseCandidate();
    c.endings[0].requirements = [{ kind: "npc_affinity_at_least", npcId: "npc_ghost", value: 10 }];
    expect(issues(c)).toContain("missing_reference");
  });
});
