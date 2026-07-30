import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId, type GameState, type ScenarioBlueprint } from "@/game/domain";
import type {
  DirectorSource,
  SceneScriptSource,
} from "./runtimeNarrative";
import { orchestrateNarrativeScene } from "./orchestrateNarrativeScene";

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

describe("orchestrateNarrativeScene fallback", () => {
  const blueprint = buildTestBlueprint();
  const state = buildTestGameState();

  it("当 director source 失败时返回 fallback scene", async () => {
    let directorCalls = 0;
    const failingDirector: DirectorSource = {
      async generate(_request) {
        directorCalls += 1;
        return {
          ok: false,
          provenance: "unavailable",
          category: "service_error",
          diagnostics: {
            traceId: "test-director",
            contractVersion: "runtime-narrative-v1",
            stage: "failed",
            category: "service_error",
          },
        };
      },
    };

    const mockScriptSource: SceneScriptSource = {
      async generate(_request) {
        return {
          ok: false,
          provenance: "unavailable",
          category: "service_error",
          diagnostics: {
            traceId: "test-script",
            contractVersion: "runtime-narrative-v1",
            stage: "failed",
            category: "service_error",
          },
        };
      },
    };

    const mockNpcSource = {
      async generate(_request: Parameters<SceneScriptSource["generate"]>[0]) {
        return { ok: false as const, provenance: "unavailable" as const, category: "service_error" as const, diagnostics: { traceId: "test", contractVersion: "runtime-narrative-v1" as const, stage: "failed" as const } };
      },
    };

    const result = await orchestrateNarrativeScene({
      traceId: "test-fallback",
      blueprint,
      state,
      directorSource: failingDirector,
      sceneScriptSource: mockScriptSource,
      npcLineSource: mockNpcSource,
    });

    expect(result.provenance).toBe("fallback");
    expect(result.scene.source).toBe("fallback");
    expect(result.scene.narration.length).toBeGreaterThan(0);
    expect(result.scene.choices).toHaveLength(2);
    expect(directorCalls).toBe(2);
  });
});
