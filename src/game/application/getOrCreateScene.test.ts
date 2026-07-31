import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId, type GameState, type ScenarioBlueprint } from "@/game/domain";
import { NARRATIVE_CONTRACT_VERSION, type DirectorSource, type SceneScriptSource, type NpcLineSource } from "./runtimeNarrative";
import { getOrCreateScene } from "./getOrCreateScene";

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

function buildTestGameState(currentScene: GameState["narrative"]["currentScene"] = null): GameState {
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
    worldFacts: [{ factId: asFactId("fact_1"), discovered: true }],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene },
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

const mockDirectorSource: DirectorSource = {
  async generate() {
    return {
      ok: false,
      provenance: "unavailable",
      category: "service_error",
      diagnostics: {
        traceId: "test",
        contractVersion: NARRATIVE_CONTRACT_VERSION,
        stage: "failed",
        category: "service_error",
      },
    };
  },
};

const mockScriptSource: SceneScriptSource = {
  async generate() {
    return {
      ok: false,
      provenance: "unavailable",
      category: "service_error",
      diagnostics: {
        traceId: "test",
        contractVersion: NARRATIVE_CONTRACT_VERSION,
        stage: "failed",
        category: "service_error",
      },
    };
  },
};

const mockNpcSource: NpcLineSource = {
  async generate() {
    return {
      ok: false,
      provenance: "unavailable",
      category: "service_error",
      diagnostics: {
        traceId: "test",
        contractVersion: NARRATIVE_CONTRACT_VERSION,
        stage: "failed",
      },
    };
  },
};

describe("getOrCreateScene", () => {
  const blueprint = buildTestBlueprint();

  it("currentScene 为 null 时返回 fallback scene", async () => {
    const state = buildTestGameState(null);
    const result = await getOrCreateScene({
      blueprint,
      state,
      directorSource: mockDirectorSource,
      sceneScriptSource: mockScriptSource,
      npcLineSource: mockNpcSource,
    });
    expect(result.scene.source).toBe("fallback");
    expect(result.provenance).toBe("fallback");
  });

  it("currentScene 已存在时返回 cached", async () => {
    const existingScene = {
      sceneId: "existing-scene",
      turn: 1,
      narration: "已有的场景",
      usedFactIds: [] as unknown as GameState["narrative"]["currentScene"] extends { usedFactIds: infer U } ? U : never,
      npcLine: null,
      choices: [
        { choiceToken: "a", label: "选项A", actionKey: "talk:npc_1" },
        { choiceToken: "b", label: "选项B", actionKey: "observe:loc_a" },
      ] as unknown as GameState["narrative"]["currentScene"] extends { choices: infer C } ? C : never,
      source: "generated" as const,
    };
    const state = buildTestGameState(existingScene as GameState["narrative"]["currentScene"]);
    const result = await getOrCreateScene({
      blueprint,
      state,
      directorSource: mockDirectorSource,
      sceneScriptSource: mockScriptSource,
      npcLineSource: mockNpcSource,
    });
    expect(result.provenance).toBe("cached");
    expect(result.scene.sceneId).toBe("existing-scene");
  });
});
