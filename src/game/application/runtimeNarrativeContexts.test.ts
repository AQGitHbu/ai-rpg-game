import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId, type GameState, type NewGameInput, type ScenarioBlueprint } from "@/game/domain";
import { ensureTownRuntime } from "@/game/gameplay/rpg/town";
import type { ApprovedDirectorPlan } from "@/game/gameplay/rpg/narrative";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { toDirectorContext, toNpcLineContext, toSceneScriptContext, toTownSpatialContext } from "./runtimeNarrativeContexts";
import { runScenarioPipeline } from "./applicationFixture.testutil";

function buildTestBlueprint(): ScenarioBlueprint {
  return {
    schemaVersion: 1 as const,
    generationId: "gen-test" as ScenarioBlueprint["generationId"],
    seed: "test-seed",
    templateVersion: "tpl-1",
    inputDigest: "digest-test",
    gameType: "wuxia",
    world: {
      name: "Test World",
      summary: "A test world",
      tone: "dark",
      themes: ["justice"],
      facts: [
        { id: asFactId("fact_1"), text: "公开事实1", source: "player_input" },
        { id: asFactId("fact_2"), text: "未发现事实", source: "generated" },
        { id: asFactId("fact_3"), text: "秘密事实", source: "generated" },
      ]
    },
    locations: [
      { id: asLocationId("loc_a"), name: "地点A", description: "", kind: "public", connectedLocationIds: [] },
    ],
    npcs: [
      { id: asNpcId("npc_1"), name: "NPC1", role: "村民", locationId: asLocationId("loc_a"), knownFactIds: [asFactId("fact_1")] },
    ],
    quests: [],
    enemies: [],
    items: [],
    endings: [],
    player: {
      name: "Player", identity: "Hero",
      startingItemIds: [],
      baseStats: { hp: 20, attack: 5, defense: 3 }
    },
    openingScene: {
      locationId: asLocationId("loc_a"),
      narration: "开始",
      suggestedActions: [],
      presentNpcIds: [asNpcId("npc_1")],
      investigableFactIds: [],
    },
  } as unknown as ScenarioBlueprint;
}

function buildTestGameState(): GameState {
  return {
    stateVersion: 1 as const,
    generation: {
      generationId: "gen-test" as GameState["generation"]["generationId"],
      seed: "test-seed",
      templateVersion: "tpl-1",
      inputDigest: "digest-test",
      gameType: "wuxia",
    },
    player: { name: "Player", identity: "Hero", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: asLocationId("loc_a"),
    unlockedLocationIds: [asLocationId("loc_a")],
    visitedLocationIds: [asLocationId("loc_a")],
    npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_a"), met: true }],
    quests: [],
    inventory: [],
    worldFacts: [
      { factId: asFactId("fact_1"), discovered: true },
      { factId: asFactId("fact_2"), discovered: false },
      { factId: asFactId("fact_3"), discovered: false },
    ],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null },
    eventLedger: [{
      type: "game_initialized",
      generation: {
        generationId: "gen-test" as GameState["generation"]["generationId"],
        seed: "test-seed",
        templateVersion: "tpl-1",
        inputDigest: "digest-test",
        gameType: "wuxia",
      },
    }],
  } as unknown as GameState;
}

describe("runtimeNarrativeContexts 导演", () => {
  const blueprint = buildTestBlueprint();
  const state = buildTestGameState();

  it("toDirectorContext 包含 narrative state", () => {
    const context = toDirectorContext({ blueprint, state });
    expect(context.narrative.currentScene).toBeNull();
  });

  it("toDirectorContext 包含 current location", () => {
    const context = toDirectorContext({ blueprint, state });
    expect(context.currentLocationId).toBe("loc_a");
  });

  it("toDirectorContext 有 discovered facts ids", () => {
    const context = toDirectorContext({ blueprint, state });
    expect(context.discoveredFactIds).toContain("fact_1");
  });

  it("toDirectorContext 的 event ledger 不含 AI prompt 原文", () => {
    const context = toDirectorContext({ blueprint, state });
    const line = JSON.stringify(context);
    expect(line).not.toMatch(/\bprompt\b/i);
    expect(line).not.toMatch(/\bkey\b/i);
  });
});

describe("runtimeNarrativeContexts 编剧", () => {
  const blueprint = buildTestBlueprint();
  const state = buildTestGameState();

  it("toSceneScriptContext 包含 plan", () => {
    const context = toSceneScriptContext({
      blueprint,
      state,
      plan: {
        sceneGoal: "test",
        tensionLevel: 2,
        focusNpcId: "npc_1",
        relevantFactIds: ["fact_1"],
        allowedRevealFactIds: ["fact_1"],
        suggestedActionKeys: ["talk:npc_1", "observe:loc_a"],
        introducedEntities: [],
        pacing: "develop",
      },
    });
    expect(context.plan.sceneGoal).toBe("test");
  });

  it("toSceneScriptContext 不含 AI prompt 原文", () => {
    const context = toSceneScriptContext({
      blueprint,
      state,
      plan: {
        sceneGoal: "test",
        tensionLevel: 2,
        focusNpcId: "npc_1",
        relevantFactIds: ["fact_1"],
        allowedRevealFactIds: ["fact_1"],
        suggestedActionKeys: ["talk:npc_1", "observe:loc_a"],
        introducedEntities: [],
        pacing: "develop",
      },
    });
    const line = JSON.stringify(context);
    expect(line).not.toMatch(/\bprompt\b/i);
    expect(line).not.toMatch(/\bkey\b/i);
  });
});

describe("runtimeNarrativeContexts 演员", () => {
  const blueprint = buildTestBlueprint();
  const state = buildTestGameState();

  it("toNpcLineContext 包含 NPC 定义", () => {
    const context = toNpcLineContext({
      blueprint,
      state,
      npcId: "npc_1",
      speechAct: "inform",
      allowedFactIds: ["fact_1"],
      mayLie: false,
    });
    const npcDef = context.npcDefinition as Record<string, unknown>;
    expect(npcDef.id).toBe("npc_1");
    expect(npcDef.name).toBe("NPC1");
  });

  it("toNpcLineContext 包含事实卡片", () => {
    const context = toNpcLineContext({
      blueprint,
      state,
      npcId: "npc_1",
      speechAct: "inform",
      allowedFactIds: ["fact_1"],
      mayLie: false,
    });
    expect(context.factCards).toHaveLength(1);
    const card = context.factCards[0] as Record<string, unknown>;
    expect(card.id).toBe("fact_1");
  });

  it("toNpcLineContext 不含 AI prompt 原文", () => {
    const context = toNpcLineContext({
      blueprint,
      state,
      npcId: "npc_1",
      speechAct: "inform",
      allowedFactIds: ["fact_1"],
      mayLie: false,
    });
    const line = JSON.stringify(context);
    expect(line).not.toMatch(/\bprompt\b/i);
    expect(line).not.toMatch(/\bkey\b/i);
  });
});

// ---------------------------------------------------------------------------
// Town 主循环 S8：小镇空间语义注入（当前地点为就绪 town 时才注入）。
// fallback 蓝图的 loc_2 固定为 town 地点（createFallbackBlueprint 约定）。
// ---------------------------------------------------------------------------

describe("runtimeNarrativeContexts 小镇空间语义", () => {
  const FIXTURE = wuxiaFixture as unknown as { input: NewGameInput; seed: string };
  const PIPELINE = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);
  const TOWN_ID = "loc_2";
  const FIXED_TIME = "2026-07-27T12:00:00.000Z";

  function readyTownState(): GameState {
    const base: GameState = { ...PIPELINE.state, currentLocationId: asLocationId(TOWN_ID) };
    const entry = ensureTownRuntime(PIPELINE.blueprint, base, TOWN_ID, "offline", FIXED_TIME);
    if (entry.kind !== "generated") throw new Error("loc_2 应为 town 地点");
    return { ...base, towns: [entry.town] };
  }

  const scenePlan: ApprovedDirectorPlan = {
    sceneGoal: "探查",
    tensionLevel: 2,
    focusNpcId: null,
    relevantFactIds: [],
    allowedRevealFactIds: [],
    suggestedActionKeys: ["observe:loc_2", "observe:loc_2"],
    introducedEntities: [],
    pacing: "develop",
  };

  it("非 town 地点：toTownSpatialContext 返回 undefined，两个上下文均不注入", () => {
    const state: GameState = { ...PIPELINE.state, currentLocationId: asLocationId("loc_1") };
    expect(toTownSpatialContext(PIPELINE.blueprint, state)).toBeUndefined();
    expect(toDirectorContext({ blueprint: PIPELINE.blueprint, state }).townSpatial).toBeUndefined();
    expect(
      toSceneScriptContext({ blueprint: PIPELINE.blueprint, state, plan: scenePlan }).townSpatial
    ).toBeUndefined();
  });

  it("就绪 town：导演上下文注入镇名与非空语义句子", () => {
    const state = readyTownState();
    const context = toDirectorContext({ blueprint: PIPELINE.blueprint, state });
    expect(context.townSpatial).toBeDefined();
    expect(context.townSpatial?.townName.length).toBeGreaterThan(0);
    expect(context.townSpatial?.sentences.length).toBeGreaterThan(0);
  });

  it("就绪 town：编剧上下文注入建筑方位语义且不含坐标", () => {
    const state = readyTownState();
    const context = toSceneScriptContext({ blueprint: PIPELINE.blueprint, state, plan: scenePlan });
    expect(context.townSpatial).toBeDefined();
    for (const building of context.townSpatial?.buildings ?? []) {
      expect(typeof building.displayName).toBe("string");
      expect(typeof building.area).toBe("string");
      expect(typeof building.buildingType).toBe("string");
    }
    // 坐标无关：投影不得泄露 seed 或几何坐标字段。
    const line = JSON.stringify(context.townSpatial);
    expect(line).not.toMatch(/\bseed\b/i);
    expect(line).not.toMatch(/footprint|entrance|\bx\b|\by\b/i);
  });
});
