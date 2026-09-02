import type { TownBuildingSlotType } from "../townState";
import type {
  EnemyTier, FactSource, ItemCategory, ItemRarity, LocationKind, LocationScale,
} from "../worldEntity";
import type { InvestigationApproach, QuestObjective, QuestOutcome } from "../worldEntries";
import type { EntityKind, EntityLifecycle } from "./entityCore";
import type { QuestComponent } from "./entityComponents";
import type { EntityRecord } from "./entityRecord";
import {
  validateNpcDynamicState,
  validateNpcHistory,
  validateNpcIdentityAnchors,
  validateNpcKnowledge,
  validateNpcRelationships,
  type NpcComponentValidationIssue,
} from "./npcComponents";
import { PLAYER_ENTITY_ID } from "../worldEntity";

// ---------------------------------------------------------------------------
// EntityStore：唯一世界事实来源。零 IO、可 JSON 序列化、无可空万能字段。
// validateEntityStoreStructure / parseEntityStore 直接接受 unknown：从 SQLite JSON
// 读回的值未经解析通过前不得当作 EntityStore 使用（禁止调用方类型断言跳过解析）。
// ---------------------------------------------------------------------------

export type EntityStore = Readonly<{
  version: 2;
  records: readonly EntityRecord[];
}>;

export type EntityStoreValidationCode =
  | "invalid_store_version"
  | "invalid_record_shape"
  | "invalid_component_value"
  | "duplicate_entity_id"
  | "invalid_created_turn"
  | "invalid_lifecycle"
  | "kind_id_mismatch"
  | "component_id_mismatch"
  | "component_lifecycle_mismatch"
  | "invalid_player_id"
  | "missing_player"
  | "multiple_players";

export type EntityStoreValidationIssue = Readonly<{
  code: EntityStoreValidationCode;
  entityId?: string;
  /** 只含字段名与数组下标的定位（如 identity.anchors.values[0]），绝不含实体正文。 */
  path?: string;
}>;

/** 稳定失败：错误对象只含 code/entityId，绝不包含实体正文。 */
export class EntityStoreInvariantError extends Error {
  readonly code: EntityStoreValidationCode;
  readonly entityId?: string;

  constructor(issue: EntityStoreValidationIssue) {
    super(`entity store invariant violated: ${issue.code}`);
    this.name = "EntityStoreInvariantError";
    this.code = issue.code;
    this.entityId = issue.entityId;
  }
}

export type ParseEntityStoreResult =
  | { readonly ok: true; readonly store: EntityStore }
  | { readonly ok: false; readonly issues: readonly EntityStoreValidationIssue[] };

// ---------------------------------------------------------------------------
// 封闭值域表：与 domain 联合类型逐一对应；联合成员被删除或改名时编译期即失败。
// ---------------------------------------------------------------------------

const ENTITY_KINDS: readonly EntityKind[] = [
  "player_character", "npc", "location", "item", "enemy", "faction", "quest", "fact",
];
const ENTITY_LIFECYCLES: readonly EntityLifecycle[] = ["active", "inactive", "resolved", "destroyed"];
const FACT_SOURCES: readonly FactSource[] = ["player_input", "generated"];
const LOCATION_KINDS: readonly LocationKind[] = ["main", "hidden"];
const LOCATION_SCALES: readonly LocationScale[] = ["scene", "town"];
const ENEMY_TIERS: readonly EnemyTier[] = ["normal", "boss"];
const ITEM_CATEGORIES: readonly ItemCategory[] = ["equipment", "consumable", "material", "quest"];
const ITEM_RARITIES: readonly ItemRarity[] = ["common", "fine", "rare", "epic"];
const QUEST_KINDS: readonly QuestComponent["kind"][] = ["main", "side"];
const QUEST_STATUSES: readonly QuestComponent["status"][] = ["locked", "active", "completed", "failed", "closed"];
const QUEST_OUTCOMES: readonly QuestOutcome["kind"][] = ["advance_story", "resolve_story", "closed"];
const EVIDENCE_QUALITIES: readonly InvestigationApproach["evidenceQuality"][] = ["clean", "noisy"];
const TOWN_BUILDING_SLOT_TYPES: readonly TownBuildingSlotType[] = [
  "tavern", "blacksmith", "house", "guild", "clinic", "market",
];
const MIN_INVESTIGATION_TENSION_DELTA = -5;
const MAX_INVESTIGATION_TENSION_DELTA = 20;

const OBJECTIVE_KINDS: readonly QuestObjective["kind"][] = [
  "visit_location", "talk_to_npc", "obtain_item", "discover_fact", "defeat_enemy",
];
const OBJECTIVE_ID_FIELDS: Readonly<Record<QuestObjective["kind"], string>> = {
  visit_location: "locationId",
  talk_to_npc: "npcId",
  obtain_item: "itemId",
  discover_fact: "factId",
  defeat_enemy: "enemyId",
};

/** 每个 kind 唯一合法的组件集合；缺成员是 invalid_record_shape，整体换了另一套是 kind_id_mismatch。 */
const REQUIRED_COMPONENTS: Readonly<Record<EntityKind, readonly string[]>> = {
  player_character: ["identity", "position"],
  npc: ["identity", "position", "dynamicState", "knowledge", "relationships", "history"],
  location: ["location"],
  item: ["possession", "presentation"],
  enemy: ["enemy", "position"],
  faction: ["faction"],
  quest: ["quest"],
  fact: ["fact"],
};

function signatureOf(names: readonly string[]): string {
  return [...names].sort().join(",");
}

const KIND_BY_SIGNATURE: Readonly<Record<string, EntityKind>> = Object.fromEntries(
  (Object.keys(REQUIRED_COMPONENTS) as EntityKind[]).map((kind) => [
    signatureOf(REQUIRED_COMPONENTS[kind]),
    kind,
  ]),
);

const CORE_KEYS = ["id", "kind", "name", "createdAtTurn", "lifecycle"] as const;

// ---------------------------------------------------------------------------
// shape 原语
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

function issue(code: EntityStoreValidationCode, entityId?: string, path?: string): EntityStoreValidationIssue {
  const result: { code: EntityStoreValidationCode; entityId?: string; path?: string } = { code };
  if (entityId !== undefined) result.entityId = entityId;
  if (path !== undefined) result.path = path;
  return result;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString);
}

function matchesEnum<T extends string>(value: unknown, table: readonly T[]): value is T {
  return isString(value) && (table as readonly string[]).includes(value);
}

/** exact keys：required 必须存在，allowed 之外的一律视为多余。 */
function hasExactKeys(value: UnknownRecord, required: readonly string[], allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) return false;
  }
  return required.every((key) => key in value);
}

function optionalIs(value: UnknownRecord, key: string, predicate: (raw: unknown) => boolean): boolean {
  if (!(key in value)) return true;
  const raw = value[key];
  return raw === undefined || predicate(raw);
}

/** 组件必须是对象、exact keys 合法，收敛为 UnknownRecord 供后续字段检查。 */
function component(
  value: unknown,
  required: readonly string[],
  allowed: readonly string[] = required,
): value is UnknownRecord {
  return isRecord(value) && hasExactKeys(value, required, allowed);
}

/** quest status → lifecycle 的单向确定映射；enemy defeated 同理。 */
function questLifecycleOf(status: string): EntityLifecycle | undefined {
  if (status === "locked") return "inactive";
  if (status === "active") return "active";
  if (status === "completed" || status === "failed" || status === "closed") return "resolved";
  return undefined;
}

function enemyLifecycleOf(defeated: boolean): EntityLifecycle {
  return defeated ? "resolved" : "active";
}

// ---------------------------------------------------------------------------
// 组件值域检查：任一嵌套字段 shape/值域不合法即 false
// ---------------------------------------------------------------------------

function isPositionValue(value: unknown): boolean {
  return (
    component(value, ["locationId", "locationOrder"]) &&
    isString(value.locationId) &&
    isNonNegativeInteger(value.locationOrder)
  );
}

function isStatsValue(value: unknown): boolean {
  return (
    component(
      value,
      ["hp", "attack", "defense"],
      ["hp", "attack", "defense", "maxHp", "maxEnergy", "speed"],
    ) &&
    isNumber(value.hp) &&
    isNumber(value.attack) &&
    isNumber(value.defense) &&
    optionalIs(value, "maxHp", isNumber) &&
    optionalIs(value, "maxEnergy", isNumber) &&
    optionalIs(value, "speed", isNumber)
  );
}

function isPlayerIdentityValue(value: unknown): boolean {
  return component(value, ["identity", "stats"]) && isString(value.identity) && isStatsValue(value.stats);
}

function isNpcIdentityValue(value: unknown): boolean {
  return (
    component(value, ["role", "description", "tags", "anchors"]) &&
    isString(value.role) &&
    isString(value.description) &&
    isStringArray(value.tags)
  );
}

type NpcComponentValidator = (value: unknown) => readonly NpcComponentValidationIssue[];

/** 分层组件的 validator 表：路径根已是组件名，无需再加前缀。 */
const NPC_LAYERED_VALIDATORS: readonly (readonly [string, NpcComponentValidator])[] = [
  ["dynamicState", validateNpcDynamicState],
  ["knowledge", validateNpcKnowledge],
  ["relationships", validateNpcRelationships],
  ["history", validateNpcHistory],
];

/**
 * 嵌套字段的稳定失败：只把 { code, path } 折叠成 invalid_component_value + 路径。
 * anchors 的 validator 以 anchors 为根，挂到 record 上必须限定为 identity.anchors.*。
 */
function npcComponentIssues(record: UnknownRecord, entityId: string | undefined): EntityStoreValidationIssue[] {
  const issues: EntityStoreValidationIssue[] = [];
  const push = (path: string): void => { issues.push(issue("invalid_component_value", entityId, path)); };
  if (isRecord(record.identity)) {
    for (const entry of validateNpcIdentityAnchors(record.identity.anchors)) push(`identity.${entry.path}`);
  }
  for (const [name, validate] of NPC_LAYERED_VALIDATORS) {
    for (const entry of validate(record[name])) push(entry.path);
  }
  return issues;
}

/** 关系边不得指向自己：旧 memory.npcId === core.id 不变量在分层形状下的等价形式。 */
function npcSelfEdgeIssues(record: UnknownRecord, entityId: string | undefined): EntityStoreValidationIssue[] {
  const outgoing = isRecord(record.relationships) ? record.relationships.outgoing : undefined;
  if (!Array.isArray(outgoing) || entityId === undefined) return [];
  const issues: EntityStoreValidationIssue[] = [];
  outgoing.forEach((edge, index) => {
    if (isRecord(edge) && edge.targetId === entityId) {
      issues.push(issue("component_id_mismatch", entityId, `relationships.outgoing[${index}].targetId`));
    }
  });
  return issues;
}

function isTownValue(value: unknown): boolean {
  if (!component(value, ["locationId", "seed", "generatorVersion", "slots"])) return false;
  if (!isString(value.locationId) || !isString(value.seed) || !isString(value.generatorVersion)) return false;
  if (!Array.isArray(value.slots)) return false;
  return value.slots.every((slot) => {
    if (
      !component(
        slot,
        ["slotId", "buildingId", "buildingType", "boundNpcId"],
        ["slotId", "buildingId", "buildingType", "displayName", "boundNpcId"],
      )
    ) {
      return false;
    }
    if (!isString(slot.slotId) || !isString(slot.buildingId) || !matchesEnum(slot.buildingType, TOWN_BUILDING_SLOT_TYPES)) return false;
    if (!optionalIs(slot, "displayName", isString)) return false;
    return slot.boundNpcId === null || isString(slot.boundNpcId);
  });
}

function isLocationValue(value: unknown): boolean {
  if (
    !component(
      value,
      ["description", "kind", "connectedLocationIds", "tags", "unlocked", "visited"],
      ["description", "kind", "scale", "connectedLocationIds", "tags", "town", "unlocked", "visited"],
    )
  ) {
    return false;
  }
  if (
    !isString(value.description) ||
    !matchesEnum(value.kind, LOCATION_KINDS) ||
    !isStringArray(value.connectedLocationIds) ||
    !isStringArray(value.tags) ||
    !isBoolean(value.unlocked) ||
    !isBoolean(value.visited)
  ) {
    return false;
  }
  return (
    optionalIs(value, "scale", (raw) => matchesEnum(raw, LOCATION_SCALES)) &&
    optionalIs(value, "town", isTownValue)
  );
}

function townLocationIdMatches(value: unknown, coreId: string | undefined): boolean {
  if (!isRecord(value) || !("town" in value) || value.town === undefined) return true;
  return isRecord(value.town) && isString(value.town.locationId) && value.town.locationId === coreId;
}

function isStatLinesValue(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((line) => component(line, ["label", "value"]) && isString(line.label) && isString(line.value))
  );
}

function isPresentationValue(value: unknown): boolean {
  if (
    !component(
      value,
      ["description", "kind", "tags"],
      ["description", "kind", "tags", "category", "rarity", "level", "statLines"],
    )
  ) {
    return false;
  }
  if (!isString(value.description) || !isString(value.kind) || !isStringArray(value.tags)) return false;
  return (
    optionalIs(value, "category", (raw) => matchesEnum(raw, ITEM_CATEGORIES)) &&
    optionalIs(value, "rarity", (raw) => matchesEnum(raw, ITEM_RARITIES)) &&
    optionalIs(value, "level", isNonNegativeInteger) &&
    optionalIs(value, "statLines", isStatLinesValue)
  );
}

function isOwnerValue(value: unknown): value is UnknownRecord {
  if (!isRecord(value) || !isString(value.kind)) return false;
  switch (value.kind) {
    case "player":
      return component(value, ["kind", "playerId"]) && isString(value.playerId);
    case "location":
      return component(value, ["kind", "locationId"]) && isString(value.locationId);
    case "npc":
      return component(value, ["kind", "npcId"]) && isString(value.npcId);
    case "none":
      return component(value, ["kind"]);
    default:
      return false;
  }
}

function isPossessionValue(value: unknown): boolean {
  return (
    component(value, ["owner", "quantity", "ownerOrder"]) &&
    isOwnerValue(value.owner) &&
    value.quantity === 1 &&
    isNonNegativeInteger(value.ownerOrder) &&
    // 无主物品不属于可排序容器；固定 0 避免无意义且不受唯一性约束的序号进入存档。
    (value.owner.kind !== "none" || value.ownerOrder === 0)
  );
}

function isEnemyValue(value: unknown): boolean {
  return (
    component(value, ["tier", "stats", "tags", "defeated"]) &&
    matchesEnum(value.tier, ENEMY_TIERS) &&
    isStatsValue(value.stats) &&
    isStringArray(value.tags) &&
    isBoolean(value.defeated)
  );
}

function isFactionValue(value: unknown): boolean {
  return component(value, ["attitudeToPlayer"]) && isNumber(value.attitudeToPlayer);
}

function isObjectiveValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const kind = value.kind;
  if (!matchesEnum(kind, OBJECTIVE_KINDS)) return false;
  const idField = OBJECTIVE_ID_FIELDS[kind];
  return component(value, ["kind", idField]) && isString(value[idField]);
}

function isOutcomeValue(value: unknown): boolean {
  return component(value, ["kind"]) && matchesEnum(value.kind, QUEST_OUTCOMES);
}

function isQuestValue(value: unknown): boolean {
  if (
    !component(
      value,
      ["description", "objectives", "onSuccess", "onFailure", "tags", "kind", "status"],
      ["description", "objectives", "onSuccess", "onFailure", "tags", "kind", "stage", "status"],
    )
  ) {
    return false;
  }
  if (
    !isString(value.description) ||
    !Array.isArray(value.objectives) ||
    !value.objectives.every(isObjectiveValue) ||
    !isOutcomeValue(value.onSuccess) ||
    !isOutcomeValue(value.onFailure) ||
    !isStringArray(value.tags) ||
    !matchesEnum(value.kind, QUEST_KINDS) ||
    !matchesEnum(value.status, QUEST_STATUSES)
  ) {
    return false;
  }
  return optionalIs(value, "stage", isNonNegativeInteger);
}

function isApproachValue(value: unknown): boolean {
  if (
    !component(
      value,
      ["approachId", "label", "evidenceQuality", "tensionDelta"],
      ["approachId", "label", "hint", "evidenceQuality", "tensionDelta"],
    )
  ) {
    return false;
  }
  return (
    isString(value.approachId) &&
    isString(value.label) &&
    matchesEnum(value.evidenceQuality, EVIDENCE_QUALITIES) &&
    isNumber(value.tensionDelta) &&
    value.tensionDelta >= MIN_INVESTIGATION_TENSION_DELTA &&
    value.tensionDelta <= MAX_INVESTIGATION_TENSION_DELTA &&
    optionalIs(value, "hint", isString)
  );
}

function isFactValue(value: unknown): boolean {
  if (
    !component(
      value,
      ["text", "source", "discovered"],
      ["text", "source", "discovered", "locationId", "investigationLabel", "investigationApproaches"],
    )
  ) {
    return false;
  }
  if (!isString(value.text) || !matchesEnum(value.source, FACT_SOURCES) || !isBoolean(value.discovered)) return false;
  return (
    optionalIs(value, "locationId", isString) &&
    optionalIs(value, "investigationLabel", isString) &&
    optionalIs(value, "investigationApproaches", (raw) => Array.isArray(raw) && raw.every(isApproachValue))
  );
}

const COMPONENT_CHECKS: Readonly<Partial<Record<EntityKind, (raw: UnknownRecord) => boolean>>> = {
  player_character: (raw) => isPlayerIdentityValue(raw.identity) && isPositionValue(raw.position),
  npc: (raw) => isNpcIdentityValue(raw.identity) && isPositionValue(raw.position),
  location: (raw) => isLocationValue(raw.location),
  item: (raw) => isPresentationValue(raw.presentation) && isPossessionValue(raw.possession),
  enemy: (raw) => isEnemyValue(raw.enemy) && isPositionValue(raw.position),
  faction: (raw) => isFactionValue(raw.faction),
  quest: (raw) => isQuestValue(raw.quest),
  fact: (raw) => isFactValue(raw.fact),
};

// ---------------------------------------------------------------------------
// record / store 检查
// ---------------------------------------------------------------------------

function coreIdOf(core: UnknownRecord): string | undefined {
  return isString(core.id) ? core.id : undefined;
}

function validateCore(core: UnknownRecord): readonly EntityStoreValidationIssue[] {
  const entityId = coreIdOf(core);
  if (!hasExactKeys(core, CORE_KEYS, CORE_KEYS)) return [issue("invalid_record_shape", entityId)];
  if (!isString(core.id) || !isString(core.name) || !isString(core.kind)) {
    return [issue("invalid_record_shape", entityId)];
  }
  const issues: EntityStoreValidationIssue[] = [];
  if (!isNonNegativeInteger(core.createdAtTurn)) issues.push(issue("invalid_created_turn", entityId));
  if (!matchesEnum(core.lifecycle, ENTITY_LIFECYCLES)) issues.push(issue("invalid_lifecycle", entityId));
  return issues;
}

function questDrift(quest: unknown, lifecycle: unknown): boolean {
  if (!isRecord(quest) || !isString(quest.status)) return false;
  const expected = questLifecycleOf(quest.status);
  return expected !== undefined && expected !== lifecycle;
}

function enemyDrift(enemy: unknown, lifecycle: unknown): boolean {
  if (!isRecord(enemy) || !isBoolean(enemy.defeated)) return false;
  return enemyLifecycleOf(enemy.defeated) !== lifecycle;
}

function validateRecord(record: unknown): readonly EntityStoreValidationIssue[] {
  if (!isRecord(record)) return [issue("invalid_record_shape")];
  const core = record.core;
  if (!isRecord(core)) return [issue("invalid_record_shape")];
  const entityId = coreIdOf(core);
  const issues: EntityStoreValidationIssue[] = [...validateCore(core)];
  if (!matchesEnum(core.kind, ENTITY_KINDS)) return [...issues, issue("invalid_record_shape", entityId)];
  const kind = core.kind;

  if (kind === "player_character" && core.id !== PLAYER_ENTITY_ID) {
    issues.push(issue("invalid_player_id", entityId));
  }

  const present = Object.keys(record)
    .filter((key) => key !== "core")
    .sort();
  const required = REQUIRED_COMPONENTS[kind];
  if (signatureOf(present) !== signatureOf(required)) {
    // 组件集合与声明 kind 不符时：整套恰好命中另一个 kind 的签名、且含本 kind 不合法的
    // 组件名，才算 kind 说错；只是缺成员（present ⊆ 本 kind 组件集）算 record shape 问题。
    const otherKind: EntityKind | undefined = KIND_BY_SIGNATURE[signatureOf(present)];
    const hasNoForeignComponent = present.every((name) => required.includes(name));
    if (otherKind !== undefined && !hasNoForeignComponent) {
      return [...issues, issue("kind_id_mismatch", entityId)];
    }
    return [...issues, issue("invalid_record_shape", entityId)];
  }

  const check = COMPONENT_CHECKS[kind];
  if (kind === "npc") issues.push(...npcComponentIssues(record, entityId), ...npcSelfEdgeIssues(record, entityId));
  if (check === undefined || !check(record)) issues.push(issue("invalid_component_value", entityId));
  if (kind === "location" && isLocationValue(record.location) && !townLocationIdMatches(record.location, entityId)) {
    issues.push(issue("component_id_mismatch", entityId));
  }

  if (kind === "quest" && questDrift(record.quest, core.lifecycle)) {
    issues.push(issue("component_lifecycle_mismatch", entityId));
  }
  if (kind === "enemy" && enemyDrift(record.enemy, core.lifecycle)) {
    issues.push(issue("component_lifecycle_mismatch", entityId));
  }
  return issues;
}

export function validateEntityStoreStructure(value: unknown): readonly EntityStoreValidationIssue[] {
  if (!component(value, ["version", "records"])) return [issue("invalid_record_shape")];
  const issues: EntityStoreValidationIssue[] = [];
  if (value.version !== 2) issues.push(issue("invalid_store_version"));
  if (!Array.isArray(value.records)) return [...issues, issue("invalid_record_shape")];
  const seen = new Set<string>();
  let playerCount = 0;
  for (const record of value.records) {
    issues.push(...validateRecord(record));
    const id = isRecord(record) && isRecord(record.core) ? coreIdOf(record.core) : undefined;
    if (id !== undefined) {
      if (seen.has(id)) issues.push(issue("duplicate_entity_id", id));
      else seen.add(id);
      if (isRecord(record) && isRecord(record.core) && record.core.kind === "player_character") playerCount += 1;
    }
  }
  if (playerCount === 0) issues.push(issue("missing_player"));
  if (playerCount > 1) issues.push(issue("multiple_players"));
  return issues;
}

export function createEntityStore(records: readonly EntityRecord[]): EntityStore {
  const store: EntityStore = { version: 2, records: [...records] };
  const [first] = validateEntityStoreStructure(store);
  if (first !== undefined) throw new EntityStoreInvariantError(first);
  return store;
}

export function parseEntityStore(value: unknown): ParseEntityStoreResult {
  const issues = validateEntityStoreStructure(value);
  if (issues.length > 0) return { ok: false, issues };
  // 通过全量 exact-key/值域检查后，value 的形状必为 { version: 2, records: 合法 record }；
  // 这里只做公开类型收敛，不跳过任何一项校验。
  const { records } = value as Readonly<{ records: readonly EntityRecord[] }>;
  return { ok: true, store: { version: 2, records } };
}

export function getEntity(store: EntityStore, id: string): EntityRecord | undefined {
  return store.records.find((record) => record.core.id === id);
}

export function entitiesOfKind<K extends EntityKind>(
  store: EntityStore,
  kind: K,
): readonly Extract<EntityRecord, { core: { kind: K } }>[] {
  return store.records.filter(
    (record): record is Extract<EntityRecord, { core: { kind: K } }> => record.core.kind === kind,
  );
}
