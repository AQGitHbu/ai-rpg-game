import { describe, expect, it } from "vitest";
import { asItemId, asLocationId, asQuestId, type GameState, type NewGameInput } from "@/game/domain";
import { resolveAction, type PlayerIntent } from "@/game/gameplay/rpg/actions";
import { reconcileQuests } from "@/game/gameplay/rpg/quests";
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
const PIPELINE = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);

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
    expect(quest.name).toBe(questName("quest_m1"));
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
    expect(names).toContain(questName("quest_m2"));
    expect(names).not.toContain(questName("quest_m1"));
  });

  it("obtain_item objective 为受支持目标：中性文案，未取得时未完成", () => {
    const view = project(moved, 1);
    const m2 = view.activeQuests.find((quest) => quest.name === questName("quest_m2"));
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
    expect(JSON.stringify(view.activeQuests)).not.toContain(questName("quest_m3"));
  });
});

describe("projectGameSessionView：物品摘要与 take_item 行动（Phase 5 Task 3）", () => {
  const moved = advance(PIPELINE.state, { type: "move", locationId: asLocationId("loc_2") });
  const atKeyLocation = advance(moved, { type: "move", locationId: asLocationId("loc_3") });
  const keyItem = blueprintItem("item_key");

  it("开场背包摘要：inventoryItems 只含初始物品的名称与描述", () => {
    const view = project(PIPELINE.state, 0);
    expect(view.inventoryItems).toEqual([blueprintItem("item_start")]);
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

  it("取得物品后：take 行动与 obtainableItems 消失，inventoryItems 收录新物品", () => {
    const taken = advance(atKeyLocation, { type: "take_item", itemId: asItemId("item_key") });
    const view = project(taken, 3);
    expect(view.obtainableItems).toEqual([]);
    expect(view.availableActions.filter((action) => action.type === "take_item")).toEqual([]);
    expect(view.inventoryItems).toContainEqual(keyItem);
  });

  it("obtain_item objective 随背包立即完成：取得后 talk 前 completed=true", () => {
    const taken = advance(atKeyLocation, { type: "take_item", itemId: asItemId("item_key") });
    const view = project(taken, 3);
    const m2 = view.activeQuests.find((quest) => quest.name === questName("quest_m2"));
    expect(m2?.objectives).toContainEqual({
      label: "取得关键物品",
      completed: true,
      supported: true
    });
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
