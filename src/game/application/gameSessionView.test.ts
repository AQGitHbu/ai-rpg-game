import { describe, expect, it } from "vitest";
import {
  asFactId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
  createEmptyStoryMemory,
  type GameState,
  type NewGameInput,
  type StoryMemoryEntry
} from "@/game/domain";
import { resolveAction, type PlayerIntent } from "@/game/gameplay/rpg/actions";
import { reconcileQuests } from "@/game/gameplay/rpg/quests";
import { ensureTownRuntime } from "@/game/gameplay/rpg/town";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { projectGameSessionView, type GameSessionView } from "./gameSessionView";
import { runScenarioPipeline, TEST_GAME_ID } from "./applicationFixture.testutil";

// ---------------------------------------------------------------------------
// Phase 4 Task 3：GameSessionView read model 契约测试。
// OpeningGameView 演进为语义中性的场景视图：move 行动不再过滤、当前地点
// 运行时 NPC、active quest 摘要（未支持 objective 标记为后续阶段能力）。
// 仍不泄漏：锁定任务、隐藏地点、完整蓝图、seed、inputDigest。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;
const PIPELINE = runScenarioPipeline({ ...FIXTURE.input, gameLength: "short" }, FIXTURE.seed);

const FIXED_TIME = "2026-07-27T12:00:00.000Z";
const ruleDeps = { now: () => FIXED_TIME };

function project(state: GameState, revision: number): GameSessionView {
  return projectGameSessionView({
    gameId: TEST_GAME_ID,
    blueprint: PIPELINE.blueprint,
    state,
    revision,
    worldName: "武侠"
  });
}

/** 走真实规则管线推进状态：行动 resolver + 任务 reconciliation。 */
function advance(state: GameState, intent: PlayerIntent): GameState {
  const resolved = resolveAction(PIPELINE.blueprint, state, intent, ruleDeps);
  if (!resolved.ok) throw new Error(`行动应当成功，实际被拒绝：${resolved.code}`);
  return reconcileQuests(PIPELINE.blueprint, resolved.state, ruleDeps).state;
}

function questName(questId: string): string {
  const quest = PIPELINE.blueprint.quests.find((entry) => entry.id === asQuestId(questId));
  if (quest === undefined) throw new Error(`fixture 应含任务 ${questId}`);
  return quest.name;
}

function locationName(locationId: string): string {
  const location = PIPELINE.blueprint.locations.find(
    (entry) => entry.id === asLocationId(locationId)
  );
  if (location === undefined) throw new Error(`fixture 应含地点 ${locationId}`);
  return location.name;
}

function blueprintItem(itemId: string): { name: string; description: string } {
  const item = PIPELINE.blueprint.items.find((entry) => entry.id === asItemId(itemId));
  if (item === undefined) throw new Error(`fixture 应含物品 ${itemId}`);
  return { name: item.name, description: item.description };
}

// 背包富视图预期值：直接钉死 wuxia fallback 模板的展示元数据，避免测试与实现
// 共用同一推导函数（resolveItemPresentation）导致互证。
const INVENTORY_ITEM_START = {
  ...blueprintItem("item_start"),
  category: "equipment",
  rarity: "fine",
  level: 2,
  statLines: [
    { label: "攻击力", value: "+6" },
    { label: "身法", value: "+3%" }
  ],
  icon: "sword"
} as const;

const INVENTORY_ITEM_KEY = {
  ...blueprintItem("item_key"),
  category: "quest",
  rarity: "rare",
  level: null,
  statLines: [],
  icon: "key"
} as const;

describe("projectGameSessionView：开场视图", () => {
  it("availableActions 不再过滤 move，含前往已连通已解锁地点的行动", () => {
    const view = project(PIPELINE.state, 0);
    const moveActions = view.availableActions.filter((action) => action.type === "move");
    expect(moveActions).toEqual([
      { type: "move", locationId: "loc_2", label: `前往${locationName("loc_2")}` }
    ]);
  });

  it("保持 OpeningGameView 兼容字段：revision/openingNarration/knownFacts 等", () => {
    const view = project(PIPELINE.state, 0);
    expect(view.gameId).toBe(TEST_GAME_ID);
    expect(view.revision).toBe(0);
    expect(view.openingNarration).toBe(PIPELINE.blueprint.openingScene.narration);
    expect(view.currentLocation.name).toBe(locationName("loc_1"));
  });

  it("presentNpcs 投影运行时位于当前地点的 NPC", () => {
    const view = project(PIPELINE.state, 0);
    const expected = PIPELINE.state.npcs
      .filter((npc) => npc.locationId === PIPELINE.state.currentLocationId)
      .map((npcState) => {
        const npc = PIPELINE.blueprint.npcs.find((entry) => entry.id === npcState.npcId);
        return { name: npc?.name, role: npc?.role };
      });
    expect(expected.length).toBeGreaterThan(0);
    expect(view.presentNpcs).toEqual(expected);
  });

  it("activeQuests 只含 stage 1 主线，visit objective 支持且未完成", () => {
    const view = project(PIPELINE.state, 0);
    expect(view.activeQuests).toHaveLength(1);
    const quest = view.activeQuests[0];
    expect(quest.name).toBe(questName("quest_main_1"));
    expect(quest.kind).toBe("main");
    expect(quest.objectives).toEqual([
      { label: `到访${locationName("loc_2")}`, completed: false, supported: true }
    ]);
  });
});

describe("projectGameSessionView：移动完成主线后", () => {
  const moved = advance(PIPELINE.state, { type: "move", locationId: asLocationId("loc_2") });

  it("当前地点与 presentNpcs 切换到新地点", () => {
    const view = project(moved, 1);
    expect(view.currentLocation.name).toBe(locationName("loc_2"));
    for (const npc of view.presentNpcs) {
      const runtime = moved.npcs.find((entry) => {
        const definition = PIPELINE.blueprint.npcs.find((d) => d.id === entry.npcId);
        return definition?.name === npc.name;
      });
      expect(runtime?.locationId).toBe(moved.currentLocationId);
    }
  });

  it("completed 主线退出 activeQuests，解锁的 stage 2 进入", () => {
    const view = project(moved, 1);
    const names = view.activeQuests.map((quest) => quest.name);
    expect(names).toContain(questName("quest_main_2"));
    expect(names).not.toContain(questName("quest_main_1"));
  });

  it("obtain_item objective 为受支持目标：中性文案，未取得时未完成", () => {
    const view = project(moved, 1);
    const m2 = view.activeQuests.find((quest) => quest.name === questName("quest_main_2"));
    expect(m2).toBeDefined();
    expect(m2?.objectives).toContainEqual({
      label: "取得关键物品",
      completed: false,
      supported: true
    });
    expect(m2?.objectives.every((objective) => objective.supported)).toBe(true);
  });

  it("锁定的 stage 3 主线名称不泄漏", () => {
    const view = project(moved, 1);
    expect(JSON.stringify(view.activeQuests)).not.toContain(questName("quest_main_3"));
  });
});

describe("projectGameSessionView：物品摘要与 take_item 行动（Phase 5 Task 3）", () => {
  const moved = advance(PIPELINE.state, { type: "move", locationId: asLocationId("loc_2") });
  const atKeyLocation = advance(moved, { type: "move", locationId: asLocationId("loc_3") });
  const keyItem = blueprintItem("item_key");

  it("开场背包摘要：inventoryItems 为含展示元数据的富视图（分类/稀有度/等级/属性行/图标）", () => {
    const view = project(PIPELINE.state, 0);
    expect(view.inventoryItems).toEqual([INVENTORY_ITEM_START]);
  });

  it("initialItems 与 obtainableItems 保持简单形态：只含名称与描述", () => {
    const view = project(atKeyLocation, 2);
    expect(view.initialItems).toEqual([blueprintItem("item_start")]);
    expect(view.obtainableItems).toEqual([blueprintItem("item_key")]);
  });

  it("当前地点可取得物品：obtainableItems 摘要与 take_item 可用行动一致", () => {
    const view = project(atKeyLocation, 2);
    expect(view.obtainableItems).toEqual([keyItem]);
    const takeActions = view.availableActions.filter((action) => action.type === "take_item");
    expect(takeActions).toEqual([
      { type: "take_item", itemId: "item_key", label: `拾取${keyItem.name}` }
    ]);
  });

  it("其他地点的可取得物品不泄漏：loc_1/loc_2 视图 JSON 不含 key 物品名称与 ID", () => {
    const cases: readonly (readonly [GameState, number])[] = [
      [PIPELINE.state, 0],
      [moved, 1]
    ];
    for (const [state, revision] of cases) {
      const viewJson = JSON.stringify(project(state, revision));
      expect(viewJson.includes(keyItem.name)).toBe(false);
      expect(viewJson.includes("item_key")).toBe(false);
    }
  });

  it("取得物品后：take 行动与 obtainableItems 消失，inventoryItems 收录新物品富视图", () => {
    const taken = advance(atKeyLocation, { type: "take_item", itemId: asItemId("item_key") });
    const view = project(taken, 3);
    expect(view.obtainableItems).toEqual([]);
    expect(view.availableActions.filter((action) => action.type === "take_item")).toEqual([]);
    expect(view.inventoryItems).toContainEqual(INVENTORY_ITEM_KEY);
  });

  it("obtain_item objective 随背包立即完成：取得后 talk 前 completed=true", () => {
    const taken = advance(atKeyLocation, { type: "take_item", itemId: asItemId("item_key") });
    const view = project(taken, 3);
    const m2 = view.activeQuests.find((quest) => quest.name === questName("quest_main_2"));
    expect(m2?.objectives).toContainEqual({
      label: "取得关键物品",
      completed: true,
      supported: true
    });
  });
});

describe("projectGameSessionView：终幕地点与战斗 objective 渲染", () => {
  it("stage 2 完成后终幕进入 active：先展示到访地点，再展示战斗目标", () => {
    // 完整推进到 stage 3：移动完成 stage 1 → 抵达 loc_3 → 交谈 npc_3
    // → 取得 key → stage 2 完成、stage 3（到访地点 + defeat_enemy）解锁。
    const moved = advance(PIPELINE.state, { type: "move", locationId: asLocationId("loc_2") });
    const atKeyLocation = advance(moved, { type: "move", locationId: asLocationId("loc_3") });
    const talked = advance(atKeyLocation, { type: "talk", npcId: asNpcId("npc_3") });
    const taken = advance(talked, { type: "take_item", itemId: asItemId("item_key") });

    const view = project(taken, 4);
    const names = view.activeQuests.map((quest) => quest.name);
    expect(names).not.toContain(questName("quest_main_2"));
    expect(names).toContain(questName("quest_main_3"));

    // 终幕地点与战斗均由规则支持；战斗只有在到达 loc_4 后才会成为可执行行动。
    const m3 = view.activeQuests.find((quest) => quest.name === questName("quest_main_3"));
    expect(m3?.objectives).toEqual([
      { label: "到访断魂崖", completed: false, supported: true },
      { label: "战胜强敌", completed: false, supported: true }
    ]);
  });
});

describe("projectGameSessionView：closed 支线与泄漏防护", () => {
  it("closed outcome 的支线完成后彻底退出 activeQuests，不冒充 completed", () => {
    // 先调查出 fact_gen_1（quest_s1 尚 locked），移动触发级联：m1 完成 →
    // s1 解锁并因事实已发现立即 closed。
    const investigated = advance(PIPELINE.state, {
      type: "investigate",
      factId: PIPELINE.blueprint.openingScene.investigableFactIds[0]
    });
    const moved = advance(investigated, { type: "move", locationId: asLocationId("loc_2") });
    expect(moved.quests.find((quest) => quest.questId === asQuestId("quest_s1"))?.status).toBe(
      "closed"
    );

    const view = project(moved, 2);
    expect(JSON.stringify(view.activeQuests)).not.toContain(questName("quest_s1"));
  });

  it("开场视图 JSON 不含 seed/inputDigest/隐藏地点/锁定任务名称", () => {
    const viewJson = JSON.stringify(project(PIPELINE.state, 0));
    expect(viewJson.includes(PIPELINE.blueprint.seed)).toBe(false);
    expect(viewJson.includes(PIPELINE.blueprint.inputDigest)).toBe(false);
    for (const location of PIPELINE.blueprint.locations.filter((l) => l.kind === "hidden")) {
      expect(viewJson.includes(location.name), `hidden=${location.name}`).toBe(false);
    }
    const lockedIds = new Set(
      PIPELINE.state.quests.filter((q) => q.status === "locked").map((q) => q.questId)
    );
    for (const quest of PIPELINE.blueprint.quests.filter((q) => lockedIds.has(q.id))) {
      expect(viewJson.includes(quest.name), `locked=${quest.name}`).toBe(false);
      expect(viewJson.includes(quest.id), `locked id=${quest.id}`).toBe(false);
    }
  });
});

describe("projectGameSessionView：地图 / 地点场景 / 对话 read model（Phase 7 Task 3）", () => {
  it("worldMap 首节点是当前地点，且为封闭可见范围（无隐藏地点泄漏）", () => {
    const view = project(PIPELINE.state, 0);
    expect(view.worldMap.nodes.length).toBeGreaterThan(0);
    expect(view.worldMap.nodes[0]).toMatchObject({
      state: "current",
      locationId: "loc_1",
      name: locationName("loc_1")
    });
    const json = JSON.stringify(view.worldMap);
    for (const location of PIPELINE.blueprint.locations.filter((l) => l.kind === "hidden")) {
      expect(json.includes(location.name), `hidden=${location.name}`).toBe(false);
    }
  });

  it("locationScene 投影当前地点标题/描述与只读背景", () => {
    const view = project(PIPELINE.state, 0);
    expect(view.locationScene.title).toBe(locationName("loc_1"));
    expect(view.locationScene.description).toBe(view.currentLocation.description);
    expect(view.locationScene.backdrop).toBe("location_backdrop");
  });

  it("dialogues 为当前地点在场 NPC 投影，含只读 review_clue choice", () => {
    const view = project(PIPELINE.state, 0);
    const presentNpcIds = new Set(
      PIPELINE.state.npcs
        .filter((npc) => npc.locationId === PIPELINE.state.currentLocationId)
        .map((npc) => String(npc.npcId))
    );
    expect(view.dialogues.length).toBe(presentNpcIds.size);
    for (const dialogue of view.dialogues) {
      expect(presentNpcIds.has(dialogue.npcId)).toBe(true);
      expect(dialogue.choices).toContainEqual({
        kind: "review_clue",
        label: "回顾已知线索",
        mutatesState: false
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Town 主循环 S4：会话视图透出地点层级（locationScene.scale）与 town 就绪
// 状态（townStatus / town）——由 locationAdventureView 投影展开而来。
// ---------------------------------------------------------------------------

describe("projectGameSessionView：town 层透出", () => {
  it("开场地点（scene）：scale 为 scene、townStatus 为 none", () => {
    const view = project(PIPELINE.state, 0);
    expect(view.locationScene.scale).toBe("scene");
    expect(view.townStatus).toBe("none");
    expect(view.town).toBeUndefined();
  });

  it("town 地点就绪后：scale 为 town、townStatus 为 ready 且透出小镇视图", () => {
    const base: GameState = { ...PIPELINE.state, currentLocationId: asLocationId("loc_2") };
    const entry = ensureTownRuntime(PIPELINE.blueprint, base, "loc_2", "offline", FIXED_TIME);
    if (entry.kind !== "generated") throw new Error("loc_2 应为 town 地点");
    const view = project({ ...base, towns: [entry.town] }, 0);
    expect(view.locationScene.scale).toBe("town");
    expect(view.townStatus).toBe("ready");
    expect(view.town?.townName).toBe(locationName("loc_2"));
    expect(view.town?.interactiveBuildings.length).toBeGreaterThan(0);
  });
});

describe("projectGameSessionView：Phase 11 场景提交事件不污染日志", () => {
  it("narrative_scene_presented 不产出 storyEvents 行、不泄 undefined（由本章进展单独呈现）", () => {
    const sceneEvent = {
      type: "narrative_scene_presented" as const,
      sceneId: "scene-1",
      locationId: asLocationId("loc_1"),
      focusNpcId: null,
      revealedFactIds: [],
      pacing: "develop" as const,
      occurredAt: "2026-07-31T00:00:00.000Z"
    };
    const state: GameState = {
      ...PIPELINE.state,
      eventLedger: [...PIPELINE.state.eventLedger, sceneEvent]
    };
    const view = project(state, 0);
    // 每条 storyEvent 都必须是带非空 text 的结构，绝不泄 undefined/null。
    for (const entry of view.storyEvents) {
      expect(typeof entry.text).toBe("string");
      expect(entry.text.length).toBeGreaterThan(0);
    }
    expect(view.storyEvents.every((entry) => entry != null && typeof entry.text === "string")).toBe(true);
    // 场景提交事件不作为单条日志行重复呈现（仅经本章进展里程碑呈现，Task 7 落地）。
    expect(view.storyEvents.some((entry) => entry.text.includes("scene-1"))).toBe(false);
  });
});

describe("projectGameSessionView：Phase 11 本章进展 (storyContinuity)", () => {
  it("显示最近 6 条里程碑；相邻重复 scene 折叠为一条；不含原始 ID", () => {
    const recent: readonly StoryMemoryEntry[] = [
      { kind: "location", locationId: asLocationId("loc_1"), turn: 1 },
      { kind: "scene", sceneId: "s1", locationId: asLocationId("loc_1"), focusNpcId: null, pacing: "develop", turn: 2 },
      { kind: "scene", sceneId: "s2", locationId: asLocationId("loc_1"), focusNpcId: null, pacing: "develop", turn: 3 },
      { kind: "npc", npcId: asNpcId("npc_1"), locationId: asLocationId("loc_1"), turn: 4 },
      { kind: "fact", factId: asFactId("fact_1"), turn: 5 },
      { kind: "item", itemId: asItemId("item_key"), locationId: asLocationId("loc_1"), turn: 6 }
    ];
    const state = {
      ...PIPELINE.state,
      storyMemory: { ...createEmptyStoryMemory(), reducedThroughEventCount: 7, recent }
    } as GameState;
    const view = project(state, 0);
    expect(view.storyContinuity).toHaveLength(5);
    expect(view.storyContinuity.every((m) => typeof m.text === "string" && m.text.length > 0)).toBe(true);
    expect(JSON.stringify(view.storyContinuity)).not.toContain("loc_1");
    expect(JSON.stringify(view.storyContinuity)).not.toContain("s1");
  });

  it("已发现事实显示安全文本，memory 中的未发现事实仍保持泛化", () => {
    const discovered = PIPELINE.state.worldFacts.find((entry) => entry.discovered);
    const hidden = PIPELINE.state.worldFacts.find((entry) => !entry.discovered);
    if (discovered === undefined || hidden === undefined) throw new Error("fixture must contain both fact kinds");
    const state = {
      ...PIPELINE.state,
      storyMemory: {
        ...createEmptyStoryMemory(),
        reducedThroughEventCount: 2,
        recent: [
          { kind: "fact" as const, factId: discovered.factId, turn: 0 },
          { kind: "fact" as const, factId: hidden.factId, turn: 1 },
        ],
      },
    } as GameState;
    const json = JSON.stringify(project(state, 0).storyContinuity);
    const discoveredText = PIPELINE.blueprint.world.facts.find((entry) => entry.id === discovered.factId)?.text;
    const hiddenText = PIPELINE.blueprint.world.facts.find((entry) => entry.id === hidden.factId)?.text;
    expect(json).toContain(discoveredText);
    expect(json).not.toContain(hiddenText);
  });

  it("缺省 storyMemory 的旧存档回退为空 storyContinuity（不抛错）", () => {
    const { storyMemory: _omit, ...legacy } = PIPELINE.state;
    void _omit;
    const view = project(legacy as GameState, 0);
    expect(view.storyContinuity).toEqual([]);
  });
});
