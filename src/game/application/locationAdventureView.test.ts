import { describe, expect, it } from "vitest";
import {
  asEnemyId,
  asLocationId,
  asNpcId,
  asQuestId,
  type GameState,
  type LocationId,
  type NarrativeSceneState,
  type QuestId,
  type ScenarioBlueprint
} from "@/game/domain";
import { composeNpcSpeech, projectAvailableActions } from "@/game/gameplay/rpg/actions";
import {
  compileScenarioBlueprint,
  initializeGameState,
  validateScenarioBlueprintCandidate
} from "@/game/gameplay/rpg/scenario";
import {
  makeValidCandidate,
  TEST_POLICY,
  TEST_PROFILE
} from "@/game/gameplay/rpg/scenario/scenarioBlueprintFixture.testutil";
import { ensureTownRuntime } from "@/game/gameplay/rpg/town";
import { projectLocationAdventureView, SPEECH_PAGE_CHAR_BUDGET } from "./locationAdventureView";

// ---------------------------------------------------------------------------
// Phase 7 Task 3：地图 / 地点场景 / 安全对话 read model 的纯投影契约测试。
// 关键守卫：世界地图可见范围封闭（unlocked + active visit 目标），locked 节点
// 不携带 locationId 且用中性名，隐藏地点真实信息零泄漏；场景互动只来自当前
// 可用 action；对话只投影当前地点 NPC，slot 稳定，reviewClues 只含已发现事实。
// ---------------------------------------------------------------------------

// Phase 14 开局收窄后 fallback 蓝图只有起始锚点（无 town/后继地点/boss/结局）。
// 本文件的投影契约测试依赖"运行时扩展后"的完整蓝图，以 makeValidCandidate 为
// 基座编译，并把 loc_b 标记为 town 供 town 层三态测试使用。
function compileRuntimeBlueprint(): ScenarioBlueprint {
  const candidate = makeValidCandidate();
  const compiled = compileScenarioBlueprint(
    validateScenarioBlueprintCandidate(
      {
        ...candidate,
        locations: candidate.locations.map((location) =>
          location.id === "loc_b" ? { ...location, scale: "town" } : location
        )
      },
      {
        profile: TEST_PROFILE,
        policy: TEST_POLICY,
        phase: "runtime_expansion"
      }
    )
  );
  if (!compiled.ok) {
    throw new Error(`fixture 蓝图应当合法：${JSON.stringify(compiled.issues)}`);
  }
  return compiled.blueprint;
}

const RUNTIME_BLUEPRINT = compileRuntimeBlueprint();
const PIPELINE = { blueprint: RUNTIME_BLUEPRINT, state: initializeGameState(RUNTIME_BLUEPRINT) };
const { blueprint } = PIPELINE;

const SLOTS = ["left", "center", "right", "foreground"] as const;
type Slot = (typeof SLOTS)[number];

/** 与实现保持同一确定性算法：稳定 ID 字符码累加后对 4 取模。 */
function expectedSlot(id: string): Slot {
  let sum = 0;
  for (const ch of id) sum += ch.charCodeAt(0);
  return SLOTS[sum % 4];
}

function project(state: GameState) {
  return projectLocationAdventureView(blueprint, state, projectAvailableActions(blueprint, state));
}

function locationName(raw: string): string {
  const location = blueprint.locations.find((entry) => entry.id === asLocationId(raw));
  if (location === undefined) throw new Error(`fixture 应含地点 ${raw}`);
  return location.name;
}

/** 以 quest 状态覆写初始状态，其余保持 initializeGameState 的确定性结果。 */
function withQuestStatuses(
  state: GameState,
  overrides: ReadonlyMap<QuestId, GameState["quests"][number]["status"]>
): GameState {
  return {
    ...state,
    quests: state.quests.map((quest) =>
      overrides.has(quest.questId)
        ? { questId: quest.questId, status: overrides.get(quest.questId)! }
        : quest
    )
  };
}

describe("projectLocationAdventureView：世界地图封闭可见范围", () => {
  // 人造投影状态：当前 loc_3，解锁 loc_3/loc_4/loc_1；quest_m1（visit loc_2）保持
  // active 且 loc_2 未解锁 ⇒ loc_2 成为唯一 locked 节点；loc_hidden 既未解锁也非
  // 任何 active visit 目标 ⇒ 完全不出现。
  const state: GameState = {
    ...PIPELINE.state,
    currentLocationId: asLocationId("loc_c"),
    unlockedLocationIds: [asLocationId("loc_c"), asLocationId("loc_d"), asLocationId("loc_a")]
  };

  it("节点顺序固定为 current、travelable、known、locked", () => {
    const view = project(state);
    expect(view.worldMap.nodes.map((node) => node.state)).toEqual([
      "current",
      "travelable",
      "known",
      "locked"
    ]);
  });

  it("current/travelable/known 携带真实地点信息，locked 节点用中性文案且无 locationId", () => {
    const view = project(state);
    const [current, travelable, known, locked] = view.worldMap.nodes;
    expect(current).toMatchObject({
      state: "current",
      locationId: "loc_c",
      name: locationName("loc_c"),
      visual: "map_node"
    });
    expect(current).toHaveProperty("position");
    expect(travelable).toMatchObject({
      state: "travelable",
      locationId: "loc_d",
      name: locationName("loc_d"),
      visual: "map_node"
    });
    expect(travelable).toHaveProperty("position");
    expect(known).toMatchObject({
      state: "known",
      locationId: "loc_a",
      name: locationName("loc_a"),
      hint: "需从相邻地点前往",
      visual: "map_node"
    });
    expect(known).toHaveProperty("position");
    expect(view.worldMap.nodes.at(-1)).toMatchObject({
      state: "locked",
      name: "探寻未知之地",
      hint: "尚未解锁",
      visual: "map_node_locked"
    });
    expect(locked).toHaveProperty("position");
    // locked 节点绝不携带 locationId 键（不是 undefined，而是根本不存在）。
    expect(Object.prototype.hasOwnProperty.call(locked, "locationId")).toBe(false);
  });

  it("零泄漏：locked 目标真实名称、隐藏地点名称、seed、inputDigest 都不出现在 JSON", () => {
    const json = JSON.stringify(project(state));
    // locked 目标是 loc_2（渡口集市）——真实名不得泄漏。
    expect(json.includes(locationName("loc_b"))).toBe(false);
    for (const hidden of blueprint.locations.filter((entry) => entry.kind === "hidden")) {
      expect(json.includes(hidden.name), `hidden=${hidden.name}`).toBe(false);
    }
    expect(json.includes(blueprint.seed)).toBe(false);
    expect(json.includes(blueprint.inputDigest)).toBe(false);
  });

  it("为同一安全节点集投影稳定位置，locked 仍无真实标识", () => {
    const first = project(state).worldMap.nodes;
    expect(project(state).worldMap.nodes).toEqual(first);
    expect(first.every((node) => "position" in node)).toBe(true);
    // 节点数未超过可用位置时，locked 不得遮住任何已知节点。
    expect(new Set(first.map((node) => node.position)).size).toBe(first.length);
    const locked = first.find((node) => node.state === "locked");
    expect(locked).toMatchObject({ state: "locked", position: expect.any(String) });
    expect(locked).not.toHaveProperty("locationId");
  });
});

describe("projectLocationAdventureView：地点场景互动", () => {
  it("互动只来自当前可用 observe/investigate（开场地点），排除 talk/move", () => {
    const view = project(PIPELINE.state);
    const actions = projectAvailableActions(blueprint, PIPELINE.state);
    // 开场地点：observe 当前地点 + investigate 开场可调查事实。
    const observe = actions.find((a) => a.type === "observe");
    if (observe?.type !== "observe") throw new Error("开场地点应可 observe");
    expect(view.locationScene.title).toBe(locationName("loc_a"));
    expect(view.locationScene.backdrop).toBe("location_backdrop");
    expect(view.locationScene.interactions).toContainEqual({
      kind: "observe",
      locationId: observe.locationId,
      label: observe.label,
      slot: expectedSlot(observe.locationId)
    });
    // talk / move 绝不出现在场景互动里（分别归对话与世界地图）。
    for (const interaction of view.locationScene.interactions) {
      expect(["observe", "investigate", "take_item", "start_battle"]).toContain(interaction.kind);
    }
    // 互动数量与可用 action 中的四类互动一一对应。
    const interactive = actions.filter(
      (a) => a.type === "observe" || a.type === "investigate" || a.type === "take_item" || a.type === "start_battle"
    );
    expect(view.locationScene.interactions).toHaveLength(interactive.length);
  });

  it("take_item 互动带确定性槽位（当前地点存在可取得物品时）", () => {
    // 当前 loc_3：availableItemIds=[item_key]，背包未持有 ⇒ take_item 可用。
    const atKeyLocation: GameState = {
      ...PIPELINE.state,
      currentLocationId: asLocationId("loc_c")
    };
    const view = project(atKeyLocation);
    const take = view.locationScene.interactions.find((i) => i.kind === "take_item");
    expect(take).toBeDefined();
    if (take?.kind !== "take_item") throw new Error("loc_3 应可拾取 item_key");
    expect(take.itemId).toBe("item_b");
    expect(take.slot).toBe(expectedSlot("item_b"));
  });

  it("start_battle 互动带确定性槽位（boss 地点 + stage3 active）", () => {
    // 当前 loc_4（boss 所在地），quest_m3（defeat enemy_boss）设为 active。
    const atBoss = withQuestStatuses(
      { ...PIPELINE.state, currentLocationId: asLocationId("loc_d") },
      new Map<QuestId, GameState["quests"][number]["status"]>([[asQuestId("m3"), "active"]])
    );
    const view = project(atBoss);
    const battle = view.locationScene.interactions.find((i) => i.kind === "start_battle");
    expect(battle).toBeDefined();
    if (battle?.kind !== "start_battle") throw new Error("loc_4 应可发起 boss 战");
    expect(battle.enemyId).toBe("enemy_b");
    expect(battle.slot).toBe(expectedSlot(String(asEnemyId("enemy_b"))));
  });
});

describe("projectLocationAdventureView：安全对话", () => {
  it("只投影当前地点 NPC；Phase 14 后无 currentScene 时 choices 为空、freeInputEnabled=true", () => {
    // 当前 loc_3，npc_3 在场未结识；Phase 14 废除规则投影后 choices 来自 currentScene。
    const state = withQuestStatuses(
      { ...PIPELINE.state, currentLocationId: asLocationId("loc_c") },
      new Map<QuestId, GameState["quests"][number]["status"]>([[asQuestId("m2"), "active"]])
    );
    const view = project(state);
    expect(view.dialogues).toHaveLength(1);
    const dialogue = view.dialogues[0];
    expect(dialogue.npcId).toBe("npc_c");
    const npc = blueprint.npcs.find((n) => n.id === asNpcId("npc_c"));
    expect(dialogue.name).toBe(npc?.name);
    expect(dialogue.role).toBe(npc?.role);
    // 无 currentScene ⇒ 无情境选项；自由输入恒可用（非只读）；reviewClues 恒为已发现事实文本。
    expect(dialogue.choices).toEqual([]);
    expect(dialogue.freeInputEnabled).toBe(true);
  });

  it("未被任务指向的未结识 NPC；Phase 14 后无 currentScene 时 choices 为空", () => {
    // 开场地点 loc_1，npc_1 在场未结识；Phase 14 后无规则投影，choices 来自 currentScene。
    const view = project(PIPELINE.state);
    const dialogue = view.dialogues.find((d) => d.npcId === "npc_a");
    expect(dialogue).toBeDefined();
    expect(dialogue!.choices).toEqual([]);
    // reviewClues = 当前已发现事实文本（初始只有 player_input 事实）。
    const discoveredTexts = PIPELINE.state.worldFacts
      .filter((f) => f.discovered)
      .map((f) => blueprint.world.facts.find((fact) => fact.id === f.factId)?.text);
    expect(discoveredTexts.length).toBeGreaterThan(0);
    expect(dialogue!.reviewClues).toEqual(discoveredTexts);
  });

  it("NPC slot 对同一 ID 在两次投影中一致（确定性）", () => {
    const state: GameState = { ...PIPELINE.state, currentLocationId: asLocationId("loc_c") };
    const first = project(state).dialogues;
    const second = project(state).dialogues;
    expect(first.length).toBeGreaterThan(0);
    for (const dialogue of first) {
      const other = second.find((d) => d.npcId === dialogue.npcId);
      expect(other?.slot).toBe(dialogue.slot);
      expect(dialogue.slot).toBe(expectedSlot(dialogue.npcId));
    }
  });
});

describe("projectLocationAdventureView：对白分页投影", () => {
  it("speechPages 非空，顺序拼接 === composeNpcSpeech 产出，每页不超预算", () => {
    const view = project(PIPELINE.state);
    const dialogue = view.dialogues.find((d) => d.npcId === "npc_a");
    expect(dialogue).toBeDefined();
    expect(dialogue!.speechPages.length).toBeGreaterThan(0);
    const speech = composeNpcSpeech(blueprint, PIPELINE.state, asNpcId("npc_a"));
    expect(speech).not.toBe("");
    expect(dialogue!.speechPages.join("")).toBe(speech);
    for (const page of dialogue!.speechPages) {
      expect(page.length).toBeLessThanOrEqual(SPEECH_PAGE_CHAR_BUDGET);
    }
  });

  it("确定性：两次投影的 speechPages 完全一致", () => {
    const first = project(PIPELINE.state).dialogues;
    const second = project(PIPELINE.state).dialogues;
    expect(first.length).toBeGreaterThan(0);
    for (const dialogue of first) {
      const other = second.find((d) => d.npcId === dialogue.npcId);
      expect(other?.speechPages).toEqual(dialogue.speechPages);
    }
  });

  it("只读投影（active battle）下对白仍存在，供回顾展示", () => {
    const state: GameState = {
      ...PIPELINE.state,
      currentLocationId: asLocationId("loc_c"),
      battle: { status: "active", enemyId: asEnemyId("enemy_b"), playerHp: 20, enemyHp: 10, round: 1 }
    };
    const view = project(state);
    expect(view.dialogues.length).toBeGreaterThan(0);
    for (const dialogue of view.dialogues) {
      expect(dialogue.speechPages.length).toBeGreaterThan(0);
    }
  });
});

describe("projectLocationAdventureView：结局 / 战斗只读投影", () => {
  const npcLocation = (id: LocationId) => ({ ...PIPELINE.state, currentLocationId: id });

  it("active battle：仍投影地图/地点，但 interactions 为空、对话 choices 为空", () => {
    const boss = blueprint.enemies.find((e) => e.tier === "boss");
    const state: GameState = {
      ...npcLocation(asLocationId("loc_c")),
      battle: { status: "active", enemyId: asEnemyId("enemy_b"), playerHp: 20, enemyHp: 10, round: 1 }
    };
    if (boss === undefined) throw new Error("fixture 应含 boss");
    const view = project(state);
    expect(view.worldMap.nodes.length).toBeGreaterThan(0);
    expect(view.locationScene.interactions).toEqual([]);
    for (const dialogue of view.dialogues) {
      // Phase 14：read-only 投影下 choices 恒为空、freeInputEnabled=false。
      expect(dialogue.choices).toEqual([]);
      expect(dialogue.freeInputEnabled).toBe(false);
    }
  });

  it("结局后：仍投影地图/地点，interactions 为空、对话 choices 为空", () => {
    const state: GameState = {
      ...npcLocation(asLocationId("loc_c")),
      ending: { endingId: blueprint.endings[0].id, outcome: "success" }
    };
    const view = project(state);
    expect(view.locationScene.interactions).toEqual([]);
    for (const dialogue of view.dialogues) {
      expect(dialogue.choices).toEqual([]);
      expect(dialogue.freeInputEnabled).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Town 主循环 S4：town 层投影三态（非 town / pending / ready）与 scale 透出。
// fallback 蓝图的 loc_2 固定为 town 地点（createFallbackBlueprint 约定）。
// ---------------------------------------------------------------------------

describe("projectLocationAdventureView：town 层三态", () => {
  const TOWN_ID = asLocationId("loc_b");
  const FIXED_TIME = "2026-07-27T12:00:00.000Z";

  function stateAt(locationId: LocationId): GameState {
    return { ...PIPELINE.state, currentLocationId: locationId };
  }

  /** 经 ensureTownRuntime 离线路径派生 towns 条目（与 performAction 写入一致）。 */
  function readyTownState(): GameState {
    const base = stateAt(TOWN_ID);
    const entry = ensureTownRuntime(blueprint, base, "loc_b", "offline", FIXED_TIME);
    if (entry.kind !== "generated") throw new Error("loc_2 应为 town 地点");
    return { ...base, towns: [entry.town] };
  }

  it("非 town 地点：townStatus 为 none、无 town 视图、scale 为 scene", () => {
    const view = project(stateAt(asLocationId("loc_a")));
    expect(view.townStatus).toBe("none");
    expect(view.town).toBeUndefined();
    expect(view.locationScene.scale).toBe("scene");
  });

  it("town 地点尚未派生规划：townStatus 为 none，但 scale 透出 town", () => {
    const view = project(stateAt(TOWN_ID));
    expect(view.townStatus).toBe("none");
    expect(view.town).toBeUndefined();
    expect(view.locationScene.scale).toBe("town");
  });

  it("pending：townGeneration 指向当前地点时输出 pending 且无 town 视图", () => {
    const state: GameState = {
      ...stateAt(TOWN_ID),
      townGeneration: { status: "pending", locationId: TOWN_ID, requestedAt: FIXED_TIME }
    };
    const view = project(state);
    expect(view.townStatus).toBe("pending");
    expect(view.town).toBeUndefined();
  });

  it("其他地点的 pending 不影响当前地点的三态判定", () => {
    const state: GameState = {
      ...stateAt(asLocationId("loc_a")),
      townGeneration: { status: "pending", locationId: TOWN_ID, requestedAt: FIXED_TIME }
    };
    const view = project(state);
    expect(view.townStatus).toBe("none");
  });

  it("ready：towns 已有条目时投影小镇层视图", () => {
    const view = project(readyTownState());
    expect(view.townStatus).toBe("ready");
    expect(view.town).toBeDefined();
    expect(view.town?.locationId).toBe("loc_b");
    expect(view.town?.planSource).toBe("offline");
    expect(view.town?.snapshot.buildings.length).toBeGreaterThan(0);
    expect(view.town?.semanticView.sentences.length).toBeGreaterThan(0);
  });

  it("ready 投影确定性：同状态两次投影深度相等", () => {
    const state = readyTownState();
    expect(project(state)).toEqual(project(state));
  });
});

// ---------------------------------------------------------------------------
// Phase 14 Task 5：NPC 对话层统一——choices 从 currentScene 读取，无规则投影。
// ---------------------------------------------------------------------------

describe("Phase 14 NPC 对话层统一", () => {
  it("无 currentScene 时返回空 choices", () => {
    const state: GameState = {
      ...PIPELINE.state,
      narrative: { ...PIPELINE.state.narrative, currentScene: null }
    };
    const view = project(state);
    expect(view.dialogues.length).toBeGreaterThan(0);
    const npc = view.dialogues[0];
    expect(npc.choices).toEqual([]);
  });

  it("有 currentScene 时从 scene.choices 读取情境选项", () => {
    const scene: NarrativeSceneState = {
      sceneId: "scene_1",
      turn: 1,
      narration: "test",
      usedFactIds: [],
      npcLine: null,
      choices: [
        { choiceToken: "tok_1", label: "选项A", actionKey: "observe" },
        { choiceToken: "tok_2", label: "选项B", actionKey: "investigate" }
      ],
      source: "generated",
      npcDialogues: [{ npcId: asNpcId("npc_a"), npcName: "老者", npcRole: "elder", speechPages: ["你好"] }]
    };
    const state: GameState = {
      ...PIPELINE.state,
      narrative: { ...PIPELINE.state.narrative, currentScene: scene }
    };
    const view = project(state);
    const npc = view.dialogues.find((d) => d.npcId === "npc_a");
    expect(npc).toBeDefined();
    expect(npc!.choices.length).toBe(2);
    expect(npc!.choices[0].label).toBe("选项A");
  });
});
