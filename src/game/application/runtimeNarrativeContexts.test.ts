import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId, type GameState, type ScenarioBlueprint } from "@/game/domain";
import { toDirectorContext, toNpcLineContext, toSceneScriptContext } from "./runtimeNarrativeContexts";

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
