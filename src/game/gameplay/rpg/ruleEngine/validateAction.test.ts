import { describe, it, expect } from "vitest";
import { validateAction } from "./validateAction";
import { createInitialWorldState, appendEnemy, appendNpc, type LocationEntry, type EnemyEntry, type NpcEntry } from "@/game/domain/worldState";
import { asLocationId, asNpcId, asEnemyId, asGenerationId, asItemId } from "@/game/domain/worldEntity";

function makeWorldWithEnemy() {
  const startingLocation: LocationEntry = {
    id: asLocationId("loc_1"), name: "荒野", description: "test", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const ws = createInitialWorldState({
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

  it("accepts attack after a resolved withdrawal when the enemy remains undefeated", () => {
    const ws2 = makeWorldWithEnemy();
    const ws3 = {
      ...ws2,
      battle: { status: "resolved", enemyId: asEnemyId("enemy_1"), outcome: "withdraw" } as const,
    };
    expect(validateAction(ws3, { type: "attack", enemyId: asEnemyId("enemy_1") }).ok).toBe(true);
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

  describe("give_item", () => {
    const giveLoc: LocationEntry = {
      id: asLocationId("loc_1"), name: "起始地点", description: "测试", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    };
    const giveBase = createInitialWorldState({
      generation: { generationId: asGenerationId("gen_test"), seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
      player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
      startingLocation: giveLoc,
      startingItemIds: [],
    });
    const npc: NpcEntry = {
      id: asNpcId("npc_gift"), name: "老板", role: "路人", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId("npc_gift"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const item = { id: asItemId("item_gift"), name: "铜钥匙", description: "d", kind: "key", tags: [] } as const;
    const base = appendNpc(giveBase, npc);
    const withGift = { ...base, items: [...base.items, item], inventory: [...base.inventory, item.id] };

    it("拥有物品且 NPC 在场时允许给予", () => {
      expect(validateAction(withGift, { type: "give_item", itemId: item.id, npcId: npc.id }).ok).toBe(true);
    });

    it("未拥有物品拒绝给予", () => {
      // 世界存在该物品但不在背包 → ITEM_NOT_OWNED
      const notOwned = { ...base, items: [...base.items, item] };
      const result = validateAction(notOwned, { type: "give_item", itemId: item.id, npcId: npc.id });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("ITEM_NOT_OWNED");
    });

    it("重复给予（物品已不在背包）稳定拒绝且零写入", () => {
      const afterGive = { ...withGift, inventory: withGift.inventory.filter((id) => id !== item.id) };
      const result = validateAction(afterGive, { type: "give_item", itemId: item.id, npcId: npc.id });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("ITEM_NOT_OWNED");
    });

    it("未知物品与不在场 NPC 拒绝", () => {
      expect(validateAction(withGift, { type: "give_item", itemId: asItemId("item_none"), npcId: npc.id }).ok).toBe(false);
      expect(validateAction(withGift, { type: "give_item", itemId: item.id, npcId: asNpcId("npc_absent") }).ok).toBe(false);
    });
  });
});
