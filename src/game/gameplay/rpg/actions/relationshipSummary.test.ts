import { describe, expect, it } from "vitest";
import { projectRelationshipSummary } from "./relationshipSummary";
import type { GameState, ScenarioBlueprint } from "@/game/domain";

function buildState(overrides?: Partial<GameState>): GameState {
  return {
    stateVersion: 1 as const, generation: {} as never,
    player: { name: "P", identity: "H", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: "loc_1" as never,
    unlockedLocationIds: ["loc_1" as never], visitedLocationIds: ["loc_1" as never],
    npcs: [{ npcId: "npc_1" as never, locationId: "loc_1" as never, met: true }],
    quests: [], inventory: [], worldFacts: [], defeatedEnemyIds: [],
    battle: { status: "idle" }, ending: null,
    narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
    eventLedger: [],
    storyMemory: {
      version: 1, reducedThroughEventCount: 1, recent: [],
      npcContacts: [
        { npcId: "npc_1" as never, lastContactTurn: 1, lastLocationId: "loc_1" as never, lastInteractionSummary: "你初次结识了这位NPC。" },
      ],
    },
    ...overrides,
  } as unknown as GameState;
}

describe("projectRelationshipSummary", () => {
  const blueprint = {} as unknown as ScenarioBlueprint;

  it("有 lastInteractionSummary 时返回它", () => {
    const state = buildState();
    expect(projectRelationshipSummary(state, blueprint, "npc_1")).toBe("你初次结识了这位NPC。");
  });

  it("无 contact 时返回空串", () => {
    const state = buildState();
    expect(projectRelationshipSummary(state, blueprint, "npc_999")).toBe("");
  });

  it("无 lastInteractionSummary 时返回空串", () => {
    const state = buildState({
      storyMemory: {
        version: 1, reducedThroughEventCount: 1, recent: [],
        npcContacts: [{ npcId: "npc_1" as never, lastContactTurn: 1, lastLocationId: "loc_1" as never }],
      },
    });
    expect(projectRelationshipSummary(state, blueprint, "npc_1")).toBe("");
  });
});
