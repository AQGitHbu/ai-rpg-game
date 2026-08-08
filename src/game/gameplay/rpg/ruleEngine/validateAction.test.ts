import { describe, it, expect } from "vitest";
import { validateAction } from "./validateAction";
import { createInitialWorldState, appendEnemy, type LocationEntry, type EnemyEntry } from "@/game/domain/worldState";
import { asLocationId, asNpcId, asEnemyId, asGenerationId } from "@/game/domain/scenarioBlueprint";

function makeWorldWithEnemy() {
  const startingLocation: LocationEntry = {
    id: asLocationId("loc_1"), name: "荒野", description: "test", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  let ws = createInitialWorldState({
    generation: { generationId: asGenerationId("gen_test"), seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation,
    startingItemIds: [],
  });
  const enemy: EnemyEntry = {
    id: asEnemyId("enemy_1"), name: "山贼", tier: "normal",
    stats: { hp: 20, attack: 5, defense: 2 },
    locationId: asLocationId("loc_1"), tags: [],
  };
  return appendEnemy(ws, enemy);
}

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
    const result = validateAction(ws, { type: "talk", npcId: asNpcId("unknown"), dialogueAct: "ask" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_NPC");
    }
  });

  it("accepts ack_prologue always", () => {
    const result = validateAction(ws, { type: "ack_prologue" });
    expect(result.ok).toBe(true);
  });

  it("rejects attack on unknown enemy", () => {
    const ws2 = makeWorldWithEnemy();
    const result = validateAction(ws2, { type: "attack", enemyId: asEnemyId("unknown") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNKNOWN_ENEMY");
  });

  it("rejects attack when player not at enemy location", () => {
    const ws2 = makeWorldWithEnemy();
    const ws3 = { ...ws2, currentLocationId: asLocationId("loc_2") };
    const result = validateAction(ws3, { type: "attack", enemyId: asEnemyId("enemy_1") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ENEMY_NOT_AT_LOCATION");
  });

  it("rejects attack when enemy already defeated", () => {
    const ws2 = makeWorldWithEnemy();
    const ws3 = { ...ws2, defeatedEnemyIds: [asEnemyId("enemy_1")] };
    const result = validateAction(ws3, { type: "attack", enemyId: asEnemyId("enemy_1") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ENEMY_ALREADY_DEFEATED");
  });

  it("rejects attack when battle already active", () => {
    const ws2 = makeWorldWithEnemy();
    const ws3 = { ...ws2, battle: { status: "active", enemyId: asEnemyId("enemy_1"), playerHp: 30, enemyHp: 20, round: 1 } as const };
    const result = validateAction(ws3, { type: "attack", enemyId: asEnemyId("enemy_1") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BATTLE_ALREADY_ACTIVE");
  });

  it("accepts attack on valid enemy at location with idle battle", () => {
    const ws2 = makeWorldWithEnemy();
    const result = validateAction(ws2, { type: "attack", enemyId: asEnemyId("enemy_1") });
    expect(result.ok).toBe(true);
  });
});

describe("validateAction — battle_action", () => {
  it("rejects battle_action when no active battle", () => {
    const startingLocation: LocationEntry = {
      id: asLocationId("loc_1"), name: "荒野", description: "test", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    };
    const ws2 = createInitialWorldState({
      generation: { generationId: asGenerationId("gen_test"), seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation,
      startingItemIds: [],
    });
    const result = validateAction(ws2, { type: "battle_action", action: "attack" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_ACTIVE_BATTLE");
  });

  it("accepts battle_action when battle is active", () => {
    const startingLocation: LocationEntry = {
      id: asLocationId("loc_1"), name: "荒野", description: "test", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    };
    let ws2 = createInitialWorldState({
      generation: { generationId: asGenerationId("gen_test"), seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation,
      startingItemIds: [],
    });
    ws2 = { ...ws2, battle: { status: "active", enemyId: asEnemyId("e1"), playerHp: 100, enemyHp: 50, round: 1 } };
    const result = validateAction(ws2, { type: "battle_action", action: "attack" });
    expect(result.ok).toBe(true);
  });
});
