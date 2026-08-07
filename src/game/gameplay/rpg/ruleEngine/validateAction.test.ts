import { describe, it, expect } from "vitest";
import { validateAction } from "./validateAction";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { asLocationId, asNpcId, asEnemyId, asGenerationId } from "@/game/domain/scenarioBlueprint";

describe("validateAction", () => {
  const startingLocation: LocationEntry = {
    id: asLocationId("loc_1"),
    name: "起始地点",
    description: "测试",
    kind: "main",
    connectedLocationIds: [],
    npcIds: [],
    availableItemIds: [],
    tags: [],
  };
  const ws = createInitialWorldState({
    generation: {
      generationId: asGenerationId("gen_test"),
      seed: "test",
      templateVersion: "v2",
      inputDigest: "",
      gameType: "wuxia",
    },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation,
    startingItemIds: [],
  });

  it("rejects move to unknown location", () => {
    const result = validateAction(ws, { type: "move", locationId: asLocationId("unknown") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_LOCATION");
    }
  });

  it("rejects talk to unknown npc", () => {
    const result = validateAction(ws, { type: "talk", npcId: asNpcId("unknown") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_NPC");
    }
  });

  it("accepts ack_prologue always", () => {
    const result = validateAction(ws, { type: "ack_prologue" });
    expect(result.ok).toBe(true);
  });

  it("rejects battle actions in P1", () => {
    expect(validateAction(ws, { type: "attack", enemyId: asEnemyId("e1") }).ok).toBe(false);
    expect(validateAction(ws, { type: "battle_action", action: "attack" }).ok).toBe(false);
  });
});
