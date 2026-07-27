import { describe, expect, it } from "vitest";
import type { ScenarioBlueprint, ScenarioBlueprintCandidate } from "@/game/domain";
import { compileScenarioBlueprint, initializeGameState } from "./compileScenarioBlueprint";
import { validateScenarioBlueprintCandidate } from "./validateScenarioBlueprint";
import { TEST_PROFILE, makeValidCandidate } from "./scenarioBlueprintFixture.testutil";

function compileValid(candidate: ScenarioBlueprintCandidate = makeValidCandidate()): ScenarioBlueprint {
  const validation = validateScenarioBlueprintCandidate(candidate, { profile: TEST_PROFILE });
  const compiled = compileScenarioBlueprint(validation);
  if (!compiled.ok) throw new Error("fixture 应当编译成功");
  return compiled.blueprint;
}

function deepFreezeInPlace(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreezeInPlace(child);
    Object.freeze(value);
  }
}

/** fixture 中所有实体数组本身已按 id 升序，可直接当作期望的编译输出形状。 */
const SORTED_LOCATION_IDS = ["loc_a", "loc_b", "loc_c", "loc_d", "loc_h"];
const SORTED_NPC_IDS = ["npc_a", "npc_b", "npc_c", "npc_d"];
const SORTED_QUEST_IDS = ["m1", "m2", "m3", "s1"];

// ---------------------------------------------------------------------------
// compileScenarioBlueprint
// ---------------------------------------------------------------------------

describe("compileScenarioBlueprint：成功路径", () => {
  it("编译产物与候选数据深度相等（fixture 已按 id 排序）", () => {
    expect(compileValid()).toEqual(makeValidCandidate());
  });

  it("实体数组按 id 稳定排序（打乱输入顺序后仍然有序）", () => {
    const candidate = makeValidCandidate();
    const shuffled: ScenarioBlueprintCandidate = {
      ...candidate,
      world: { ...candidate.world, facts: [...candidate.world.facts].reverse() },
      locations: [...candidate.locations].reverse(),
      npcs: [...candidate.npcs].reverse(),
      quests: [...candidate.quests].reverse(),
      enemies: [...candidate.enemies].reverse(),
      items: [...candidate.items].reverse(),
      endings: [...candidate.endings].reverse()
    };
    const blueprint = compileValid(shuffled);
    expect(blueprint.locations.map((entry) => entry.id)).toEqual(SORTED_LOCATION_IDS);
    expect(blueprint.npcs.map((entry) => entry.id)).toEqual(SORTED_NPC_IDS);
    expect(blueprint.quests.map((entry) => entry.id)).toEqual(SORTED_QUEST_IDS);
    expect(blueprint.enemies.map((entry) => entry.id)).toEqual(["enemy_a", "enemy_b"]);
    expect(blueprint.items.map((entry) => entry.id)).toEqual(["item_a", "item_b"]);
    expect(blueprint.endings.map((entry) => entry.id)).toEqual(["e1", "e2"]);
    expect(blueprint.world.facts.map((entry) => entry.id)).toEqual(["fact_a", "fact_b"]);
    expect(blueprint).toEqual(compileValid());
  });

  it("编译产物深度冻结", () => {
    const blueprint = compileValid();
    expect(Object.isFrozen(blueprint)).toBe(true);
    expect(Object.isFrozen(blueprint.locations)).toBe(true);
    expect(Object.isFrozen(blueprint.locations[0])).toBe(true);
    expect(Object.isFrozen(blueprint.locations[0].connectedLocationIds)).toBe(true);
    expect(Object.isFrozen(blueprint.world.facts[0])).toBe(true);
    expect(Object.isFrozen(blueprint.player.baseStats)).toBe(true);
    expect(Object.isFrozen(blueprint.openingScene.presentNpcIds)).toBe(true);
  });

  it("不修改候选：候选被深度冻结后依然可以编译", () => {
    const candidate = makeValidCandidate();
    deepFreezeInPlace(candidate);
    expect(() => compileValid(candidate)).not.toThrow();
    expect(candidate).toEqual(makeValidCandidate());
  });

  it("确定性：同一候选两次编译结果深度相等", () => {
    expect(compileValid()).toEqual(compileValid());
  });
});

describe("compileScenarioBlueprint：失败路径", () => {
  it("校验失败时透传结构化诊断，不产生部分结果", () => {
    const candidate = { ...makeValidCandidate(), seed: " " };
    const validation = validateScenarioBlueprintCandidate(candidate, { profile: TEST_PROFILE });
    const compiled = compileScenarioBlueprint(validation);
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) {
      expect(compiled.issues).toContainEqual({ path: "seed", code: "REQUIRED", params: {} });
    }
    expect("blueprint" in compiled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// initializeGameState
// ---------------------------------------------------------------------------

describe("initializeGameState", () => {
  it("完全由蓝图派生出初始状态", () => {
    const state = initializeGameState(compileValid());
    const generation = {
      generationId: "gen_0001",
      seed: "seed-1",
      templateVersion: "tpl-1",
      inputDigest: "digest-1",
      gameType: "wuxia"
    };
    expect(state).toEqual({
      stateVersion: 1,
      generation,
      player: {
        name: "沈青崖",
        identity: "落魄镖师",
        stats: { hp: 30, attack: 6, defense: 4 }
      },
      currentLocationId: "loc_a",
      unlockedLocationIds: ["loc_a", "loc_b", "loc_c", "loc_d"],
      visitedLocationIds: ["loc_a"],
      npcs: [
        { npcId: "npc_a", locationId: "loc_a", met: false },
        { npcId: "npc_b", locationId: "loc_b", met: false },
        { npcId: "npc_c", locationId: "loc_c", met: false },
        { npcId: "npc_d", locationId: "loc_d", met: false }
      ],
      quests: [
        { questId: "m1", status: "active" },
        { questId: "m2", status: "locked" },
        { questId: "m3", status: "locked" },
        { questId: "s1", status: "locked" }
      ],
      inventory: ["item_a"],
      worldFacts: [
        { factId: "fact_a", discovered: true },
        { factId: "fact_b", discovered: false }
      ],
      eventLedger: [{ type: "game_initialized", generation }]
    });
  });

  it("隐藏地点不进入初始解锁列表", () => {
    const state = initializeGameState(compileValid());
    expect(state.unlockedLocationIds).not.toContain("loc_h");
  });

  it("初始已访问地点只有开场地点（Phase 4 visit 事实基线）", () => {
    const blueprint = compileValid();
    const state = initializeGameState(blueprint);
    expect(state.visitedLocationIds).toEqual([blueprint.openingScene.locationId]);
  });

  it("初始事件账本只有一条 game_initialized，携带生成元数据", () => {
    const blueprint = compileValid();
    const state = initializeGameState(blueprint);
    expect(state.eventLedger).toHaveLength(1);
    expect(state.eventLedger[0]).toEqual({
      type: "game_initialized",
      generation: {
        generationId: blueprint.generationId,
        seed: blueprint.seed,
        templateVersion: blueprint.templateVersion,
        inputDigest: blueprint.inputDigest,
        gameType: blueprint.gameType
      }
    });
  });

  it("确定性：同一蓝图两次初始化结果深度相等", () => {
    const blueprint = compileValid();
    expect(initializeGameState(blueprint)).toEqual(initializeGameState(blueprint));
  });

  it("是纯函数：不修改蓝图（蓝图已冻结，仅再断言数据不变）", () => {
    const blueprint = compileValid();
    initializeGameState(blueprint);
    expect(blueprint).toEqual(compileValid());
  });
});
