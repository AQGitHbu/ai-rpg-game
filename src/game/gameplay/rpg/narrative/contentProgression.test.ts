import { describe, expect, it } from "vitest";
import {
  asEndingId,
  asLocationId,
  asQuestId,
  createBudgetPolicy,
  type GameState,
  type QuestId,
  type ScenarioBlueprint
} from "@/game/domain";
import { deriveContentProgression } from "./contentProgression";

// Phase 11 内容推进器：从当前主线状态派生允许的 pacing。
// 见 docs/superpowers/specs/2026-07-31-phase-11-story-continuity-structured-memory.md §5。
// 纯函数：不读 IO/Date/process.env/随机；不从 narrative prose 推断章节。

function buildBlueprint(): ScenarioBlueprint {
  return {
    schemaVersion: 1,
    generationId: "gen-test" as ScenarioBlueprint["generationId"],
    seed: "test-seed",
    templateVersion: "tpl-1",
    inputDigest: "digest-test",
    gameType: "wuxia",
    world: { name: "W", summary: "", tone: "dark", themes: [], facts: [] },
    locations: [{ id: asLocationId("loc_a"), name: "L", description: "", kind: "public", connectedLocationIds: [] }],
    npcs: [],
    quests: [
      { id: asQuestId("m1"), name: "主线一", description: "", objectives: [], onSuccess: { kind: "unlock_quests", questIds: [asQuestId("m2")] }, onFailure: { kind: "closed" }, kind: "main", stage: 1 },
      { id: asQuestId("m2"), name: "主线二", description: "", objectives: [], onSuccess: { kind: "unlock_quests", questIds: [asQuestId("m3")] }, onFailure: { kind: "closed" }, kind: "main", stage: 2 },
      { id: asQuestId("m3"), name: "主线三", description: "", objectives: [], onSuccess: { kind: "reach_ending", endingId: asEndingId("e1") }, onFailure: { kind: "closed" }, kind: "main", stage: 3 },
      { id: asQuestId("s1"), name: "支线一", description: "", objectives: [], onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, kind: "side" }
    ],
    enemies: [],
    items: [],
    endings: [],
    player: { name: "P", identity: "H", startingItemIds: [], baseStats: { hp: 20, attack: 5, defense: 3 } },
    openingScene: { locationId: asLocationId("loc_a"), narration: "", suggestedActions: [], presentNpcIds: [], investigableFactIds: [] }
  } as unknown as ScenarioBlueprint;
}

function buildLongBlueprint(): ScenarioBlueprint {
  return {
    ...blueprint,
    budgetPolicy: createBudgetPolicy("medium"),
    quests: [
      ...blueprint.quests,
      { id: asQuestId("m4"), name: "主线四", description: "", objectives: [], onSuccess: { kind: "reach_ending", endingId: asEndingId("e1") }, onFailure: { kind: "closed" }, kind: "main", stage: 4 }
    ]
  } as ScenarioBlueprint;
}

type QuestStatus = GameState["quests"][number]["status"];

function stateWith(questStatuses: ReadonlyArray<readonly [QuestId, QuestStatus]>): GameState {
  return {
    stateVersion: 1,
    generation: {
      generationId: "gen-test" as GameState["generation"]["generationId"],
      seed: "test-seed", templateVersion: "tpl-1", inputDigest: "digest-test", gameType: "wuxia"
    },
    player: { name: "P", identity: "H", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: asLocationId("loc_a"),
    unlockedLocationIds: [],
    visitedLocationIds: [],
    npcs: [],
    quests: questStatuses.map(([questId, status]) => ({ questId, status })),
    inventory: [],
    worldFacts: [],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
    towns: [],
    townGeneration: { status: "idle" },
    eventLedger: [{ type: "game_initialized", generation: {
      generationId: "gen-test" as GameState["generation"]["generationId"],
      seed: "test-seed", templateVersion: "tpl-1", inputDigest: "digest-test", gameType: "wuxia"
    } }]
  } as unknown as GameState;
}

const blueprint = buildBlueprint();
const M1 = asQuestId("m1");
const M2 = asQuestId("m2");
const M3 = asQuestId("m3");
const S1 = asQuestId("s1");

describe("deriveContentProgression：主线阶段派生 allowed pacing", () => {
  it.each([
    [1, ["setup", "develop"] as const],
    [2, ["develop", "turn"] as const],
    [3, ["climax"] as const]
  ])("active main stage %i derives required pacing", (stage, allowedPacing) => {
    const states: ReadonlyArray<GameState> = [
      stateWith([[M1, "active"], [M2, "locked"], [M3, "locked"], [S1, "locked"]]),
      stateWith([[M1, "completed"], [M2, "active"], [M3, "locked"], [S1, "locked"]]),
      stateWith([[M1, "completed"], [M2, "completed"], [M3, "active"], [S1, "locked"]])
    ];
    const progression = deriveContentProgression({ blueprint, state: states[stage - 1] });
    expect(progression.mainStage).toBe(stage);
    expect(progression.allowedPacing).toEqual(allowedPacing);
  });

  it("中段连续两幕仍未出现 turn 时，下一场强制转折", () => {
    const state = {
      ...stateWith([[M1, "completed"], [M2, "active"], [M3, "locked"], [S1, "locked"]]),
      storyMemory: {
        version: 1 as const,
        reducedThroughEventCount: 2,
        recent: [
          { kind: "scene" as const, sceneId: "scene-1", locationId: asLocationId("loc_a"), focusNpcId: null, pacing: "setup" as const, turn: 1 },
          { kind: "scene" as const, sceneId: "scene-2", locationId: asLocationId("loc_a"), focusNpcId: null, pacing: "develop" as const, turn: 2 }
        ],
        npcContacts: []
      }
    } as GameState;
    const progression = deriveContentProgression({ blueprint: buildLongBlueprint(), state });
    expect(progression.allowedPacing).toEqual(["turn"]);
  });

  it("新长蓝图的空 story memory 第一场只允许 setup", () => {
    const state = {
      ...stateWith([[M1, "active"], [M2, "locked"], [M3, "locked"], [S1, "locked"]]),
      storyMemory: { version: 1 as const, reducedThroughEventCount: 0, recent: [], npcContacts: [] }
    } as GameState;
    const progression = deriveContentProgression({ blueprint: buildLongBlueprint(), state });
    expect(progression.allowedPacing).toEqual(["setup"]);
  });

  it("已有 turn 后恢复中段 develop/turn 选择，不重复锁死转折", () => {
    const state = {
      ...stateWith([[M1, "completed"], [M2, "active"], [M3, "locked"], [S1, "locked"]]),
      storyMemory: {
        version: 1 as const,
        reducedThroughEventCount: 3,
        recent: [
          { kind: "scene" as const, sceneId: "scene-1", locationId: asLocationId("loc_a"), focusNpcId: null, pacing: "setup" as const, turn: 1 },
          { kind: "scene" as const, sceneId: "scene-2", locationId: asLocationId("loc_a"), focusNpcId: null, pacing: "turn" as const, turn: 2 },
          { kind: "scene" as const, sceneId: "scene-3", locationId: asLocationId("loc_a"), focusNpcId: null, pacing: "develop" as const, turn: 3 }
        ],
        npcContacts: []
      }
    } as GameState;
    const progression = deriveContentProgression({ blueprint, state });
    expect(progression.allowedPacing).toEqual(["develop", "turn"]);
  });

  it("activeQuestIds 只含当前 active 任务，顺序沿用蓝图", () => {
    const state = stateWith([[M1, "active"], [M2, "locked"], [M3, "locked"], [S1, "active"]]);
    const progression = deriveContentProgression({ blueprint, state });
    expect(progression.activeQuestIds).toEqual([M1, S1]);
  });

  it("无 active 主线且至少一个主线已完成 → resolution", () => {
    const state = stateWith([[M1, "completed"], [M2, "completed"], [M3, "completed"], [S1, "locked"]]);
    const progression = deriveContentProgression({ blueprint, state });
    expect(progression.mainStage).toBeNull();
    expect(progression.allowedPacing).toEqual(["resolution"]);
    expect(progression.activeQuestIds).toEqual([]);
  });

  it("无 active 主线但存在 closed 主线（完成即关闭）也视为已完成 → resolution", () => {
    const state = stateWith([[M1, "closed"], [M2, "closed"], [M3, "completed"], [S1, "locked"]]);
    const progression = deriveContentProgression({ blueprint, state });
    expect(progression.mainStage).toBeNull();
    expect(progression.allowedPacing).toEqual(["resolution"]);
  });

  it("其他合法旧存档状态安全回退 setup/develop（不抛错）", () => {
    // 全部 locked 的极端旧档（不应出现，但不得阻断流程）
    const state = stateWith([[M1, "locked"], [M2, "locked"], [M3, "locked"], [S1, "locked"]]);
    const progression = deriveContentProgression({ blueprint, state });
    expect(progression.mainStage).toBeNull();
    expect(progression.allowedPacing).toEqual(["setup", "develop"]);
  });

  it("蓝图无 main 任务时安全回退 setup/develop", () => {
    const sideOnly = { ...blueprint, quests: blueprint.quests.filter((q) => q.kind === "side") } as ScenarioBlueprint;
    const state = stateWith([[S1, "active"]]);
    const progression = deriveContentProgression({ blueprint: sideOnly, state });
    expect(progression.mainStage).toBeNull();
    expect(progression.allowedPacing).toEqual(["setup", "develop"]);
  });
});
