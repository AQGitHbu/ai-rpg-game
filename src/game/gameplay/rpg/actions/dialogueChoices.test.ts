import { describe, expect, it } from "vitest";
import {
  asFactId,
  asGenerationId,
  asItemId,
  asLocationId,
  asNpcId,
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
  makeDialogueChoiceId,
  projectDialogueChoices,
  resolveAction,
  validateIntent
} from "./index";

// ---------------------------------------------------------------------------
// Phase 7 Task 2：封闭的 NPC 对话选择规则。
// 复用 actions.test.ts 的合法 fixture 管线（validate → compile），钉住：
//   - makeDialogueChoiceId 只返回 `${npcId}:${kind}`，解析要求完全相等；
//   - greet 只在 NPC 在场、未结识且无 active talk_to_npc objective 时投影；
//   - ask_main_quest 只在存在未满足的 active 主线 talk_to_npc objective 时投影
//     （二者互斥）；已结识 NPC 投影空数组；
//   - 伪造/不可用 choice 返回稳定拒绝码且 state/event ledger 零变化。
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
const ITEM_START = asItemId("item_1");

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
        { id: "fact_other", text: "其他事实。", source: "generated" },
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
      { id: "npc_2", name: "NPC2", role: "商贩", description: "主线交谈目标NPC。", locationId: "loc_b", isCompanion: false, knownFactIds: [], tags: [] },
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
      { factId: asFactId("fact_known"), discovered: true },
      { factId: asFactId("fact_investigable"), discovered: false },
      { factId: asFactId("fact_other"), discovered: false },
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

const FIXED_TIME = "2026-07-27T10:00:00Z";
const deps = { now: () => FIXED_TIME };

/** 走真实规则管线：move 到 loc_b → q1 完成、q2（talk_to_npc npc_2）激活。 */
function buildActiveTalkTargetState(blueprint: ScenarioBlueprint): GameState {
  const moved = resolveAction(blueprint, buildInitialState(), { type: "move", locationId: LOC_B }, deps);
  if (!moved.ok) throw new Error(`前置 move 应当成功：${moved.code}`);
  const state = reconcileQuests(blueprint, moved.state, deps).state;
  const q2 = state.quests.find((quest) => quest.questId === asQuestId("q2"));
  if (q2?.status !== "active") throw new Error("前置条件失败：q2 应当已激活");
  return state;
}

/** npc_1 已结识的状态。 */
function buildMetState(): GameState {
  const initial = buildInitialState();
  return {
    ...initial,
    npcs: [
      { npcId: NPC_1, locationId: LOC_A, met: true },
      { npcId: NPC_2, locationId: LOC_B, met: false },
    ],
  };
}

// ---------------------------------------------------------------------------
// makeDialogueChoiceId
// ---------------------------------------------------------------------------

describe("makeDialogueChoiceId", () => {
  it("返回精确的 `${npcId}:${kind}`", () => {
    expect(makeDialogueChoiceId(NPC_1, "greet")).toBe("npc_1:greet");
    expect(makeDialogueChoiceId(NPC_2, "ask_main_quest")).toBe("npc_2:ask_main_quest");
  });
});

// ---------------------------------------------------------------------------
// projectDialogueChoices
// ---------------------------------------------------------------------------

describe("projectDialogueChoices", () => {
  it("在场、未结识且无 active talk 目标 → 只投影 greet", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    expect(projectDialogueChoices(bp, st, NPC_1)).toEqual([
      { kind: "greet", choiceId: "npc_1:greet", label: "与NPC1初次交谈" },
    ]);
  });

  it("active 主线 talk_to_npc 目标 → 只投影 ask_main_quest（替代 greet）", () => {
    const bp = buildBlueprint();
    const st = buildActiveTalkTargetState(bp);
    expect(projectDialogueChoices(bp, st, NPC_2)).toEqual([
      { kind: "ask_main_quest", choiceId: "npc_2:ask_main_quest", label: "询问当前线索" },
    ]);
  });

  it("已结识 NPC → 空数组", () => {
    const bp = buildBlueprint();
    expect(projectDialogueChoices(bp, buildMetState(), NPC_1)).toEqual([]);
  });

  it("NPC 不在当前地点 → 空数组", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    expect(projectDialogueChoices(bp, st, NPC_2)).toEqual([]);
  });

  it("确定性：相同输入产出相同投影", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    expect(JSON.stringify(projectDialogueChoices(bp, st, NPC_1))).toBe(
      JSON.stringify(projectDialogueChoices(bp, st, NPC_1))
    );
  });
});

// ---------------------------------------------------------------------------
// validateIntent: dialogue_choice
// ---------------------------------------------------------------------------

describe("validateIntent: dialogue_choice", () => {
  it("greet 在场未结识 NPC 有效", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, {
      type: "dialogue_choice",
      npcId: NPC_1,
      choiceId: "npc_1:greet",
    });
    expect(result.ok).toBe(true);
  });

  it("伪造 kind 拒绝 (INVALID_DIALOGUE_CHOICE)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, {
      type: "dialogue_choice",
      npcId: NPC_1,
      choiceId: "npc_1:hack",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_DIALOGUE_CHOICE");
    }
  });

  it("额外分隔符拒绝 (INVALID_DIALOGUE_CHOICE)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, {
      type: "dialogue_choice",
      npcId: NPC_1,
      choiceId: "npc_1:greet:extra",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_DIALOGUE_CHOICE");
    }
  });

  it("choiceId 指向其他 NPC 拒绝 (INVALID_DIALOGUE_CHOICE)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, {
      type: "dialogue_choice",
      npcId: NPC_1,
      choiceId: "npc_2:greet",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_DIALOGUE_CHOICE");
    }
  });

  it("未知 NPC 拒绝 (UNKNOWN_NPC)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, {
      type: "dialogue_choice",
      npcId: asNpcId("ghost"),
      choiceId: "ghost:greet",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_NPC");
    }
  });

  it("NPC 不在场拒绝 (NPC_NOT_PRESENT)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, {
      type: "dialogue_choice",
      npcId: NPC_2,
      choiceId: "npc_2:greet",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NPC_NOT_PRESENT");
    }
  });

  it("已结识 NPC 的 greet 拒绝 (DIALOGUE_CHOICE_UNAVAILABLE)", () => {
    const bp = buildBlueprint();
    const result = validateIntent(bp, buildMetState(), {
      type: "dialogue_choice",
      npcId: NPC_1,
      choiceId: "npc_1:greet",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DIALOGUE_CHOICE_UNAVAILABLE");
    }
  });

  it("无 active talk 目标时 ask_main_quest 拒绝 (DIALOGUE_CHOICE_UNAVAILABLE)", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = validateIntent(bp, st, {
      type: "dialogue_choice",
      npcId: NPC_1,
      choiceId: "npc_1:ask_main_quest",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DIALOGUE_CHOICE_UNAVAILABLE");
    }
  });

  it("存在 active talk 目标时 greet 被 ask_main_quest 替代 (DIALOGUE_CHOICE_UNAVAILABLE)", () => {
    const bp = buildBlueprint();
    const st = buildActiveTalkTargetState(bp);
    const rejected = validateIntent(bp, st, {
      type: "dialogue_choice",
      npcId: NPC_2,
      choiceId: "npc_2:greet",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.code).toBe("DIALOGUE_CHOICE_UNAVAILABLE");
    }
    // 互斥的另一侧仍然有效。
    expect(
      validateIntent(bp, st, {
        type: "dialogue_choice",
        npcId: NPC_2,
        choiceId: "npc_2:ask_main_quest",
      }).ok
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveAction: dialogue_choice
// ---------------------------------------------------------------------------

describe("resolveAction: dialogue_choice", () => {
  it("greet 成功：与 talk 一致——met 置 true、一个 npc_met 事件、确定性反馈", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const snapshot = JSON.stringify(st);
    const result = resolveAction(
      bp, st, { type: "dialogue_choice", npcId: NPC_1, choiceId: "npc_1:greet" }, deps
    );
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
      expect(result.state.eventLedger).toHaveLength(2);
      expect(result.state.eventLedger[1]).toEqual(result.events[0]);
      expect(result.feedback.message).toBe("你与NPC1交谈，初次见面。");
      // 除 npcs.met 与事件账本外，其余状态不变。
      expect(result.state.quests).toEqual(st.quests);
      expect(result.state.inventory).toEqual(st.inventory);
      expect(result.state.currentLocationId).toBe(st.currentLocationId);
    }
    // 不修改输入
    expect(JSON.stringify(st)).toBe(snapshot);
  });

  it("ask_main_quest 成功：仍只产生 npc_met 事件，仅文案不同", () => {
    const bp = buildBlueprint();
    const st = buildActiveTalkTargetState(bp);
    const result = resolveAction(
      bp, st, { type: "dialogue_choice", npcId: NPC_2, choiceId: "npc_2:ask_main_quest" }, deps
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({
        type: "npc_met",
        npcId: NPC_2,
        occurredAt: FIXED_TIME,
        interactionKind: "ask_main_quest",
      });
      const npc = result.state.npcs.find((n) => n.npcId === NPC_2);
      expect(npc?.met).toBe(true);
      expect(result.feedback.message).toBe("你向NPC2询问当前线索。");
      // 不直接改 quest：talk_to_npc objective 由 application 的 reconcileQuests 满足。
      expect(result.state.quests).toEqual(st.quests);
      expect(result.events.filter((e) => e.type !== "npc_met")).toEqual([]);
    }
  });

  it("成功后 reconcileQuests 从 met 事实满足 talk_to_npc objective（fixed point）", () => {
    const bp = buildBlueprint();
    const st = buildActiveTalkTargetState(bp);
    const result = resolveAction(
      bp, st, { type: "dialogue_choice", npcId: NPC_2, choiceId: "npc_2:ask_main_quest" }, deps
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // q2 还有 obtain_item objective，未满足 → reconcile 幂等，不完成任务。
    const reconciled = reconcileQuests(bp, result.state, deps);
    expect(reconciled.events).toEqual([]);
    // 再次对同一 NPC 提交任一 choice：已结识 → 稳定拒绝。
    const again = resolveAction(
      bp, result.state, { type: "dialogue_choice", npcId: NPC_2, choiceId: "npc_2:ask_main_quest" }, deps
    );
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.code).toBe("DIALOGUE_CHOICE_UNAVAILABLE");
    }
    expect(projectDialogueChoices(bp, result.state, NPC_2)).toEqual([]);
  });

  it("各拒绝码零状态变化、不产生事件、不返回 next state", () => {
    const bp = buildBlueprint();
    const rejections: readonly {
      readonly state: GameState;
      readonly npcId: string;
      readonly choiceId: string;
      readonly code: string;
    }[] = [
      { state: buildInitialState(), npcId: "npc_1", choiceId: "npc_1:hack", code: "INVALID_DIALOGUE_CHOICE" },
      { state: buildInitialState(), npcId: "npc_1", choiceId: "npc_1:greet:extra", code: "INVALID_DIALOGUE_CHOICE" },
      { state: buildInitialState(), npcId: "ghost", choiceId: "ghost:greet", code: "UNKNOWN_NPC" },
      { state: buildInitialState(), npcId: "npc_2", choiceId: "npc_2:greet", code: "NPC_NOT_PRESENT" },
      { state: buildMetState(), npcId: "npc_1", choiceId: "npc_1:greet", code: "DIALOGUE_CHOICE_UNAVAILABLE" },
      { state: buildInitialState(), npcId: "npc_1", choiceId: "npc_1:ask_main_quest", code: "DIALOGUE_CHOICE_UNAVAILABLE" },
    ];
    for (const { state, npcId, choiceId, code } of rejections) {
      const snapshot = JSON.stringify(state);
      const result = resolveAction(
        bp, state, { type: "dialogue_choice", npcId: asNpcId(npcId), choiceId }, deps
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(code);
        expect(result.feedback.message).toBeTruthy();
        expect("state" in result).toBe(false);
        expect("events" in result).toBe(false);
      }
      expect(JSON.stringify(state)).toBe(snapshot);
    }
  });

  it("既有 talk intent 行为不变：npc_1 talk 仍然成功", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    const result = resolveAction(bp, st, { type: "talk", npcId: NPC_1 }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events[0]).toEqual({ type: "npc_met", npcId: NPC_1, occurredAt: FIXED_TIME });
      expect(result.feedback.message).toBe("你与NPC1交谈，初次见面。");
    }
  });
});
