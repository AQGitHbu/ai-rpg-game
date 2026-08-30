import {
  EntityStoreInvariantError,
  createEntityStore,
  projectEntityStore,
  validateEntityReferences,
  type EntityRecord,
  type ItemEntityRecord,
  type LocationComponent,
  type NpcEntityRecord,
  type NpcStateComponent,
  type PossessionComponent,
} from "@/game/domain/entity";
import type { WorldState } from "@/game/domain/worldState";
import { PLAYER_ENTITY_ID, type EnemyId, type FactId, type ItemId, type LocationId, type NpcId, type QuestId } from "@/game/domain/worldEntity";

/** 规则层唯一允许的实体写入语言；AI 输入不使用此联合。 */
export type EntityMutation =
  | { readonly kind: "move_player"; readonly toLocationId: LocationId; readonly markVisited: true }
  | { readonly kind: "move_npc"; readonly npcId: NpcId; readonly toLocationId: LocationId }
  | { readonly kind: "set_location_unlocked"; readonly locationId: LocationId; readonly unlocked: boolean }
  | { readonly kind: "set_location_visited"; readonly locationId: LocationId; readonly visited: boolean }
  | { readonly kind: "replace_npc_state"; readonly npcId: NpcId; readonly npcState: NpcStateComponent }
  | { readonly kind: "transfer_item"; readonly itemId: ItemId; readonly owner: PossessionComponent["owner"] }
  | { readonly kind: "discover_fact"; readonly factId: FactId }
  | { readonly kind: "set_quest_status"; readonly questId: QuestId; readonly status: "locked" | "active" | "completed" | "failed" | "closed" }
  | { readonly kind: "set_enemy_defeated"; readonly enemyId: EnemyId; readonly defeated: boolean }
  | { readonly kind: "set_npc_lifecycle"; readonly npcId: NpcId; readonly lifecycle: "active" | "inactive" }
  | { readonly kind: "replace_location_component"; readonly locationId: LocationId; readonly location: LocationComponent }
  | { readonly kind: "create_entities"; readonly records: readonly EntityRecord[] };

export type EntityMutationErrorCode =
  | "unknown_entity_id"
  | "duplicate_entity_id"
  | "wrong_entity_kind"
  | "invalid_reference"
  | "invalid_lifecycle_transition"
  | "structure_invalid";

export type ApplyEntityMutationsResult =
  | { readonly ok: true; readonly worldState: WorldState }
  | { readonly ok: false; readonly code: EntityMutationErrorCode; readonly entityId?: string };

/** 供必须把内部不变量失败升级为异常的上游调用点使用。 */
export class EntityMutationInvariantError extends Error {
  readonly code: EntityMutationErrorCode;
  readonly entityId?: string;

  constructor(input: { readonly code: EntityMutationErrorCode; readonly entityId?: string }) {
    super(`entity mutation invariant violated: ${input.code}`);
    this.name = "EntityMutationInvariantError";
    this.code = input.code;
    this.entityId = input.entityId;
  }
}

type MutationResult =
  | { readonly ok: true; readonly records: readonly EntityRecord[] }
  | { readonly ok: false; readonly code: EntityMutationErrorCode; readonly entityId?: string };

type EntityRecordOfKind<K extends EntityRecord["core"]["kind"]> = Extract<EntityRecord, { readonly core: { readonly kind: K } }>;

function isNpcRecord(record: EntityRecord): record is NpcEntityRecord {
  return record.core.kind === "npc";
}

function isItemRecord(record: EntityRecord): record is ItemEntityRecord {
  return record.core.kind === "item";
}

function failure(code: EntityMutationErrorCode, entityId?: string): MutationResult {
  return entityId === undefined ? { ok: false, code } : { ok: false, code, entityId };
}

function recordOfKind<K extends EntityRecord["core"]["kind"]>(
  records: readonly EntityRecord[],
  entityId: string,
  kind: K,
): { readonly ok: true; readonly record: EntityRecordOfKind<K> } | { readonly ok: false; readonly code: EntityMutationErrorCode; readonly entityId: string } {
  const record = records.find((entry) => entry.core.id === entityId);
  if (record === undefined) return { ok: false, code: "unknown_entity_id", entityId };
  if (record.core.kind !== kind) return { ok: false, code: "wrong_entity_kind", entityId };
  const typedRecord = records.find((entry): entry is EntityRecordOfKind<K> => entry.core.id === entityId && entry.core.kind === kind);
  if (typedRecord === undefined) return { ok: false, code: "unknown_entity_id", entityId };
  return { ok: true, record: typedRecord };
}

function hasKind(records: readonly EntityRecord[], entityId: string, kind: EntityRecord["core"]["kind"]): boolean {
  return records.some((record) => record.core.id === entityId && record.core.kind === kind);
}

function replaceRecord(records: readonly EntityRecord[], entityId: string, replacement: EntityRecord): readonly EntityRecord[] {
  return records.map((record) => record.core.id === entityId ? replacement : record);
}

function maxNpcOrder(records: readonly EntityRecord[], locationId: LocationId): number {
  return records.reduce((max, record) => (
    isNpcRecord(record)
      && record.core.lifecycle === "active"
      && record.position.locationId === locationId
      ? Math.max(max, record.position.locationOrder)
      : max
  ), -1);
}

function ownerKey(owner: PossessionComponent["owner"]): string {
  if (owner.kind === "player") return `player:${owner.playerId}`;
  if (owner.kind === "location") return `location:${owner.locationId}`;
  if (owner.kind === "npc") return `npc:${owner.npcId}`;
  return "none";
}

function sameOwner(left: PossessionComponent["owner"], right: PossessionComponent["owner"]): boolean {
  return ownerKey(left) === ownerKey(right);
}

function maxItemOrder(records: readonly EntityRecord[], owner: PossessionComponent["owner"]): number {
  if (owner.kind === "none") return 0;
  return records.reduce((max, record) => (
    isItemRecord(record) && sameOwner(record.possession.owner, owner)
      ? Math.max(max, record.possession.ownerOrder)
      : max
  ), -1);
}

function questLifecycle(status: Extract<EntityMutation, { readonly kind: "set_quest_status" }>["status"]): "active" | "inactive" | "resolved" {
  if (status === "active") return "active";
  if (status === "locked") return "inactive";
  return "resolved";
}

function applyOne(records: readonly EntityRecord[], mutation: EntityMutation): MutationResult {
  switch (mutation.kind) {
    case "move_player": {
      const player = recordOfKind(records, PLAYER_ENTITY_ID, "player_character");
      if (!player.ok) return player;
      const location = recordOfKind(records, mutation.toLocationId, "location");
      if (!location.ok) return failure("invalid_reference", mutation.toLocationId);
      const nextRecords = replaceRecord(records, player.record.core.id, {
        ...player.record,
        position: { ...player.record.position, locationId: mutation.toLocationId },
      });
      return {
        ok: true,
        records: replaceRecord(nextRecords, mutation.toLocationId, {
          ...location.record,
          location: { ...location.record.location, visited: mutation.markVisited || location.record.location.visited },
        }),
      };
    }
    case "move_npc": {
      const npc = recordOfKind(records, mutation.npcId, "npc");
      if (!npc.ok) return npc;
      const location = recordOfKind(records, mutation.toLocationId, "location");
      if (!location.ok) return failure("invalid_reference", mutation.toLocationId);
      const position = npc.record.position.locationId === mutation.toLocationId
        ? npc.record.position
        : { ...npc.record.position, locationId: mutation.toLocationId, locationOrder: maxNpcOrder(records, mutation.toLocationId) + 1 };
      return { ok: true, records: replaceRecord(records, mutation.npcId, { ...npc.record, position }) };
    }
    case "set_location_unlocked":
    case "set_location_visited": {
      const location = recordOfKind(records, mutation.locationId, "location");
      if (!location.ok) return location;
      const locationComponent = mutation.kind === "set_location_unlocked"
        ? { ...location.record.location, unlocked: mutation.unlocked }
        : { ...location.record.location, visited: mutation.visited };
      return { ok: true, records: replaceRecord(records, mutation.locationId, { ...location.record, location: locationComponent }) };
    }
    case "replace_npc_state": {
      const npc = recordOfKind(records, mutation.npcId, "npc");
      if (!npc.ok) return npc;
      return { ok: true, records: replaceRecord(records, mutation.npcId, { ...npc.record, npcState: mutation.npcState }) };
    }
    case "transfer_item": {
      const item = recordOfKind(records, mutation.itemId, "item");
      if (!item.ok) return item;
      const owner = mutation.owner;
      if (owner.kind === "location" && !hasKind(records, owner.locationId, "location")) return failure("invalid_reference", owner.locationId);
      if (owner.kind === "npc" && !hasKind(records, owner.npcId, "npc")) return failure("invalid_reference", owner.npcId);
      if (owner.kind === "player" && !hasKind(records, owner.playerId, "player_character")) return failure("invalid_reference", owner.playerId);
      const possession = sameOwner(item.record.possession.owner, owner)
        ? item.record.possession
        : { ...item.record.possession, owner, ownerOrder: maxItemOrder(records, owner) + 1 };
      return { ok: true, records: replaceRecord(records, mutation.itemId, { ...item.record, possession }) };
    }
    case "discover_fact": {
      const fact = recordOfKind(records, mutation.factId, "fact");
      if (!fact.ok) return fact;
      if (fact.record.fact.discovered) return { ok: true, records };
      return { ok: true, records: replaceRecord(records, mutation.factId, { ...fact.record, fact: { ...fact.record.fact, discovered: true } }) };
    }
    case "set_quest_status": {
      const quest = recordOfKind(records, mutation.questId, "quest");
      if (!quest.ok) return quest;
      return {
        ok: true,
        records: replaceRecord(records, mutation.questId, {
          ...quest.record,
          core: { ...quest.record.core, lifecycle: questLifecycle(mutation.status) },
          quest: { ...quest.record.quest, status: mutation.status },
        }),
      };
    }
    case "set_enemy_defeated": {
      const enemy = recordOfKind(records, mutation.enemyId, "enemy");
      if (!enemy.ok) return enemy;
      return {
        ok: true,
        records: replaceRecord(records, mutation.enemyId, {
          ...enemy.record,
          core: { ...enemy.record.core, lifecycle: mutation.defeated ? "resolved" : "active" },
          enemy: { ...enemy.record.enemy, defeated: mutation.defeated },
        }),
      };
    }
    case "set_npc_lifecycle": {
      const npc = recordOfKind(records, mutation.npcId, "npc");
      if (!npc.ok) return npc;
      if (npc.record.core.lifecycle === "resolved" || npc.record.core.lifecycle === "destroyed") {
        return failure("invalid_lifecycle_transition", mutation.npcId);
      }
      return { ok: true, records: replaceRecord(records, mutation.npcId, { ...npc.record, core: { ...npc.record.core, lifecycle: mutation.lifecycle } }) };
    }
    case "replace_location_component": {
      const location = recordOfKind(records, mutation.locationId, "location");
      if (!location.ok) return location;
      return { ok: true, records: replaceRecord(records, mutation.locationId, { ...location.record, location: mutation.location }) };
    }
    case "create_entities": {
      const seen = new Set(records.map((record) => record.core.id));
      for (const record of mutation.records) {
        if (seen.has(record.core.id)) return failure("duplicate_entity_id", record.core.id);
        seen.add(record.core.id);
      }
      return { ok: true, records: [...records, ...mutation.records] };
    }
  }
}

/**
 * 先在局部 records 执行整批命令，再集中运行 store/reference 校验并投影。
 * 任一失败都不返回部分状态，传入 WorldState 也不会被修改。
 */
export function applyEntityMutations(
  worldState: WorldState,
  mutations: readonly EntityMutation[],
): ApplyEntityMutationsResult {
  if (mutations.length === 0) return { ok: true, worldState };

  let records = worldState.entityStore.records;
  for (const mutation of mutations) {
    const applied = applyOne(records, mutation);
    if (applied.ok === false) {
      return {
        ok: false,
        code: applied.code,
        ...(applied.entityId === undefined ? {} : { entityId: applied.entityId }),
      };
    }
    records = applied.records;
  }

  let entityStore;
  try {
    entityStore = createEntityStore(records);
  } catch (error) {
    if (error instanceof EntityStoreInvariantError && error.code === "duplicate_entity_id") {
      return { ok: false, code: "duplicate_entity_id", ...(error.entityId === undefined ? {} : { entityId: error.entityId }) };
    }
    return {
      ok: false,
      code: "structure_invalid",
      ...(!(error instanceof EntityStoreInvariantError) || error.entityId === undefined ? {} : { entityId: error.entityId }),
    };
  }
  const [referenceIssue] = validateEntityReferences(entityStore);
  if (referenceIssue !== undefined) return { ok: false, code: "invalid_reference", entityId: referenceIssue.entityId };

  return { ok: true, worldState: { ...worldState, entityStore, ...projectEntityStore(entityStore) } };
}
