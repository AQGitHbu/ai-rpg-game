import { describe, it, expect } from "vitest";
import { startBattle, battleAction } from "./battleResolver";
import {
  createInitialWorldState,
  type WorldState,
  type EnemyEntry,
  type LocationEntry,
} from "@/game/domain/worldState";
import { updateWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import { asEnemyId, asLocationId, asGenerationId } from "@/game/domain/worldEntity";
import { asTurnId, eventIdFor } from "@/game/domain/events";

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
  return updateWorldStateFixture(ws, { enemies: [enemy] });
}

describe("startBattle", () => {
  it("derives battleKey from the stable battle_started event ID", () => {
    const ws = makeWorldWithEnemy();
    const turnId = asTurnId("turn:open-battle");
    const result = startBattle(ws, asEnemyId("enemy_1"), turnId);
    expect(result.ok).toBe(true);
    if (!result.ok || result.nextWorldState.battle.status !== "active") return;
    const expectedEventId = eventIdFor(turnId, "battle_started:enemy_1");
    expect(result.nextWorldState.battle.battleKey).toBe(expectedEventId);
    expect(result.drafts[0]?.episodeKey).toBe(`battle:${expectedEventId}`);
  });

  it("starts battle when enemy exists at player location and no active battle", () => {
    const ws = makeWorldWithEnemy();
    const result = startBattle(ws, asEnemyId("enemy_1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("active");
      if (result.nextWorldState.battle.status === "active") {
        expect(result.nextWorldState.battle.enemyId).toBe(asEnemyId("enemy_1"));
        expect(result.nextWorldState.battle.playerHp).toBe(30);
        expect(result.nextWorldState.battle.enemyHp).toBe(20);
        expect(result.nextWorldState.battle.round).toBe(1);
      }
      expect(result.drafts[0]?.payload.type).toBe("battle_started");
      expect(result.status).toBe("success");
    }
  });

  it("rejects when enemy does not exist", () => {
    const ws = makeWorldWithEnemy();
    const result = startBattle(ws, asEnemyId("nonexistent"));
    expect(result.ok).toBe(false);
  });

  it("rejects when player not at enemy location", () => {
    const ws = makeWorldWithEnemy();
    const ws2: WorldState = { ...ws, currentLocationId: asLocationId("loc_elsewhere") };
    const result = startBattle(ws2, asEnemyId("enemy_1"));
    expect(result.ok).toBe(false);
  });

  it("rejects when battle already active", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattle(ws, asEnemyId("enemy_1"));
    if (!started.ok) throw new Error("setup failed");
    const result = startBattle(started.nextWorldState, asEnemyId("enemy_1"));
    expect(result.ok).toBe(false);
  });

  it("allows retrying an undefeated enemy after withdrawing", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattle(ws, asEnemyId("enemy_1"));
    if (!started.ok) throw new Error("setup failed");
    const withdrawn = battleAction(started.nextWorldState, "flee");
    if (!withdrawn.ok) throw new Error("withdraw failed");
    const retried = startBattle(withdrawn.nextWorldState, asEnemyId("enemy_1"));
    expect(retried.ok).toBe(true);
  });

  it("rejects when enemy already defeated", () => {
    const ws = makeWorldWithEnemy();
    const ws2: WorldState = { ...ws, defeatedEnemyIds: [asEnemyId("enemy_1")] };
    const result = startBattle(ws2, asEnemyId("enemy_1"));
    expect(result.ok).toBe(false);
  });
});

describe("battleAction", () => {
  it("attack deals damage and enemy counters", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattle(ws, asEnemyId("enemy_1"));
    if (!started.ok) throw new Error("setup failed");
    // player attack=6, enemy defense=2 → damage=4; enemy attack=5, player defense=4 → counter=1
    const result = battleAction(started.nextWorldState, "attack");
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

  it("keeps the pre-battle snapshot and battleKey across a non-terminal legacy round", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattle(ws, asEnemyId("enemy_1"));
    if (!started.ok) throw new Error("setup failed");
    if (started.nextWorldState.battle.status !== "active") throw new Error("setup failed: battle not active");
    const before = started.nextWorldState.battle;

    const result = battleAction(started.nextWorldState, "attack");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("non-terminal round must be accepted");
    if (result.nextWorldState.battle.status !== "active") throw new Error("round must stay non-terminal");
    const after = result.nextWorldState.battle;

    // 战前快照是战败/撤退唯一可恢复的世界，battleKey 标识同一场战斗：
    // 它们在规则层就该跨回合存活，否则回滚保证在应用层之前就已经没了。
    expect(after.preBattleSnapshot).toEqual(before.preBattleSnapshot);
    expect(after.battleKey).toBe(before.battleKey);
  });

  it("carries every active-battle field through a non-terminal legacy round", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattle(ws, asEnemyId("enemy_1"));
    if (!started.ok) throw new Error("setup failed");
    if (started.nextWorldState.battle.status !== "active") throw new Error("setup failed: battle not active");
    // 旧存档可以带可选 enemyIds 却不带任何现代战斗字段：仍属非终结的 legacy 分支。
    const worldState: WorldState = {
      ...started.nextWorldState,
      battle: { ...started.nextWorldState.battle, enemyIds: [asEnemyId("enemy_1")] },
    };
    const before = worldState.battle;
    if (before.status !== "active") throw new Error("setup failed: battle not active");

    const result = battleAction(worldState, "attack");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("non-terminal round must be accepted");
    if (result.nextWorldState.battle.status !== "active") throw new Error("round must stay non-terminal");
    const after = result.nextWorldState.battle;

    // 回合只允许改写 hp 与 round：其余字段（这里用可选 enemyIds 探针）必须原样带过。
    // 手工枚举字段的结构一旦漏写新字段就静默丢档，所以这里锁“整份带过去”而不是锁两个字段。
    expect(after.enemyIds).toEqual(before.enemyIds);
    expect(after.enemyId).toBe(before.enemyId);
    expect(after.status).toBe("active");
  });

  it("guard reduces counter damage", () => {
    const ws = makeWorldWithEnemy();
    const started = startBattle(ws, asEnemyId("enemy_1"));
    if (!started.ok) throw new Error("setup failed");
    // guard: no damage to enemy; counter = max(1, 5-4-2) = max(1,-1) = 1
    const result = battleAction(started.nextWorldState, "guard");
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
    const started = startBattle(ws, asEnemyId("enemy_1"));
    if (!started.ok) throw new Error("setup failed");
    const result = battleAction(started.nextWorldState, "flee");
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
    const started = startBattle(ws, asEnemyId("enemy_1"));
    if (!started.ok) throw new Error("setup failed");
    if (started.nextWorldState.battle.status !== "active") throw new Error("battle not active");
    const wsLowHp: WorldState = {
      ...started.nextWorldState,
      battle: { ...started.nextWorldState.battle, enemyHp: 4 },
    };
    const result = battleAction(wsLowHp, "attack");
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
    const started = startBattle(ws, asEnemyId("enemy_1"));
    if (!started.ok) throw new Error("setup failed");
    if (started.nextWorldState.battle.status !== "active") throw new Error("battle not active");
    const wsLowHp: WorldState = {
      ...started.nextWorldState,
      battle: { ...started.nextWorldState.battle, playerHp: 1 },
    };
    const result = battleAction(wsLowHp, "attack");
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
    const result = battleAction(ws, "attack");
    expect(result.ok).toBe(false);
  });
});
