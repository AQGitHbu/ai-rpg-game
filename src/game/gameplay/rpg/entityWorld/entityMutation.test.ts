import { describe, it, expect } from "vitest";
import { emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { createWorldStateFromProjection, type WorldState } from "@/game/domain/worldState";
import type {
  EnemyEntry, ItemEntry, LocationEntry, NpcEntry, PlayerState, QuestEntry, WorldFactEntry,
} from "@/game/domain/worldState";
import type { EntityCompatibilityProjection, NpcEntityRecord, NpcStateComponent, PossessionComponent } from "@/game/domain/entity";
import { entitiesOfKind, getEntity } from "@/game/domain/entity";
import {
  asFactId, asGenerationId, asItemId, asLocationId, asNpcId, asQuestId, asEnemyId,
  PLAYER_ENTITY_ID, type GenerationMetadata,
} from "@/game/domain/worldEntity";
import { applyEntityMutations, EntityMutationInvariantError, type EntityMutation } from "./entityMutation";

// ---------------------------------------------------------------------------
// 规则可信 mutation 闭包：store 是唯一写入目标，兼容投影一律由 projector 重建。
// 每个用例都同时断言 store 事实与投影结果，防止“只改数组不回写 store”的漂移复活。
// ---------------------------------------------------------------------------

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("g1"), seed: "s", templateVersion: "v3", inputDigest: "", gameType: "wuxia",
};
const PLAYER: PlayerState = { name: "侠客", identity: "镖师", stats: { hp: 100, attack: 10, defense: 5 } };

const LOC_1 = asLocationId("loc_1");
const LOC_2 = asLocationId("loc_2");
const LOC_3 = asLocationId("loc_3");
const NPC_1 = asNpcId("npc_1");
const NPC_2 = asNpcId("npc_2");
const ITEM_A = asItemId("item_a");
const ITEM_B = asItemId("item_b");
const ITEM_C = asItemId("item_c");
const FACT_1 = asFactId("fact_1");
const QUEST_1 = asQuestId("quest_1");
const ENEMY_1 = asEnemyId("enemy_1");

function location(id: LocationEntry["id"], connectedLocationIds: readonly LocationEntry["id"][]): LocationEntry {
  return {
    id, name: String(id), description: "", kind: "main",
    connectedLocationIds, npcIds: [], availableItemIds: [], tags: [],
  };
}

function memoryOf(npcId: NpcEntry["id"]): NpcStateComponent["memory"] {
  return {
    npcId, knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
    relationship: { affinity: 0 }, emotion: "neutral", goals: [],
  };
}

function npcEntry(id: NpcEntry["id"], locationId: LocationEntry["id"]): NpcEntry {
  return {
    id, name: String(id), role: "线人", description: "", locationId,
    isCompanion: false, tags: [], met: false, memory: memoryOf(id),
  };
}

function itemEntry(id: ItemEntry["id"]): ItemEntry {
  return { id, name: String(id), description: "", kind: "token", tags: [] };
}

const FACT_1_ENTRY: WorldFactEntry = {
  factId: FACT_1, text: "古井下有密道", source: "generated", discovered: false, locationId: LOC_1,
};
const QUEST_1_ENTRY: QuestEntry = {
  id: QUEST_1, name: "寻人", description: "", objectives: [{ kind: "discover_fact", factId: FACT_1 }],
  onSuccess: { kind: "closed" }, onFailure: { kind: "closed" }, tags: [], kind: "main", status: "active",
};
const ENEMY_1_ENTRY: EnemyEntry = {
  id: ENEMY_1, name: "山贼", tier: "normal", stats: { hp: 20, attack: 5, defense: 2 }, locationId: LOC_1, tags: [],
};

// loc_1 上挂 npc_1/npc_2（按声明顺序取 locationOrder 0/1）与 item_a；
// inventory 有 item_b；item_c 无主；loc_2 已解锁未到访；loc_3 未解锁未到访。
const BASE: EntityCompatibilityProjection = {
  ...emptyProjection({
    player: PLAYER,
    locations: [{ ...location(LOC_1, [LOC_2, LOC_3]), availableItemIds: [ITEM_A] }, location(LOC_2, [LOC_1]), location(LOC_3, [LOC_1])],
    currentLocationId: LOC_1,
    unlockedLocationIds: [LOC_1, LOC_2],
    visitedLocationIds: [LOC_1],
  }),
  npcs: [npcEntry(NPC_1, LOC_1), npcEntry(NPC_2, LOC_1)],
  items: [itemEntry(ITEM_A), itemEntry(ITEM_B), itemEntry(ITEM_C)],
  inventory: [ITEM_B],
  worldFacts: [FACT_1_ENTRY],
  quests: [QUEST_1_ENTRY],
  enemies: [ENEMY_1_ENTRY],
};

function world(overrides: Partial<EntityCompatibilityProjection> = {}): WorldState {
  return createWorldStateFromProjection({
    generation: GENERATION,
    projection: { ...BASE, ...overrides },
    battle: { status: "active", enemyId: ENEMY_1, playerHp: 90, enemyHp: 20, round: 1 },
    eventLedger: [{ type: "game_initialized", generation: GENERATION }],
  });
}

function okApply(ws: WorldState, mutations: readonly EntityMutation[]): WorldState {
  const result = applyEntityMutations(ws, mutations);
  if (!result.ok) throw new Error(`expected mutation batch to succeed, got ${result.code}`);
  return result.worldState;
}

function itemPossession(ws: WorldState, itemId: ItemEntry["id"]): PossessionComponent {
  const record = entitiesOfKind(ws.entityStore, "item").find((entry) => entry.core.id === itemId);
  if (record === undefined) throw new Error(`missing item ${itemId}`);
  return record.possession;
}

function npcRecord(ws: WorldState, npcId: NpcEntry["id"]) {
  const record = entitiesOfKind(ws.entityStore, "npc").find((r) => r.core.id === npcId);
  if (record === undefined) throw new Error(`missing npc ${npcId}`);
  return record;
}

function locationRecord(ws: WorldState, locationId: LocationEntry["id"]) {
  const record = entitiesOfKind(ws.entityStore, "location").find((r) => r.core.id === locationId);
  if (record === undefined) throw new Error(`missing location ${locationId}`);
  return record;
}

function npcEntityRecord(record: NpcEntityRecord): NpcEntityRecord {
  return record;
}

describe("applyEntityMutations — 玩家与 NPC 位置", () => {
  it("move_player 一次更新 position、currentLocationId 与 visitedLocationIds", () => {
    const next = okApply(world(), [{ kind: "move_player", toLocationId: LOC_2, markVisited: true }]);
    expect(entitiesOfKind(next.entityStore, "player_character")[0].position.locationId).toBe(LOC_2);
    expect(next.currentLocationId).toBe(LOC_2);
    expect(next.visitedLocationIds).toEqual([LOC_1, LOC_2]);
    expect(locationRecord(next, LOC_2).location.visited).toBe(true);
  });

  it("move_player 重复到访同一地点不产生第二条 visited 记录", () => {
    const once = okApply(world(), [{ kind: "move_player", toLocationId: LOC_2, markVisited: true }]);
    const twice = okApply(once, [{ kind: "move_player", toLocationId: LOC_2, markVisited: true }]);
    expect(twice.visitedLocationIds).toEqual([LOC_1, LOC_2]);
    expect(twice.currentLocationId).toBe(LOC_2);
  });

  it("move_player 引用未知地点返回 invalid_reference 且整批零修改", () => {
    const ws = world();
    const result = applyEntityMutations(ws, [
      { kind: "discover_fact", factId: FACT_1 },
      { kind: "move_player", toLocationId: asLocationId("loc_missing"), markVisited: true },
    ]);
    expect(result).toEqual({ ok: false, code: "invalid_reference", entityId: asLocationId("loc_missing") });
    expect(ws.worldFacts.find((f) => f.factId === FACT_1)?.discovered).toBe(false);
  });

  it("move_npc 只接受 npc：对地点施加返回 wrong_entity_kind", () => {
    const result = applyEntityMutations(world(), [{ kind: "move_npc", npcId: asNpcId(String(LOC_2)), toLocationId: LOC_1 }]);
    expect(result).toEqual({ ok: false, code: "wrong_entity_kind", entityId: LOC_2 });
  });

  it("move_npc 同时刷新两地名册投影", () => {
    const next = okApply(world(), [{ kind: "move_npc", npcId: NPC_2, toLocationId: LOC_2 }]);
    expect(next.locations.find((l) => l.id === LOC_1)?.npcIds).toEqual([NPC_1]);
    expect(next.locations.find((l) => l.id === LOC_2)?.npcIds).toEqual([NPC_2]);
    expect(next.npcs.find((n) => n.id === NPC_2)?.locationId).toBe(LOC_2);
  });

  it("move_npc 移入新地点取目标容器最大 locationOrder + 1，追加顺序稳定", () => {
    const next = okApply(world(), [
      { kind: "move_npc", npcId: NPC_2, toLocationId: LOC_2 },
      { kind: "move_npc", npcId: NPC_1, toLocationId: LOC_2 },
    ]);
    expect(next.locations.find((l) => l.id === LOC_2)?.npcIds).toEqual([NPC_2, NPC_1]);
    expect(npcRecord(next, NPC_2).position.locationOrder).toBe(0);
    expect(npcRecord(next, NPC_1).position.locationOrder).toBe(1);
  });

  it("move_npc 回到原地点不改变已有 locationOrder", () => {
    const before = npcRecord(world(), NPC_2).position.locationOrder;
    const next = okApply(world(), [{ kind: "move_npc", npcId: NPC_2, toLocationId: LOC_1 }]);
    expect(npcRecord(next, NPC_2).position.locationOrder).toBe(before);
    expect(next.locations.find((l) => l.id === LOC_1)?.npcIds).toEqual([NPC_1, NPC_2]);
  });

  it("set_npc_lifecycle 停用 NPC 会把它移出可见名册", () => {
    const next = okApply(world(), [{ kind: "set_npc_lifecycle", npcId: NPC_2, lifecycle: "inactive" }]);
    expect(next.locations.find((l) => l.id === LOC_1)?.npcIds).toEqual([NPC_1]);
    expect(getEntity(next.entityStore, NPC_2)?.core.lifecycle).toBe("inactive");
    expect(next.npcs.map((n) => n.id)).toContain(NPC_2);
  });

  it("set_npc_lifecycle 引用未知 NPC 返回 unknown_entity_id", () => {
    const result = applyEntityMutations(world(), [{ kind: "set_npc_lifecycle", npcId: asNpcId("npc_missing"), lifecycle: "inactive" }]);
    expect(result).toEqual({ ok: false, code: "unknown_entity_id", entityId: asNpcId("npc_missing") });
  });

  it("set_npc_lifecycle 对已结算的 NPC 返回 invalid_lifecycle_transition", () => {
    const retired = okApply(world(), [{
      kind: "create_entities",
      records: [npcEntityRecord({
        core: { id: asNpcId("npc_old"), kind: "npc", name: "故人", createdAtTurn: 0, lifecycle: "resolved" },
        identity: { role: "故人", description: "", tags: [] },
        position: { locationId: LOC_1, locationOrder: 9 },
        npcState: { isCompanion: false, met: true, memory: memoryOf(asNpcId("npc_old")) },
      })],
    }]);
    const result = applyEntityMutations(retired, [{ kind: "set_npc_lifecycle", npcId: asNpcId("npc_old"), lifecycle: "active" }]);
    expect(result).toEqual({ ok: false, code: "invalid_lifecycle_transition", entityId: asNpcId("npc_old") });
  });
});

describe("applyEntityMutations — 地点解锁与到访", () => {
  it("set_location_unlocked 只改 unlocked，不触碰 visited", () => {
    const next = okApply(world(), [{ kind: "set_location_unlocked", locationId: LOC_3, unlocked: true }]);
    expect(next.unlockedLocationIds).toEqual([LOC_1, LOC_2, LOC_3]);
    expect(next.visitedLocationIds).toEqual([LOC_1]);
    expect(locationRecord(next, LOC_3).location.visited).toBe(false);
  });

  it("set_location_visited 只改 visited，不解锁", () => {
    const next = okApply(world(), [{ kind: "set_location_visited", locationId: LOC_3, visited: true }]);
    expect(next.visitedLocationIds).toEqual([LOC_1, LOC_3]);
    expect(next.unlockedLocationIds).toEqual([LOC_1, LOC_2]);
  });

  it("地点解锁可以撤回", () => {
    const next = okApply(world(), [{ kind: "set_location_unlocked", locationId: LOC_2, unlocked: false }]);
    expect(next.unlockedLocationIds).toEqual([LOC_1]);
  });

  it("replace_location_component 替换组件但保留 core 身份与派生名册", () => {
    const ws = world();
    const next = okApply(ws, [{
      kind: "replace_location_component",
      locationId: LOC_1,
      location: { ...locationRecord(ws, LOC_1).location, description: "重整过的客栈", tags: ["rebuilt"] },
    }]);
    expect(next.locations.find((l) => l.id === LOC_1)?.description).toBe("重整过的客栈");
    expect(next.locations.find((l) => l.id === LOC_1)?.tags).toEqual(["rebuilt"]);
    expect(getEntity(next.entityStore, LOC_1)?.core.name).toBe("loc_1");
    expect(next.locations.find((l) => l.id === LOC_1)?.npcIds).toEqual([NPC_1, NPC_2]);
  });

  it("replace_location_component 制造悬空连接时返回 invalid_reference 并整批零修改", () => {
    const ws = world();
    const result = applyEntityMutations(ws, [{
      kind: "replace_location_component",
      locationId: LOC_1,
      location: { ...locationRecord(ws, LOC_1).location, connectedLocationIds: [asLocationId("loc_missing")] },
    }]);
    expect(result).toMatchObject({ ok: false, code: "invalid_reference" });
    expect(ws.locations.find((l) => l.id === LOC_1)?.connectedLocationIds).toEqual([LOC_2, LOC_3]);
  });
});

describe("applyEntityMutations — 物品归属", () => {
  it("transfer_item 从地点到玩家：加入 inventory 并从地点消失，不双持有", () => {
    const next = okApply(world(), [{ kind: "transfer_item", itemId: ITEM_A, owner: { kind: "player", playerId: PLAYER_ENTITY_ID } }]);
    expect(next.inventory).toEqual([ITEM_B, ITEM_A]);
    expect(next.locations.find((l) => l.id === LOC_1)?.availableItemIds).toEqual([]);
    expect(itemPossession(next, ITEM_A).owner).toEqual({ kind: "player", playerId: PLAYER_ENTITY_ID });
  });

  it("transfer_item 交给 NPC：离开 inventory 且不进任何 availableItemIds", () => {
    const gave = okApply(world(), [{ kind: "transfer_item", itemId: ITEM_B, owner: { kind: "npc", npcId: NPC_1 } }]);
    expect(gave.inventory).toEqual([]);
    expect(gave.locations.every((l) => !l.availableItemIds.includes(ITEM_B))).toBe(true);
    expect(itemPossession(gave, ITEM_B).owner).toEqual({ kind: "npc", npcId: NPC_1 });
    const later = okApply(gave, [{ kind: "discover_fact", factId: FACT_1 }]);
    expect(itemPossession(later, ITEM_B).owner).toEqual({ kind: "npc", npcId: NPC_1 });
    expect(later.locations.every((l) => !l.availableItemIds.includes(ITEM_B))).toBe(true);
  });

  it("transfer_item 转给新 owner 取该容器最大 ownerOrder + 1；重复相同归属不改顺序", () => {
    const moved = okApply(world(), [{ kind: "transfer_item", itemId: ITEM_C, owner: { kind: "player", playerId: PLAYER_ENTITY_ID } }]);
    expect(moved.inventory).toEqual([ITEM_B, ITEM_C]);
    const again = okApply(moved, [{ kind: "transfer_item", itemId: ITEM_C, owner: { kind: "player", playerId: PLAYER_ENTITY_ID } }]);
    expect(again.inventory).toEqual([ITEM_B, ITEM_C]);
    expect(itemPossession(again, ITEM_C).ownerOrder).toBe(1);
  });

  it("transfer_item 退回地点时追加到该地点末尾", () => {
    const dropped = okApply(world(), [{ kind: "transfer_item", itemId: ITEM_B, owner: { kind: "location", locationId: LOC_2 } }]);
    expect(dropped.inventory).toEqual([]);
    expect(dropped.locations.find((l) => l.id === LOC_2)?.availableItemIds).toEqual([ITEM_B]);
    expect(dropped.locations.find((l) => l.id === LOC_1)?.availableItemIds).toEqual([ITEM_A]);
  });

  it("transfer_item 引用未知 owner 返回 invalid_reference", () => {
    const result = applyEntityMutations(world(), [{ kind: "transfer_item", itemId: ITEM_A, owner: { kind: "npc", npcId: asNpcId("npc_missing") } }]);
    expect(result).toEqual({ ok: false, code: "invalid_reference", entityId: asNpcId("npc_missing") });
  });

  it("transfer_item 对未知物品返回 unknown_entity_id", () => {
    const result = applyEntityMutations(world(), [{ kind: "transfer_item", itemId: asItemId("item_missing"), owner: { kind: "none" } }]);
    expect(result).toEqual({ ok: false, code: "unknown_entity_id", entityId: asItemId("item_missing") });
  });
});

describe("applyEntityMutations — NPC 记忆、事实、任务与敌人", () => {
  it("replace_npc_state 只改 npcState，不触碰 identity/position", () => {
    const ws = world();
    const before = npcRecord(ws, NPC_1);
    const next = okApply(ws, [{
      kind: "replace_npc_state",
      npcId: NPC_1,
      npcState: { ...before.npcState, met: true },
    }]);
    const after = npcRecord(next, NPC_1);
    expect(after.npcState.met).toBe(true);
    expect(after.identity).toEqual(before.identity);
    expect(after.position).toEqual(before.position);
    expect(next.npcs.find((n) => n.id === NPC_1)?.met).toBe(true);
  });

  it("replace_npc_state 引用非 NPC 返回 wrong_entity_kind", () => {
    const result = applyEntityMutations(world(), [{
      kind: "replace_npc_state", npcId: asNpcId(String(LOC_1)), npcState: { isCompanion: false, met: true, memory: memoryOf(NPC_1) },
    }]);
    expect(result).toEqual({ ok: false, code: "wrong_entity_kind", entityId: LOC_1 });
  });

  it("replace_npc_state 写入悬空 knownFactIds 时返回 invalid_reference 且零修改", () => {
    const ws = world();
    const result = applyEntityMutations(ws, [{
      kind: "replace_npc_state",
      npcId: NPC_1,
      npcState: { ...npcRecord(ws, NPC_1).npcState, memory: { ...memoryOf(NPC_1), knownFactIds: [asFactId("fact_missing")] } },
    }]);
    expect(result).toMatchObject({ ok: false, code: "invalid_reference" });
    expect(ws.npcs.find((n) => n.id === NPC_1)?.memory.knownFactIds).toEqual([]);
  });

  it("discover_fact 幂等：重复发现不改变 store", () => {
    const once = okApply(world(), [{ kind: "discover_fact", factId: FACT_1 }]);
    const twice = okApply(once, [{ kind: "discover_fact", factId: FACT_1 }]);
    expect(twice.worldFacts.find((f) => f.factId === FACT_1)?.discovered).toBe(true);
    expect(twice.entityStore.records).toEqual(once.entityStore.records);
  });

  it("set_quest_status 同步 quest.status 与 core.lifecycle", () => {
    for (const [status, lifecycle] of [
      ["completed", "resolved"], ["locked", "inactive"], ["failed", "resolved"], ["closed", "resolved"], ["active", "active"],
    ] as const) {
      const next = okApply(world(), [{ kind: "set_quest_status", questId: QUEST_1, status }]);
      expect(next.quests.find((q) => q.id === QUEST_1)?.status).toBe(status);
      expect(getEntity(next.entityStore, QUEST_1)?.core.lifecycle).toBe(lifecycle);
    }
  });

  it("set_quest_status 对未知任务返回 unknown_entity_id", () => {
    const result = applyEntityMutations(world(), [{ kind: "set_quest_status", questId: asQuestId("quest_missing"), status: "completed" }]);
    expect(result).toEqual({ ok: false, code: "unknown_entity_id", entityId: asQuestId("quest_missing") });
  });

  it("set_enemy_defeated 同步 defeated 与 lifecycle；撤回后恢复 active", () => {
    const defeated = okApply(world(), [{ kind: "set_enemy_defeated", enemyId: ENEMY_1, defeated: true }]);
    expect(defeated.defeatedEnemyIds).toEqual([ENEMY_1]);
    expect(getEntity(defeated.entityStore, ENEMY_1)?.core.lifecycle).toBe("resolved");
    const revived = okApply(defeated, [{ kind: "set_enemy_defeated", enemyId: ENEMY_1, defeated: false }]);
    expect(revived.defeatedEnemyIds).toEqual([]);
    expect(getEntity(revived.entityStore, ENEMY_1)?.core.lifecycle).toBe("active");
  });

  it("set_enemy_defeated 对非敌人实体返回 wrong_entity_kind", () => {
    const result = applyEntityMutations(world(), [{ kind: "set_enemy_defeated", enemyId: asEnemyId(String(NPC_1)), defeated: true }]);
    expect(result).toEqual({ ok: false, code: "wrong_entity_kind", entityId: NPC_1 });
  });
});

describe("applyEntityMutations — create_entities 与批量原子性", () => {
  it("create_entities 追加合法 record 并立即出现在投影中", () => {
    const next = okApply(world(), [{
      kind: "create_entities",
      records: [npcEntityRecord({
        core: { id: asNpcId("npc_9"), kind: "npc", name: "新旅人", createdAtTurn: 3, lifecycle: "active" },
        identity: { role: "旅人", description: "", tags: [] },
        position: { locationId: LOC_2, locationOrder: 0 },
        npcState: { isCompanion: false, met: false, memory: memoryOf(asNpcId("npc_9")) },
      })],
    }]);
    expect(next.npcs.map((n) => n.id)).toContain(asNpcId("npc_9"));
    expect(next.locations.find((l) => l.id === LOC_2)?.npcIds).toEqual([asNpcId("npc_9")]);
    expect(getEntity(next.entityStore, asNpcId("npc_9"))?.core.createdAtTurn).toBe(3);
  });

  it("create_entities 与既有实体同 id 返回 duplicate_entity_id 且零修改", () => {
    const result = applyEntityMutations(world(), [{
      kind: "create_entities",
      records: [npcEntityRecord({
        core: { id: NPC_1, kind: "npc", name: "重复", createdAtTurn: 1, lifecycle: "active" },
        identity: { role: "r", description: "", tags: [] },
        position: { locationId: LOC_1, locationOrder: 5 },
        npcState: { isCompanion: false, met: false, memory: memoryOf(NPC_1) },
      })],
    }]);
    expect(result).toEqual({ ok: false, code: "duplicate_entity_id", entityId: NPC_1 });
  });

  it("create_entities 引用未知地点时 store 校验报出携带该 record 的 invalid_reference", () => {
    const result = applyEntityMutations(world(), [{
      kind: "create_entities",
      records: [npcEntityRecord({
        core: { id: asNpcId("npc_9"), kind: "npc", name: "新旅人", createdAtTurn: 1, lifecycle: "active" },
        identity: { role: "旅人", description: "", tags: [] },
        position: { locationId: asLocationId("loc_missing"), locationOrder: 0 },
        npcState: { isCompanion: false, met: false, memory: memoryOf(asNpcId("npc_9")) },
      })],
    }]);
    expect(result).toEqual({ ok: false, code: "invalid_reference", entityId: asNpcId("npc_9") });
  });

  it("任一 command 非法时整批零修改且入参 WorldState 引用不变", () => {
    const ws = world();
    const store = ws.entityStore;
    const result = applyEntityMutations(ws, [
      { kind: "move_player", toLocationId: LOC_2, markVisited: true },
      { kind: "discover_fact", factId: FACT_1 },
      { kind: "set_quest_status", questId: asQuestId("quest_missing"), status: "completed" },
    ]);
    expect(result).toEqual({ ok: false, code: "unknown_entity_id", entityId: asQuestId("quest_missing") });
    expect(ws.entityStore).toBe(store);
    expect(ws.currentLocationId).toBe(LOC_1);
    expect(ws.worldFacts.find((f) => f.factId === FACT_1)?.discovered).toBe(false);
  });

  it("失败结果只含 code/entityId，不携带任何部分状态", () => {
    const result = applyEntityMutations(world(), [{ kind: "discover_fact", factId: asFactId("fact_missing") }]);
    const { ok, ...failure } = result;
    expect(ok).toBe(false);
    expect(Object.keys(failure).sort()).toEqual(["code", "entityId"]);
  });

  it("成功结果逐字携带非实体权威字段", () => {
    const ws = world();
    const next = okApply(ws, [{ kind: "discover_fact", factId: FACT_1 }]);
    expect(next.version).toBe(3);
    expect(next.generation).toBe(ws.generation);
    expect(next.battle).toBe(ws.battle);
    expect(next.endings).toBe(ws.endings);
    expect(next.ending).toBe(ws.ending);
    expect(next.eventLedger).toBe(ws.eventLedger);
  });

  it("空批次返回同一 WorldState 引用", () => {
    const ws = world();
    expect(applyEntityMutations(ws, [])).toEqual({ ok: true, worldState: ws });
  });
});

describe("EntityMutationInvariantError — 供上游写入方抛出的稳定失败", () => {
  it("只携带 code/entityId，不携带实体正文", () => {
    const error = new EntityMutationInvariantError({ code: "unknown_entity_id", entityId: QUEST_1 });
    expect(error.code).toBe("unknown_entity_id");
    expect(error.entityId).toBe(QUEST_1);
    expect(JSON.stringify(error)).not.toContain(PLAYER.name);
  });

  it("把失败结果转成异常时保留 code/entityId", () => {
    const result = applyEntityMutations(world(), [{ kind: "set_enemy_defeated", enemyId: asEnemyId("enemy_missing"), defeated: true }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(() => {
      throw new EntityMutationInvariantError(result);
    }).toThrow(EntityMutationInvariantError);
  });
});
