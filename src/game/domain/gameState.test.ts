import { describe, expect, it } from "vitest";
import type { GameEvent } from "./events";
import type { GameState } from "./gameState";
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
    npcs: [{ npcId: asNpcId("npc_elder"), locationId: asLocationId("loc_village"), met: false }],
    quests: [
      { questId: asQuestId("quest_main_1"), status: "active" },
      { questId: asQuestId("quest_side_1"), status: "locked" }
    ],
    inventory: [asItemId("item_sword")],
    worldFacts: [{ factId: asFactId("fact_master_missing"), discovered: false }],
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
