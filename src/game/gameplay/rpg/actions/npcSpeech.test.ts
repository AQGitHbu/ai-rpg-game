import { describe, expect, it } from "vitest";
import {
  asFactId,
  asGenerationId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
  CONTENT_BUDGET,
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
import { composeNpcSpeech, resolveAction } from "./index";

// ---------------------------------------------------------------------------
// NPC 对白组合规则（对话布局重构）：由蓝图 NPC 资料 + 当前任务状态确定性
// 组合出多句对白文本。复用 dialogueChoices.test 的合法 fixture 管线，钉住：
//   - 未结识且无 active talk 目标：description + 自我介绍句；
//   - 存在未满足的 active 主线 talk_to_npc 目标：追加任务求助句；
//   - 已结识：description + 重逢句；
//   - 未知 NPC / 不在当前地点：空串；
//   - 纯确定性：无 Date / Math.random / AI。
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
    contentBudget: { ...CONTENT_BUDGET },
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

describe("composeNpcSpeech", () => {
  it("未结识且无 active talk 目标 → description + 自我介绍句", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    expect(composeNpcSpeech(bp, st, NPC_1)).toBe(
      "在场NPC。初次见面，我是NPC1，线人。"
    );
  });

  it("active 主线 talk_to_npc 目标 → 追加任务求助句", () => {
    const bp = buildBlueprint();
    const st = buildActiveTalkTargetState(bp);
    expect(composeNpcSpeech(bp, st, NPC_2)).toBe(
      "主线交谈目标NPC。初次见面，我是NPC2，商贩。最近发生了一些奇怪的事情——主线2。你愿意帮我们调查吗？"
    );
  });

  it("已结识 NPC → description + 重逢句，不再追加任务求助句", () => {
    const bp = buildBlueprint();
    expect(composeNpcSpeech(bp, buildMetState(), NPC_1)).toBe(
      "在场NPC。又见面了，若有新的发现，随时可以来找我。"
    );
  });

  it("未知 NPC → 空串", () => {
    const bp = buildBlueprint();
    expect(composeNpcSpeech(bp, buildInitialState(), asNpcId("ghost"))).toBe("");
  });

  it("NPC 不在当前地点 → 空串", () => {
    const bp = buildBlueprint();
    expect(composeNpcSpeech(bp, buildInitialState(), NPC_2)).toBe("");
  });

  it("确定性：相同输入产出相同对白", () => {
    const bp = buildBlueprint();
    const st = buildInitialState();
    expect(composeNpcSpeech(bp, st, NPC_1)).toBe(composeNpcSpeech(bp, st, NPC_1));
  });
});
