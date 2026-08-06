import { describe, expect, it } from "vitest";
import {
  asLocationId,
  asNpcId,
  asFactId,
  createBudgetPolicy,
  type ScenarioBlueprint,
  type GameState
} from "@/game/domain";
import type { ApprovedDirectorPlan, ProposedNewEnemy, ProposedNewFact, ProposedNewItem, ProposedNewLocation, ProposedNewNpc } from "./types";
import { approveBlueprintExpansion } from "./approveBlueprintExpansion";

// ---------------------------------------------------------------------------
// approveBlueprintExpansion 闸门顺序测试（spec §4.5）。
// 蓝图带 budgetPolicy: createBudgetPolicy("short")（软上限 8/10），state 解锁 loc_1。
// ---------------------------------------------------------------------------

function buildBlueprint(opts?: {
  locationCount?: number;
  npcCount?: number;
  townCount?: number;
  gameLength?: "short" | "open";
}): ScenarioBlueprint {
  const locationCount = opts?.locationCount ?? 3;
  const npcCount = opts?.npcCount ?? 3;
  const townCount = opts?.townCount ?? 0;
  const policy = createBudgetPolicy(opts?.gameLength ?? "short");

  const locations = Array.from({ length: locationCount }, (_, i) => ({
    id: asLocationId(`loc_${i + 1}`),
    name: `地点${i + 1}`,
    description: `描述${i + 1}`,
    kind: "main" as const,
    connectedLocationIds: [],
    npcIds: [],
    availableItemIds: [],
    tags: [],
    ...(i < townCount ? { scale: "town" as const } : { scale: "scene" as const })
  }));

  const npcs = Array.from({ length: npcCount }, (_, i) => ({
    id: asNpcId(`npc_${i + 1}`),
    name: `NPC${i + 1}`,
    role: "角色",
    description: "描述",
    locationId: asLocationId("loc_1"),
    isCompanion: false,
    knownFactIds: [],
    tags: []
  }));

  return {
    schemaVersion: 1,
    generationId: "gen-test" as ScenarioBlueprint["generationId"],
    seed: "test-seed",
    templateVersion: "tpl-1",
    inputDigest: "digest-test",
    gameType: "wuxia",
    world: {
      summary: "测试世界",
      tone: "沉稳",
      themes: ["正义"],
      facts: [{ id: asFactId("fact_1"), text: "事实", source: "player_input" }],
      tags: []
    },
    player: {
      name: "Player",
      identity: "Hero",
      backgroundSummary: "背景",
      startingLocationId: asLocationId("loc_1"),
      startingItemIds: [],
      baseStats: { hp: 20, attack: 5, defense: 3 }
    },
    locations,
    npcs,
    quests: [
      {
        id: "quest_main_1" as ScenarioBlueprint["quests"][number]["id"],
        name: "主线1",
        kind: "main" as const,
        stage: 1,
        description: "描述",
        objectives: [],
        onSuccess: { kind: "closed" as const },
        onFailure: { kind: "closed" as const },
        tags: []
      },
      {
        id: "quest_main_2" as ScenarioBlueprint["quests"][number]["id"],
        name: "主线2",
        kind: "main" as const,
        stage: 2,
        description: "描述",
        objectives: [],
        onSuccess: { kind: "closed" as const },
        onFailure: { kind: "closed" as const },
        tags: []
      },
      {
        id: "quest_main_3" as ScenarioBlueprint["quests"][number]["id"],
        name: "主线3",
        kind: "main" as const,
        stage: 3,
        description: "描述",
        objectives: [],
        onSuccess: { kind: "closed" as const },
        onFailure: { kind: "closed" as const },
        tags: []
      }
    ],
    enemies: [],
    items: [],
    endings: [],
    openingScene: {
      id: "scene_opening" as ScenarioBlueprint["openingScene"]["id"],
      locationId: asLocationId("loc_1"),
      narration: "开始",
      presentNpcIds: [],
      suggestedActions: [],
      investigableFactIds: []
    },
    budgetPolicy: policy
  } as unknown as ScenarioBlueprint;
}

function buildState(opts?: {
  unlockedIds?: string[];
  activeMainStage?: number;
  allMainCompleted?: boolean;
}): GameState {
  const unlockedIds = opts?.unlockedIds ?? ["loc_1"];
  const activeMainStage = opts?.activeMainStage ?? 1;
  const allMainCompleted = opts?.allMainCompleted ?? false;

  const quests = allMainCompleted
    ? [
        { questId: "quest_main_1" as GameState["quests"][number]["questId"], status: "completed" as const },
        { questId: "quest_main_2" as GameState["quests"][number]["questId"], status: "completed" as const },
        { questId: "quest_main_3" as GameState["quests"][number]["questId"], status: "completed" as const }
      ]
    : [
        { questId: "quest_main_1" as GameState["quests"][number]["questId"], status: (activeMainStage === 1 ? "active" : "locked") as GameState["quests"][number]["status"] },
        { questId: "quest_main_2" as GameState["quests"][number]["questId"], status: (activeMainStage === 2 ? "active" : "locked") as GameState["quests"][number]["status"] },
        { questId: "quest_main_3" as GameState["quests"][number]["questId"], status: (activeMainStage === 3 ? "active" : "locked") as GameState["quests"][number]["status"] }
      ];

  return {
    stateVersion: 1,
    generation: {
      generationId: "gen-test" as GameState["generation"]["generationId"],
      seed: "test-seed",
      templateVersion: "tpl-1",
      inputDigest: "digest-test",
      gameType: "wuxia"
    },
    player: { name: "Player", identity: "Hero", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: asLocationId("loc_1"),
    unlockedLocationIds: unlockedIds.map(asLocationId),
    visitedLocationIds: [asLocationId("loc_1")],
    npcs: [],
    quests,
    inventory: [],
    worldFacts: [],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null },
    eventLedger: [],
    revision: 0
  } as unknown as GameState;
}

function buildPlan(overrides?: {
  proposedNewLocations?: readonly ProposedNewLocation[];
  proposedNewNpcs?: readonly ProposedNewNpc[];
  proposedNewFacts?: readonly ProposedNewFact[];
  proposedNewItems?: readonly ProposedNewItem[];
  proposedNewEnemies?: readonly ProposedNewEnemy[];
  eventKind?: ApprovedDirectorPlan["eventKind"];
  pacing?: ApprovedDirectorPlan["pacing"];
}): ApprovedDirectorPlan {
  return {
    sceneGoal: "推进剧情",
    tensionLevel: 3,
    focusNpcId: null,
    relevantFactIds: [],
    allowedRevealFactIds: [],
    suggestedActionKeys: ["key_a", "key_b"],
    introducedEntities: [],
    pacing: overrides?.pacing ?? "develop",
    proposedNewLocations: overrides?.proposedNewLocations ?? [],
    proposedNewNpcs: overrides?.proposedNewNpcs ?? [],
    proposedNewFacts: overrides?.proposedNewFacts ?? [],
    proposedNewItems: overrides?.proposedNewItems ?? [],
    proposedNewEnemies: overrides?.proposedNewEnemies ?? [],
    ...(overrides?.eventKind !== undefined ? { eventKind: overrides.eventKind, eventTargetId: `runtime:new_${overrides.eventKind === "investigate" ? "fact" : overrides.eventKind === "item" ? "item" : "enemy"}` } : {})
  };
}

const validLocation: ProposedNewLocation = {
  name: "废弃货栈",
  description: "码头边长期无人问津的旧货栈。",
  scale: "scene",
  connectFromLocationId: "loc_1",
  reason: "线人约定在此交接密信。"
};

const validNpc: ProposedNewNpc = {
  name: "神秘线人",
  role: "情报贩子",
  description: "一个戴着斗笠的神秘人物，专门贩卖江湖情报。",
  locationId: "loc_1"
};

describe("approveBlueprintExpansion 闸门顺序", () => {
  it("无提案 → none_proposed", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan: buildPlan({ proposedNewLocations: [], proposedNewNpcs: [] })
    });
    expect(decision).toEqual({ ok: false, reason: "none_proposed" });
  });

  it("name 超 20 码点 → invalid_payload", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan: buildPlan({
        proposedNewLocations: [{ ...validLocation, name: "这个名字超过了二十个码点的限制长度啊啊啊啊" }]
      })
    });
    expect(decision).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("description 不足 10 码点 → invalid_payload", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan: buildPlan({
        proposedNewLocations: [{ ...validLocation, description: "太短了" }]
      })
    });
    expect(decision).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("npc.locationId 既非蓝图既有 ID 也非哨兵 new:0 → invalid_payload", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan: buildPlan({
        proposedNewNpcs: [{ ...validNpc, locationId: "loc_nonexistent" }]
      })
    });
    expect(decision).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("npc 用 new:0 但无新地点提案 → invalid_payload", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan: buildPlan({
        proposedNewLocations: [],
        proposedNewNpcs: [{ ...validNpc, locationId: "new:0" }]
      })
    });
    expect(decision).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("connectFromLocationId 非蓝图既有 ID → invalid_payload", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan: buildPlan({
        proposedNewLocations: [{ ...validLocation, connectFromLocationId: "loc_nonexistent" }]
      })
    });
    expect(decision).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("pacing climax → pacing_locked（即使载荷合法）", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan: buildPlan({ proposedNewLocations: [validLocation], pacing: "climax" })
    });
    expect(decision).toEqual({ ok: false, reason: "pacing_locked" });
  });

  it("pacing resolution → pacing_locked", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan: buildPlan({ proposedNewLocations: [validLocation], pacing: "resolution" })
    });
    expect(decision).toEqual({ ok: false, reason: "pacing_locked" });
  });

  it("激活主线为终幕 → endgame_locked", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState({ activeMainStage: 3 }),
      plan: buildPlan({ proposedNewLocations: [validLocation] })
    });
    expect(decision).toEqual({ ok: false, reason: "endgame_locked" });
  });

  it("主线已全部完成 → endgame_locked", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState({ allMainCompleted: true }),
      plan: buildPlan({ proposedNewLocations: [validLocation] })
    });
    expect(decision).toEqual({ ok: false, reason: "endgame_locked" });
  });

  it("地点总数达软上限 8 → soft_cap_reached", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint({ locationCount: 8 }),
      state: buildState(),
      plan: buildPlan({ proposedNewLocations: [validLocation] })
    });
    expect(decision).toEqual({ ok: false, reason: "soft_cap_reached" });
  });

  it("open 档软上限为 null → 同状态放行", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint({ locationCount: 8, gameLength: "open" }),
      state: buildState(),
      plan: buildPlan({ proposedNewLocations: [validLocation] })
    });
    expect(decision.ok).toBe(true);
  });

  it("NPC 总数达软上限 10 → soft_cap_reached", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint({ npcCount: 10 }),
      state: buildState(),
      plan: buildPlan({ proposedNewNpcs: [validNpc] })
    });
    expect(decision).toEqual({ ok: false, reason: "soft_cap_reached" });
  });

  it("地点总数达硬上限 40 → hard_cap_reached", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint({ locationCount: 40, gameLength: "open" }),
      state: buildState(),
      plan: buildPlan({ proposedNewLocations: [validLocation] })
    });
    expect(decision).toEqual({ ok: false, reason: "hard_cap_reached" });
  });

  it("connectFrom 未解锁 → connect_not_unlocked", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState({ unlockedIds: ["loc_1"] }),
      plan: buildPlan({
        proposedNewLocations: [{ ...validLocation, connectFromLocationId: "loc_2" }]
      })
    });
    expect(decision).toEqual({ ok: false, reason: "connect_not_unlocked" });
  });

  it("town 提案且 town 已达 2 → town_cap_reached", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint({ townCount: 2 }),
      state: buildState(),
      plan: buildPlan({
        proposedNewLocations: [{ ...validLocation, scale: "town" }]
      })
    });
    expect(decision).toEqual({ ok: false, reason: "town_cap_reached" });
  });

  it("合法地点提案 → ok 且 expansion 为逐字段重建（引用不等于输入）", () => {
    const plan = buildPlan({ proposedNewLocations: [validLocation], proposedNewNpcs: [] });
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.expansion.newLocation).toEqual(validLocation);
      expect(decision.expansion.newLocation).not.toBe(plan.proposedNewLocations[0]);
      expect(decision.expansion.newNpc).toBeNull();
    }
  });

  it("合法 NPC 提案 → ok 且 expansion.newNpc 逐字段重建", () => {
    const plan = buildPlan({ proposedNewLocations: [], proposedNewNpcs: [validNpc] });
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.expansion.newNpc).toEqual(validNpc);
      expect(decision.expansion.newNpc).not.toBe(plan.proposedNewNpcs[0]);
      expect(decision.expansion.newLocation).toBeNull();
    }
  });

  it("合法地点 + NPC 提案 → ok 且两者均重建", () => {
    const npcAtNew: ProposedNewNpc = { ...validNpc, locationId: "new:0" };
    const plan = buildPlan({ proposedNewLocations: [validLocation], proposedNewNpcs: [npcAtNew] });
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.expansion.newLocation).toEqual(validLocation);
      expect(decision.expansion.newNpc).toEqual(npcAtNew);
    }
  });

  it("调查事件可审批一个懒生成事实，并拒绝同场多个资源", () => {
    const fact: ProposedNewFact = {
      text: "维修记录里藏着一段被删去的时间戳。",
      locationId: "loc_1",
      reason: "玩家调查设备残留信息。"
    };
    const item: ProposedNewItem = {
      name: "加密维修卡",
      description: "一张刻着维修权限的薄卡。",
      kind: "key",
      tags: ["station"],
      locationId: "loc_1"
    };
    const valid = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan: buildPlan({ eventKind: "investigate", proposedNewFacts: [fact] })
    });
    expect(valid).toMatchObject({ ok: true, expansion: { newFact: fact, newItem: null, newEnemy: null } });
    if (valid.ok) expect(valid.expansion.newFact).not.toBe(fact);

    const rejected = approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan: buildPlan({ eventKind: "investigate", proposedNewFacts: [fact], proposedNewItems: [item] })
    });
    expect(rejected).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("物品和战斗懒资源必须绑定各自的原子事件与当前地点", () => {
    const item: ProposedNewItem = {
      name: "加密维修卡",
      description: "一张刻着维修权限的薄卡。",
      kind: "key",
      tags: [],
      locationId: "loc_1"
    };
    const enemy: ProposedNewEnemy = {
      name: "失控维修无人机",
      tier: "normal",
      stats: { hp: 12, attack: 4, defense: 2 },
      locationId: "loc_1",
      reason: "故障设施触发防御单位。"
    };
    expect(approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan: buildPlan({ eventKind: "item", proposedNewItems: [item] })
    })).toMatchObject({ ok: true, expansion: { newItem: item } });
    expect(approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan: buildPlan({ eventKind: "battle", proposedNewEnemies: [enemy] })
    })).toMatchObject({ ok: true, expansion: { newEnemy: enemy } });
    expect(approveBlueprintExpansion({
      blueprint: buildBlueprint(),
      state: buildState(),
      plan: buildPlan({ eventKind: "battle", proposedNewEnemies: [{ ...enemy, locationId: "loc_2" }] })
    })).toEqual({ ok: false, reason: "invalid_payload" });
  });
});
