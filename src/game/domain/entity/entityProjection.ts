import { PLAYER_ENTITY_ID, asFactionId } from "../worldEntity";
import type { EnemyId, ItemId, LocationId, NpcId } from "../worldEntity";
import type {
  EnemyEntry, FactionEntry, ItemEntry, LocationEntry, NpcEntry, PlayerState, QuestEntry,
  QuestObjective, WorldFactEntry,
} from "../worldEntries";
import type { EntityCore, EntityId, EntityKind, EntityLifecycle } from "./entityCore";
import type { ItemOwner, PositionComponent, PossessionComponent } from "./entityComponents";
import type {
  EnemyEntityRecord, EntityRecord, FactionEntityRecord, FactEntityRecord, ItemEntityRecord,
  LocationEntityRecord, NpcEntityRecord, PlayerEntityRecord, QuestEntityRecord,
} from "./entityRecord";
import { createEntityStore, entitiesOfKind, type EntityStore } from "./entityStore";
import { normalizeLegacyNpcEntry, projectNpcEntry } from "./npcProjection";
import type { NpcImportedLayers } from "./npcProjection";
import { parseStoryInteraction } from "../storyInteraction";
import {
  validateNpcDynamicState,
  validateNpcHistory,
  validateNpcIdentityAnchors,
  validateNpcKnowledge,
  validateNpcRelationships,
} from "./npcComponents";

// ---------------------------------------------------------------------------
// Entity Store ↔ legacy WorldState 兼容投影：两套形状之间唯一的编译/投影通道。
// store 是唯一事实来源；projection 只是旧读取路径的派生视图。
// projection 无法表达的字段（createdAtTurn / lifecycle / inactive NPC 顺序 /
// npc|none 归属）一律从 previousStore 继承，绝不静默归零。
// ---------------------------------------------------------------------------

export type EntityCompatibilityProjection = Readonly<{
  player: PlayerState;
  locations: readonly LocationEntry[];
  currentLocationId: LocationId;
  unlockedLocationIds: readonly LocationId[];
  visitedLocationIds: readonly LocationId[];
  npcs: readonly NpcEntry[];
  items: readonly ItemEntry[];
  inventory: readonly ItemId[];
  worldFacts: readonly WorldFactEntry[];
  quests: readonly QuestEntry[];
  enemies: readonly EnemyEntry[];
  defeatedEnemyIds: readonly EnemyId[];
  factions: readonly FactionEntry[];
}>;

export type EntityReferenceIssueCode =
  | "unknown_location_ref"
  | "self_connection"
  | "asymmetric_connection"
  | "unknown_item_owner_ref"
  | "unknown_quest_objective_ref"
  | "unknown_npc_fact_ref"
  | "unknown_confidentiality_ref"
  | "unknown_player_location"
  | "unknown_town_npc_ref"
  | "town_npc_location_mismatch"
  | "duplicate_location_order"
  | "duplicate_owner_order";

export type EntityReferenceIssue = Readonly<{
  code: EntityReferenceIssueCode;
  entityId: string;
  referencedId?: string;
}>;

export type EntityProjectionIssue = Readonly<{
  code:
    | "projection_mismatch"
    | "npc_multiple_locations"
    | "npc_membership_mismatch"
    | "item_multiple_owners"
    | "npc_creation_components_required"
    | "npc_creation_components_invalid";
  field: string;
  entityId?: string;
}>;

/** 稳定失败：只带 code/entityId，绝不携带 issue 列表或投影副本。 */
export class EntityProjectionInvariantError extends Error {
  readonly code: EntityProjectionIssue["code"] | EntityReferenceIssueCode;
  readonly entityId?: string;

  constructor(issue: EntityProjectionIssue | EntityReferenceIssue) {
    super(`entity compatibility projection invariant violated: ${issue.code}`);
    this.name = "EntityProjectionInvariantError";
    this.code = issue.code;
    this.entityId = issue.entityId;
  }
}

// ---------------------------------------------------------------------------
// 形状/比较原语
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深比较：undefined 值键与缺键等价（legacy 条目大量使用可选字段）。 */
function sameStructure(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => sameStructure(entry, b[index]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!sameStructure(a[key], b[key])) return false;
  }
  return true;
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** 容器成员按 order 还原：容器键 → 有序 ID 列表；顺序即玩家可见顺序。 */
function orderedMembers<Key extends string, Id extends string>(
  members: readonly (readonly [Key, Id, number])[],
): Map<Key, readonly Id[]> {
  const groups = new Map<Key, { id: Id; order: number }[]>();
  for (const [key, id, order] of members) {
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [{ id, order }]);
    else list.push({ id, order });
  }
  const ordered = new Map<Key, readonly Id[]>();
  for (const [key, list] of groups) {
    ordered.set(key, [...list].sort((left, right) => left.order - right.order).map((member) => member.id));
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// store → projection
// ---------------------------------------------------------------------------

function locationEntryOf(
  record: LocationEntityRecord,
  npcIds: readonly NpcId[],
  availableItemIds: readonly ItemId[],
): LocationEntry {
  const { location } = record;
  return {
    id: record.core.id,
    name: record.core.name,
    description: location.description,
    kind: location.kind,
    connectedLocationIds: [...location.connectedLocationIds],
    npcIds,
    availableItemIds,
    tags: [...location.tags],
    ...(location.scale === undefined ? {} : { scale: location.scale }),
    ...(location.town === undefined ? {} : { town: location.town }),
  };
}

function itemEntryOf(record: ItemEntityRecord): ItemEntry {
  const { presentation } = record;
  return {
    id: record.core.id,
    name: record.core.name,
    description: presentation.description,
    kind: presentation.kind,
    tags: [...presentation.tags],
    ...(presentation.category === undefined ? {} : { category: presentation.category }),
    ...(presentation.rarity === undefined ? {} : { rarity: presentation.rarity }),
    ...(presentation.level === undefined ? {} : { level: presentation.level }),
    ...(presentation.statLines === undefined ? {} : { statLines: presentation.statLines }),
  };
}

function enemyEntryOf(record: EnemyEntityRecord): EnemyEntry {
  return {
    id: record.core.id,
    name: record.core.name,
    tier: record.enemy.tier,
    stats: { ...record.enemy.stats },
    locationId: record.position.locationId,
    tags: [...record.enemy.tags],
  };
}

function questEntryOf(record: QuestEntityRecord): QuestEntry {
  const { quest } = record;
  return {
    id: record.core.id,
    name: record.core.name,
    description: quest.description,
    objectives: quest.objectives,
    onSuccess: quest.onSuccess,
    onFailure: quest.onFailure,
    tags: [...quest.tags],
    kind: quest.kind,
    ...(quest.stage === undefined ? {} : { stage: quest.stage }),
    status: quest.status,
  };
}

function factEntryOf(record: FactEntityRecord): WorldFactEntry {
  const { fact } = record;
  return {
    factId: record.core.id,
    text: fact.text,
    source: fact.source,
    discovered: fact.discovered,
    ...(fact.locationId === undefined ? {} : { locationId: fact.locationId }),
    ...(fact.investigationLabel === undefined ? {} : { investigationLabel: fact.investigationLabel }),
    ...(fact.investigationApproaches === undefined
      ? {}
      : { investigationApproaches: fact.investigationApproaches }),
  };
}

function factionEntryOf(record: FactionEntityRecord): FactionEntry {
  return {
    factionId: record.core.id,
    name: record.core.name,
    attitudeToPlayer: record.faction.attitudeToPlayer,
  };
}

export function projectEntityStore(store: EntityStore): EntityCompatibilityProjection {
  // 前置条件：store 已过 structure/reference 校验（每局恰有一名玩家）。
  const player = entitiesOfKind(store, "player_character")[0];
  const locationRecords = entitiesOfKind(store, "location");
  const npcRecords = entitiesOfKind(store, "npc");
  const itemRecords = entitiesOfKind(store, "item");
  const enemyRecords = entitiesOfKind(store, "enemy");

  const npcIdsByLocation = orderedMembers(
    npcRecords
      .filter((record) => record.core.lifecycle === "active")
      .map((record) => [record.position.locationId, record.core.id, record.position.locationOrder] as const),
  );
  const availableItemIdsByLocation = orderedMembers(
    itemRecords.flatMap((record) => {
      const { owner } = record.possession;
      return owner.kind === "location"
        ? [[owner.locationId, record.core.id, record.possession.ownerOrder] as const]
        : [];
    }),
  );
  const inventory = itemRecords
    .filter((record) => record.possession.owner.kind === "player")
    .sort((left, right) => left.possession.ownerOrder - right.possession.ownerOrder)
    .map((record) => record.core.id);

  return {
    player: { name: player.core.name, identity: player.identity.identity, stats: { ...player.identity.stats } },
    locations: locationRecords.map((record) => locationEntryOf(
      record,
      npcIdsByLocation.get(record.core.id) ?? [],
      availableItemIdsByLocation.get(record.core.id) ?? [],
    )),
    currentLocationId: player.position.locationId,
    unlockedLocationIds: locationRecords
      .filter((record) => record.location.unlocked)
      .map((record) => record.core.id),
    visitedLocationIds: locationRecords
      .filter((record) => record.location.visited)
      .map((record) => record.core.id),
    npcs: npcRecords.map(projectNpcEntry),
    items: itemRecords.map(itemEntryOf),
    inventory,
    worldFacts: entitiesOfKind(store, "fact").map(factEntryOf),
    quests: entitiesOfKind(store, "quest").map(questEntryOf),
    enemies: enemyRecords.map(enemyEntryOf),
    defeatedEnemyIds: enemyRecords.filter((record) => record.enemy.defeated).map((record) => record.core.id),
    factions: entitiesOfKind(store, "faction").map(factionEntryOf),
  };
}

// ---------------------------------------------------------------------------
// projection → store
// ---------------------------------------------------------------------------

type KindRecord<K extends EntityKind> = Extract<EntityRecord, { core: { kind: K } }>;

/**
 * previousStore 的类型化索引：嵌套判别式（record.core.kind）不会收窄 record 联合，
 * 因此按 kind 一次建索引，组件字段直接以强类型读取。
 */
function previousOfKind<K extends EntityKind>(
  store: EntityStore | undefined,
  kind: K,
): ReadonlyMap<string, KindRecord<K>> {
  const records = store === undefined ? [] : entitiesOfKind(store, kind);
  return new Map(records.map((record) => [record.core.id, record] as const));
}

function validNpcCreationComponents(value: unknown): value is NpcImportedLayers {
  if (!isRecord(value)) return false;
  const keys = ["anchors", "dynamicState", "knowledge", "relationships", "history"];
  const allowed = new Set([...keys, "interactions"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || keys.some((key) => !(key in value))) return false;
  return validateNpcIdentityAnchors(value.anchors).length === 0
    && validateNpcDynamicState(value.dynamicState).length === 0
    && validateNpcKnowledge(value.knowledge).length === 0
    && validateNpcRelationships(value.relationships).length === 0
    && validateNpcHistory(value.history).length === 0
    && (!('interactions' in value) || (Array.isArray(value.interactions) && value.interactions.every((entry) => parseStoryInteraction(entry).ok)));
}

function coreOf<Id extends EntityId, Kind extends EntityKind>(input: {
  readonly id: Id;
  readonly kind: Kind;
  readonly name: string;
  readonly lifecycle: EntityLifecycle;
  readonly createdAtTurn: number;
}): EntityCore<Id, Kind> {
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    lifecycle: input.lifecycle,
    createdAtTurn: input.createdAtTurn,
  };
}

function turnOf(previous: EntityRecord | undefined, createdAtTurn: number): number {
  return previous?.core.createdAtTurn ?? createdAtTurn;
}

/** lifecycle 无法由 legacy 条目表达时，只能继承 previousStore；全新实体为 active。 */
function retainedLifecycle(previous: EntityRecord | undefined): EntityLifecycle {
  return previous?.core.lifecycle ?? "active";
}

function questLifecycleOf(status: QuestEntry["status"]): EntityLifecycle {
  if (status === "locked") return "inactive";
  if (status === "active") return "active";
  return "resolved";
}

function enemyLifecycleOf(defeated: boolean): EntityLifecycle {
  return defeated ? "resolved" : "active";
}

function rosterOccurrences(
  projection: EntityCompatibilityProjection,
): Map<NpcId, { readonly locationId: LocationId; readonly order: number }[]> {
  const occurrences = new Map<NpcId, { locationId: LocationId; order: number }[]>();
  for (const location of projection.locations) {
    location.npcIds.forEach((npcId, order) => {
      const list = occurrences.get(npcId);
      if (list === undefined) occurrences.set(npcId, [{ locationId: location.id, order }]);
      else list.push({ locationId: location.id, order });
    });
  }
  return occurrences;
}

/**
 * 玩家可见容器的索引 → owner 事实：inventory 与每个 availableItemIds 各占一段顺序。
 * items 才是实体清单：容器里出现但缺少 ItemEntry 的 ID 不会补出 record，
 * 该投影无法被表示，只能由 validateEntityCompatibilityProjection 报 mismatch。
 */
function containerOwnership(
  projection: EntityCompatibilityProjection,
): Map<ItemId, { readonly owner: ItemOwner; readonly ownerOrder: number }> {
  const owners = new Map<ItemId, { owner: ItemOwner; ownerOrder: number }>();
  projection.inventory.forEach((itemId, ownerOrder) => {
    owners.set(itemId, { owner: { kind: "player", playerId: PLAYER_ENTITY_ID }, ownerOrder });
  });
  for (const location of projection.locations) {
    location.availableItemIds.forEach((itemId, ownerOrder) => {
      owners.set(itemId, { owner: { kind: "location", locationId: location.id }, ownerOrder });
    });
  }
  return owners;
}

function compilePlayer(
  projection: EntityCompatibilityProjection,
  createdAtTurn: number,
  previousStore: EntityStore | undefined,
): PlayerEntityRecord {
  const previous = previousOfKind(previousStore, "player_character").get(PLAYER_ENTITY_ID);
  return {
    core: coreOf({
      id: PLAYER_ENTITY_ID,
      kind: "player_character",
      name: projection.player.name,
      lifecycle: retainedLifecycle(previous),
      createdAtTurn: turnOf(previous, createdAtTurn),
    }),
    identity: { identity: projection.player.identity, stats: { ...projection.player.stats } },
    knowledge: {
      knownFactIds: projection.worldFacts.filter((fact) => fact.discovered).map((fact) => fact.factId),
    },
    position: { locationId: projection.currentLocationId, locationOrder: 0 },
  };
}

function compileLocations(
  projection: EntityCompatibilityProjection,
  createdAtTurn: number,
  previousStore: EntityStore | undefined,
): readonly LocationEntityRecord[] {
  const unlocked = new Set(projection.unlockedLocationIds);
  const visited = new Set(projection.visitedLocationIds);
  const previousRecords = previousOfKind(previousStore, "location");
  return projection.locations.map((entry) => {
    const previous = previousRecords.get(entry.id);
    return {
      core: coreOf({
        id: entry.id,
        kind: "location",
        name: entry.name,
        lifecycle: retainedLifecycle(previous),
        createdAtTurn: turnOf(previous, createdAtTurn),
      }),
      location: {
        description: entry.description,
        kind: entry.kind,
        ...(entry.scale === undefined ? {} : { scale: entry.scale }),
        connectedLocationIds: [...entry.connectedLocationIds],
        tags: [...entry.tags],
        ...(entry.town === undefined ? {} : { town: entry.town }),
        unlocked: unlocked.has(entry.id),
        visited: visited.has(entry.id),
      },
    };
  });
}

function compileNpcs(
  projection: EntityCompatibilityProjection,
  createdAtTurn: number,
  previousStore: EntityStore | undefined,
  npcCreationComponentsById: ReadonlyMap<NpcId, NpcImportedLayers> | undefined,
): readonly NpcEntityRecord[] {
  const occurrences = rosterOccurrences(projection);
  const previousRecords = previousOfKind(previousStore, "npc");
  // 未出现在任何名册的 NPC（inactive 或旧 fixture 缺名册）挂到自身地点末尾。
  const nextFreeOrder = new Map<LocationId, number>(
    projection.locations.map((entry) => [entry.id, entry.npcIds.length] as const),
  );
  return projection.npcs.map((entry) => {
    const previous = previousRecords.get(entry.id);
    const listed = occurrences.get(entry.id)?.[0];
    let position: PositionComponent;
    if (listed !== undefined) {
      position = { locationId: listed.locationId, locationOrder: listed.order };
    } else if (previous !== undefined) {
      position = { locationId: entry.locationId, locationOrder: previous.position.locationOrder };
    } else {
      const order = nextFreeOrder.get(entry.locationId) ?? 0;
      nextFreeOrder.set(entry.locationId, order + 1);
      position = { locationId: entry.locationId, locationOrder: order };
    }
    const layers = previous === undefined
      ? npcCreationComponentsById?.get(entry.id)
      : undefined;
    if (previous === undefined && layers === undefined) {
      throw new EntityProjectionInvariantError({
        code: "npc_creation_components_required",
        field: "npcCreationComponentsById",
        entityId: entry.id,
      });
    }
    if (previous === undefined && !validNpcCreationComponents(layers)) {
      throw new EntityProjectionInvariantError({
        code: "npc_creation_components_invalid",
        field: "npcCreationComponentsById",
        entityId: entry.id,
      });
    }
    return {
      core: coreOf({
        id: entry.id,
        kind: "npc",
        name: entry.name,
        lifecycle: retainedLifecycle(previous),
        createdAtTurn: turnOf(previous, createdAtTurn),
      }),
      identity: previous?.identity ?? {
        role: entry.role,
        description: entry.description,
        tags: [...entry.tags],
        anchors: layers!.anchors,
      },
      position,
      dynamicState: previous?.dynamicState ?? layers!.dynamicState,
      knowledge: previous?.knowledge ?? layers!.knowledge,
      relationships: previous?.relationships ?? layers!.relationships,
      history: previous?.history ?? layers!.history,
      ...(previous?.interactions === undefined && layers?.interactions === undefined
        ? {}
        : { interactions: [...(previous?.interactions ?? layers?.interactions ?? [])] }),
    };
  });
}

function compileItems(
  projection: EntityCompatibilityProjection,
  createdAtTurn: number,
  previousStore: EntityStore | undefined,
): readonly ItemEntityRecord[] {
  const containers = containerOwnership(projection);
  const previousRecords = previousOfKind(previousStore, "item");
  const compiled = projection.items.map((entry) => {
    const previous = previousRecords.get(entry.id);
    const previousPossession = previous?.possession;
    const container = containers.get(entry.id);
    // legacy 容器无法表达 npc|none owner：只有这两种 previous owner 可以继承。
    // player/location owner 一旦从对应容器移除，就必须变为 none，不能静默保留旧归属。
    const retainedHiddenPossession = previousPossession?.owner.kind === "npc"
      || previousPossession?.owner.kind === "none"
      ? previousPossession
      : undefined;
    const possession: PossessionComponent = container === undefined
      ? (retainedHiddenPossession ?? { owner: { kind: "none" }, quantity: 1, ownerOrder: 0 })
      : { owner: container.owner, quantity: 1, ownerOrder: container.ownerOrder };
    return {
      core: coreOf({
        id: entry.id,
        kind: "item",
        name: entry.name,
        lifecycle: retainedLifecycle(previous),
        createdAtTurn: turnOf(previous, createdAtTurn),
      }),
      presentation: {
        description: entry.description,
        kind: entry.kind,
        tags: [...entry.tags],
        ...(entry.category === undefined ? {} : { category: entry.category }),
        ...(entry.rarity === undefined ? {} : { rarity: entry.rarity }),
        ...(entry.level === undefined ? {} : { level: entry.level }),
        ...(entry.statLines === undefined ? {} : { statLines: entry.statLines }),
      },
      possession,
    };
  });
  return compiled;
}

function compileEnemies(
  projection: EntityCompatibilityProjection,
  createdAtTurn: number,
  previousStore: EntityStore | undefined,
): readonly EnemyEntityRecord[] {
  const defeated = new Set(projection.defeatedEnemyIds);
  const previousRecords = previousOfKind(previousStore, "enemy");
  return projection.enemies.map((entry) => {
    const previous = previousRecords.get(entry.id);
    const isDefeated = defeated.has(entry.id);
    return {
      core: coreOf({
        id: entry.id,
        kind: "enemy",
        name: entry.name,
        lifecycle: enemyLifecycleOf(isDefeated),
        createdAtTurn: turnOf(previous, createdAtTurn),
      }),
      enemy: { tier: entry.tier, stats: { ...entry.stats }, tags: [...entry.tags], defeated: isDefeated },
      position: {
        locationId: entry.locationId,
        locationOrder: previous?.position.locationOrder ?? 0,
      },
    };
  });
}

function compileQuests(
  projection: EntityCompatibilityProjection,
  createdAtTurn: number,
  previousStore: EntityStore | undefined,
): readonly QuestEntityRecord[] {
  const previousRecords = previousOfKind(previousStore, "quest");
  return projection.quests.map((entry) => {
    const previous = previousRecords.get(entry.id);
    return {
      core: coreOf({
        id: entry.id,
        kind: "quest",
        name: entry.name,
        lifecycle: questLifecycleOf(entry.status),
        createdAtTurn: turnOf(previous, createdAtTurn),
      }),
      quest: {
        description: entry.description,
        objectives: entry.objectives,
        onSuccess: entry.onSuccess,
        onFailure: entry.onFailure,
        tags: [...entry.tags],
        kind: entry.kind,
        ...(entry.stage === undefined ? {} : { stage: entry.stage }),
        status: entry.status,
      },
    };
  });
}

function compileFacts(
  projection: EntityCompatibilityProjection,
  createdAtTurn: number,
  previousStore: EntityStore | undefined,
): readonly FactEntityRecord[] {
  const previousRecords = previousOfKind(previousStore, "fact");
  return projection.worldFacts.map((entry) => {
    const previous = previousRecords.get(entry.factId);
    return {
      core: coreOf({
        id: entry.factId,
        kind: "fact",
        // core.name 是列表展示用的安全名，绝不复制事实正文。
        name: `fact:${entry.factId}`,
        lifecycle: retainedLifecycle(previous),
        createdAtTurn: turnOf(previous, createdAtTurn),
      }),
      fact: {
        text: entry.text,
        source: entry.source,
        discovered: entry.discovered,
        ...(entry.locationId === undefined ? {} : { locationId: entry.locationId }),
        ...(entry.investigationLabel === undefined ? {} : { investigationLabel: entry.investigationLabel }),
        ...(entry.investigationApproaches === undefined
          ? {}
          : { investigationApproaches: entry.investigationApproaches }),
      },
    };
  });
}

function compileFactions(
  projection: EntityCompatibilityProjection,
  createdAtTurn: number,
  previousStore: EntityStore | undefined,
): readonly FactionEntityRecord[] {
  const previousRecords = previousOfKind(previousStore, "faction");
  return projection.factions.map((entry) => {
    const id = asFactionId(entry.factionId);
    const previous = previousRecords.get(id);
    return {
      core: coreOf({
        id,
        kind: "faction",
        name: entry.name,
        lifecycle: retainedLifecycle(previous),
        createdAtTurn: turnOf(previous, createdAtTurn),
      }),
      faction: { attitudeToPlayer: entry.attitudeToPlayer },
    };
  });
}

function throwOnFirstIssue(
  issues: readonly (EntityProjectionIssue | EntityReferenceIssue)[],
): void {
  if (issues.length > 0) throw new EntityProjectionInvariantError(issues[0]);
}

export function compileEntityStoreFromCompatibilityProjection(input: {
  projection: EntityCompatibilityProjection;
  createdAtTurn: number;
  previousStore?: EntityStore;
  npcCreationComponentsById?: ReadonlyMap<NpcId, NpcImportedLayers>;
}): EntityStore {
  const { projection, createdAtTurn, previousStore, npcCreationComponentsById } = input;
  // 歧义输入绝不在编译时“选一个”消解：先拒非法成员关系，再建立 store。
  throwOnFirstIssue(validateCompatibilityProjectionInput(projection));
  const compiledRecords = [
    compilePlayer(projection, createdAtTurn, previousStore),
    ...compileLocations(projection, createdAtTurn, previousStore),
    ...compileNpcs(projection, createdAtTurn, previousStore, npcCreationComponentsById),
    ...compileItems(projection, createdAtTurn, previousStore),
    ...compileEnemies(projection, createdAtTurn, previousStore),
    ...compileFactions(projection, createdAtTurn, previousStore),
    ...compileQuests(projection, createdAtTurn, previousStore),
    ...compileFacts(projection, createdAtTurn, previousStore),
  ];
  // aliases are scoped store data, not part of the legacy projection. Carry them
  // forward only for the same entity kind; a reused ID with a different kind
  // must not inherit an unrelated name claim.
  const aliasesById = new Map(
    previousStore?.records
      .filter((record) => record.core.aliases !== undefined)
      .map((record) => [record.core.id, record] as const) ?? [],
  );
  const store = createEntityStore(compiledRecords.map((record) => {
    const previous = aliasesById.get(record.core.id);
    if (previous === undefined || previous.core.kind !== record.core.kind || previous.core.aliases === undefined) return record;
    return { ...record, core: { ...record.core, aliases: [...previous.core.aliases] } } as EntityRecord;
  }));
  throwOnFirstIssue(validateEntityReferences(store));
  // 旧 fixture 允许只在 NpcEntry.locationId 表达位置、遗漏 location.npcIds；编译器
  // 将这一处兼容输入规范化为 roster。除此之外不得补齐、丢弃或重新挂载事实。
  const derived = projectEntityStore(store);
  const previousNpcIds = new Set(
    previousOfKind(previousStore, "npc").keys(),
  );
  const normalizedInput: EntityCompatibilityProjection = {
    ...projection,
    locations: projection.locations.map((location) => ({
      ...location,
      npcIds: derived.locations.find((entry) => entry.id === location.id)?.npcIds ?? location.npcIds,
    })),
    // 新模型里 hidden 只是知识条目的披露标签，"未知道的事实" 不可能对它隐藏；
    // 编译器按 known ∪ hidden 建条目，故输入侧做同一处保守归一。
    // Existing NPC component layers are authoritative.  Their legacy memory may
    // be stale or hand-edited, so only new NPCs are checked against the input
    // memory during the compatibility round-trip.
    npcs: projection.npcs.map((entry) => previousNpcIds.has(entry.id)
      ? derived.npcs.find((candidate) => candidate.id === entry.id) ?? normalizeLegacyNpcEntry(entry)
      : normalizeLegacyNpcEntry(entry)),
  };
  throwOnFirstIssue(validateEntityCompatibilityProjection(store, normalizedInput));
  return store;
}

// ---------------------------------------------------------------------------
// projection 层歧义校验
// ---------------------------------------------------------------------------

export function validateCompatibilityProjectionInput(
  projection: EntityCompatibilityProjection,
): readonly EntityProjectionIssue[] {
  const issues: EntityProjectionIssue[] = [];
  const occurrences = rosterOccurrences(projection);
  const knownNpcIds = new Set(projection.npcs.map((entry) => entry.id));
  for (const [npcId, list] of occurrences) {
    if (list.length > 1) {
      issues.push({ code: "npc_multiple_locations", field: "locations.npcIds", entityId: npcId });
    } else if (!knownNpcIds.has(npcId)) {
      issues.push({ code: "npc_membership_mismatch", field: "locations.npcIds", entityId: npcId });
    }
  }
  for (const entry of projection.npcs) {
    const [listed] = occurrences.get(entry.id) ?? [];
    if (listed !== undefined && listed.locationId !== entry.locationId) {
      issues.push({ code: "npc_membership_mismatch", field: "npcs.locationId", entityId: entry.id });
    }
  }
  const containerCounts = new Map<ItemId, number>();
  const countContainer = (itemId: ItemId): void => {
    containerCounts.set(itemId, (containerCounts.get(itemId) ?? 0) + 1);
  };
  projection.inventory.forEach(countContainer);
  for (const location of projection.locations) location.availableItemIds.forEach(countContainer);
  for (const [itemId, count] of containerCounts) {
    if (count > 1) {
      issues.push({ code: "item_multiple_owners", field: "inventory|locations.availableItemIds", entityId: itemId });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// store 层引用校验
// ---------------------------------------------------------------------------

type KnownEntityIds = Readonly<{
  locations: ReadonlySet<string>;
  npcs: ReadonlySet<string>;
  items: ReadonlySet<string>;
  enemies: ReadonlySet<string>;
  facts: ReadonlySet<string>;
}>;

function knownIds(store: EntityStore): KnownEntityIds {
  return {
    locations: new Set(entitiesOfKind(store, "location").map((record) => record.core.id)),
    npcs: new Set(entitiesOfKind(store, "npc").map((record) => record.core.id)),
    items: new Set(entitiesOfKind(store, "item").map((record) => record.core.id)),
    enemies: new Set(entitiesOfKind(store, "enemy").map((record) => record.core.id)),
    facts: new Set(entitiesOfKind(store, "fact").map((record) => record.core.id)),
  };
}

function ownerKeyOf(owner: ItemOwner): string {
  if (owner.kind === "player") return `player:${owner.playerId}`;
  if (owner.kind === "location") return `location:${owner.locationId}`;
  if (owner.kind === "npc") return `npc:${owner.npcId}`;
  return "none";
}

function objectiveReference(
  objective: QuestObjective,
  known: KnownEntityIds,
): { readonly referencedId: string; readonly resolved: boolean } {
  switch (objective.kind) {
    case "visit_location":
      return { referencedId: objective.locationId, resolved: known.locations.has(objective.locationId) };
    case "talk_to_npc":
      return { referencedId: objective.npcId, resolved: known.npcs.has(objective.npcId) };
    case "obtain_item":
      return { referencedId: objective.itemId, resolved: known.items.has(objective.itemId) };
    case "discover_fact":
      return { referencedId: objective.factId, resolved: known.facts.has(objective.factId) };
    case "defeat_enemy":
      return { referencedId: objective.enemyId, resolved: known.enemies.has(objective.enemyId) };
  }
}

export function validateEntityReferences(store: EntityStore): readonly EntityReferenceIssue[] {
  const issues: EntityReferenceIssue[] = [];
  const known = knownIds(store);
  const locations = new Map(entitiesOfKind(store, "location").map((record) => [record.core.id, record]));
  const npcs = new Map(entitiesOfKind(store, "npc").map((record) => [record.core.id, record]));

  for (const record of entitiesOfKind(store, "player_character")) {
    if (!known.locations.has(record.position.locationId)) {
      issues.push({
        code: "unknown_player_location",
        entityId: record.core.id,
        referencedId: record.position.locationId,
      });
    }
  }
  for (const record of [...entitiesOfKind(store, "npc"), ...entitiesOfKind(store, "enemy")]) {
    if (!known.locations.has(record.position.locationId)) {
      issues.push({ code: "unknown_location_ref", entityId: record.core.id, referencedId: record.position.locationId });
    }
  }
  for (const record of entitiesOfKind(store, "fact")) {
    const locationId = record.fact.locationId;
    if (locationId !== undefined && !known.locations.has(locationId)) {
      issues.push({ code: "unknown_location_ref", entityId: record.core.id, referencedId: locationId });
    }
  }

  for (const record of entitiesOfKind(store, "location")) {
    for (const targetId of record.location.connectedLocationIds) {
      if (targetId === record.core.id) {
        issues.push({ code: "self_connection", entityId: record.core.id, referencedId: targetId });
        continue;
      }
      const target = locations.get(targetId);
      if (target === undefined) {
        issues.push({ code: "unknown_location_ref", entityId: record.core.id, referencedId: targetId });
        continue;
      }
      if (!target.location.connectedLocationIds.includes(record.core.id)) {
        issues.push({ code: "asymmetric_connection", entityId: record.core.id, referencedId: targetId });
      }
    }
    for (const slot of record.location.town?.slots ?? []) {
      if (slot.boundNpcId === null) continue;
      const npc = npcs.get(slot.boundNpcId);
      if (npc === undefined) {
        issues.push({ code: "unknown_town_npc_ref", entityId: record.core.id, referencedId: slot.boundNpcId });
      } else if (npc.position.locationId !== record.core.id) {
        issues.push({ code: "town_npc_location_mismatch", entityId: record.core.id, referencedId: slot.boundNpcId });
      }
    }
  }

  for (const record of entitiesOfKind(store, "item")) {
    const { owner } = record.possession;
    const unresolved =
      (owner.kind === "location" && !known.locations.has(owner.locationId))
      || (owner.kind === "npc" && !known.npcs.has(owner.npcId))
      || (owner.kind === "player" && owner.playerId !== PLAYER_ENTITY_ID);
    if (unresolved) {
      issues.push({ code: "unknown_item_owner_ref", entityId: record.core.id, referencedId: ownerKeyOf(owner) });
    }
  }

  for (const record of entitiesOfKind(store, "quest")) {
    for (const objective of record.quest.objectives) {
      if (objective.kind === "obtain_item" && objective.giftFromNpcId !== undefined && !known.npcs.has(objective.giftFromNpcId)) {
        issues.push({ code: "unknown_quest_objective_ref", entityId: record.core.id, referencedId: objective.giftFromNpcId });
      }
      const reference = objectiveReference(objective, known);
      if (!reference.resolved) {
        issues.push({
          code: "unknown_quest_objective_ref",
          entityId: record.core.id,
          referencedId: reference.referencedId,
        });
      }
    }
  }

  for (const record of entitiesOfKind(store, "npc")) {
    for (const entry of record.knowledge.entries) {
      if (!known.facts.has(entry.factId)) {
        issues.push({ code: "unknown_npc_fact_ref", entityId: record.core.id, referencedId: entry.factId });
      }
    }
  }

  for (const record of entitiesOfKind(store, "npc")) {
    const terms = [
      ...(record.interactions ?? []).flatMap((interaction) => interaction.confidentiality === undefined ? [] : [interaction.confidentiality]),
      ...record.relationships.outgoing.flatMap((edge) => edge.commitments.flatMap((commitment) => commitment.kind === "promise" && commitment.confidentiality !== undefined ? [commitment.confidentiality] : [])),
    ];
    for (const term of terms) {
      for (const id of term.protectedFactIds) if (!known.facts.has(id)) issues.push({ code: "unknown_confidentiality_ref", entityId: record.core.id, referencedId: id });
      for (const id of term.allowedAudienceIds) if (id !== PLAYER_ENTITY_ID && !known.npcs.has(id as NpcId)) issues.push({ code: "unknown_confidentiality_ref", entityId: record.core.id, referencedId: id });
    }
  }

  const usedLocationOrders = new Set<string>();
  for (const record of entitiesOfKind(store, "npc")) {
    if (record.core.lifecycle !== "active") continue;
    const key = `${record.position.locationId}\u0000${record.position.locationOrder}`;
    if (usedLocationOrders.has(key)) {
      issues.push({
        code: "duplicate_location_order",
        entityId: record.core.id,
        referencedId: record.position.locationId,
      });
    }
    usedLocationOrders.add(key);
  }

  const usedOwnerOrders = new Set<string>();
  for (const record of entitiesOfKind(store, "item")) {
    const { owner, ownerOrder } = record.possession;
    if (owner.kind === "none") continue;
    const key = `${ownerKeyOf(owner)}\u0000${ownerOrder}`;
    if (usedOwnerOrders.has(key)) {
      issues.push({ code: "duplicate_owner_order", entityId: record.core.id, referencedId: ownerKeyOf(owner) });
    }
    usedOwnerOrders.add(key);
  }

  return issues;
}

/**
 * store 与（可能被手工改写过的）兼容投影是否仍互为确定结果。
 * 玩家可见顺序字段逐位比较；纯状态索引只比集合，顺序允许随 record 顺序归一。
 */
export function validateEntityCompatibilityProjection(
  store: EntityStore,
  projection: EntityCompatibilityProjection,
): readonly EntityProjectionIssue[] {
  const issues: EntityProjectionIssue[] = [];
  const derived = projectEntityStore(store);
  const orderedFields = [
    "player", "locations", "currentLocationId", "npcs", "items", "inventory",
    "worldFacts", "quests", "enemies", "factions",
  ] as const;
  for (const field of orderedFields) {
    if (!sameStructure(derived[field], projection[field])) {
      issues.push({ code: "projection_mismatch", field });
    }
  }
  const setFields = ["unlockedLocationIds", "visitedLocationIds", "defeatedEnemyIds"] as const;
  for (const field of setFields) {
    if (!sameIdSet(derived[field], projection[field])) {
      issues.push({ code: "projection_mismatch", field });
    }
  }
  return issues;
}
