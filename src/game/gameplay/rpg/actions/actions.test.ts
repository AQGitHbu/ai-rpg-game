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
  type ScenarioBlueprint
} from "@/game/domain";
import {
  validateIntent,
  resolveAction,
  projectAvailableActions,
  type PlayerIntent
} from "./index";

// ---------------------------------------------------------------------------
// 测试 fixture：手工构造最小蓝图 + 状态，覆盖 Phase 3 行动场景。
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

function buildBlueprint(): ScenarioBlueprint {
  const candidate = {
    schemaVersion: 1 as const,
    generationId: "gen-0001",
    seed: "seed-1",
    templateVersion: "tpl-1",
    gameType: "wuxia" as const,
    inputDigest: "digest-abc",
    world: {
      summary: "测试世界。",
      tone: "测试",
      themes: ["测试"],
      facts: [
        { id: "fact_known", text: "已知事实。", source: "player_input" as const },
        { id: "fact_investigable", text: "可调查事实。", source: "generated" as const },
        { id: "fact_other", text: "其他事实。", source: "generated" as const },
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
      { id: "loc_a", name: "地点A", description: "测试地点A。", kind: "main" as const, connectedLocationIds: ["loc_b"], npcIds: ["npc_1"], tags: [] },
      { id: "loc_b", name: "地点B", description: "测试地点B。", kind: "main" as const, connectedLocationIds: ["loc_a"], npcIds: ["npc_2"], tags: [] },
      { id: "loc_c", name: "地点C", description: "测试地点C。", kind: "main" as const, connectedLocationIds: ["loc_a"], npcIds: [], tags: [] },
      { id: "loc_d", name: "地点D", description: "测试地点D。", kind: "main" as const, connectedLocationIds: ["loc_c"], npcIds: [], tags: [] },
    ],
    npcs: [
      { id: "npc_1", name: "NPC1", role: "线人", description: "在场NPC。", locationId: "loc_a", isCompanion: false, knownFactIds: [], tags: [] },
      { id: "npc_2", name: "NPC2", role: "商贩", description: "不在场NPC。", locationId: "loc_b", isCompanion: false, knownFactIds: [], tags: [] },
    ],
    quests: [
      { kind: "main" as const, stage: 1 as const, id: "q1", name: "主线", description: "主线任务。", objectives: [{ kind: "visit_location" as const, locationId: "loc_b" }], onSuccess: { kind: "unlock_quests" as const, questIds: ["q2"] }, onFailure: { kind: "closed" as const }, tags: [] },
      { kind: "main" as const, stage: 2 as const, id: "q2", name: "主线2", description: "主线2。", objectives: [{ kind: "defeat_enemy" as const, enemyId: "enemy_1" }], onSuccess: { kind: "reach_ending" as const, endingId: "e1" }, onFailure: { kind: "reach_ending" as const, endingId: "e2" }, tags: [] },
    ],
    enemies: [
      { id: "enemy_1", name: "敌人", tier: "boss" as const, stats: { hp: 50, attack: 8, defense: 3 }, tags: [] },
    ],
    items: [
      { id: "item_1", name: "物品", description: "测试物品。", kind: "weapon", tags: [] },
    ],
    endings: [
      { id: "e1", name: "结局1", description: "好结局。", requirements: [{ kind: "quest_completed" as const, questId: "q2" }] },
      { id: "e2", name: "结局2", description: "坏结局。", requirements: [{ kind: "fact_discovered" as const, factId: "fact_investigable" }] },
    ],
    openingScene: {
      id: "scene_opening",
      locationId: "loc_a",
      narration: "测试开场叙事。",
      presentNpcIds: ["npc_1"],
      suggestedActions: ["观察周围", "与NPC1交谈"],
      investigableFactIds: ["fact_investigable"],
    },
    contentBudget: { mainLocations: 4, hiddenLocationsMax: 1, coreNpcsMin: 4, coreNpcsMax: 6, companionsMax: 1, sideQuestsMax: 2, endings: 2 },
  };
  return candidate as unknown as ScenarioBlueprint;
}

function buildInitialState(): GameState {
  return {
    stateVersion: 1,
    generation: GEN,
    player: { name: "测试角色", identity: "测试身份", stats: { hp: 30, attack: 6, defense: 4 } },
    currentLocationId: LOC_A,
    unlockedLocationIds: [LOC_A, LOC_B, LOC_C, LOC_D],
    npcs: [
      { npcId: NPC_1, locationId: LOC_A, met: false },
      { npcId: NPC_2, locationId: LOC_B, met: false },
    ],
    quests: [
      { questId: asQuestId("q1"), status: "active" },
      { questId: asQuestId("q2"), status: "locked" },
    ],
    inventory: [asItemId("item_1")],
    worldFacts: [
      { factId: FACT_KNOWN, discovered: true },
      { factId: FACT_INVESTIGABLE, discovered: false },
      { factId: FACT_OTHER, discovered: false },
    ],
    eventLedger: [{ type: "game_initialized", generation: GEN }],
  };
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
      });
      const npc = result.state.npcs.find((n) => n.npcId === NPC_1);
      expect(npc?.met).toBe(true);
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
