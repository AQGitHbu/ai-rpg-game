import { describe, expect, it } from "vitest";
import {
  asFactId,
  asLocationId,
  asNpcId,
  asGenerationId,
  asItemId,
  asQuestId,
  type GameState,
  type GenerationMetadata,
  type ScenarioBlueprint,
  type ScenarioBlueprintCandidate
} from "@/game/domain";
import {
  compileScenarioBlueprint,
  validateScenarioBlueprintCandidate
} from "../scenario";
import { TEST_POLICY, TEST_PROFILE } from "../scenario/scenarioBlueprintFixture.testutil";
import { reconcileQuests } from "../quests";
import {
  validateIntent,
  resolveAction,
  projectAvailableActions,
  type PlayerIntent
} from "./index";

// ---------------------------------------------------------------------------
// 测试 fixture：手工构造最小候选蓝图，走真实 validate → compile 管线获得
// 品牌化 ScenarioBlueprint（不再强转），覆盖 Phase 3 行动、Phase 4 move
//（`location_visited`）与 Phase 5 take_item（`item_obtained`）场景。
// ---------------------------------------------------------------------------

const GEN: GenerationMetadata = {
  generationId: asGenerationId("gen-0001"),
  seed: "seed-1",
  templateVersion: "tpl-1",
  inputDigest: "digest-abc",
  gameType: "wuxia",
};

const LOC_A = asLocationId("loc_a");
const LOC_B = asLocationId("loc_b");
const LOC_C = asLocationId("loc_c");
const LOC_D = asLocationId("loc_d");
const NPC_1 = asNpcId("npc_1");
const NPC_2 = asNpcId("npc_2");
const FACT_KNOWN = asFactId("fact_known");
const FACT_INVESTIGABLE = asFactId("fact_investigable");
const FACT_OTHER = asFactId("fact_other");
// 物品布局：item_1 为初始背包物品（不可再取得）；item_2 预置在 loc_a；
// item_3 预置在 loc_b；item_4 存在但未配置在任何地点。
const ITEM_START = asItemId("item_1");
const ITEM_AT_A = asItemId("item_2");
const ITEM_AT_B = asItemId("item_3");
const ITEM_UNPLACED = asItemId("item_4");

function buildBlueprint(): ScenarioBlueprint {
  const candidate: ScenarioBlueprintCandidate = {
    schemaVersion: 1,
    generationId: "gen-0001",
    seed: "seed-1",
    templateVersion: "tpl-1",
    gameType: "wuxia",
    inputDigest: "digest-abc",
    world: {
      summary: "测试世界。",
      tone: "测试",
      themes: ["测试"],
      facts: [
        { id: "fact_known", text: "已知事实。", source: "player_input" },
        { id: "fact_investigable", text: "可调查事实。", source: "generated" },
        { id: "fact_other", text: "其他事实。", source: "player_input" },
      ],
      tags: ["测试"],
    },
    player: {
      name: "测试角色",
      identity: "测试身份",
      backgroundSummary: "测试背景。",
      startingLocationId: "loc_a",
      startingItemIds: ["item_1"],
      baseStats: { hp: 30, attack: 6, defense: 4 },
    },
    locations: [
      { id: "loc_a", name: "地点A", description: "测试地点A。", kind: "main", connectedLocationIds: ["loc_b"], npcIds: ["npc_1"], availableItemIds: ["item_2"], tags: [] },
      { id: "loc_b", name: "地点B", description: "测试地点B。", kind: "main", connectedLocationIds: ["loc_a"], npcIds: ["npc_2"], availableItemIds: ["item_3"], tags: [] },
      { id: "loc_c", name: "地点C", description: "测试地点C。", kind: "main", connectedLocationIds: ["loc_a"], npcIds: ["npc_3"], availableItemIds: [], tags: [] },
      { id: "loc_d", name: "地点D", description: "测试地点D。", kind: "main", connectedLocationIds: ["loc_c"], npcIds: ["npc_4"], availableItemIds: [], tags: [] },
    ],
    npcs: [
      { id: "npc_1", name: "NPC1", role: "线人", description: "在场NPC。", locationId: "loc_a", isCompanion: false, knownFactIds: [], tags: [] },
      { id: "npc_2", name: "NPC2", role: "商贩", description: "不在场NPC。", locationId: "loc_b", isCompanion: false, knownFactIds: [], tags: [] },
      { id: "npc_3", name: "NPC3", role: "盟友", description: "内容预算补位NPC。", locationId: "loc_c", isCompanion: false, knownFactIds: [], tags: [] },
      { id: "npc_4", name: "NPC4", role: "同伴", description: "内容预算补位NPC。", locationId: "loc_d", isCompanion: false, knownFactIds: [], tags: [] },
    ],
    quests: [
      { kind: "main", stage: 1, id: "q1", name: "主线", description: "主线任务。", objectives: [{ kind: "visit_location", locationId: "loc_b" }], onSuccess: { kind: "unlock_quests", questIds: ["q2"] }, onFailure: { kind: "closed" }, tags: [] },
      { kind: "main", stage: 2, id: "q2", name: "主线2", description: "主线2。", objectives: [{ kind: "talk_to_npc", npcId: "npc_2" }, { kind: "obtain_item", itemId: "item_3" }], onSuccess: { kind: "unlock_quests", questIds: ["q3"] }, onFailure: { kind: "closed" }, tags: [] },
      { kind: "main", stage: 3, id: "q3", name: "主线3", description: "主线3。", objectives: [{ kind: "defeat_enemy", enemyId: "enemy_1" }], onSuccess: { kind: "reach_ending", endingId: "e1" }, onFailure: { kind: "reach_ending", endingId: "e2" }, tags: [] },
    ],
    enemies: [
      { id: "enemy_1", name: "敌人", tier: "boss", stats: { hp: 50, attack: 8, defense: 3 }, locationId: "loc_d", tags: [] },
    ],
    items: [
      { id: "item_1", name: "物品", description: "测试物品。", kind: "weapon", tags: [] },
      { id: "item_2", name: "地点A物品", description: "预置在地点A。", kind: "key", tags: [] },
      { id: "item_3", name: "地点B物品", description: "预置在地点B。", kind: "key", tags: [] },
      { id: "item_4", name: "无主物品", description: "未配置在任何地点。", kind: "misc", tags: [] },
    ],
    endings: [
      { id: "e1", name: "结局1", description: "好结局。", requirements: [{ kind: "quest_completed", questId: "q3" }] },
      { id: "e2", name: "结局2", description: "坏结局。", requirements: [{ kind: "fact_discovered", factId: "fact_investigable" }] },
    ],
    openingScene: {
      id: "scene_opening",
      locationId: "loc_a",
      narration: "测试开场叙事。",
      presentNpcIds: ["npc_1"],
      suggestedActions: ["观察周围", "与NPC1交谈"],
      investigableFactIds: ["fact_investigable"],
    },
    budgetPolicy: TEST_POLICY,
  };
  const compiled = compileScenarioBlueprint(
    validateScenarioBlueprintCandidate(candidate, { profile: TEST_PROFILE, policy: TEST_POLICY })
  );
  if (!compiled.ok) {
    throw new Error(`fixture 蓝图应当合法：${JSON.stringify(compiled.issues)}`);
  }
  return compiled.blueprint;
}

function buildInitialState(): GameState {
  return {
    stateVersion: 1,
    generation: GEN,
    player: { name: "测试角色", identity: "测试身份", stats: { hp: 30, attack: 6, defense: 4 } },
    currentLocationId: LOC_A,
    unlockedLocationIds: [LOC_A, LOC_B, LOC_C, LOC_D],
    visitedLocationIds: [LOC_A],
    npcs: [
      { npcId: NPC_1, locationId: LOC_A, met: false },
      { npcId: NPC_2, locationId: LOC_B, met: false },
    ],
    quests: [
      { questId: asQuestId("q1"), status: "active" },
      { questId: asQuestId("q2"), status: "locked" },
      { questId: asQuestId("q3"), status: "locked" },
    ],
    inventory: [ITEM_START],
    worldFacts: [
      { factId: FACT_KNOWN, discovered: true },
      { factId: FACT_INVESTIGABLE, discovered: false },
      { factId: FACT_OTHER, discovered: false },
    ],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
    towns: [],
    townGeneration: { status: "idle" },
    eventLedger: [{ type: "game_initialized", generation: GEN }],
  };
}

/** 走真实规则管线：move 到 loc_b → q1 完成、q2（talk_to_npc npc_2）激活。 */
function buildActiveTalkTargetState(blueprint: ScenarioBlueprint): GameState {
  const moved = resolveAction(blueprint, buildInitialState(), { type: "move", locationId: LOC_B }, deps);
  if (!moved.ok) throw new Error(`前置 move 应当成功：${moved.code}`);
  const state = reconcileQuests(blueprint, moved.state, deps).state;
  const q2 = state.quests.find((quest) => quest.questId === asQuestId("q2"));
  if (q2?.status !== "active") throw new Error("前置条件失败：q2 应当已激活");
  return state;
}

const FIXED_TIME = "2026-07-27T10:00:00Z";
const deps = { now: () => FIXED_TIME };

// ---------------------------------------------------------------------------
// validateIntent
// ---------------------------------------------------------------------------

describe("validateIntent", () => {
  it("observe 当前地点有效", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "observe", locationId: LOC_A });
    expect(result.ok).toBe(true);
  });

  it("observe 非当前地点拒绝 (LOCATION_NOT_CURRENT)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "observe", locationId: LOC_B });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("LOCATION_NOT_CURRENT");
    }
  });

  it("observe 未知地点拒绝 (UNKNOWN_LOCATION)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "observe", locationId: asLocationId("ghost") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_LOCATION");
    }
  });

  it("observe 已观察过的地点拒绝 (LOCATION_ALREADY_OBSERVED)", () => {
    const bp = buildBlueprint();
    const st: GameState = {
      ...buildInitialState(),
      eventLedger: [
        { type: "game_initialized", generation: GEN },
        { type: "location_observed", locationId: LOC_A, occurredAt: FIXED_TIME },
      ],
    };
    const result = validateIntent(bp, st, { type: "observe", locationId: LOC_A });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("LOCATION_ALREADY_OBSERVED");
    }
  });

  it("talk 在场 NPC 有效", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "talk", npcId: NPC_1 });
    expect(result.ok).toBe(true);
  });

  it("talk 不在场 NPC 拒绝 (NPC_NOT_PRESENT)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "talk", npcId: NPC_2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NPC_NOT_PRESENT");
    }
  });

  it("talk 未知 NPC 拒绝 (UNKNOWN_NPC)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "talk", npcId: asNpcId("ghost") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_NPC");
    }
  });

  it("talk 已见 NPC 拒绝 (NPC_ALREADY_MET)", () => {
    const bp = buildBlueprint();
    const st: GameState = {
      ...buildInitialState(),
      npcs: [
        { npcId: NPC_1, locationId: LOC_A, met: true },
        { npcId: NPC_2, locationId: LOC_B, met: false },
      ],
    };
    const result = validateIntent(bp, st, { type: "talk", npcId: NPC_1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NPC_ALREADY_MET");
    }
  });

  it("investigate 可调查事实有效", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "investigate", factId: FACT_INVESTIGABLE });
    expect(result.ok).toBe(true);
  });

  it("investigate 不可调查事实拒绝 (FACT_NOT_INVESTIGABLE)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "investigate", factId: FACT_OTHER });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FACT_NOT_INVESTIGABLE");
    }
  });

  it("investigate 未知事实拒绝 (UNKNOWN_FACT)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "investigate", factId: asFactId("ghost") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_FACT");
    }
  });

  it("investigate 已发现事实拒绝 (FACT_ALREADY_DISCOVERED)", () => {
    const bp = buildBlueprint();
    const st: GameState = {
      ...buildInitialState(),
      worldFacts: [
        { factId: FACT_KNOWN, discovered: true },
        { factId: FACT_INVESTIGABLE, discovered: true },
        { factId: FACT_OTHER, discovered: false },
      ],
    };
    const result = validateIntent(bp, st, { type: "investigate", factId: FACT_INVESTIGABLE });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("FACT_ALREADY_DISCOVERED");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveAction
// ---------------------------------------------------------------------------

describe("resolveAction", () => {
  it("observe 成功：追加事件、状态不可变、反馈确定", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const snapshot = JSON.stringify(st);
    const result = resolveAction(bp, st, { type: "observe", locationId: LOC_A }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({
        type: "location_observed",
        locationId: LOC_A,
        occurredAt: FIXED_TIME,
      });
      expect(result.state.eventLedger).toHaveLength(2);
      expect(result.state.eventLedger[1]).toEqual(result.events[0]);
      expect(result.feedback.message).toBeTruthy();
    }
    // 不修改输入
    expect(JSON.stringify(st)).toBe(snapshot);
  });

  it("talk 成功：NPC 标记为已见、追加事件", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = resolveAction(bp, st, { type: "talk", npcId: NPC_1 }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({
        type: "npc_met",
        npcId: NPC_1,
        occurredAt: FIXED_TIME,
        interactionKind: "greet",
      });
      const npc = result.state.npcs.find((n) => n.npcId === NPC_1);
      expect(npc?.met).toBe(true);
      expect(npc?.relationship).toEqual({ affinity: 5 });
      expect(result.state.eventLedger).toHaveLength(2);
    }
  });

  it("investigate 成功：事实标记为已发现、追加事件", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = resolveAction(bp, st, { type: "investigate", factId: FACT_INVESTIGABLE }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({
        type: "fact_discovered",
        factId: FACT_INVESTIGABLE,
        occurredAt: FIXED_TIME,
      });
      const fact = result.state.worldFacts.find((f) => f.factId === FACT_INVESTIGABLE);
      expect(fact?.discovered).toBe(true);
      expect(result.state.eventLedger).toHaveLength(2);
    }
  });

  it("无效 intent 返回拒绝且不返回 next state", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = resolveAction(bp, st, { type: "talk", npcId: NPC_2 }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NPC_NOT_PRESENT");
      expect(result.feedback.message).toBeTruthy();
      // 拒绝不返回 state
      expect("state" in result).toBe(false);
    }
  });

  it("拒绝不产生事件、不修改状态、不递增 ledger", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const snapshot = JSON.stringify(st);
    const result = resolveAction(bp, st, { type: "investigate", factId: FACT_OTHER }, deps);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(st)).toBe(snapshot);
  });

  it("相同输入和注入依赖产出相同结果（确定性）", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const intent: PlayerIntent = { type: "observe", locationId: LOC_A };
    const r1 = resolveAction(bp, st, intent, deps);
    const r2 = resolveAction(bp, st, intent, deps);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("不修改输入蓝图和状态（不可变）", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const bpSnapshot = JSON.stringify(bp);
    const stSnapshot = JSON.stringify(st);
    resolveAction(bp, st, { type: "observe", locationId: LOC_A }, deps);
    expect(JSON.stringify(bp)).toBe(bpSnapshot);
    expect(JSON.stringify(st)).toBe(stSnapshot);
  });

  it("事件账本只追加，不重写初始化事件", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = resolveAction(bp, st, { type: "observe", locationId: LOC_A }, deps);
    if (result.ok) {
      expect(result.state.eventLedger[0]).toEqual({ type: "game_initialized", generation: GEN });
    }
  });
});

// ---------------------------------------------------------------------------
// projectAvailableActions
// ---------------------------------------------------------------------------

describe("projectAvailableActions", () => {
  it("投影当前地点的 observe 行动", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const actions = projectAvailableActions(bp, st);
    const observeActions = actions.filter((a) => a.type === "observe");
    expect(observeActions).toHaveLength(1);
    expect(observeActions[0].locationId).toBe(LOC_A);
  });

  it("投影在场 NPC 的 talk 行动", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const actions = projectAvailableActions(bp, st);
    const talkActions = actions.filter((a) => a.type === "talk");
    expect(talkActions).toHaveLength(1);
    expect(talkActions[0].npcId).toBe(NPC_1);
  });

  it("投影可调查事实的 investigate 行动", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const actions = projectAvailableActions(bp, st);
    const investigateActions = actions.filter((a) => a.type === "investigate");
    expect(investigateActions).toHaveLength(1);
    expect(investigateActions[0].factId).toBe(FACT_INVESTIGABLE);
  });

  it("已观察过的地点不投影 observe 行动", () => {
    const bp = buildBlueprint();
    const st: GameState = {
      ...buildInitialState(),
      eventLedger: [
        { type: "game_initialized", generation: GEN },
        { type: "location_observed", locationId: LOC_A, occurredAt: FIXED_TIME },
      ],
    };
    const actions = projectAvailableActions(bp, st);
    expect(actions.filter((a) => a.type === "observe")).toHaveLength(0);
  });

  it("已见的 NPC 不投影 talk 行动", () => {
    const bp = buildBlueprint();
    const st: GameState = {
      ...buildInitialState(),
      npcs: [
        { npcId: NPC_1, locationId: LOC_A, met: true },
        { npcId: NPC_2, locationId: LOC_B, met: false },
      ],
    };
    const actions = projectAvailableActions(bp, st);
    expect(actions.filter((a) => a.type === "talk")).toHaveLength(0);
  });

  it("已发现的事实不投影 investigate 行动", () => {
    const bp = buildBlueprint();
    const st: GameState = {
      ...buildInitialState(),
      worldFacts: [
        { factId: FACT_KNOWN, discovered: true },
        { factId: FACT_INVESTIGABLE, discovered: true },
        { factId: FACT_OTHER, discovered: false },
      ],
    };
    const actions = projectAvailableActions(bp, st);
    expect(actions.filter((a) => a.type === "investigate")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// move（Phase 4 Task 1）：validateIntent
// ---------------------------------------------------------------------------

describe("validateIntent: move", () => {
  it("move 到连通且已解锁的非当前地点有效", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "move", locationId: LOC_B });
    expect(result.ok).toBe(true);
  });

  it("move 未知地点拒绝 (UNKNOWN_LOCATION)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "move", locationId: asLocationId("ghost") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_LOCATION");
    }
  });

  it("move 当前地点拒绝 (LOCATION_ALREADY_CURRENT)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "move", locationId: LOC_A });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("LOCATION_ALREADY_CURRENT");
    }
  });

  it("move 未连通地点拒绝 (LOCATION_NOT_CONNECTED)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    // loc_c 连向 loc_a，但 loc_a 的 connectedLocationIds 只有 loc_b：连通性只读当前地点出边。
    const result = validateIntent(bp, st, { type: "move", locationId: LOC_C });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("LOCATION_NOT_CONNECTED");
    }
  });

  it("move 未解锁地点拒绝 (LOCATION_LOCKED)", () => {
    const bp = buildBlueprint();
    const st: GameState = {
      ...buildInitialState(),
      unlockedLocationIds: [LOC_A, LOC_C, LOC_D],
    };
    const result = validateIntent(bp, st, { type: "move", locationId: LOC_B });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("LOCATION_LOCKED");
    }
  });
});

// ---------------------------------------------------------------------------
// move（Phase 4 Task 1）：resolveAction
// ---------------------------------------------------------------------------

describe("resolveAction: move", () => {
  it("move 成功：切换当前地点、记录访问、追加 location_visited 事件", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const snapshot = JSON.stringify(st);
    const result = resolveAction(bp, st, { type: "move", locationId: LOC_B }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.currentLocationId).toBe(LOC_B);
      expect(result.state.visitedLocationIds).toEqual([LOC_A, LOC_B]);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({
        type: "location_visited",
        locationId: LOC_B,
        occurredAt: FIXED_TIME,
      });
      expect(result.state.eventLedger).toHaveLength(2);
      expect(result.state.eventLedger[1]).toEqual(result.events[0]);
      expect(result.feedback.message).toBeTruthy();
    }
    // 不修改输入
    expect(JSON.stringify(st)).toBe(snapshot);
  });

  it("move 回到已访问地点：事件照常追加，visitedLocationIds 不重复", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const first = resolveAction(bp, st, { type: "move", locationId: LOC_B }, deps);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = resolveAction(bp, first.state, { type: "move", locationId: LOC_A }, deps);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.state.currentLocationId).toBe(LOC_A);
      expect(second.state.visitedLocationIds).toEqual([LOC_A, LOC_B]);
      expect(second.state.eventLedger).toHaveLength(3);
      expect(second.state.eventLedger[2]).toEqual({
        type: "location_visited",
        locationId: LOC_A,
        occurredAt: FIXED_TIME,
      });
    }
  });

  it("move 各拒绝码零状态变化、不产生事件", () => {
    const bp = buildBlueprint();
    const rejections: readonly { readonly state: GameState; readonly target: string; readonly code: string }[] = [
      { state: buildInitialState(), target: "ghost", code: "UNKNOWN_LOCATION" },
      { state: buildInitialState(), target: "loc_a", code: "LOCATION_ALREADY_CURRENT" },
      { state: buildInitialState(), target: "loc_c", code: "LOCATION_NOT_CONNECTED" },
      {
        state: { ...buildInitialState(), unlockedLocationIds: [LOC_A, LOC_C, LOC_D] },
        target: "loc_b",
        code: "LOCATION_LOCKED",
      },
    ];
    for (const { state, target, code } of rejections) {
      const snapshot = JSON.stringify(state);
      const result = resolveAction(bp, state, { type: "move", locationId: asLocationId(target) }, deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(code);
        expect(result.feedback.message).toBeTruthy();
        expect("state" in result).toBe(false);
      }
      expect(JSON.stringify(state)).toBe(snapshot);
    }
  });
});

// ---------------------------------------------------------------------------
// move（Phase 4 Task 1）：当前场景投影与场景切换
// ---------------------------------------------------------------------------

describe("projectAvailableActions: move 与场景切换", () => {
  it("投影当前地点连通且解锁的 move 行动", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const moveActions = projectAvailableActions(bp, st).filter((a) => a.type === "move");
    expect(moveActions).toHaveLength(1);
    expect(moveActions[0].locationId).toBe(LOC_B);
  });

  it("未解锁的连通地点不投影 move 行动", () => {
    const bp = buildBlueprint();
    const st: GameState = {
      ...buildInitialState(),
      unlockedLocationIds: [LOC_A, LOC_C, LOC_D],
    };
    const moveActions = projectAvailableActions(bp, st).filter((a) => a.type === "move");
    expect(moveActions).toHaveLength(0);
  });

  it("移动后 talk 行动切换到新地点 NPC，opening NPC 不泄漏", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const moved = resolveAction(bp, st, { type: "move", locationId: LOC_B }, deps);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const talkActions = projectAvailableActions(bp, moved.state).filter((a) => a.type === "talk");
    expect(talkActions).toHaveLength(1);
    expect(talkActions[0].npcId).toBe(NPC_2);
  });

  it("移动后 talk 校验：新地点 NPC 有效，旧 opening NPC 拒绝 (NPC_NOT_PRESENT)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const moved = resolveAction(bp, st, { type: "move", locationId: LOC_B }, deps);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(validateIntent(bp, moved.state, { type: "talk", npcId: NPC_2 }).ok).toBe(true);
    const stale = validateIntent(bp, moved.state, { type: "talk", npcId: NPC_1 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe("NPC_NOT_PRESENT");
    }
  });

  it("移动后新地点的 observe 行动可用", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const moved = resolveAction(bp, st, { type: "move", locationId: LOC_B }, deps);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const observeActions = projectAvailableActions(bp, moved.state).filter((a) => a.type === "observe");
    expect(observeActions).toHaveLength(1);
    expect(observeActions[0].locationId).toBe(LOC_B);
    expect(validateIntent(bp, moved.state, { type: "observe", locationId: LOC_B }).ok).toBe(true);
  });

  it("移动后 opening 场景的 investigate 不泄漏到其他地点", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const moved = resolveAction(bp, st, { type: "move", locationId: LOC_B }, deps);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const investigateActions = projectAvailableActions(bp, moved.state).filter(
      (a) => a.type === "investigate",
    );
    expect(investigateActions).toHaveLength(0);
    const rejected = validateIntent(bp, moved.state, { type: "investigate", factId: FACT_INVESTIGABLE });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.code).toBe("FACT_NOT_INVESTIGABLE");
    }
  });
});

// ---------------------------------------------------------------------------
// take_item（Phase 5 Task 2）：validateIntent
// ---------------------------------------------------------------------------

describe("validateIntent: take_item", () => {
  it("take_item 当前地点预置且未拥有的物品有效", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "take_item", itemId: ITEM_AT_A });
    expect(result.ok).toBe(true);
  });

  it("take_item 未知物品拒绝 (UNKNOWN_ITEM)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "take_item", itemId: asItemId("ghost") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_ITEM");
    }
  });

  it("take_item 配置在其他地点的物品拒绝 (ITEM_NOT_AVAILABLE_HERE)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "take_item", itemId: ITEM_AT_B });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ITEM_NOT_AVAILABLE_HERE");
    }
  });

  it("take_item 未配置在任何地点的物品拒绝 (ITEM_NOT_AVAILABLE_HERE)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, { type: "take_item", itemId: ITEM_UNPLACED });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ITEM_NOT_AVAILABLE_HERE");
    }
  });

  it("take_item 已拥有的当地物品拒绝 (ITEM_ALREADY_OWNED)", () => {
    const bp = buildBlueprint();
    const st: GameState = {
      ...buildInitialState(),
      inventory: [ITEM_START, ITEM_AT_A],
    };
    const result = validateIntent(bp, st, { type: "take_item", itemId: ITEM_AT_A });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ITEM_ALREADY_OWNED");
    }
  });
});

// ---------------------------------------------------------------------------
// take_item（Phase 5 Task 2）：resolveAction
// ---------------------------------------------------------------------------

describe("resolveAction: take_item", () => {
  it("take_item 成功：只追加背包 ID 与 item_obtained 事件，其余状态不变", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const snapshot = JSON.stringify(st);
    const result = resolveAction(bp, st, { type: "take_item", itemId: ITEM_AT_A }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({
        type: "item_obtained",
        itemId: ITEM_AT_A,
        locationId: LOC_A,
        occurredAt: FIXED_TIME,
      });
      expect(result.state.inventory).toEqual([ITEM_START, ITEM_AT_A]);
      expect(result.state.eventLedger).toHaveLength(2);
      expect(result.state.eventLedger[1]).toEqual(result.events[0]);
      // 不改变数值、NPC、任务、事实或地点。
      expect(result.state.player).toEqual(st.player);
      expect(result.state.npcs).toEqual(st.npcs);
      expect(result.state.quests).toEqual(st.quests);
      expect(result.state.worldFacts).toEqual(st.worldFacts);
      expect(result.state.currentLocationId).toBe(st.currentLocationId);
      expect(result.feedback.message).toBeTruthy();
    }
    // 不修改输入
    expect(JSON.stringify(st)).toBe(snapshot);
  });

  it("take_item 事件时间来自注入时钟", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const later = "2026-07-27T18:30:00Z";
    const result = resolveAction(bp, st, { type: "take_item", itemId: ITEM_AT_A }, { now: () => later });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events[0]).toMatchObject({ type: "item_obtained", occurredAt: later });
    }
  });

  it("移动后可取得新地点预置物品，事件携带新地点 ID", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const moved = resolveAction(bp, st, { type: "move", locationId: LOC_B }, deps);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const result = resolveAction(bp, moved.state, { type: "take_item", itemId: ITEM_AT_B }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events[0]).toEqual({
        type: "item_obtained",
        itemId: ITEM_AT_B,
        locationId: LOC_B,
        occurredAt: FIXED_TIME,
      });
      expect(result.state.inventory).toEqual([ITEM_START, ITEM_AT_B]);
    }
  });

  it("take_item 各拒绝码零状态变化、不产生事件", () => {
    const bp = buildBlueprint();
    const rejections: readonly { readonly state: GameState; readonly itemId: string; readonly code: string }[] = [
      { state: buildInitialState(), itemId: "ghost", code: "UNKNOWN_ITEM" },
      { state: buildInitialState(), itemId: "item_3", code: "ITEM_NOT_AVAILABLE_HERE" },
      { state: buildInitialState(), itemId: "item_4", code: "ITEM_NOT_AVAILABLE_HERE" },
      {
        state: { ...buildInitialState(), inventory: [ITEM_START, ITEM_AT_A] },
        itemId: "item_2",
        code: "ITEM_ALREADY_OWNED",
      },
    ];
    for (const { state, itemId, code } of rejections) {
      const snapshot = JSON.stringify(state);
      const result = resolveAction(bp, state, { type: "take_item", itemId: asItemId(itemId) }, deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(code);
        expect(result.feedback.message).toBeTruthy();
        expect("state" in result).toBe(false);
      }
      expect(JSON.stringify(state)).toBe(snapshot);
    }
  });
});

// ---------------------------------------------------------------------------
// dialogue_choice（Phase 13 Task 3）：resolveAction 关系变化
// ---------------------------------------------------------------------------

describe("resolveAction dialogue_choice 关系变化", () => {
  it("greet（首次结识）→ 好感度 +5", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = resolveAction(bp, st, {
      type: "dialogue_choice", npcId: NPC_1, choiceId: "npc_1:greet",
    } as never, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const npc = result.state.npcs.find((n) => n.npcId === NPC_1);
      expect(npc?.relationship?.affinity).toBe(5);
    }
  });

  it("ask_main_quest → 好感度 +10", () => {
    const bp = buildBlueprint();
    const st = buildActiveTalkTargetState(bp);
    const result = resolveAction(bp, st, {
      type: "dialogue_choice", npcId: NPC_2, choiceId: "npc_2:ask_main_quest",
    } as never, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const npc = result.state.npcs.find((n) => n.npcId === NPC_2);
      expect(npc?.relationship?.affinity).toBe(10);
    }
  });

  it("npc_met 事件携带 interactionKind greet", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = resolveAction(bp, st, {
      type: "dialogue_choice", npcId: NPC_1, choiceId: "npc_1:greet",
    } as never, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const event = result.events.find((e) => e.type === "npc_met");
      expect(event?.interactionKind).toBe("greet");
    }
  });

  it("npc_met 事件携带 interactionKind ask_main_quest", () => {
    const bp = buildBlueprint();
    const st = buildActiveTalkTargetState(bp);
    const result = resolveAction(bp, st, {
      type: "dialogue_choice", npcId: NPC_2, choiceId: "npc_2:ask_main_quest",
    } as never, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const event = result.events.find((e) => e.type === "npc_met");
      expect(event?.interactionKind).toBe("ask_main_quest");
    }
  });
});

// ---------------------------------------------------------------------------
// take_item（Phase 5 Task 2）：可用行动投影
// ---------------------------------------------------------------------------

describe("projectAvailableActions: take_item", () => {
  it("投影当前地点预置且未拥有的 take_item 行动", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const takeActions = projectAvailableActions(bp, st).filter((a) => a.type === "take_item");
    expect(takeActions).toHaveLength(1);
    expect(takeActions[0].itemId).toBe(ITEM_AT_A);
    expect(takeActions[0].label).toBeTruthy();
  });

  it("已拥有的当地物品不投影 take_item 行动", () => {
    const bp = buildBlueprint();
    const st: GameState = {
      ...buildInitialState(),
      inventory: [ITEM_START, ITEM_AT_A],
    };
    const takeActions = projectAvailableActions(bp, st).filter((a) => a.type === "take_item");
    expect(takeActions).toHaveLength(0);
  });

  it("移动后 take_item 投影切换到新地点的预置物品", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const moved = resolveAction(bp, st, { type: "move", locationId: LOC_B }, deps);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const takeActions = projectAvailableActions(bp, moved.state).filter((a) => a.type === "take_item");
    expect(takeActions).toHaveLength(1);
    expect(takeActions[0].itemId).toBe(ITEM_AT_B);
  });

  it("取得后同一物品不再投影 take_item 行动", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const taken = resolveAction(bp, st, { type: "take_item", itemId: ITEM_AT_A }, deps);
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    const takeActions = projectAvailableActions(bp, taken.state).filter((a) => a.type === "take_item");
    expect(takeActions).toHaveLength(0);
    // 重复取得被拒绝。
    const again = resolveAction(bp, taken.state, { type: "take_item", itemId: ITEM_AT_A }, deps);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.code).toBe("ITEM_ALREADY_OWNED");
    }
  });
});
