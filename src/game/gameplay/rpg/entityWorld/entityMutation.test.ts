import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import type { WorldState, NpcMemory, NpcInteraction } from "@/game/domain/worldState";
import type { DialogueAct, StructuredDialogueTopic } from "@/game/domain/action";
import type { NarrativeEmotion } from "@/game/domain/narrative";
import type {
  EnemyEntry, ItemEntry, LocationEntry, NpcEntry, PlayerState, QuestEntry, WorldFactEntry,
} from "@/game/domain/worldState";
import type {
  EntityCompatibilityProjection, EntityLifecycle, EntityRecord, NpcEntityRecord,
  NpcKnowledgeCertainty, NpcKnowledgeDisclosure,
  PositionComponent, PossessionComponent,
} from "@/game/domain/entity";
import type { FactChangeSource } from "@/game/domain/resolvedEvent";
import {
  entitiesOfKind, getEntity, importNpcLayers, NPC_HISTORY_CAP,
} from "@/game/domain/entity";
import {
  asFactId, asGenerationId, asItemId, asLocationId, asNpcId, asQuestId, asEnemyId,
  PLAYER_ENTITY_ID, type GenerationMetadata,
} from "@/game/domain/worldEntity";
import {
  applyEntityMutations, EntityMutationInvariantError,
  type EntityMutation, type EntityMutationErrorCode,
  type KnowledgeMutationSource, type RelationshipMutationSource,
} from "./entityMutation";
import type { FactId, LocationId, NpcId } from "@/game/domain/worldEntity";
import type { RelationshipSignal } from "@/game/domain/entity";
import type { RelationshipCommitmentOperation, RelationshipTargetId } from "@/game/gameplay/rpg/npcMemory";

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

function memoryOf(npcId: NpcEntry["id"]): NpcMemory {
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
  return createWorldStateFixture({
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

/**
 * 测试夹具专用：旧形状 → 分层 record 一律经 domain 的 legacy_import 创建桥，
 * 测试里不手搓第二套组件形状。
 */
function npcEntityRecord(input: Readonly<{
  core: NpcEntityRecord["core"];
  identity: Readonly<{ role: string; description: string; tags: readonly string[] }>;
  position: PositionComponent;
  npc: Readonly<{ isCompanion: boolean; met: boolean; memory: NpcMemory }>;
}>): NpcEntityRecord {
  const layers = importNpcLayers({
    entry: {
      id: input.core.id,
      name: input.core.name,
      role: input.identity.role,
      description: input.identity.description,
      locationId: input.position.locationId,
      isCompanion: input.npc.isCompanion,
      tags: input.identity.tags,
      met: input.npc.met,
      memory: input.npc.memory,
    },
    createdAtTurn: input.core.createdAtTurn,
  });
  return {
    core: input.core,
    identity: { ...input.identity, anchors: layers.anchors },
    position: input.position,
    dynamicState: layers.dynamicState,
    knowledge: layers.knowledge,
    relationships: layers.relationships,
    history: layers.history,
  };
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
        npc: { isCompanion: false, met: true, memory: memoryOf(asNpcId("npc_old")) },
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
        npc: { isCompanion: false, met: false, memory: memoryOf(asNpcId("npc_9")) },
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
        npc: { isCompanion: false, met: false, memory: memoryOf(NPC_1) },
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
        npc: { isCompanion: false, met: false, memory: memoryOf(asNpcId("npc_9")) },
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
    expect(next.version).toBe(4);
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

// ---------------------------------------------------------------------------
// Task 3B：关系写入只能走 apply_relationship_signal / apply_relationship_commitment
// 两条细粒度 mutation。数值、stage、trend、证据与承诺一律由 npcMemory 规则层裁决，
// 本层只做边界校验（实体类型 / self-edge / lifecycle / source）与原子写回。
// ---------------------------------------------------------------------------

const ACT_1 = "act_1";

function source(actionId: string = ACT_1, turnNumber = 3): RelationshipMutationSource {
  return { kind: "action", actionId, turnNumber };
}

function signalMutation(input: Readonly<{
  fromNpcId?: NpcId;
  targetId?: RelationshipTargetId;
  /** 表外 signal 由调用点直接传字符串（生产类型是封闭 union）。 */
  signal?: RelationshipSignal | string;
  source?: RelationshipMutationSource;
}> = {}): EntityMutation {
  return {
    kind: "apply_relationship_signal",
    fromNpcId: input.fromNpcId ?? NPC_1,
    targetId: input.targetId ?? NPC_2,
    signal: (input.signal ?? "supported") as RelationshipSignal,
    source: input.source ?? source(),
  };
}

function edgeOf(ws: WorldState, npcId: NpcId, targetId: string) {
  const edge = npcRecord(ws, npcId).relationships.outgoing.find((entry) => entry.targetId === targetId);
  if (edge === undefined) throw new Error(`missing edge ${npcId} -> ${targetId}`);
  return edge;
}

/** 拒绝用例统一入口：断言稳定 code/entityId，且入参 store 引用与关系组件原样不动。 */
function expectRejected(ws: WorldState, mutations: readonly EntityMutation[], expected: { readonly code: EntityMutationErrorCode; readonly entityId?: string }) {
  const store = ws.entityStore;
  const relationshipsBefore = npcRecord(ws, NPC_1).relationships;
  const result = applyEntityMutations(ws, mutations);
  expect(result).toEqual({ ok: false, ...expected });
  expect(ws.entityStore).toBe(store);
  expect(npcRecord(ws, NPC_1).relationships).toBe(relationshipsBefore);
}

describe("applyEntityMutations — apply_relationship_signal", () => {
  it("合法信号在 A→B 建边并写入表决定的数值、stage、trend 与唯一证据", () => {
    const next = okApply(world(), [signalMutation({ signal: "supported" })]);
    const edge = edgeOf(next, NPC_1, NPC_2);
    expect(edge.dimensions).toEqual({ affinity: 3, trust: 2, fear: 0, hostility: 0 });
    expect(edge.stage).toBe("acquainted");
    expect(edge.trend).toBe("improving");
    expect(edge.origin).toEqual({ kind: "action", actionId: ACT_1, turnNumber: 3 });
    expect(edge.evidence).toEqual([{
      evidenceId: `ev:${ACT_1}:npc_1:npc_2:supported`, actionId: ACT_1, turnNumber: 3,
      signal: "supported", severity: "normal", summaryKey: "relationship.signal.supported",
    }]);
    expect(edge.commitments).toEqual([]);
  });

  it("载荷不携带任何数值通道：多一个 affinity 键过不了类型检查，运行时也进不了 store", () => {
    // 负编译探针（本仓 @ts-expect-error 惯例）：载荷整行写完，指令只覆盖下一行。
    // 删掉 affinity 后指令变成「未使用的 @ts-expect-error」，typecheck 直接报错——
    // 所以这条锁的是 EntityMutation 的形状（RelationshipSignalPayloadKeysLock 那一族编译锁），
    // 不是测试夹具自己写的字面量。
    // @ts-expect-error affinity 不是 apply_relationship_signal 的载荷键
    const signalWithNumber: EntityMutation = { kind: "apply_relationship_signal", fromNpcId: NPC_1, targetId: NPC_2, signal: "supported", source: source(), affinity: 50 };
    // @ts-expect-error affinity 不是 apply_relationship_commitment 的载荷键
    const commitmentWithNumber: EntityMutation = { kind: "apply_relationship_commitment", fromNpcId: NPC_1, targetId: NPC_2, operation: { kind: "open_debt", openKey: "task_help", direction: "source_owes_target", description: "d" }, source: source(), affinity: 50 };
    // 运行时那一半同样是生产事实：类型没拦住的数值也不会被读进规则层。
    const next = okApply(world(), [signalWithNumber]);
    expect(edgeOf(next, NPC_1, NPC_2).dimensions).toEqual({ affinity: 3, trust: 2, fear: 0, hostility: 0 });
    expect(edgeOf(next, NPC_1, NPC_2).commitments).toEqual([]);
    const promised = okApply(next, [commitmentWithNumber]);
    expect(edgeOf(promised, NPC_1, NPC_2).dimensions).toEqual({ affinity: 3, trust: 2, fear: 0, hostility: 0 });
    expect(edgeOf(promised, NPC_1, NPC_2).commitments).toHaveLength(1);
  });

  it("A→B 的信号绝不镜像成 B→A", () => {
    const ws = world();
    const reverseBefore = npcRecord(ws, NPC_2).relationships;
    const next = okApply(ws, [signalMutation({ signal: "supported" })]);
    expect(npcRecord(next, NPC_2).relationships).toBe(reverseBefore);
    expect(npcRecord(next, NPC_2).relationships.outgoing.map((edge) => edge.targetId)).toEqual([PLAYER_ENTITY_ID]);
    // 只有显式的第二条反向 mutation 才建立 B→A。
    const mirrored = okApply(next, [signalMutation({ fromNpcId: NPC_2, targetId: NPC_1, signal: "challenged" })]);
    expect(edgeOf(mirrored, NPC_2, NPC_1).dimensions).toEqual({ affinity: -3, trust: -1, fear: 0, hostility: 0 });
    expect(edgeOf(mirrored, NPC_1, NPC_2).dimensions).toEqual({ affinity: 3, trust: 2, fear: 0, hostility: 0 });
  });

  it("只写 relationships 组件：同 record 其余组件引用不变，兼容 memory 由投影重建", () => {
    const ws = world();
    const before = npcRecord(ws, NPC_1);
    const next = okApply(ws, [signalMutation({ targetId: PLAYER_ENTITY_ID, signal: "supported", source: source(ACT_1, 2) })]);
    const after = npcRecord(next, NPC_1);
    expect(after.relationships).not.toBe(before.relationships);
    expect(after.core).toBe(before.core);
    expect(after.identity).toBe(before.identity);
    expect(after.position).toBe(before.position);
    expect(after.dynamicState).toBe(before.dynamicState);
    expect(after.knowledge).toBe(before.knowledge);
    expect(after.history).toBe(before.history);
    const entry = next.npcs.find((npc) => npc.id === NPC_1);
    if (entry === undefined) throw new Error("missing npc_1");
    // 兼容 memory 不是被并行改写的字段：它等于 projector 从新边重算出的那份。
    expect(entry.memory.relationship.affinity).toBe(edgeOf(next, NPC_1, PLAYER_ENTITY_ID).dimensions.affinity);
    expect(entry.memory.relationship.affinity).toBe(3);
    expect(entry.memory.interactionHistory).toEqual([]);
    expect(entry.met).toBe(false);
  });

  it("initial_world 起源的既有边不因规则信号被改写成 action 起源", () => {
    const next = okApply(world(), [signalMutation({ targetId: PLAYER_ENTITY_ID, signal: "supported" })]);
    const edge = edgeOf(next, NPC_1, PLAYER_ENTITY_ID);
    expect(edge.origin.kind).toBe("initial_world");
    expect("actionId" in edge.origin).toBe(false);
    expect(edge.dimensions.trust).toBe(2);
  });

  it("同一行动同一信号重放零写入：批次内与跨批次都只留一条证据", () => {
    const mutation = signalMutation({ signal: "supported" });
    const batched = okApply(world(), [mutation, mutation]);
    expect(edgeOf(batched, NPC_1, NPC_2).evidence).toHaveLength(1);
    const twiceApplied = okApply(batched, [mutation]);
    expect(twiceApplied.entityStore.records).toEqual(batched.entityStore.records);
  });

  it("同一行动的两条不同信号按批次数组顺序各写一条证据（本层不扇出、不重排）", () => {
    const next = okApply(world(), [
      signalMutation({ signal: "supported" }),
      signalMutation({ signal: "offered_help" }),
    ]);
    const edge = edgeOf(next, NPC_1, NPC_2);
    expect(edge.evidence.map((entry) => entry.signal)).toEqual(["supported", "offered_help"]);
    // 一个行动最多一档：第二条信号不再移动 stage。
    expect(edge.stage).toBe("acquainted");
  });

  it("self-edge 返回 relationship_self_edge 且整批零修改", () => {
    const ws = world();
    expectRejected(ws, [signalMutation({ fromNpcId: NPC_1, targetId: NPC_1 })], { code: "relationship_self_edge", entityId: NPC_1 });
  });

  it("目标必须是 NPC 或玩家：地点与敌人各返回 wrong_entity_kind", () => {
    const ws = world();
    expectRejected(ws, [signalMutation({ targetId: asNpcId(String(LOC_2)) })], { code: "wrong_entity_kind", entityId: LOC_2 });
    expectRejected(ws, [signalMutation({ targetId: asNpcId(String(ENEMY_1)) })], { code: "wrong_entity_kind", entityId: ENEMY_1 });
  });

  it("来源必须是 NPC：对地点施加返回 wrong_entity_kind", () => {
    const ws = world();
    const result = applyEntityMutations(ws, [signalMutation({ fromNpcId: asNpcId(String(LOC_1)) })]);
    expect(result).toEqual({ ok: false, code: "wrong_entity_kind", entityId: LOC_1 });
  });

  it("未知来源与未知目标分别返回 unknown_entity_id", () => {
    const ws = world();
    expectRejected(ws, [signalMutation({ fromNpcId: asNpcId("npc_missing") })], { code: "unknown_entity_id", entityId: asNpcId("npc_missing") });
    const result = applyEntityMutations(ws, [signalMutation({ targetId: asNpcId("npc_missing") })]);
    expect(result).toEqual({ ok: false, code: "unknown_entity_id", entityId: asNpcId("npc_missing") });
  });

  it("非活跃实体不得作为关系任一方：来源或目标 inactive 都返回 invalid_lifecycle_transition", () => {
    const inactive = okApply(world(), [{ kind: "set_npc_lifecycle", npcId: NPC_2, lifecycle: "inactive" }]);
    expect(npcRecord(inactive, NPC_2).core.lifecycle).toBe("inactive");
    const store = inactive.entityStore;
    const asTarget = applyEntityMutations(inactive, [signalMutation()]);
    expect(asTarget).toEqual({ ok: false, code: "invalid_lifecycle_transition", entityId: NPC_2 });
    const asSource = applyEntityMutations(inactive, [signalMutation({ fromNpcId: NPC_2, targetId: NPC_1 })]);
    expect(asSource).toEqual({ ok: false, code: "invalid_lifecycle_transition", entityId: NPC_2 });
    expect(inactive.entityStore).toBe(store);
  });

  it("已结算实体不得成为关系任一方：resolved NPC 与 defeated 敌人各返回稳定错误", () => {
    const ws = world();
    const retired = okApply(ws, [{
      kind: "create_entities",
      records: [npcEntityRecord({
        core: { id: asNpcId("npc_old"), kind: "npc", name: "故人", createdAtTurn: 0, lifecycle: "resolved" },
        identity: { role: "故人", description: "", tags: [] },
        position: { locationId: LOC_1, locationOrder: 9 },
        npc: { isCompanion: false, met: true, memory: memoryOf(asNpcId("npc_old")) },
      })],
    }]);
    const result = applyEntityMutations(retired, [signalMutation({ targetId: asNpcId("npc_old") })]);
    expect(result).toEqual({ ok: false, code: "invalid_lifecycle_transition", entityId: asNpcId("npc_old") });
    const defeated = okApply(ws, [{ kind: "set_enemy_defeated", enemyId: ENEMY_1, defeated: true }]);
    const enemyTarget = applyEntityMutations(defeated, [signalMutation({ targetId: asNpcId(String(ENEMY_1)) })]);
    expect(enemyTarget).toEqual({ ok: false, code: "wrong_entity_kind", entityId: ENEMY_1 });
  });

  it("空白与缺失 actionId 都是稳定错误，且不会退化成一个凭空来源", () => {
    const ws = world();
    expectRejected(ws, [signalMutation({ source: source("   ") })], { code: "invalid_relationship_source", entityId: NPC_1 });
    expectRejected(ws, [signalMutation({ source: { kind: "action", actionId: "", turnNumber: 3 } })], { code: "invalid_relationship_source", entityId: NPC_1 });
  });

  it("turnNumber 必须是非负整数", () => {
    const ws = world();
    expectRejected(ws, [signalMutation({ source: source(ACT_1, -1) })], { code: "invalid_relationship_turn", entityId: NPC_1 });
    expectRejected(ws, [signalMutation({ source: source(ACT_1, 1.5) })], { code: "invalid_relationship_turn", entityId: NPC_1 });
  });

  it("表外 signal（含原型链键名）返回 invalid_relationship_signal 且零写入", () => {
    const ws = world();
    expectRejected(ws, [signalMutation({ signal: "toString" })], { code: "invalid_relationship_signal", entityId: NPC_1 });
    expectRejected(ws, [signalMutation({ signal: "__proto__" })], { code: "invalid_relationship_signal", entityId: NPC_1 });
    expectRejected(ws, [signalMutation({ signal: "affinity_plus_50" })], { code: "invalid_relationship_signal", entityId: NPC_1 });
  });

  it("initial_world 来源在本层被拒：规则层只按 action 起源建边与铸 ID（背景关系属 Task 6）", () => {
    const ws = world();
    const initial: RelationshipMutationSource = { kind: "initial_world", createdAtTurn: 0, reasonKey: "npc.seed.ally" };
    expectRejected(ws, [signalMutation({ source: initial })], { code: "invalid_relationship_source", entityId: NPC_1 });
    expectRejected(ws, [{
      kind: "apply_relationship_commitment", fromNpcId: NPC_1, targetId: PLAYER_ENTITY_ID,
      operation: { kind: "open_debt", openKey: "k", direction: "source_owes_target", description: "d" },
      source: initial,
    }], { code: "invalid_relationship_source", entityId: NPC_1 });
  });

  it("来源判别联合之外的 kind 返回 invalid_relationship_source", () => {
    const ws = world();
    expectRejected(ws, [signalMutation({ source: { kind: "ai_said_so" } as unknown as RelationshipMutationSource })], {
      code: "invalid_relationship_source", entityId: NPC_1,
    });
  });

  it("合法信号与失败信号混在同一批时整批零修改", () => {
    const ws = world();
    const store = ws.entityStore;
    const result = applyEntityMutations(ws, [
      signalMutation({ signal: "supported" }),
      signalMutation({ signal: "threatened", source: source(ACT_1, -2) }),
    ]);
    expect(result).toEqual({ ok: false, code: "invalid_relationship_turn", entityId: NPC_1 });
    expect(ws.entityStore).toBe(store);
    expect(npcRecord(ws, NPC_1).relationships.outgoing.map((edge) => edge.targetId)).toEqual([PLAYER_ENTITY_ID]);
  });
});

describe("applyEntityMutations — apply_relationship_commitment", () => {
  const openDebt: EntityMutation = {
    kind: "apply_relationship_commitment", fromNpcId: NPC_1, targetId: NPC_2,
    operation: { kind: "open_debt", openKey: "task_help", direction: "source_owes_target", description: "relationship.commitment.debt.help_received" },
    source: source(ACT_1, 4),
  };

  function withEdge(ws: WorldState = world()): WorldState {
    return okApply(ws, [signalMutation({ signal: "supported" })]);
  }

  const baseCommitment = { kind: "apply_relationship_commitment", fromNpcId: NPC_1, targetId: NPC_2 } as const;
  const openPromise: EntityMutation = {
    ...baseCommitment,
    operation: { kind: "open_promise", openKey: "escort", promisor: "source", description: "relationship.commitment.promise.escort" },
    source: source(ACT_1, 4),
  };

  function withPromise(): WorldState {
    return okApply(withEdge(), [openPromise]);
  }

  /** 取边上第一笔承诺的确定性 ID：新用例都按 ID 结案，不手搓 ID。 */
  function commitmentIdOf(ws: WorldState): string {
    const commitmentId = edgeOf(ws, NPC_1, NPC_2).commitments[0]?.commitmentId;
    if (commitmentId === undefined) throw new Error("missing commitment on npc_1 -> npc_2");
    return commitmentId;
  }

  function closeWith(operation: RelationshipCommitmentOperation, actionId: string, turnNumber: number): EntityMutation {
    return { ...baseCommitment, operation, source: source(actionId, turnNumber) };
  }

  it("开债只写 commitments 与 lastChangedAtTurn，ID 由行动确定性铸造", () => {
    const next = okApply(withEdge(), [openDebt]);
    const edge = edgeOf(next, NPC_1, NPC_2);
    expect(edge.commitments).toEqual([{
      kind: "debt", commitmentId: `cmt:action:${ACT_1}:open_debt:task_help`, direction: "source_owes_target",
      status: "open", description: "relationship.commitment.debt.help_received",
      source: { kind: "action", actionId: ACT_1, turnNumber: 4 },
    }]);
    expect(edge.dimensions).toEqual({ affinity: 3, trust: 2, fear: 0, hostility: 0 });
    expect(edge.stage).toBe("acquainted");
    expect(edge.trend).toBe("improving");
    expect(edge.evidence).toHaveLength(1);
    expect(edge.lastChangedAtTurn).toBe(4);
  });

  it("同一行动重放同一 open_debt 零写入；跨行动同 openKey 因 ID 含 actionId 而各自成立", () => {
    const once = okApply(withEdge(), [openDebt]);
    const twice = okApply(once, [openDebt]);
    expect(twice.entityStore.records).toEqual(once.entityStore.records);
    const otherAction = okApply(once, [{ ...openDebt, source: source("act_2", 5) }]);
    expect(edgeOf(otherAction, NPC_1, NPC_2).commitments).toHaveLength(2);
  });

  it("结案操作按状态迁移表推进；promise 的 release 与 debt 的 release 各自稳定", () => {
    const promised = withPromise();
    const promiseId = edgeOf(promised, NPC_1, NPC_2).commitments[0]?.commitmentId;
    const released = okApply(promised, [{
      kind: "apply_relationship_commitment", fromNpcId: NPC_1, targetId: NPC_2,
      operation: { kind: "release", commitmentId: String(promiseId) }, source: source("act_2", 6),
    }]);
    expect(edgeOf(released, NPC_1, NPC_2).commitments.map((entry) => entry.status)).toEqual(["released"]);
    const debt = okApply(withEdge(), [openDebt]);
    const rejected = applyEntityMutations(debt, [{
      kind: "apply_relationship_commitment", fromNpcId: NPC_1, targetId: NPC_2,
      operation: { kind: "release", commitmentId: "cmt:action:act_1:open_debt:task_help" }, source: source("act_2", 6),
    }]);
    expect(rejected).toEqual({ ok: false, code: "illegal_relationship_commitment_transition", entityId: NPC_1 });
    expect(edgeOf(debt, NPC_1, NPC_2).commitments.map((entry) => entry.status)).toEqual(["open"]);
  });

  it("forgive 走 mutation：债务 open→forgiven 成立，promise 的 forgive 仍是非法迁移", () => {
    const debt = okApply(withEdge(), [openDebt]);
    const before = edgeOf(debt, NPC_1, NPC_2);
    const next = okApply(debt, [closeWith({ kind: "forgive", commitmentId: commitmentIdOf(debt) }, "act_forgive", 7)]);
    const edge = edgeOf(next, NPC_1, NPC_2);
    expect(edge.commitments.map((entry) => entry.status)).toEqual(["forgiven"]);
    expect(edge.lastChangedAtTurn).toBe(7);
    // 结案操作不碰数值、stage、trend 与证据：证据数组按引用不变。
    expect(edge.dimensions).toEqual(before.dimensions);
    expect(edge.stage).toBe(before.stage);
    expect(edge.trend).toBe(before.trend);
    expect(edge.evidence).toBe(before.evidence);
    // promise 的 forgive 在迁移表里是 null：稳定码 + 入参 store 引用逐字不变。
    const promised = withPromise();
    const records = promised.entityStore.records;
    const rejected = applyEntityMutations(promised, [closeWith({ kind: "forgive", commitmentId: commitmentIdOf(promised) }, "act_forgive", 8)]);
    expect(rejected).toEqual({ ok: false, code: "illegal_relationship_commitment_transition", entityId: NPC_1 });
    expect(promised.entityStore.records).toBe(records);
    expect(edgeOf(promised, NPC_1, NPC_2).commitments.map((entry) => entry.status)).toEqual(["open"]);
  });

  it("break 走 mutation：开着的承诺 open→broken 成立，已结案的再 break 是非法迁移", () => {
    const promised = withPromise();
    const promiseId = commitmentIdOf(promised);
    const broken = okApply(promised, [closeWith({ kind: "break", commitmentId: promiseId }, "act_break", 6)]);
    const edge = edgeOf(broken, NPC_1, NPC_2);
    expect(edge.commitments.map((entry) => entry.kind)).toEqual(["promise"]);
    expect(edge.commitments.map((entry) => entry.status)).toEqual(["broken"]);
    expect(edge.lastChangedAtTurn).toBe(6);
    const records = broken.entityStore.records;
    const rejected = applyEntityMutations(broken, [closeWith({ kind: "break", commitmentId: promiseId }, "act_break_again", 7)]);
    expect(rejected).toEqual({ ok: false, code: "illegal_relationship_commitment_transition", entityId: NPC_1 });
    expect(broken.entityStore.records).toBe(records);
    expect(edgeOf(broken, NPC_1, NPC_2).commitments.map((entry) => entry.status)).toEqual(["broken"]);
  });

  it("来源校验排在查边之前：非法来源即使指向不存在的边也不退化成 invalid_reference", () => {
    const ws = world();
    // npc_1 → npc_2 此刻还没有边：若把 findRelationshipEdge 挪到来源校验之前，
    // 下面三条都会先返回 invalid_reference（entityId 也会从 NPC_1 变成 NPC_2）。
    const openOperation = { kind: "open_debt", openKey: "task_help", direction: "source_owes_target", description: "d" } as const;
    const initial: RelationshipMutationSource = { kind: "initial_world", createdAtTurn: 0, reasonKey: "npc.seed.ally" };
    expectRejected(ws, [{ ...baseCommitment, operation: openOperation, source: initial }], { code: "invalid_relationship_source", entityId: NPC_1 });
    expectRejected(ws, [{ ...baseCommitment, operation: openOperation, source: source("", 3) }], { code: "invalid_relationship_source", entityId: NPC_1 });
    expectRejected(ws, [{ ...baseCommitment, operation: openOperation, source: source(ACT_1, -1) }], { code: "invalid_relationship_turn", entityId: NPC_1 });
  });

  it("未知 commitmentId 返回 unknown_relationship_commitment 且 store 逐字不变", () => {
    const ws = withEdge();
    const records = ws.entityStore.records;
    const result = applyEntityMutations(ws, [{
      kind: "apply_relationship_commitment", fromNpcId: NPC_1, targetId: NPC_2,
      operation: { kind: "fulfill", commitmentId: "cmt:action:act_missing:open_promise:x" }, source: source("act_9", 9),
    }]);
    expect(result).toEqual({ ok: false, code: "unknown_relationship_commitment", entityId: NPC_1 });
    expect(ws.entityStore.records).toBe(records);
  });

  it("本 mutation 不建边：指向不存在边返回 invalid_reference 并带上 targetId", () => {
    const ws = world();
    const result = applyEntityMutations(ws, [openDebt]);
    expect(result).toEqual({ ok: false, code: "invalid_reference", entityId: NPC_2 });
    expect(npcRecord(ws, NPC_1).relationships.outgoing.map((edge) => edge.targetId)).toEqual([PLAYER_ENTITY_ID]);
  });

  it("操作名不在封闭六类内返回 invalid_commitment_operation 且零写入", () => {
    const ws = withEdge();
    const records = ws.entityStore.records;
    const forged = { kind: "erase_memory", commitmentId: "whatever" } as unknown as RelationshipCommitmentOperation;
    const result = applyEntityMutations(ws, [{
      kind: "apply_relationship_commitment", fromNpcId: NPC_1, targetId: NPC_2,
      operation: forged, source: source(),
    }]);
    expect(result).toEqual({ ok: false, code: "invalid_commitment_operation", entityId: NPC_1 });
    expect(ws.entityStore.records).toBe(records);
  });

  it("承诺 mutation 复用同一套边界校验：self-edge、错误目标类型与非法来源各自稳定", () => {
    const ws = world();
    const base = { kind: "apply_relationship_commitment", operation: { kind: "open_promise", openKey: "k", promisor: "source", description: "d" } } as const;
    expect(applyEntityMutations(ws, [{ ...base, fromNpcId: NPC_1, targetId: NPC_1, source: source() }]))
      .toEqual({ ok: false, code: "relationship_self_edge", entityId: NPC_1 });
    expect(applyEntityMutations(ws, [{ ...base, fromNpcId: NPC_1, targetId: asNpcId(String(ITEM_A)), source: source() }]))
      .toEqual({ ok: false, code: "wrong_entity_kind", entityId: ITEM_A });
    expect(applyEntityMutations(ws, [{ ...base, fromNpcId: NPC_1, targetId: PLAYER_ENTITY_ID, source: source("", 3) }]))
      .toEqual({ ok: false, code: "invalid_relationship_source", entityId: NPC_1 });
  });
});

describe("关系写入通道唯一性", () => {
  it("entityMutation.ts 里把 relationships 组件写回 record 的 case 只有三个", () => {
    const file = resolve(process.cwd(), "src/game/gameplay/rpg/entityWorld/entityMutation.ts");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    const body = text.slice(text.indexOf("function applyOne("), text.indexOf("export function applyEntityMutations"));
    const labels = [...body.matchAll(/\n\s*case "([a-z_]+)":/g)]
      .map((match) => ({ name: match[1] ?? "", at: match.index ?? 0 }));
    expect(labels.length).toBeGreaterThan(0);
    const writers = labels
      .filter((entry, index) => {
        const next = labels[index + 1];
        return /\brelationships\s*[:,}]/.test(body.slice(entry.at, next === undefined ? body.length : next.at));
      })
      .map((entry) => entry.name);
    expect(writers.sort()).toEqual(["apply_relationship_commitment", "apply_relationship_signal"]);
  });
});

// ---------------------------------------------------------------------------
// Task 4B：知识写入只能走 record_npc_knowledge / set_npc_knowledge_disclosure。
// entry 语义（幂等、certainty 阶梯、disclosure 独占通道、来源合法性、引用存在性）
// 全部由 npcMemory 的 npcKnowledge 规则层裁决；本层只做三件事：
// 主体 NPC 的边界校验、从 store 派生的引用上下文、以及只替换 knowledge 一个组件的原子写回。
// ---------------------------------------------------------------------------

const FACT_2 = asFactId("fact_2");

/** 引用上下文只认 canonical Fact Entity，所以测试里的第二条事实也必须是一条实体。 */
function factEntityRecord(id: FactId, lifecycle: EntityLifecycle = "active"): EntityRecord {
  return {
    core: { id, kind: "fact", name: `fact:${id}`, createdAtTurn: 0, lifecycle },
    fact: { text: "古井下有密道", source: "generated", discovered: false },
  };
}

function knowledgeSource(overrides: Partial<Readonly<{
  mode: FactChangeSource; actionId: string; turnNumber: number; sourceNpcId: NpcId;
}>> = {}): KnowledgeMutationSource {
  return { kind: "action", mode: "scene_witness", actionId: ACT_1, turnNumber: 3, ...overrides };
}

function recordKnowledge(input: Readonly<{
  npcId?: NpcId;
  factId?: FactId;
  /** 表外取值由调用点直接传字符串（生产类型是封闭 union）。 */
  certainty?: NpcKnowledgeCertainty | string;
  disclosure?: NpcKnowledgeDisclosure | string;
  source?: KnowledgeMutationSource;
}> = {}): EntityMutation {
  return {
    kind: "record_npc_knowledge",
    npcId: input.npcId ?? NPC_1,
    factId: input.factId ?? FACT_1,
    certainty: (input.certainty ?? "known") as NpcKnowledgeCertainty,
    disclosure: (input.disclosure ?? "public") as NpcKnowledgeDisclosure,
    source: input.source ?? knowledgeSource(),
  };
}

function setDisclosure(input: Readonly<{
  npcId?: NpcId;
  factId?: FactId;
  disclosure?: NpcKnowledgeDisclosure | string;
  actionId?: string;
  turnNumber?: number;
}> = {}): EntityMutation {
  return {
    kind: "set_npc_knowledge_disclosure",
    npcId: input.npcId ?? NPC_1,
    factId: input.factId ?? FACT_1,
    disclosure: (input.disclosure ?? "secret") as NpcKnowledgeDisclosure,
    actionId: input.actionId ?? ACT_1,
    turnNumber: input.turnNumber ?? 3,
  };
}

function knowledgeOf(ws: WorldState, npcId: NpcId = NPC_1) {
  return npcRecord(ws, npcId).knowledge;
}

/** 未知主体的知识组件当然不存在：零写入断言不得因为查不到 record 就抛。 */
function knowledgeComponentOf(ws: WorldState, npcId: NpcId) {
  return entitiesOfKind(ws.entityStore, "npc").find((record) => record.core.id === npcId)?.knowledge;
}

/** 拒绝用例统一入口：稳定 code/entityId，且 store 与知识组件都按**引用**原样不动。 */
function expectKnowledgeRejected(
  ws: WorldState,
  mutations: readonly EntityMutation[],
  expected: Readonly<{ code: EntityMutationErrorCode; entityId?: string; subjectId?: NpcId }>,
) {
  const store = ws.entityStore;
  const records = store.records;
  // 诊断按本文件既有惯例报**越界的那个引用**（事实 ID / 说话人 ID），它通常不是行动主体；
  // 所以零写入的取证对象要单独给，缺省才退化成 entityId。
  const subjectId = expected.subjectId ?? (expected.entityId as NpcId | undefined);
  const knowledgeBefore = subjectId === undefined ? undefined : knowledgeComponentOf(ws, subjectId);
  const result = applyEntityMutations(ws, mutations);
  // `subjectId` 只是取证用的入参，绝不是结果字段：这里逐字段构造期望，不整体展开。
  expect(result).toEqual({
    ok: false, code: expected.code, ...(expected.entityId === undefined ? {} : { entityId: expected.entityId }),
  });
  expect(ws.entityStore).toBe(store);
  expect(ws.entityStore.records).toBe(records);
  if (subjectId !== undefined) expect(knowledgeComponentOf(ws, subjectId)).toBe(knowledgeBefore);
}

describe("applyEntityMutations — record_npc_knowledge", () => {
  it("两条知识 mutation 的载荷键集合恰好等于声明：整块 entries 与兼容 memory 都进不来", () => {
    // 负编译探针（同 3B 惯例）：多余键写成字面量即 typecheck 失败，
    // 锁的是 EntityMutation 的载荷形状（*PayloadKeysLock 那一族编译锁），不是夹具自己。
    // @ts-expect-error entries 不是 record_npc_knowledge 的载荷键：Step 3 禁止整块替换 knowledge
    const blockReplacement: EntityMutation = { kind: "record_npc_knowledge", npcId: NPC_1, factId: FACT_1, certainty: "known", disclosure: "public", source: knowledgeSource(), entries: [] };
    // @ts-expect-error memory 不是 set_npc_knowledge_disclosure 的载荷键：兼容读模型没有写入口
    const parallelMemory: EntityMutation = { kind: "set_npc_knowledge_disclosure", npcId: NPC_1, factId: FACT_1, disclosure: "secret", actionId: ACT_1, turnNumber: 3, memory: { knownFactIds: [FACT_1] } };
    // 运行时那一半同样是生产事实：类型没拦住的多余键读不进规则层。
    const next = okApply(world(), [blockReplacement, parallelMemory]);
    const knowledge = knowledgeOf(next);
    expect(Object.keys(knowledge)).toEqual(["entries"]);
    expect(knowledge.entries).toHaveLength(1);
    expect(knowledge.entries[0]).toEqual({
      factId: FACT_1, certainty: "known", disclosure: "secret",
      source: { kind: "action", mode: "scene_witness", actionId: ACT_1, learnedAtTurn: 3 },
    });
  });

  it("首写只替换主体的 knowledge 一个组件：其余组件与另一 NPC 的 knowledge 全部引用不变", () => {
    const ws = world();
    const before = npcRecord(ws, NPC_1);
    const next = okApply(ws, [recordKnowledge({ certainty: "suspected", disclosure: "conditional" })]);
    const after = npcRecord(next, NPC_1);
    expect(after.knowledge).not.toBe(before.knowledge);
    expect(after.core).toBe(before.core);
    expect(after.identity).toBe(before.identity);
    expect(after.position).toBe(before.position);
    expect(after.dynamicState).toBe(before.dynamicState);
    expect(after.relationships).toBe(before.relationships);
    expect(after.history).toBe(before.history);
    // npc_2 没有被顺手写入：本 mutation 只写主体的组件（方向性由签名保证）。
    expect(npcRecord(next, NPC_2).knowledge).toBe(npcRecord(ws, NPC_2).knowledge);
  });

  it("兼容 memory 只由 projector 从新组件重建：本层不存在第二条平行写路径", () => {
    const ws = world();
    expect(ws.npcs.find((npc) => npc.id === NPC_1)?.memory.knownFactIds).toEqual([]);
    const recorded = okApply(ws, [recordKnowledge()]);
    expect(knowledgeOf(recorded).entries.map((entry) => String(entry.factId))).toEqual(["fact_1"]);
    expect(recorded.npcs.find((npc) => npc.id === NPC_1)?.memory.knownFactIds).toEqual(["fact_1"]);
    expect(recorded.npcs.find((npc) => npc.id === NPC_1)?.memory.hiddenFactIds).toEqual([]);
    // 披露改动同样只经组件生效：hiddenFactIds 是 secret 条目的投影。
    const withheld = okApply(recorded, [setDisclosure()]);
    expect(withheld.npcs.find((npc) => npc.id === NPC_1)?.memory.hiddenFactIds).toEqual(["fact_1"]);
    // 入参 WorldState 一分未动：兼容数组每次都是投影新建的。
    expect(ws.npcs.find((npc) => npc.id === NPC_1)?.memory.knownFactIds).toEqual([]);
    expect(ws.npcs.find((npc) => npc.id === NPC_1)?.memory.hiddenFactIds).toEqual([]);
  });

  it("certainty 阶梯由规则层裁决：suspected→known 升级，source 与 disclosure 逐字保留", () => {
    const first = okApply(world(), [recordKnowledge({ certainty: "suspected", disclosure: "conditional" })]);
    const entry = knowledgeOf(first).entries[0]!;
    const upgraded = okApply(first, [recordKnowledge({ certainty: "known", disclosure: "public" })]);
    const nextEntry = knowledgeOf(upgraded).entries[0]!;
    expect(nextEntry.certainty).toBe("known");
    expect(nextEntry.disclosure).toBe("conditional");
    expect(nextEntry.source).toEqual(entry.source);
    expect(knowledgeOf(upgraded).entries).toHaveLength(1);
  });

  it("known→suspected 隐式降级返回 knowledge_certainty_demotion_rejected 且零写入", () => {
    const known = okApply(world(), [recordKnowledge({ certainty: "known" })]);
    expectKnowledgeRejected(known, [recordKnowledge({ certainty: "suspected" })], { code: "knowledge_certainty_demotion_rejected", entityId: NPC_1 });
  });

  it("同一条事实重放是幂等成功而非错误：组件引用原样不变", () => {
    const mutation = recordKnowledge();
    const once = okApply(world(), [mutation]);
    const component = knowledgeOf(once);
    const batched = okApply(once, [mutation, mutation]);
    expect(knowledgeOf(batched)).toBe(component);
    const again = okApply(batched, [mutation]);
    expect(knowledgeOf(again)).toBe(component);
    expect(again.npcs.find((npc) => npc.id === NPC_1)?.memory.knownFactIds).toEqual(["fact_1"]);
  });

  it("引用上下文取自 store 实体：npc_revealed 的说话人必须是活跃 NPC", () => {
    const next = okApply(world(), [recordKnowledge({
      source: knowledgeSource({ mode: "npc_revealed", sourceNpcId: NPC_2 }),
    })]);
    expect(knowledgeOf(next).entries[0]?.source).toEqual({
      kind: "action", mode: "npc_revealed", actionId: ACT_1, learnedAtTurn: 3, sourceNpcId: NPC_2,
    });
    // 说话人自己不会因此获得这条知识（sourceNpcId 不等于 audience）。
    expect(knowledgeOf(next, NPC_2).entries).toHaveLength(0);
  });

  it("Fact、target NPC、source NPC 任一未知都各自返回稳定 code 且整批零写入", () => {
    const ws = world();
    expectKnowledgeRejected(ws, [recordKnowledge({ factId: asFactId("fact_missing") })], {
      code: "unknown_knowledge_fact", entityId: asFactId("fact_missing"), subjectId: NPC_1,
    });
    const result = applyEntityMutations(ws, [recordKnowledge({ npcId: asNpcId("npc_missing") })]);
    expect(result).toEqual({ ok: false, code: "unknown_entity_id", entityId: asNpcId("npc_missing") });
    expect(knowledgeOf(ws)).toBe(npcRecord(ws, NPC_1).knowledge);
    expectKnowledgeRejected(ws, [recordKnowledge({ source: knowledgeSource({ mode: "npc_revealed", sourceNpcId: asNpcId("npc_ghost") }) })], {
      code: "unknown_knowledge_source_npc", entityId: asNpcId("npc_ghost"), subjectId: NPC_1,
    });
    // 玩家实体不是 NPC：它拿不到「知识说话人」这个身份。
    expectKnowledgeRejected(ws, [recordKnowledge({ source: knowledgeSource({ mode: "npc_revealed", sourceNpcId: asNpcId(String(PLAYER_ENTITY_ID)) }) })], {
      code: "unknown_knowledge_source_npc", entityId: asNpcId(String(PLAYER_ENTITY_ID)), subjectId: NPC_1,
    });
  });

  it("非活跃 NPC 既不能作为知识主体，也不能作为说话人洗白来源", () => {
    const inactive = okApply(world(), [{ kind: "set_npc_lifecycle", npcId: NPC_2, lifecycle: "inactive" }]);
    expectKnowledgeRejected(inactive, [recordKnowledge({ npcId: NPC_2, source: knowledgeSource({ mode: "npc_revealed", sourceNpcId: NPC_1 }) })], {
      code: "invalid_lifecycle_transition", entityId: NPC_2,
    });
    // 死掉的说话人不得借一条新知识洗白成 provenance。
    expectKnowledgeRejected(inactive, [recordKnowledge({ source: knowledgeSource({ mode: "npc_revealed", sourceNpcId: NPC_2 }) })], {
      code: "unknown_knowledge_source_npc", entityId: NPC_2, subjectId: NPC_1,
    });
    const defeated = okApply(world(), [{ kind: "set_enemy_defeated", enemyId: ENEMY_1, defeated: true }]);
    expect(applyEntityMutations(defeated, [recordKnowledge({ npcId: asNpcId(String(ENEMY_1)) })]))
      .toEqual({ ok: false, code: "wrong_entity_kind", entityId: ENEMY_1 });
  });

  it("生命周期处理是显式决定：非活跃 Fact 实体不在引用上下文里，哪怕兼容读模型仍然列着它", () => {
    const ws = world();
    const retired = okApply(ws, [{ kind: "create_entities", records: [factEntityRecord(FACT_2, "inactive")] }]);
    // 兼容数组按实体逐条投影、不看 lifecycle：拿它当引用上下文就会放行这条已停用的事实。
    expect(retired.worldFacts.some((fact) => String(fact.factId) === String(FACT_2))).toBe(true);
    expectKnowledgeRejected(retired, [recordKnowledge({ factId: FACT_2 })], {
      code: "unknown_knowledge_fact", entityId: FACT_2, subjectId: NPC_1,
    });
    const live = okApply(ws, [{ kind: "create_entities", records: [factEntityRecord(FACT_2, "active")] }]);
    const next = okApply(live, [recordKnowledge({ factId: FACT_2 })]);
    expect(knowledgeOf(next).entries.map((entry) => String(entry.factId))).toEqual(["fact_2"]);
  });

  it("同批 create_entities 造出缺 knowledge 的 NPC：闸门收口成 structure_invalid，不逃成裸 TypeError", () => {
    // 已提交的 store 里 npc 必带 knowledge（domain validator），所以这道门从存档出发不可达；
    // 但 create_entities 原样收下调用方给的 record，整批校验要等所有 applyOne 跑完才做，
    // 于是「同一批里新建的残缺 record」能真正走到这道门上——这条用例就是它的存在性证明。
    const brokenRecord: EntityRecord = {
      ...npcEntityRecord({
        core: { id: asNpcId("npc_9"), kind: "npc", name: "残缺", createdAtTurn: 1, lifecycle: "active" },
        identity: { role: "旅人", description: "", tags: [] },
        position: { locationId: LOC_1, locationOrder: 0 },
        npc: { isCompanion: false, met: false, memory: memoryOf(asNpcId("npc_9")) },
      }),
      knowledge: undefined,
    } as unknown as EntityRecord;
    const result = applyEntityMutations(world(), [
      { kind: "create_entities", records: [brokenRecord] },
      recordKnowledge({ npcId: asNpcId("npc_9") }),
    ]);
    expect(result).toEqual({ ok: false, code: "structure_invalid", entityId: asNpcId("npc_9") });
  });

  it("空白、非字符串与只挂在原型链上的 actionId 一律 invalid_knowledge_source", () => {
    const ws = world();
    expectKnowledgeRejected(ws, [recordKnowledge({ source: knowledgeSource({ actionId: "   " }) })], { code: "invalid_knowledge_source", entityId: NPC_1 });
    expectKnowledgeRejected(ws, [recordKnowledge({ source: knowledgeSource({ actionId: "" }) })], { code: "invalid_knowledge_source", entityId: NPC_1 });
    expectKnowledgeRejected(ws, [recordKnowledge({
      source: knowledgeSource({ actionId: 42 as unknown as string }),
    })], { code: "invalid_knowledge_source", entityId: NPC_1 });
    // 只挂在原型链上的 actionId 不算提供了证据（规则层的 ownField 守门在本通道同样生效）。
    const inherited = Object.assign(Object.create({ actionId: ACT_1 }), {
      kind: "action", mode: "npc_revealed", turnNumber: 3, sourceNpcId: NPC_2,
    }) as unknown as KnowledgeMutationSource;
    expectKnowledgeRejected(ws, [recordKnowledge({ source: inherited })], { code: "invalid_knowledge_source", entityId: NPC_1 });
  });

  it("turnNumber 必须是非负有限整数：负数、小数、NaN 各返回 invalid_knowledge_turn", () => {
    const ws = world();
    for (const turnNumber of [-1, 1.5, Number.NaN]) {
      expectKnowledgeRejected(ws, [recordKnowledge({ source: knowledgeSource({ turnNumber }) })], { code: "invalid_knowledge_turn", entityId: NPC_1 });
    }
  });

  it("表外 certainty 与 disclosure 各自的 code 可判别（含原型链键名）", () => {
    const ws = world();
    for (const certainty of ["absolute", "toString", "constructor"]) {
      expectKnowledgeRejected(ws, [recordKnowledge({ certainty })], { code: "invalid_knowledge_certainty", entityId: NPC_1 });
    }
    for (const disclosure of ["restricted", "__proto__", "hasOwnProperty"]) {
      expectKnowledgeRejected(ws, [recordKnowledge({ disclosure })], { code: "invalid_knowledge_disclosure", entityId: NPC_1 });
    }
  });

  it("initial_world 在本通道被拒：把知识写入开给创建期来源属 Task 6 的能力", () => {
    const ws = world();
    const initial: KnowledgeMutationSource = { kind: "initial_world", turnNumber: 0 };
    expectKnowledgeRejected(ws, [recordKnowledge({ source: initial })], { code: "invalid_knowledge_source", entityId: NPC_1 });
    // 判别式之外的 kind 同样落在这个码上：新增一支不会悄悄获得写入能力。
    expectKnowledgeRejected(ws, [recordKnowledge({
      source: { kind: "ai_said_so" } as unknown as KnowledgeMutationSource,
    })], { code: "invalid_knowledge_source", entityId: NPC_1 });
    // mode 表外值也一样：说话人策略表之外没有第二条通道。
    expectKnowledgeRejected(ws, [recordKnowledge({
      source: knowledgeSource({ mode: "toString" as FactChangeSource }),
    })], { code: "invalid_knowledge_source", entityId: NPC_1 });
  });

  it("mode 与说话人策略不匹配时零写入：无说话人的 npc_revealed 与多余的 sourceNpcId 各自稳定", () => {
    const ws = world();
    expectKnowledgeRejected(ws, [recordKnowledge({ source: knowledgeSource({ mode: "npc_revealed" }) })], { code: "invalid_knowledge_source", entityId: NPC_1 });
    expectKnowledgeRejected(ws, [recordKnowledge({
      source: knowledgeSource({ mode: "player_told", sourceNpcId: NPC_2 }),
    })], { code: "invalid_knowledge_source", entityId: NPC_1 });
  });

  it("合法写入与失败写入混在同一批时整批零修改", () => {
    const ws = world();
    const store = ws.entityStore;
    const result = applyEntityMutations(ws, [
      recordKnowledge({ factId: FACT_1 }),
      recordKnowledge({ factId: asFactId("fact_missing") }),
    ]);
    expect(result).toEqual({ ok: false, code: "unknown_knowledge_fact", entityId: asFactId("fact_missing") });
    expect(ws.entityStore).toBe(store);
    expect(knowledgeOf(ws).entries).toHaveLength(0);
  });
});

describe("applyEntityMutations — set_npc_knowledge_disclosure", () => {
  it("披露通道只改 disclosure：不建条目、不动 certainty、不改首次 source", () => {
    const recorded = okApply(world(), [recordKnowledge({ certainty: "suspected", disclosure: "public" })]);
    const before = knowledgeOf(recorded);
    const entry = before.entries[0]!;
    const next = okApply(recorded, [setDisclosure({ disclosure: "secret" })]);
    const after = knowledgeOf(next);
    expect(after).not.toBe(before);
    expect(after.entries).toHaveLength(1);
    const changed = after.entries[0]!;
    expect(changed.disclosure).toBe("secret");
    expect(changed.certainty).toBe("suspected");
    expect(changed.source).toBe(entry.source);
    expect(changed.factId).toBe(entry.factId);
    // 首次来源是历史：披露改动不留自己的 actionId 痕迹。
    expect(changed.source.kind === "action" && changed.source.actionId).toBe(ACT_1);
  });

  it("未知 Fact 与「该 NPC 并不知道这件事」都零写入，且各自返回稳定 code", () => {
    const ws = world();
    expectKnowledgeRejected(ws, [setDisclosure({ factId: asFactId("fact_missing") })], {
      code: "unknown_knowledge_fact", entityId: asFactId("fact_missing"), subjectId: NPC_1,
    });
    // 事实实体存在、NPC 也知道另一条事实：条目不存在就是 knowledge_entry_not_found，绝不隐式建条目。
    const seeded = okApply(ws, [recordKnowledge({ factId: FACT_1 })]);
    const withFact2 = okApply(seeded, [{ kind: "create_entities", records: [factEntityRecord(FACT_2)] }]);
    expect(knowledgeOf(withFact2).entries.map((entry) => String(entry.factId))).toEqual(["fact_1"]);
    // 码本身即证据：引用上下文认得 FACT_2，所以失败原因只能是「这条 NPC 没有该条目」。
    expectKnowledgeRejected(withFact2, [setDisclosure({ factId: FACT_2 })], { code: "knowledge_entry_not_found", entityId: NPC_1 });
  });

  it("披露值本身与 evidence 一样只走封闭表", () => {
    const recorded = okApply(world(), [recordKnowledge()]);
    expectKnowledgeRejected(recorded, [setDisclosure({ disclosure: "restricted" })], { code: "invalid_knowledge_disclosure", entityId: NPC_1 });
    expectKnowledgeRejected(recorded, [setDisclosure({ disclosure: "toString" })], { code: "invalid_knowledge_disclosure", entityId: NPC_1 });
    expectKnowledgeRejected(recorded, [setDisclosure({ actionId: "" })], { code: "invalid_knowledge_source", entityId: NPC_1 });
    expectKnowledgeRejected(recorded, [setDisclosure({ turnNumber: -3 })], { code: "invalid_knowledge_turn", entityId: NPC_1 });
    expectKnowledgeRejected(recorded, [setDisclosure({ npcId: asNpcId("npc_missing") })], { code: "unknown_entity_id", entityId: asNpcId("npc_missing") });
  });

  it("同值披露重放零写入：组件引用原样不变", () => {
    const recorded = okApply(world(), [recordKnowledge({ disclosure: "public" })]);
    const withheld = okApply(recorded, [setDisclosure({ disclosure: "secret" })]);
    const component = knowledgeOf(withheld);
    const replayed = okApply(withheld, [setDisclosure({ disclosure: "secret", actionId: "act_later", turnNumber: 9 })]);
    expect(knowledgeOf(replayed)).toBe(component);
  });

  it("非活跃主体与未知说话人一样先于写入被拒：披露通道也不能绕过生命周期", () => {
    const recorded = okApply(world(), [recordKnowledge()]);
    const inactive = okApply(recorded, [{ kind: "set_npc_lifecycle", npcId: NPC_1, lifecycle: "inactive" }]);
    const result = applyEntityMutations(inactive, [setDisclosure()]);
    expect(result).toEqual({ ok: false, code: "invalid_lifecycle_transition", entityId: NPC_1 });
  });
});

describe("知识写入通道唯一性", () => {
  it("entityMutation.ts 里把 knowledge 组件写回 record 的 case 只有三个", () => {
    const file = resolve(process.cwd(), "src/game/gameplay/rpg/entityWorld/entityMutation.ts");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    const body = text.slice(text.indexOf("function applyOne("), text.indexOf("export function applyEntityMutations"));
    const labels = [...body.matchAll(/\n\s*case "([a-z_]+)":/g)]
      .map((match) => ({ name: match[1] ?? "", at: match.index ?? 0 }));
    expect(labels.length).toBeGreaterThan(0);
    const writers = labels
      .filter((entry, index) => {
        const next = labels[index + 1];
        return /\bknowledge\s*[:,}]/.test(body.slice(entry.at, next === undefined ? body.length : next.at));
      })
      .map((entry) => entry.name);
    expect(writers.sort()).toEqual(["record_npc_knowledge", "set_npc_knowledge_disclosure"]);
  });
});

// ---------------------------------------------------------------------------
// Task 5A：历史 / 情绪 / met 的窄规则侧 mutation。
// 三支都不接受数值 delta、不接受 summary 正文、不接受整块组件：
// `relationshipDelta` 与 `summary` 由实体层从**本批实际应用的关系变化**里盖章（ruling R5-2），
// 兼容 memory 一律由 projector 重建，本层不存在第二条平行写路径。
// ---------------------------------------------------------------------------

const NPC_9 = asNpcId("npc_9");

function interaction(input: Readonly<{
  npcId?: NpcId;
  turnNumber?: number;
  actionId?: string;
  locationId?: LocationId;
  dialogueAct?: DialogueAct | "freeform";
  topic?: StructuredDialogueTopic;
  topicSummary?: string;
  /** 表外 outcome 由调用点直接传字符串（生产类型是封闭 union）。 */
  outcome?: NpcInteraction["outcome"] | string;
  learnedFactIds?: readonly FactId[];
}> = {}): EntityMutation {
  return {
    kind: "record_npc_interaction",
    npcId: input.npcId ?? NPC_1,
    turnNumber: input.turnNumber ?? 3,
    actionId: input.actionId ?? ACT_1,
    locationId: input.locationId ?? LOC_1,
    dialogueAct: input.dialogueAct ?? "support",
    ...(input.topic === undefined ? {} : { topic: input.topic }),
    topicSummary: input.topicSummary ?? "谈论任务",
    outcome: (input.outcome ?? "positive") as NpcInteraction["outcome"],
    learnedFactIds: input.learnedFactIds ?? [],
  };
}

function setEmotion(input: Readonly<{ npcId?: NpcId; emotion?: NarrativeEmotion | string }> = {}): EntityMutation {
  return {
    kind: "set_npc_emotion",
    npcId: input.npcId ?? NPC_1,
    emotion: (input.emotion ?? "warm") as NarrativeEmotion,
  };
}

function setMet(input: Readonly<{ npcId?: NpcId }> = {}): EntityMutation {
  return { kind: "set_npc_met", npcId: input.npcId ?? NPC_1, met: true };
}

function findNpcRecord(ws: WorldState, npcId: NpcId): NpcEntityRecord | undefined {
  return entitiesOfKind(ws.entityStore, "npc").find((record) => record.core.id === npcId);
}

function historyOf(ws: WorldState, npcId: NpcId = NPC_1): readonly NpcInteraction[] {
  const history = findNpcRecord(ws, npcId)?.history;
  if (history === undefined) throw new Error(`missing npc ${String(npcId)}`);
  return history.interactions;
}

function lastInteraction(ws: WorldState, npcId: NpcId = NPC_1): NpcInteraction {
  const entries = historyOf(ws, npcId);
  const entry = entries[entries.length - 1];
  if (entry === undefined) throw new Error("history is empty");
  return entry;
}

/** 一条 record 的全部组件（含可原地改写的数组）：零写入的取证对象。 */
function layersOf(record: NpcEntityRecord): readonly unknown[] {
  return [
    record.core, record.identity, record.position, record.dynamicState, record.knowledge,
    record.relationships, record.history, record.identity.anchors, record.dynamicState.goals,
    record.relationships.outgoing, record.history.interactions,
  ];
}

/**
 * 三支 kind 共用的拒绝入口：稳定 code/entityId，且入参 store、records 数组与主体的
 * **每一个组件对象（含数组）**都按引用原样不动——这是「没有半写入」的证据，不是快照相等。
 */
function expectNpcWriteRejected(
  ws: WorldState,
  mutations: readonly EntityMutation[],
  expected: Readonly<{ code: EntityMutationErrorCode; entityId?: string; subjectId?: NpcId }>,
) {
  const store = ws.entityStore;
  const records = store.records;
  // 诊断按本文件惯例报**越界的那个引用**（地点 ID 等），它通常不是行动主体，
  // 所以取证对象单独给；缺省才退化成 entityId。
  const subjectId = expected.subjectId ?? (expected.entityId as NpcId | undefined);
  const before = subjectId === undefined ? undefined : findNpcRecord(ws, subjectId);
  const beforeLayers = before === undefined ? undefined : layersOf(before);
  const result = applyEntityMutations(ws, mutations);
  expect(result).toEqual({
    ok: false, code: expected.code, ...(expected.entityId === undefined ? {} : { entityId: expected.entityId }),
  });
  expect(ws.entityStore).toBe(store);
  expect(ws.entityStore.records).toBe(records);
  if (subjectId !== undefined && beforeLayers !== undefined) {
    const current = findNpcRecord(ws, subjectId);
    expect(current).not.toBe(undefined);
    if (current !== undefined) {
      const afterLayers = layersOf(current);
      expect(afterLayers).toHaveLength(beforeLayers.length);
      afterLayers.forEach((layer, index) => expect(layer).toBe(beforeLayers[index]));
    }
  }
}

/** 把主体历史填到共享上限：actionId 互不相同，域校验才只可能因「新追加」而失败。 */
function seedHistory(count = NPC_HISTORY_CAP): WorldState {
  return okApply(world(), Array.from({ length: count }, (_unused, index) => interaction({
    actionId: `act_seed_${index}`,
    turnNumber: index + 1,
  })));
}

describe("applyEntityMutations — record_npc_interaction", () => {
  it("learnedFactIds 必须属于主体 NPC 自己的 knowledge，并报告越界 FactId", () => {
    expectNpcWriteRejected(world(), [interaction({ learnedFactIds: [FACT_2] })], {
      code: "invalid_reference", entityId: FACT_2, subjectId: NPC_1,
    });
  });

  it("fact topic 必须属于主体 NPC 自己的 knowledge，并报告越界 FactId", () => {
    expectNpcWriteRejected(world(), [interaction({ topic: { kind: "fact", factId: FACT_2 } })], {
      code: "invalid_reference", entityId: FACT_2, subjectId: NPC_1,
    });
  });

  it("同批创建带 knowledge 的 NPC 后再记录 interaction 时读取当前 records 并成功", () => {
    const npcId = NPC_9;
    const created = npcEntityRecord({
      core: { id: npcId, kind: "npc", name: "新旅人", createdAtTurn: 1, lifecycle: "active" },
      identity: { role: "旅人", description: "", tags: [] },
      position: { locationId: LOC_1, locationOrder: 5 },
      npc: {
        isCompanion: false, met: false,
        memory: { ...memoryOf(npcId), knownFactIds: [FACT_1] },
      },
    });
    const next = okApply(world(), [
      { kind: "create_entities", records: [created] },
      interaction({ npcId, learnedFactIds: [FACT_1], topic: { kind: "fact", factId: FACT_1 } }),
    ]);
    expect(lastInteraction(next, npcId).learnedFactIds).toEqual([FACT_1]);
  });

  it("quest topic 不在本闸门的验证范围内：没有 Quest record 也能记录", () => {
    const next = okApply(world(), [interaction({ topic: { kind: "quest", questId: asQuestId("quest_missing") } })]);
    expect(lastInteraction(next).topic).toEqual({ kind: "quest", questId: asQuestId("quest_missing") });
  });

  it("载荷键集合恰好等于声明：relationshipDelta、summary 与整块 history 都进不来", () => {
    // 负编译探针（同 3B/4B 惯例）：多余键写成字面量即 typecheck 失败，
    // 锁的是 EntityMutation 的载荷形状（RecordInteractionPayloadKeysLock），不是夹具自己。
    // @ts-expect-error relationshipDelta 不是 record_npc_interaction 的载荷键：数值归关系引擎所有
    const withDelta: EntityMutation = { kind: "record_npc_interaction", npcId: NPC_1, turnNumber: 3, actionId: "act_forged_delta", locationId: LOC_1, dialogueAct: "support", topicSummary: "谈论任务", outcome: "positive", learnedFactIds: [], relationshipDelta: 50 };
    // @ts-expect-error summary 不是载荷键：prose 里嵌着同一个数字，接受它等于接受第二份数值事实
    const withSummary: EntityMutation = { kind: "record_npc_interaction", npcId: NPC_1, turnNumber: 4, actionId: "act_forged_summary", locationId: LOC_1, dialogueAct: "support", topicSummary: "谈论任务", outcome: "positive", learnedFactIds: [], summary: "伪造" };
    // @ts-expect-error interactions 不是载荷键：替换整块历史就是第二条写入通道
    const wholeBlock: EntityMutation = { kind: "record_npc_interaction", npcId: NPC_1, turnNumber: 5, actionId: "act_forged_block", locationId: LOC_1, dialogueAct: "support", topicSummary: "谈论任务", outcome: "positive", learnedFactIds: [], interactions: [] };
    // @ts-expect-error emotion 不是载荷键：一支 kind 只写一个组件字段
    const crossField: EntityMutation = { kind: "record_npc_interaction", npcId: NPC_1, turnNumber: 6, actionId: "act_forged_emotion", locationId: LOC_1, dialogueAct: "support", topicSummary: "谈论任务", outcome: "positive", learnedFactIds: [], emotion: "angry" };
    // 运行时那一半同样是生产事实：类型没拦住的键既进不了条目、也改不动别的组件。
    // 四条各用不同 actionId，否则重复 actionId 的闸门会在第二支就把整批拒掉。
    // before 必须取自同一个 ws：这里比的是引用身份，两次 world() 永远是两个对象。
    const ws = world();
    const before = npcRecord(ws, NPC_1);
    const next = okApply(ws, [withDelta, withSummary, wholeBlock, crossField]);
    const after = npcRecord(next, NPC_1);
    expect(after.dynamicState).toBe(before.dynamicState);
    expect(after.relationships).toBe(before.relationships);
    const entries = historyOf(next);
    expect(entries).toHaveLength(4);
    // 盖章数字恒为 0（本批没有信号），伪造的 50 / "伪造" 都进不来。
    expect([...new Set(entries.map((entry) => entry.relationshipDelta))]).toEqual([0]);
    expect([...new Set(entries.map((entry) => entry.summary))]).toEqual(["首次见面，support，气氛融洽，关系+0"]);
    expect(Object.keys(lastInteraction(next)).sort()).toEqual([
      "actionId", "dialogueAct", "learnedFactIds", "locationId", "outcome",
      "relationshipDelta", "summary", "topicSummary", "turnNumber",
    ]);
  });

  it("topic 是可缺省键：省略即不留字段，给出则逐字保留", () => {
    const knowledgeable = okApply(world(), [recordKnowledge({ factId: FACT_1 })]);
    const next = okApply(knowledgeable, [
      interaction({ actionId: "act_general" }),
      interaction({ actionId: "act_fact", topic: { kind: "fact", factId: FACT_1 }, topicSummary: "询问线索" }),
    ]);
    const entries = historyOf(next);
    expect("topic" in entries[0]!).toBe(false);
    expect(entries[1]!.topic).toEqual({ kind: "fact", factId: FACT_1 });
    // learnedFactIds 原样携带；主体 knowledge 引用闸门在 append 前负责越界拒绝。
    const withFacts = okApply(knowledgeable, [interaction({ learnedFactIds: [FACT_1] })]);
    expect(lastInteraction(withFacts).learnedFactIds).toEqual([FACT_1]);
  });

  it("stamp 记的是关系引擎实际写入的 affinity 变化（signal 在前的批次数组顺序）", () => {
    const next = okApply(world(), [
      signalMutation({ targetId: PLAYER_ENTITY_ID, signal: "supported" }),
      interaction({ actionId: ACT_1 }),
    ]);
    expect(edgeOf(next, NPC_1, PLAYER_ENTITY_ID).dimensions.affinity).toBe(3);
    expect(lastInteraction(next).relationshipDelta).toBe(3);
    expect(lastInteraction(next).summary).toBe("首次见面，support，气氛融洽，关系+3");
  });

  it("预算裁剪后的真实变化才是 stamp：同行动两条 normal 信号被单维 ±5 压到 5，不是表内相加的 7", () => {
    // gave_item = affinity +4，supported = affinity +3（表内原始和 7）；
    // 同一行动对同一边的累计预算先把第二格压到 +1（4+1=5 正好贴单维 cap），
    // 所以这条交互只能盖到 5。接受调用方传数字的实现会写 7 或写原始信号值——都在这里失败。
    const next = okApply(world(), [
      signalMutation({ targetId: PLAYER_ENTITY_ID, signal: "gave_item" }),
      signalMutation({ targetId: PLAYER_ENTITY_ID, signal: "supported" }),
      interaction({ actionId: ACT_1 }),
    ]);
    const edge = edgeOf(next, NPC_1, PLAYER_ENTITY_ID);
    expect(edge.dimensions.affinity).toBe(5);
    expect(lastInteraction(next).relationshipDelta).toBe(5);
    expect(lastInteraction(next).summary).toBe("首次见面，support，气氛融洽，关系+5");
  });

  it("批次数组顺序就是契约：interaction 在 signal 之前只盖到 0", () => {
    const next = okApply(world(), [
      interaction({ actionId: ACT_1 }),
      signalMutation({ targetId: PLAYER_ENTITY_ID, signal: "supported" }),
    ]);
    expect(edgeOf(next, NPC_1, PLAYER_ENTITY_ID).dimensions.affinity).toBe(3);
    expect(lastInteraction(next).relationshipDelta).toBe(0);
    expect(lastInteraction(next).summary).toContain("关系+0");
  });

  it("stamp 是本批的变化量而不是绝对 affinity：起点非零且本批无信号时仍盖 0", () => {
    // 上一批把 NPC_1→player 的 affinity 抬到 3；这一批只追加一条交互。
    // 「盖绝对读数」的实现会在这里写 3 而不是 0——那等于把生涯累计值冒充成本次行动的关系变化，
    // 并逐批单调膨胀地持久化进 relationshipDelta 这个计划点名的兼容读模型字段。
    const warmed = okApply(world(), [signalMutation({ targetId: PLAYER_ENTITY_ID, signal: "supported" })]);
    expect(edgeOf(warmed, NPC_1, PLAYER_ENTITY_ID).dimensions.affinity).toBe(3);
    const next = okApply(warmed, [interaction({ actionId: ACT_1 })]);
    expect(edgeOf(next, NPC_1, PLAYER_ENTITY_ID).dimensions.affinity).toBe(3);
    expect(lastInteraction(next).relationshipDelta).toBe(0);
    expect(lastInteraction(next).summary).toContain("关系+0");
  });

  it("同批两条交互读到同一个本批累计 delta（一行动一交互由调用方保证）", () => {
    // 基线登记在「本批首次触及主体」那一刻，不随第二条交互再次归零：
    // 若实现改成「距上一条交互的增量」，第二条会盖成 0 而在这里失败。
    const next = okApply(world(), [
      signalMutation({ targetId: PLAYER_ENTITY_ID, signal: "supported" }),
      interaction({ actionId: ACT_1 }),
      interaction({ actionId: "act_stamp_second" }),
    ]);
    const entries = next.npcs[0]?.memory.interactionHistory ?? [];
    expect(entries.map((entry) => entry.relationshipDelta)).toEqual([3, 3]);
    expect(entries.map((entry) => entry.summary)).toEqual([
      "首次见面，support，气氛融洽，关系+3",
      "首次见面，support，气氛融洽，关系+3",
    ]);
  });

  it("没有本批信号、没有 player 边、只动 NPC→NPC 边：三种情形都盖 0", () => {
    const alone = okApply(world(), [interaction()]);
    expect(lastInteraction(alone).relationshipDelta).toBe(0);
    // 别的边上的变化不是这条交互的 delta：stamp 只看 player 目标。
    const towardNpc = okApply(world(), [
      signalMutation({ signal: "supported" }),
      interaction({ actionId: ACT_1 }),
    ]);
    expect(edgeOf(towardNpc, NPC_1, NPC_2).dimensions.affinity).toBe(3);
    expect(lastInteraction(towardNpc).relationshipDelta).toBe(0);
    // 完全没有 player 边的 NPC（同批新建）同样是 0，而不是「查不到就失败」。
    const created = okApply(world(), [{
      kind: "create_entities",
      records: [{
        ...npcEntityRecord({
          core: { id: NPC_9, kind: "npc", name: "无边的旅人", createdAtTurn: 1, lifecycle: "active" },
          identity: { role: "旅人", description: "", tags: [] },
          position: { locationId: LOC_1, locationOrder: 5 },
          npc: { isCompanion: false, met: false, memory: memoryOf(NPC_9) },
        }),
        relationships: { outgoing: [] },
      }],
    }]);
    expect(findNpcRecord(created, NPC_9)!.relationships.outgoing).toEqual([]);
    const edgeless = okApply(created, [
      signalMutation({ fromNpcId: NPC_9, targetId: NPC_2, signal: "supported" }),
      interaction({ npcId: NPC_9, actionId: ACT_1 }),
    ]);
    expect(edgeOf(edgeless, NPC_9, NPC_2).dimensions.affinity).toBe(3);
    expect(lastInteraction(edgeless, NPC_9).relationshipDelta).toBe(0);
  });

  it("summary 用盖章数字与追加那一刻的 dynamicState.met：同批先 set_npc_met 就写成再次交谈", () => {
    const first = okApply(world(), [interaction({ actionId: ACT_1, outcome: "negative" })]);
    expect(lastInteraction(first).summary).toBe("首次见面，support，氛围紧张，关系+0");
    const remeeting = okApply(world(), [
      setMet(),
      interaction({ actionId: ACT_1, dialogueAct: "challenge", outcome: "mixed" }),
    ]);
    expect(npcRecord(remeeting, NPC_1).dynamicState.met).toBe(true);
    // met 读的是**追加那一刻**的 live 值：同批排在前面的 set_npc_met 已经把措辞翻过来。
    expect(lastInteraction(remeeting).summary).toBe("再次交谈，challenge，气氛复杂，关系+0");
    // 反序是这条契约的另一半：set_npc_met 排在交互之后，追加时 met 仍是 false。
    const reversed = okApply(world(), [
      interaction({ actionId: ACT_1, dialogueAct: "challenge", outcome: "mixed" }),
      setMet(),
    ]);
    expect(npcRecord(reversed, NPC_1).dynamicState.met).toBe(true);
    expect(lastInteraction(reversed).summary).toBe("首次见面，challenge，气氛复杂，关系+0");
    const again = okApply(remeeting, [interaction({ actionId: "act_2", dialogueAct: "ask", outcome: "neutral" })]);
    expect(lastInteraction(again).summary).toBe("再次交谈，ask，语气平淡，关系+0");
    // mixed / 负数数字的正向模板同样由实体层拼出：- 号不重复、+ 号不缺席。
    const negative = okApply(world(), [
      signalMutation({ targetId: PLAYER_ENTITY_ID, signal: "threatened" }),
      interaction({ actionId: ACT_1, outcome: "negative" }),
    ]);
    expect(lastInteraction(negative).relationshipDelta).toBe(-4);
    expect(lastInteraction(negative).summary).toBe("首次见面，support，氛围紧张，关系-4");
  });

  it("追加保持 oldest→newest 并裁到共享上限常量（裁最旧，永不裁新写入）", () => {
    const seeded = seedHistory();
    expect(historyOf(seeded)).toHaveLength(NPC_HISTORY_CAP);
    expect(historyOf(seeded).map((entry) => entry.actionId)).toEqual(
      Array.from({ length: NPC_HISTORY_CAP }, (_unused, index) => `act_seed_${index}`),
    );
    const overflow = okApply(seeded, [interaction({ actionId: "act_overflow", turnNumber: 99 })]);
    const entries = historyOf(overflow);
    expect(entries).toHaveLength(NPC_HISTORY_CAP);
    expect(entries[0]!.actionId).toBe("act_seed_1");
    expect(entries[entries.length - 1]!.actionId).toBe("act_overflow");
    expect(entries.map((entry) => entry.turnNumber)).toEqual(
      [...Array.from({ length: NPC_HISTORY_CAP - 1 }, (_unused, index) => index + 2), 99],
    );
  });

  it("同一 NPC 重复 actionId 返回 duplicate_npc_interaction 且每个组件按引用不动", () => {
    const ws = seedHistory(2);
    expectNpcWriteRejected(ws, [interaction({ actionId: "act_seed_0" })], {
      code: "duplicate_npc_interaction", entityId: NPC_1,
    });
    // 跨批次也算重复：本通道永不静默去重。
    expectNpcWriteRejected(ws, [
      interaction({ actionId: "act_new" }),
      interaction({ actionId: "act_new" }),
    ], { code: "duplicate_npc_interaction", entityId: NPC_1 });
    expect(historyOf(ws)).toHaveLength(2);
  });

  it("只替换 history 一个组件：其余组件与另一 NPC 的 history 全部引用不变", () => {
    const ws = world();
    const before = npcRecord(ws, NPC_1);
    const next = okApply(ws, [interaction({ topic: { kind: "general" } })]);
    const after = npcRecord(next, NPC_1);
    expect(after.history).not.toBe(before.history);
    expect(after.core).toBe(before.core);
    expect(after.identity).toBe(before.identity);
    expect(after.position).toBe(before.position);
    expect(after.dynamicState).toBe(before.dynamicState);
    expect(after.knowledge).toBe(before.knowledge);
    expect(after.relationships).toBe(before.relationships);
    expect(npcRecord(next, NPC_2).history).toBe(npcRecord(ws, NPC_2).history);
  });

  it("兼容 interactionHistory 只由 projector 重建：本层不平行写 memory", () => {
    const ws = world();
    expect(ws.npcs.find((npc) => npc.id === NPC_1)?.memory.interactionHistory).toEqual([]);
    const next = okApply(ws, [interaction({ actionId: ACT_1 }), setMet(), setEmotion()]);
    const entry = next.npcs.find((npc) => npc.id === NPC_1)!;
    expect(entry.memory.interactionHistory.map((item) => item.actionId)).toEqual([ACT_1]);
    expect(entry.memory.interactionHistory[0]!.summary).toBe("首次见面，support，气氛融洽，关系+0");
    expect(entry.met).toBe(true);
    expect(entry.memory.emotion).toBe("warm");
    expect(npcRecord(ws, NPC_1).history.interactions).toEqual([]);
  });

  it("未知 npc、非 npc（物品与玩家）、非活跃 npc、未知地点各返回稳定 code 且零写入", () => {
    const ws = world();
    expectNpcWriteRejected(ws, [interaction({ npcId: asNpcId("npc_missing") })], {
      code: "unknown_entity_id", entityId: asNpcId("npc_missing"),
    });
    expectNpcWriteRejected(ws, [interaction({ npcId: asNpcId(String(ITEM_A)) })], {
      code: "wrong_entity_kind", entityId: ITEM_A,
    });
    expectNpcWriteRejected(ws, [interaction({ npcId: asNpcId(String(PLAYER_ENTITY_ID)) })], {
      code: "wrong_entity_kind", entityId: PLAYER_ENTITY_ID,
    });
    expectNpcWriteRejected(ws, [interaction({ locationId: asLocationId("loc_missing") })], {
      code: "invalid_reference", entityId: asLocationId("loc_missing"), subjectId: NPC_1,
    });
    const inactive = okApply(world(), [{ kind: "set_npc_lifecycle", npcId: NPC_2, lifecycle: "inactive" }]);
    expectNpcWriteRejected(inactive, [interaction({ npcId: NPC_2 })], {
      code: "invalid_lifecycle_transition", entityId: NPC_2,
    });
  });

  it("合法与失败混在同一批时整批零修改", () => {
    const ws = world();
    const result = applyEntityMutations(ws, [
      interaction({ actionId: "act_ok" }),
      interaction({ actionId: "act_bad", locationId: asLocationId("loc_missing") }),
    ]);
    expect(result).toEqual({ ok: false, code: "invalid_reference", entityId: asLocationId("loc_missing") });
    expect(historyOf(ws)).toEqual([]);
  });
});

describe("applyEntityMutations — set_npc_emotion", () => {
  it("载荷键集合恰好等于声明：met、isCompanion、goals 与整块 dynamicState 都进不来", () => {
    // @ts-expect-error met 不是 set_npc_emotion 的载荷键：一支 kind 只写一个字段
    const withMet: EntityMutation = { kind: "set_npc_emotion", npcId: NPC_1, emotion: "warm", met: true };
    // @ts-expect-error isCompanion 不是载荷键：同伴语义属 Task 7
    const withCompanion: EntityMutation = { kind: "set_npc_emotion", npcId: NPC_1, emotion: "warm", isCompanion: true };
    // @ts-expect-error goals 不是载荷键：目标永不接受运行时 patch
    const withGoals: EntityMutation = { kind: "set_npc_emotion", npcId: NPC_1, emotion: "warm", goals: [] };
    // @ts-expect-error 整块 dynamicState 不是载荷键：替换组件就是第二条通道
    const wholeBlock: EntityMutation = { kind: "set_npc_emotion", npcId: NPC_1, dynamicState: { isCompanion: true, met: true, emotion: "angry", goals: [] } };
    const ws = world();
    const before = npcRecord(ws, NPC_1);
    // 运行时那一半分两种：多给键（前三个）在逐键写入下根本落不了地；
    // 少给载荷键（整块替换那一支）连 emotion 都没有，domain 的取值闭集在任何写入前把它挡下。
    const next = okApply(ws, [withMet, withCompanion, withGoals]);
    const after = npcRecord(next, NPC_1);
    expect(after.dynamicState.emotion).toBe("warm");
    expect(after.dynamicState.isCompanion).toBe(false);
    expect(after.dynamicState.met).toBe(false);
    expect(after.dynamicState.goals).toBe(before.dynamicState.goals);
    expect(after.history).toBe(before.history);
    expect(after.relationships).toBe(before.relationships);
    expect(Object.keys(after.dynamicState).sort()).toEqual(["emotion", "goals", "isCompanion", "met"]);
    // 整块 dynamicState 不是载荷：它既换不掉组件（载荷里没有 emotion），
    // 也留不下半成品——整批零写入，取值闭集的权威在 domain。
    expectNpcWriteRejected(ws, [wholeBlock], { code: "structure_invalid", entityId: NPC_1 });
  });

  it("同值情绪重放是幂等成功而非失败：组件引用原样不变", () => {
    const ws = world();
    expect(npcRecord(ws, NPC_1).dynamicState.emotion).toBe("neutral");
    const sameValue = okApply(ws, [setEmotion({ emotion: "neutral" })]);
    expect(npcRecord(sameValue, NPC_1).dynamicState).toBe(npcRecord(ws, NPC_1).dynamicState);
    const once = okApply(ws, [setEmotion()]);
    const component = npcRecord(once, NPC_1).dynamicState;
    const batched = okApply(once, [setEmotion(), setEmotion()]);
    expect(npcRecord(batched, NPC_1).dynamicState).toBe(component);
    expect(npcRecord(batched, NPC_1).dynamicState.goals).toBe(npcRecord(ws, NPC_1).dynamicState.goals);
  });

  it("主体边界与另两支一致：未知、非 npc、非活跃各自稳定", () => {
    const ws = world();
    expectNpcWriteRejected(ws, [setEmotion({ npcId: asNpcId("npc_missing") })], {
      code: "unknown_entity_id", entityId: asNpcId("npc_missing"),
    });
    expectNpcWriteRejected(ws, [setEmotion({ npcId: asNpcId(String(ITEM_A)) })], {
      code: "wrong_entity_kind", entityId: ITEM_A,
    });
    const inactive = okApply(world(), [{ kind: "set_npc_lifecycle", npcId: NPC_1, lifecycle: "inactive" }]);
    expectNpcWriteRejected(inactive, [setEmotion()], { code: "invalid_lifecycle_transition", entityId: NPC_1 });
  });

  it("表外取值不抄第二份检查：由 domain validator 在任何写入之前挡住并零写入", () => {
    // 取值闭集的权威在 domain（validateNpcDynamicState 的 value_out_of_closed_set），
    // 本层再抄一份 NARRATIVE_EMOTIONS 判断就是第二事实来源；store 级失败同样不落盘。
    const ws = world();
    const before = npcRecord(ws, NPC_1);
    for (const emotion of ["toString", "constructor", "affinity_plus_50"]) {
      const result = applyEntityMutations(ws, [setEmotion({ emotion })]);
      expect(result).toEqual({ ok: false, code: "structure_invalid", entityId: NPC_1 });
      expect(npcRecord(ws, NPC_1).dynamicState).toBe(before.dynamicState);
    }
  });
});

describe("applyEntityMutations — set_npc_met", () => {
  it("载荷键集合恰好等于声明：emotion、isCompanion、goals 与整块 dynamicState 都进不来", () => {
    // @ts-expect-error emotion 不是 set_npc_met 的载荷键
    const withEmotion: EntityMutation = { kind: "set_npc_met", npcId: NPC_1, met: true, emotion: "warm" };
    // @ts-expect-error isCompanion 不是载荷键：Task 7 才拥有同伴语义
    const withCompanion: EntityMutation = { kind: "set_npc_met", npcId: NPC_1, met: true, isCompanion: true };
    // @ts-expect-error goals 不是载荷键
    const withGoals: EntityMutation = { kind: "set_npc_met", npcId: NPC_1, met: true, goals: [] };
    // @ts-expect-error met 的字面量类型就是 true：false 在类型层没有写入通道
    const unmeet: EntityMutation = { kind: "set_npc_met", npcId: NPC_1, met: false };
    const ws = world();
    const before = npcRecord(ws, NPC_1);
    const next = okApply(ws, [withEmotion, withCompanion, withGoals]);
    const after = npcRecord(next, NPC_1);
    expect(after.dynamicState.met).toBe(true);
    expect(after.dynamicState.emotion).toBe(before.dynamicState.emotion);
    expect(after.dynamicState.isCompanion).toBe(false);
    expect(after.dynamicState.goals).toBe(before.dynamicState.goals);
    expect(after.history).toBe(before.history);
    // 运行时那一半：伪造的 met:false 走稳定码，而不是静默把 met 改回 false。
    expectNpcWriteRejected(ws, [unmeet], { code: "invalid_npc_met_value", entityId: NPC_1 });
    expectNpcWriteRejected(ws, [{ kind: "set_npc_met", npcId: NPC_1, met: "true" as unknown as true }], {
      code: "invalid_npc_met_value", entityId: NPC_1,
    });
    expectNpcWriteRejected(ws, [{ kind: "set_npc_met", npcId: NPC_1, met: 1 as unknown as true }], {
      code: "invalid_npc_met_value", entityId: NPC_1,
    });
  });

  it("已 met 的 NPC 再 set_npc_met(true) 是幂等成功：组件引用原样不变", () => {
    const met = okApply(world(), [setMet()]);
    const component = npcRecord(met, NPC_1).dynamicState;
    const again = okApply(met, [setMet(), setMet()]);
    expect(npcRecord(again, NPC_1).dynamicState).toBe(component);
    expect(again.npcs.find((npc) => npc.id === NPC_1)?.met).toBe(true);
  });

  it("met 单调只抬 true：isCompanion 与 goals 在三支 kind 之后仍然动不了", () => {
    const ws = world();
    const before = npcRecord(ws, NPC_1);
    const next = okApply(ws, [
      signalMutation({ targetId: PLAYER_ENTITY_ID, signal: "supported" }),
      interaction({ actionId: ACT_1 }),
      setEmotion(),
      setMet(),
    ]);
    const after = npcRecord(next, NPC_1);
    expect(after.dynamicState.isCompanion).toBe(false);
    expect(after.dynamicState.goals).toBe(before.dynamicState.goals);
    expect(after.history.interactions).toHaveLength(1);
    expect(after.relationships).not.toBe(before.relationships);
    expect(npcRecord(ws, NPC_1).dynamicState).toBe(before.dynamicState);
  });

  it("主体边界与另两支一致：未知、非 npc、非活跃各自稳定", () => {
    const ws = world();
    expectNpcWriteRejected(ws, [setMet({ npcId: asNpcId("npc_missing") })], {
      code: "unknown_entity_id", entityId: asNpcId("npc_missing"),
    });
    expectNpcWriteRejected(ws, [setMet({ npcId: asNpcId(String(ENEMY_1)) })], {
      code: "wrong_entity_kind", entityId: ENEMY_1,
    });
    const inactive = okApply(world(), [{ kind: "set_npc_lifecycle", npcId: NPC_2, lifecycle: "inactive" }]);
    expectNpcWriteRejected(inactive, [setMet({ npcId: NPC_2 })], {
      code: "invalid_lifecycle_transition", entityId: NPC_2,
    });
  });
});

describe("NPC 组件与历史写入通道唯一性", () => {
  it("entityMutation.ts 里把 history 组件写回 record 的 case 只有两个", () => {
    const file = resolve(process.cwd(), "src/game/gameplay/rpg/entityWorld/entityMutation.ts");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    const body = text.slice(text.indexOf("function applyOne("), text.indexOf("export function applyEntityMutations"));
    const labels = [...body.matchAll(/\n\s*case "([a-z_]+)":/g)]
      .map((match) => ({ name: match[1] ?? "", at: match.index ?? 0 }));
    expect(labels.length).toBeGreaterThan(0);
    const writers = labels
      .filter((entry, index) => {
        const next = labels[index + 1];
        return /\bhistory\s*[:,}]/.test(body.slice(entry.at, next === undefined ? body.length : next.at));
      })
      .map((entry) => entry.name);
    expect(writers.sort()).toEqual(["record_npc_interaction"]);
  });

  it("entityMutation.ts 里把 dynamicState 组件写回 record 的 case 只有三个", () => {
    const file = resolve(process.cwd(), "src/game/gameplay/rpg/entityWorld/entityMutation.ts");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    const body = text.slice(text.indexOf("function applyOne("), text.indexOf("export function applyEntityMutations"));
    const labels = [...body.matchAll(/\n\s*case "([a-z_]+)":/g)]
      .map((match) => ({ name: match[1] ?? "", at: match.index ?? 0 }));
    expect(labels.length).toBeGreaterThan(0);
    const writers = labels
      .filter((entry, index) => {
        const next = labels[index + 1];
        return /\bdynamicState\s*[:,}]/.test(body.slice(entry.at, next === undefined ? body.length : next.at));
      })
      .map((entry) => entry.name);
    expect(writers.sort()).toEqual(["set_npc_emotion", "set_npc_met"]);
  });
});
