import { describe, expect, it } from "vitest";
import {
  asEnemyId,
  asLocationId,
  asNpcId,
  asQuestId,
  type GameState,
  type LocationId,
  type NewGameInput,
  type QuestId
} from "@/game/domain";
import { projectAvailableActions } from "@/game/gameplay/rpg/actions";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { projectLocationAdventureView } from "./locationAdventureView";
import { runScenarioPipeline } from "./applicationFixture.testutil";

// ---------------------------------------------------------------------------
// Phase 7 Task 3：地图 / 地点场景 / 安全对话 read model 的纯投影契约测试。
// 关键守卫：世界地图可见范围封闭（unlocked + active visit 目标），locked 节点
// 不携带 locationId 且用中性名，隐藏地点真实信息零泄漏；场景互动只来自当前
// 可用 action；对话只投影当前地点 NPC，slot 稳定，reviewClues 只含已发现事实。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;
const PIPELINE = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);
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
    currentLocationId: asLocationId("loc_3"),
    unlockedLocationIds: [asLocationId("loc_3"), asLocationId("loc_4"), asLocationId("loc_1")]
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
      locationId: "loc_3",
      name: locationName("loc_3"),
      visual: "map_node"
    });
    expect(current).toHaveProperty("position");
    expect(travelable).toMatchObject({
      state: "travelable",
      locationId: "loc_4",
      name: locationName("loc_4"),
      visual: "map_node"
    });
    expect(travelable).toHaveProperty("position");
    expect(known).toMatchObject({
      state: "known",
      locationId: "loc_1",
      name: locationName("loc_1"),
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
    expect(json.includes(locationName("loc_2"))).toBe(false);
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
    expect(view.locationScene.title).toBe(locationName("loc_1"));
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
      currentLocationId: asLocationId("loc_3")
    };
    const view = project(atKeyLocation);
    const take = view.locationScene.interactions.find((i) => i.kind === "take_item");
    expect(take).toBeDefined();
    if (take?.kind !== "take_item") throw new Error("loc_3 应可拾取 item_key");
    expect(take.itemId).toBe("item_key");
    expect(take.slot).toBe(expectedSlot("item_key"));
  });

  it("start_battle 互动带确定性槽位（boss 地点 + stage3 active）", () => {
    // 当前 loc_4（boss 所在地），quest_m3（defeat enemy_boss）设为 active。
    const atBoss = withQuestStatuses(
      { ...PIPELINE.state, currentLocationId: asLocationId("loc_4") },
      new Map<QuestId, GameState["quests"][number]["status"]>([[asQuestId("quest_m3"), "active"]])
    );
    const view = project(atBoss);
    const battle = view.locationScene.interactions.find((i) => i.kind === "start_battle");
    expect(battle).toBeDefined();
    if (battle?.kind !== "start_battle") throw new Error("loc_4 应可发起 boss 战");
    expect(battle.enemyId).toBe("enemy_boss");
    expect(battle.slot).toBe(expectedSlot(String(asEnemyId("enemy_boss"))));
  });
});

describe("projectLocationAdventureView：安全对话", () => {
  it("只投影当前地点 NPC；未结识且被主线 talk 目标指向 ⇒ ask_main_quest 可写", () => {
    // 当前 loc_3，npc_3 在场未结识，quest_m2（talk npc_3）active ⇒ ask_main_quest。
    const state = withQuestStatuses(
      { ...PIPELINE.state, currentLocationId: asLocationId("loc_3") },
      new Map<QuestId, GameState["quests"][number]["status"]>([[asQuestId("quest_m2"), "active"]])
    );
    const view = project(state);
    expect(view.dialogues).toHaveLength(1);
    const dialogue = view.dialogues[0];
    expect(dialogue.npcId).toBe("npc_3");
    const npc = blueprint.npcs.find((n) => n.id === asNpcId("npc_3"));
    expect(dialogue.name).toBe(npc?.name);
    expect(dialogue.role).toBe(npc?.role);
    const writable = dialogue.choices.filter((c) => c.kind !== "review_clue");
    expect(writable).toEqual([
      {
        kind: "ask_main_quest",
        choiceId: "npc_3:ask_main_quest",
        label: "询问当前线索",
        mutatesState: true
      }
    ]);
    // 本地只读回顾线索 choice 恒在。
    expect(dialogue.choices).toContainEqual({
      kind: "review_clue",
      label: "回顾已知线索",
      mutatesState: false
    });
  });

  it("未被任务指向的未结识 NPC ⇒ greet 可写；reviewClues 只等于已发现事实文本", () => {
    // 开场地点 loc_1，npc_1 在场未结识，无 talk 目标 ⇒ greet。
    const view = project(PIPELINE.state);
    const dialogue = view.dialogues.find((d) => d.npcId === "npc_1");
    expect(dialogue).toBeDefined();
    const writable = dialogue!.choices.filter((c) => c.kind !== "review_clue");
    expect(writable).toEqual([
      {
        kind: "greet",
        choiceId: "npc_1:greet",
        label: writable[0]?.label,
        mutatesState: true
      }
    ]);
    expect(writable[0]?.label).toContain("初次交谈");
    // reviewClues = 当前已发现事实文本（初始只有 player_input 事实）。
    const discoveredTexts = PIPELINE.state.worldFacts
      .filter((f) => f.discovered)
      .map((f) => blueprint.world.facts.find((fact) => fact.id === f.factId)?.text);
    expect(discoveredTexts.length).toBeGreaterThan(0);
    expect(dialogue!.reviewClues).toEqual(discoveredTexts);
  });

  it("NPC slot 对同一 ID 在两次投影中一致（确定性）", () => {
    const state: GameState = { ...PIPELINE.state, currentLocationId: asLocationId("loc_3") };
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

describe("projectLocationAdventureView：结局 / 战斗只读投影", () => {
  const npcLocation = (id: LocationId) => ({ ...PIPELINE.state, currentLocationId: id });

  it("active battle：仍投影地图/地点，但 interactions 为空、对话无可写 choice", () => {
    const boss = blueprint.enemies.find((e) => e.tier === "boss");
    const state: GameState = {
      ...npcLocation(asLocationId("loc_3")),
      battle: { status: "active", enemyId: asEnemyId("enemy_boss"), playerHp: 20, enemyHp: 10, round: 1 }
    };
    if (boss === undefined) throw new Error("fixture 应含 boss");
    const view = project(state);
    expect(view.worldMap.nodes.length).toBeGreaterThan(0);
    expect(view.locationScene.interactions).toEqual([]);
    for (const dialogue of view.dialogues) {
      expect(dialogue.choices.every((c) => c.mutatesState === false)).toBe(true);
    }
  });

  it("结局后：仍投影地图/地点，interactions 为空、对话无可写 choice", () => {
    const state: GameState = {
      ...npcLocation(asLocationId("loc_3")),
      ending: { endingId: blueprint.endings[0].id, outcome: "success" }
    };
    const view = project(state);
    expect(view.locationScene.interactions).toEqual([]);
    for (const dialogue of view.dialogues) {
      expect(dialogue.choices.every((c) => c.mutatesState === false)).toBe(true);
    }
  });
});
