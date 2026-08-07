import { describe, expect, it } from "vitest";
import type { GameEvent } from "./events";
import type { GameState, TownGenerationState, TownRuntimeState } from "./gameState";
import { TOWN_GENERATOR_VERSION, type TownSemanticPlan } from "./townSnapshot";
import {
  asFactId,
  asGenerationId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
  type GenerationMetadata
} from "./scenarioBlueprint";

function buildGeneration(): GenerationMetadata {
  return {
    generationId: asGenerationId("gen-0001"),
    seed: "seed-1",
    templateVersion: "tpl-1",
    inputDigest: "digest-abc",
    gameType: "wuxia"
  };
}

/** 手工构造的最小初始状态：Task 5 的 initializeGameState 将产出同构数据。 */
function buildInitialState(): GameState {
  const generation = buildGeneration();
  return {
    stateVersion: 1,
    generation,
    player: {
      name: "林惊羽",
      identity: "青云门外门弟子",
      stats: { hp: 20, attack: 5, defense: 3 }
    },
    currentLocationId: asLocationId("loc_village"),
    unlockedLocationIds: [asLocationId("loc_village")],
    visitedLocationIds: [asLocationId("loc_village")],
    npcs: [{ npcId: asNpcId("npc_elder"), locationId: asLocationId("loc_village"), met: false }],
    quests: [
      { questId: asQuestId("quest_main_1"), status: "active" },
      { questId: asQuestId("quest_side_1"), status: "locked" }
    ],
    inventory: [asItemId("item_sword")],
    worldFacts: [{ factId: asFactId("fact_master_missing"), discovered: false }],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
    towns: [],
    townGeneration: { status: "idle" },
    // Phase 14：序幕未播放 + 主线幕数追踪（act 1 起步，未提议结局）。
    prologueShown: false,
    mainStoryProgress: { currentAct: 1, endingProposed: false },
    eventLedger: [{ type: "game_initialized", generation }]
  };
}

describe("GameState", () => {
  it("is constructible as pure data with a game_initialized ledger entry", () => {
    const state = buildInitialState();
    expect(state.stateVersion).toBe(1);
    expect(state.eventLedger).toHaveLength(1);
    expect(state.eventLedger[0]).toEqual({
      type: "game_initialized",
      generation: buildGeneration()
    });
  });

  it("rejects raw strings for id fields at compile time", () => {
    const state = buildInitialState();
// @ts-expect-error currentLocationId requires a branded LocationId
    const broken: GameState = { ...state, currentLocationId: "loc_village" };
    expect(broken.currentLocationId).toBe("loc_village");
  });
});

describe("GameEvent", () => {
  it("narrows on the stable type discriminator", () => {
    const event: GameEvent = { type: "game_initialized", generation: buildGeneration() };
    switch (event.type) {
      case "game_initialized":
        expect(event.generation.seed).toBe("seed-1");
        break;
    }
  });

  it("rejects unknown event types at compile time", () => {
// @ts-expect-error only declared Phase 1 event types are allowed
    const unknownEvent: GameEvent = { type: "combat_resolved" };
    expect(unknownEvent).toBeDefined();
  });
});

describe("Town runtime state", () => {
  const plan: TownSemanticPlan = {
    planVersion: 1,
    theme: "青石镇",
    gridSize: { width: 32, height: 32 },
    terrain: { river: "none", externalRoad: "east_west" },
    districts: [{ type: "market", preferredArea: "center", weight: 2 }],
    requiredBuildings: [
      { key: "story_npc_elder", buildingType: "house", preferredDistrict: "residential", importance: "story_required" }
    ],
    landmarks: [{ type: "well", preferredArea: "center" }]
  };

  it("attaches a lazily generated town plan per location", () => {
    const town: TownRuntimeState = {
      locationId: asLocationId("loc_village"),
      seed: "seed-1#town#loc_village",
      plan,
      planSource: "offline",
      generatorVersion: TOWN_GENERATOR_VERSION
    };
    const state: GameState = { ...buildInitialState(), towns: [town] };
    expect(state.towns).toHaveLength(1);
    expect(state.towns[0].planSource).toBe("offline");
  });

  it("models pending AI generation with the target location", () => {
    const pending: TownGenerationState = {
      status: "pending",
      locationId: asLocationId("loc_village"),
      requestedAt: "2026-07-30T00:00:00.000Z"
    };
    const state: GameState = { ...buildInitialState(), townGeneration: pending };
    expect(state.townGeneration.status).toBe("pending");
  });

  it("rejects unknown plan sources at compile time", () => {
    const town: TownRuntimeState = {
      locationId: asLocationId("loc_village"),
      seed: "seed-1",
      plan,
// @ts-expect-error only offline | generated | fallback are legal plan sources
      planSource: "manual",
      generatorVersion: TOWN_GENERATOR_VERSION
    };
    expect(town.planSource).toBe("manual");
  });
});
