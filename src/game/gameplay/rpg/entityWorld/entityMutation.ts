import {
  EntityStoreInvariantError,
  createEntityStore,
  projectEntityStore,
  validateEntityReferences,
  type EntityRecord,
  type ItemEntityRecord,
  type LocationComponent,
  type NpcDynamicStateComponent,
  type NpcEntityRecord,
  type NpcHistoryComponent,
  type NpcKnowledgeComponent,
  type NpcRelationshipComponent,
  type PossessionComponent,
  type RelationshipSignal,
  type RelationshipSource,
} from "@/game/domain/entity";
import type { WorldState } from "@/game/domain/worldState";
import { PLAYER_ENTITY_ID, type EnemyId, type FactId, type ItemId, type LocationId, type NpcId, type QuestId } from "@/game/domain/worldEntity";
import {
  applyRelationshipCommitment,
  applyRelationshipSignalToComponent,
  findRelationshipEdge,
  upsertRelationshipEdge,
  type RelationshipCommitmentOperation,
  type RelationshipPolicyErrorCode,
  type RelationshipTargetId,
} from "@/game/gameplay/rpg/npcMemory";

/**
 * 过渡桥载荷：四个分层组件的 exact-key 集合，由 domain 的 compileLegacyNpcSync 产出。
 * 桥不携带 identity/anchors/position/core，也永远不携带 legacy memory 本体。
 */
export type NpcLegacySyncLayers = Readonly<{
  dynamicState: NpcDynamicStateComponent;
  knowledge: NpcKnowledgeComponent;
  relationships: NpcRelationshipComponent;
  history: NpcHistoryComponent;
}>;

/**
 * 关系写入声明的来源：**直接沿用 domain 的判别联合**（npcComponents.ts 的 `RelationshipSource`），
 * 本层不再手抄任何一支——domain 新增第三支时这里不可能悄悄漂移。
 * 但「类型里有这一支」不等于「本通道能用这一支」：本层只放行 `action` 一支，
 * `initial_world` 在 checkRelationshipSource 里一律以 invalid_relationship_source 拒掉。
 * 原因是 3A 规则层建边与铸承诺 ID 都固定按 action 起源写（`applyRelationshipSignal` 内
 * origin = { kind: "action", … }），所以背景种子关系只能在 Task 6 的规则层入口里落
 * initial_world；在本层放行会静默把「创建期背景」伪造成「某次行动」。
 * 这一支保留在类型里是刻意的：形状由 domain 定权，Task 6 只需补能力、不必改载荷。
 */
export type RelationshipMutationSource = RelationshipSource;

/** 规则层唯一允许的实体写入语言；AI 输入不使用此联合。 */
export type EntityMutation =
  | { readonly kind: "move_player"; readonly toLocationId: LocationId; readonly markVisited: true }
  | { readonly kind: "move_npc"; readonly npcId: NpcId; readonly toLocationId: LocationId }
  | { readonly kind: "set_location_unlocked"; readonly locationId: LocationId; readonly unlocked: boolean }
  | { readonly kind: "set_location_visited"; readonly locationId: LocationId; readonly visited: boolean }
  | { readonly kind: "sync_npc_legacy_memory"; readonly npcId: NpcId; readonly npc: NpcLegacySyncLayers }
  /**
   * 关系信号：一支 mutation 只提交一个 signal（同行动内的提交顺序由批次数组顺序决定，
   * 规则层的同行动累计预算对该顺序敏感，见 npcMemory 文件头 (b)/(c)）。
   * 载荷里没有数值 delta、没有 stage、没有 trend、没有证据对象：那些全由规则表决定。
   */
  | { readonly kind: "apply_relationship_signal"; readonly fromNpcId: NpcId; readonly targetId: RelationshipTargetId; readonly signal: RelationshipSignal; readonly source: RelationshipMutationSource }
  /** 承诺操作：只接受封闭六类操作名，且不建边（目标边必须已存在）。 */
  | { readonly kind: "apply_relationship_commitment"; readonly fromNpcId: NpcId; readonly targetId: RelationshipTargetId; readonly operation: RelationshipCommitmentOperation; readonly source: RelationshipMutationSource }
  | { readonly kind: "transfer_item"; readonly itemId: ItemId; readonly owner: PossessionComponent["owner"] }
  | { readonly kind: "discover_fact"; readonly factId: FactId }
  | { readonly kind: "set_quest_status"; readonly questId: QuestId; readonly status: "locked" | "active" | "completed" | "failed" | "closed" }
  | { readonly kind: "set_enemy_defeated"; readonly enemyId: EnemyId; readonly defeated: boolean }
  | { readonly kind: "set_npc_lifecycle"; readonly npcId: NpcId; readonly lifecycle: "active" | "inactive" }
  | { readonly kind: "replace_location_component"; readonly locationId: LocationId; readonly location: LocationComponent }
  | { readonly kind: "create_entities"; readonly records: readonly EntityRecord[] };

type Expect<T extends true> = T;
type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * 关系载荷的键集合封闭锁：谁想「顺手」在 mutation 上多带一个数值 / stage / 证据字段，
 * 先在 typecheck 失败，而不是悄悄开出第二条关系写入通道。
 */
export type RelationshipSignalPayloadKeysLock = Expect<IsExactly<
  keyof Extract<EntityMutation, { readonly kind: "apply_relationship_signal" }>,
  "kind" | "fromNpcId" | "targetId" | "signal" | "source"
>>;
export type RelationshipCommitmentPayloadKeysLock = Expect<IsExactly<
  keyof Extract<EntityMutation, { readonly kind: "apply_relationship_commitment" }>,
  "kind" | "fromNpcId" | "targetId" | "operation" | "source"
>>;

export type EntityMutationErrorCode =
  | "unknown_entity_id"
  | "duplicate_entity_id"
  | "wrong_entity_kind"
  | "invalid_reference"
  | "invalid_lifecycle_transition"
  | "structure_invalid"
  // 关系 mutation 专用：与 RelationshipPolicyErrorCode 一一映射，逐个可判别，绝不折叠成消息字符串。
  | "relationship_self_edge"
  // 本通道不可达（store 禁止同一 targetId 两条边，组件入口按 targetId 取边）：留着只为映射表穷尽性，没有对应用例。
  | "relationship_edge_mismatch"
  | "invalid_relationship_signal"
  | "invalid_relationship_source"
  | "invalid_relationship_turn"
  | "invalid_commitment_operation"
  | "unknown_relationship_commitment"
  | "illegal_relationship_commitment_transition";

/**
 * 规则层封闭错误码 → 本层错误码：`satisfies` 锁住覆盖性，
 * domain/规则层新增一个 code 而本表漏一行时直接编译失败（不存在吞掉错误的默认分支）。
 */
const RELATIONSHIP_POLICY_ERROR_CODES: Readonly<Record<RelationshipPolicyErrorCode, EntityMutationErrorCode>> = {
  self_edge_rejected: "relationship_self_edge",
  edge_target_mismatch: "relationship_edge_mismatch",
  invalid_signal: "invalid_relationship_signal",
  invalid_action_source: "invalid_relationship_source",
  invalid_turn_number: "invalid_relationship_turn",
  invalid_commitment_operation: "invalid_commitment_operation",
  unknown_commitment: "unknown_relationship_commitment",
  illegal_commitment_transition: "illegal_relationship_commitment_transition",
} as const satisfies Record<RelationshipPolicyErrorCode, EntityMutationErrorCode>;

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

// ---------------------------------------------------------------------------
// 关系 mutation 的边界校验（Task 3B）
// ---------------------------------------------------------------------------

type RelationshipSourceCheck =
  | { readonly ok: true; readonly actionId: string; readonly turnNumber: number }
  | { readonly ok: false; readonly code: EntityMutationErrorCode };

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * 来源判别式校验：本层只放行 `action` 一支，并要求 actionId 非空白、turnNumber 为非负整数。
 * 「actionId 指向真实已提交行动」这件事本层无法自查——WorldState 里没有行动账本
 * （eventLedger 的 GameEvent 不携带 actionId），所以调用方必须传服务端已铸造的那个 ID。
 * initial_world 的拒绝理由见 RelationshipMutationSource。
 */
function checkRelationshipSource(declared: RelationshipMutationSource): RelationshipSourceCheck {
  if (typeof declared !== "object" || declared === null) return { ok: false, code: "invalid_relationship_source" };
  if (declared.kind !== "action") return { ok: false, code: "invalid_relationship_source" };
  const { actionId, turnNumber } = declared;
  // 下面两条形状检查与规则层 checkActionSource（relationshipSignalPolicy.ts:478-482）刻意重复：
  // 本层要在任何写入之前失败，且 code 比 store 级 structure_invalid 精确得多。
  if (isBlank(actionId)) return { ok: false, code: "invalid_relationship_source" };
  if (typeof turnNumber !== "number" || !Number.isInteger(turnNumber) || turnNumber < 0) {
    return { ok: false, code: "invalid_relationship_turn" };
  }
  return { ok: true, actionId, turnNumber };
}

type RelationshipParties =
  | { readonly ok: true; readonly npc: NpcEntityRecord }
  | { readonly ok: false; readonly code: EntityMutationErrorCode; readonly entityId: string };

/**
 * 关系两端的存在性与类型：来源必须是 NPC，目标只能是 NPC 或玩家本体——
 * 地点 / 物品 / 敌人 / 任务都拿不到 wrong_entity_kind 之外的通道，非活跃与已结算实体一律不能当任一方。
 */
function relationshipParties(
  records: readonly EntityRecord[],
  fromNpcId: NpcId,
  targetId: RelationshipTargetId,
): RelationshipParties {
  const npc = recordOfKind(records, fromNpcId, "npc");
  if (!npc.ok) return npc;
  const target = targetId === PLAYER_ENTITY_ID
    ? recordOfKind(records, PLAYER_ENTITY_ID, "player_character")
    : recordOfKind(records, targetId, "npc");
  if (!target.ok) return target;
  if (npc.record.core.lifecycle !== "active") {
    return { ok: false, code: "invalid_lifecycle_transition", entityId: fromNpcId };
  }
  if (target.record.core.lifecycle !== "active") {
    return { ok: false, code: "invalid_lifecycle_transition", entityId: targetId };
  }
  return { ok: true, npc: npc.record };
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
    case "sync_npc_legacy_memory": {
      const npc = recordOfKind(records, mutation.npcId, "npc");
      if (!npc.ok) return npc;
      const { dynamicState, knowledge, relationships, history } = mutation.npc;
      // 逐键写入而非展开载荷：桥只覆盖四个分层组件，core/identity/position 不在其权限内。
      return {
        ok: true,
        records: replaceRecord(records, mutation.npcId, {
          ...npc.record,
          dynamicState,
          knowledge,
          relationships,
          history,
        }),
      };
    }
    case "apply_relationship_signal": {
      // 边界校验在前，数值/stage/trend/证据/承诺一律交回规则层：本分支一个数字都不重算。
      const parties = relationshipParties(records, mutation.fromNpcId, mutation.targetId);
      if (!parties.ok) return failure(parties.code, parties.entityId);
      if (mutation.fromNpcId === mutation.targetId) return failure("relationship_self_edge", mutation.fromNpcId);
      const checkedSource = checkRelationshipSource(mutation.source);
      if (!checkedSource.ok) return failure(checkedSource.code, mutation.fromNpcId);
      const applied = applyRelationshipSignalToComponent({
        relationships: parties.npc.relationships,
        fromNpcId: mutation.fromNpcId,
        targetId: mutation.targetId,
        signal: mutation.signal,
        actionId: checkedSource.actionId,
        turnNumber: checkedSource.turnNumber,
      });
      // applied.code 是规则层自己的封闭字面量 union（不是调用方数据），所以裸下标即可：
      // 表覆盖性由上面的 satisfies 锁定，漏一行在 typecheck 就失败，不会落回 undefined。
      if (!applied.ok) return failure(RELATIONSHIP_POLICY_ERROR_CODES[applied.code], mutation.fromNpcId);
      // changed:false 是同行动重放的幂等结果：零写入，但不是失败。
      if (!applied.changed) return { ok: true, records };
      // 只替换 relationships 一个组件：其余组件按引用继承，兼容 memory 由 projector 重建。
      return {
        ok: true,
        records: replaceRecord(records, mutation.fromNpcId, {
          ...parties.npc,
          relationships: applied.relationships,
        }),
      };
    }
    case "apply_relationship_commitment": {
      const parties = relationshipParties(records, mutation.fromNpcId, mutation.targetId);
      if (!parties.ok) return failure(parties.code, parties.entityId);
      if (mutation.fromNpcId === mutation.targetId) return failure("relationship_self_edge", mutation.fromNpcId);
      const checkedSource = checkRelationshipSource(mutation.source);
      if (!checkedSource.ok) return failure(checkedSource.code, mutation.fromNpcId);
      // 承诺不建边：没有边就是引用了不存在的东西，与「未知 commitmentId」是两类错误。
      const edge = findRelationshipEdge(parties.npc.relationships, mutation.targetId);
      if (edge === undefined) return failure("invalid_reference", mutation.targetId);
      const applied = applyRelationshipCommitment({
        edge,
        operation: mutation.operation,
        actionId: checkedSource.actionId,
        turnNumber: checkedSource.turnNumber,
      });
      if (!applied.ok) return failure(RELATIONSHIP_POLICY_ERROR_CODES[applied.code], mutation.fromNpcId);
      if (!applied.changed) return { ok: true, records };
      return {
        ok: true,
        records: replaceRecord(records, mutation.fromNpcId, {
          ...parties.npc,
          // 写回仍经 upsert：targetId 顺序由 domain 比较器裁决，本层不手抄排序规则。
          relationships: { outgoing: upsertRelationshipEdge(parties.npc.relationships.outgoing, applied.edge) },
        }),
      };
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
