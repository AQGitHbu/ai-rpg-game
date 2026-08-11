import { describe, it, expect } from "vitest";
import { startBattle, battleAction } from "./battleResolver";
import {
  createInitialWorldState,
  appendEnemy,
  type WorldState,
  type EnemyEntry,
  type LocationEntry,
} from "@/game/domain/worldState";
import { asEnemyId, asLocationId, asGenerationId } from "@/game/domain/worldEntity";

const FIXED_TIME = "2026-08-07T12:00:00Z";
const deps = { now: () => FIXED_TIME };

function makeWorldWithEnemy(): WorldState {
  const startingLocation: LocationEntry = {
    id: asLocationId("loc_1"),
    name: "荒野",
    description: "test",
    kind: "main",
    connectedLocationIds: [],
    npcIds: [],
    availableItemIds: [],
    tags: [],
  };
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 30, attack: 6, defense: 4 } },
    startingLocation,
    startingItemIds: [],
  });
  const enemy: EnemyEntry = {
    id: asEnemyId("enemy_1"),
    name: "山贼",
    tier: "boss",
    stats: { hp: 20, attack: 5, defense: 2 },
    locationId: asLocationId("loc_1"),
    tags: [],
  };
  return appendEnemy(ws, enemy);
}

describe("startBattle", () => {
  it("starts battle when enemy exists at player location and no active battle", () => {
    const ws = makeWorldWithEnemy();
    const result = startBattle(ws, asEnemyId("enemy_1"), deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("active");
      if (result.nextWorldState.battle.status === "active") {
        expect(result.nextWorldState.battle.enemyId).toBe(asEnemyId("enemy_1"));
        expect(result.nextWorldState.battle.playerHp).toBe(30);
        expect(result.nextWorldState.battle.enemyHp).toBe(20);
        expect(result.nextWorldState.battle.round).toBe(1);
      }
      expect(result.events[0]?.type).toBe("battle_started");
      expect(result.status).toBe("success");
    }
  });

  it("rejects when enemy does not exist", () => {
    const ws = makeWorldWithEnemy();
    const result = startBattle(ws, asEnemyId("nonexistent"), deps);
    expect(result.ok).toBe(false);
  });

  it("rejects when player not at enemy location", () => {
    const ws = makeWorldWithEnemy();
    const ws2: WorldState = { ...ws, currentLocationId: asLocationId("loc_elsewhere") };
    const result = startBattle(ws2, asEnemyId("enemy_1"), deps);
    expect(result.ok).toBe(false);
  });

  it("rejects when battle already active", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattle(ws, asEnemyId("enemy_1"), deps);
    if (!started.ok) throw new Error("setup failed");
    const result = startBattle(started.nextWorldState, asEnemyId("enemy_1"), deps);
    expect(result.ok).toBe(false);
  });

  it("rejects when enemy already defeated", () => {
    const ws = makeWorldWithEnemy();
    const ws2: WorldState = { ...ws, defeatedEnemyIds: [asEnemyId("enemy_1")] };
    const result = startBattle(ws2, asEnemyId("enemy_1"), deps);
    expect(result.ok).toBe(false);
  });
});

describe("battleAction", () => {
  it("attack deals damage and enemy counters", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattle(ws, asEnemyId("enemy_1"), deps);
    if (!started.ok) throw new Error("setup failed");
    // player attack=6, enemy defense=2 → damage=4; enemy attack=5, player defense=4 → counter=1
    const result = battleAction(started.nextWorldState, "attack", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("active");
      if (result.nextWorldState.battle.status === "active") {
        expect(result.nextWorldState.battle.enemyHp).toBe(16); // 20 - 4
        expect(result.nextWorldState.battle.playerHp).toBe(29); // 30 - 1
        expect(result.nextWorldState.battle.round).toBe(2);
      }
    }
  });

  it("guard reduces counter damage", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattle(ws, asEnemyId("enemy_1"), deps);
    if (!started.ok) throw new Error("setup failed");
    // guard: no damage to enemy; counter = max(1, 5-4-2) = max(1,-1) = 1
    const result = battleAction(started.nextWorldState, "guard", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      if (result.nextWorldState.battle.status === "active") {
        expect(result.nextWorldState.battle.enemyHp).toBe(20); // no damage
        expect(result.nextWorldState.battle.playerHp).toBe(29); // 30 - 1
      }
    }
  });

  it("flee ends battle as withdraw", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattle(ws, asEnemyId("enemy_1"), deps);
    if (!started.ok) throw new Error("setup failed");
    const result = battleAction(started.nextWorldState, "flee", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("resolved");
      if (result.nextWorldState.battle.status === "resolved") {
        expect(result.nextWorldState.battle.outcome).toBe("withdraw");
      }
    }
  });

  it("victory when enemyHp reaches 0", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattle(ws, asEnemyId("enemy_1"), deps);
    if (!started.ok) throw new Error("setup failed");
    if (started.nextWorldState.battle.status !== "active") throw new Error("battle not active");
    const wsLowHp: WorldState = {
      ...started.nextWorldState,
      battle: { ...started.nextWorldState.battle, enemyHp: 4 },
    };
    const result = battleAction(wsLowHp, "attack", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("resolved");
      if (result.nextWorldState.battle.status === "resolved") {
        expect(result.nextWorldState.battle.outcome).toBe("victory");
      }
      expect(result.nextWorldState.defeatedEnemyIds).toContain(asEnemyId("enemy_1"));
    }
  });

  it("defeat when playerHp reaches 0", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattle(ws, asEnemyId("enemy_1"), deps);
    if (!started.ok) throw new Error("setup failed");
    if (started.nextWorldState.battle.status !== "active") throw new Error("battle not active");
    const wsLowHp: WorldState = {
      ...started.nextWorldState,
      battle: { ...started.nextWorldState.battle, playerHp: 1 },
    };
    const result = battleAction(wsLowHp, "attack", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("resolved");
      if (result.nextWorldState.battle.status === "resolved") {
        expect(result.nextWorldState.battle.outcome).toBe("defeat");
      }
    }
  });

  it("rejects when no active battle", () => {
    const ws = makeWorldWithEnemy();
    const result = battleAction(ws, "attack", deps);
    expect(result.ok).toBe(false);
  });
});
