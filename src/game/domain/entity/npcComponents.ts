import { DIALOGUE_ACTS } from "../action";
import type { StructuredDialogueTopic } from "../action";
import { NARRATIVE_EMOTIONS } from "../narrative";
import type { NarrativeEmotion } from "../narrative";
import { RELATIONSHIP_MAX, RELATIONSHIP_MIN } from "../relationship";
import type { FactChangeSource } from "../resolvedEvent";
import type { NpcInteraction } from "../worldEntries";
import type { FactId, NpcId, PlayerEntityId } from "../worldEntity";

// ---------------------------------------------------------------------------
// Plan 3：NPC 分层组件的固定形状、封闭值域与纯 validator。
//
// 本文件只有类型、常量表和 validator：不 import gameplay、不持 IO、不切换生产
// record（record 形状与投影在后续任务接入）。关系数值的产生规则（signal 表、
// stage 迁移图、cap 预算）属于 gameplay，本层只验证「已提交的值仍是合法成员」。
//
// validator 一律接受 unknown：从 SQLite JSON 读回的值在解析通过前不得当作组件使用。
// 失败只返回 { code, path } 形式的稳定数据，绝不携带人格锚点正文、目标描述或
// 私密事实内容（path 只含字段名与数组下标）。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 共享上限与封闭值域表
// ---------------------------------------------------------------------------

/** 锚点枚举列表（values / capabilityBoundaries）的最少条目：长期人格不允许留空。 */
export const NPC_ANCHOR_LIST_MIN = 1;
/** 三类锚点列表共用的条目上限；taboos 的下限是 0（可以没有长期禁区）。 */
export const NPC_ANCHOR_LIST_MAX = 4;
/** 锚点列表内允许「可空」的那一档：长期禁区。 */
export const NPC_TABOO_LIST_MIN = 0;
/** 开放给创建提案的单条人格/目标文本上限，与实体文本预算保持一致。 */
export const NPC_CREATION_TEXT_MAX_LENGTH = 200;
/** 一个 NPC 出生时最多携带的并行目标数。 */
export const NPC_GOAL_LIST_MIN = 1;
export const NPC_GOAL_LIST_MAX = 4;
/** 一条关系边保留的证据条数上限：超出即拒绝，裁剪由写入侧的确定性规则负责。 */
export const RELATIONSHIP_EVIDENCE_CAP = 12;
/** NPC 交互历史保留条数上限。 */
export const NPC_HISTORY_CAP = 10;
/** 关系维度闭区间下界：复用 domain/relationship 既有 -100，不重复定义字面量。 */
export const RELATIONSHIP_DIMENSION_MIN = RELATIONSHIP_MIN;
/** 关系维度闭区间上界。 */
export const RELATIONSHIP_DIMENSION_MAX = RELATIONSHIP_MAX;

export const NPC_GOAL_HORIZONS = Object.freeze(["short", "long"] as const);
export type NpcGoalHorizon = (typeof NPC_GOAL_HORIZONS)[number];

export const NPC_GOAL_PRIORITIES = Object.freeze([1, 2, 3, 4, 5] as const);
export type NpcGoalPriority = (typeof NPC_GOAL_PRIORITIES)[number];

export const NPC_GOAL_STATUSES = Object.freeze(["active", "blocked", "completed", "abandoned"] as const);
export type NpcGoalStatus = (typeof NPC_GOAL_STATUSES)[number];

export const NPC_KNOWLEDGE_CERTAINTIES = Object.freeze(["known", "suspected"] as const);
export type NpcKnowledgeCertainty = (typeof NPC_KNOWLEDGE_CERTAINTIES)[number];

export const NPC_KNOWLEDGE_DISCLOSURES = Object.freeze(["public", "conditional", "secret"] as const);
export type NpcKnowledgeDisclosure = (typeof NPC_KNOWLEDGE_DISCLOSURES)[number];

/** knowledge 的 action 来源 mode 取值表：与 FactChangeSource 双向编译期锁定。 */
const FACT_CHANGE_SOURCE_VALUES = [
  "scene_witness", "player_told", "npc_revealed", "public_broadcast", "faction_shared",
] as const satisfies readonly FactChangeSource[];

export const FACT_CHANGE_SOURCES: readonly FactChangeSource[] = Object.freeze(FACT_CHANGE_SOURCE_VALUES);

type Expect<T extends true> = T;
type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** 表与 union 必须逐项一致：漏一项或多一项都在 typecheck 阶段失败。 */
export type FactChangeSourceTableLock = Expect<
  IsExactly<(typeof FACT_CHANGE_SOURCE_VALUES)[number], FactChangeSource>
>;

/** 关系信号的封闭集合：AI 与客户端都不得携带数值 delta，只能报 signal。 */
export const RELATIONSHIP_SIGNALS = Object.freeze([
  "supported", "challenged", "threatened", "deceived", "offered_help", "reassured",
  "refused", "gave_item", "shared_fact", "fought_together", "betrayed",
  "kept_promise", "broke_promise",
] as const);
export type RelationshipSignal = (typeof RELATIONSHIP_SIGNALS)[number];

/** stage 只验证成员合法性；阈值与相邻迁移图属于 gameplay 的关系规则层。 */
export const RELATIONSHIP_STAGES = Object.freeze([
  "unknown", "acquainted", "cooperative", "trusted", "bonded", "wary", "hostile",
] as const);
export type RelationshipStage = (typeof RELATIONSHIP_STAGES)[number];

export const RELATIONSHIP_TRENDS = Object.freeze(["improving", "stable", "worsening"] as const);
export type RelationshipTrend = (typeof RELATIONSHIP_TRENDS)[number];

export const RELATIONSHIP_SEVERITIES = Object.freeze(["normal", "major"] as const);
export type RelationshipSeverity = (typeof RELATIONSHIP_SEVERITIES)[number];

export const RELATIONSHIP_DIMENSION_KEYS = Object.freeze([
  "affinity", "trust", "fear", "hostility",
] as const);
export type RelationshipDimensionKey = (typeof RELATIONSHIP_DIMENSION_KEYS)[number];

export const RELATIONSHIP_DEBT_STATUSES = Object.freeze(["open", "fulfilled", "forgiven", "broken"] as const);
export type RelationshipDebtStatus = (typeof RELATIONSHIP_DEBT_STATUSES)[number];

export const RELATIONSHIP_PROMISE_STATUSES = Object.freeze(["open", "fulfilled", "broken", "released"] as const);
export type RelationshipPromiseStatus = (typeof RELATIONSHIP_PROMISE_STATUSES)[number];

export const RELATIONSHIP_COMMITMENT_KINDS = Object.freeze(["debt", "promise"] as const);
export const RELATIONSHIP_SOURCE_KINDS = Object.freeze(["initial_world", "action"] as const);
export const NPC_KNOWLEDGE_SOURCE_KINDS = Object.freeze(["initial_world", "action"] as const);
export const RELATIONSHIP_DEBT_DIRECTIONS = Object.freeze(
  ["source_owes_target", "target_owes_source"] as const,
);
export const RELATIONSHIP_PROMISORS = Object.freeze(["source", "target"] as const);

/** 交互历史的 dialogueAct 取值：八种结构化行为 + freeform。 */
const DIALOGUE_ACT_VALUES: readonly string[] = [...DIALOGUE_ACTS, "freeform"];
const INTERACTION_OUTCOMES: readonly NpcInteraction["outcome"][] = ["positive", "negative", "neutral", "mixed"];
const TOPIC_KINDS: readonly StructuredDialogueTopic["kind"][] = ["fact", "quest", "thread", "general"];
/**
 * kind → 引用字段名表：`satisfies` 锁住 kind 集合（漏一个或多一个都编译失败），
 * 字段名由下面的 TopicIdFieldLock 逐 kind 锁定。validator 用 exact-keys 判定主题，
 * 所以这张表是承重的：主题变体改了字段名而本表未改，合法记录会在存档解析期被拒。
 */
const TOPIC_ID_FIELDS = {
  fact: "factId",
  quest: "questId",
  thread: "threadId",
  general: "", // general 不引用实体，占位符永不读取
} as const satisfies Readonly<Record<StructuredDialogueTopic["kind"], string>>;

/** 每个主题 kind 除 kind 外真正携带的引用字段名；general 不引用实体，故不参与本表。 */
type TopicIdFieldByKind = {
  [K in Exclude<StructuredDialogueTopic["kind"], "general">]: Exclude<
    keyof Extract<StructuredDialogueTopic, Readonly<{ kind: K }>>,
    "kind"
  >;
};

/** 引用型主题的字段名必须与 StructuredDialogueTopic 变体逐一对应，改名/新增字段都编译失败。 */
export type TopicIdFieldLock = Expect<
  IsExactly<Pick<typeof TOPIC_ID_FIELDS, keyof TopicIdFieldByKind>, TopicIdFieldByKind>
>;

// Task 2：entityStore.ts 的 isTopicValue 与 validateTopic 校验同一份 shape，
// 切换 record 时删除它或改为委托本文件的 validator，不要让拷贝作为第二事实来源存活。

// ---------------------------------------------------------------------------
// 公开组件类型
// ---------------------------------------------------------------------------

/** 长期人格锚点：不随回合漂移，只能由后续 Plan 的显式事件改写。 */
export type NpcIdentityAnchors = Readonly<{
  selfConcept: string;
  /** 1..4 条、去重、非空。 */
  values: readonly string[];
  speechStyle: string;
  /** NPC 不会/不能做什么：1..4 条、去重、非空。 */
  capabilityBoundaries: readonly string[];
  /** 长期禁区：0..4 条、去重。 */
  taboos: readonly string[];
}>;

/** 服务端按 npcId + ordinal 铸造的 goalId；规则层不保存玩家原文。 */
export type NpcGoal = Readonly<{
  goalId: string;
  horizon: NpcGoalHorizon;
  description: string;
  priority: NpcGoalPriority;
  status: NpcGoalStatus;
  reason: string;
}>;

/** AI 创建 NPC 时可提交的部分目标；goalId/status 始终由服务端补齐。 */
export type NpcGoalProposal = Readonly<{
  horizon: NpcGoalHorizon;
  description: string;
  priority: NpcGoalPriority;
  reason: string;
}>;

/** AI 只能提出关系姿态；关系数值、来源与承诺由审批/规则层铸造。 */
export const NPC_RELATIONSHIP_SEED_STANCES = Object.freeze([
  "ally", "protective_of", "indebted_to", "rival", "wary",
] as const);
export type NpcRelationshipSeedStance = (typeof NPC_RELATIONSHIP_SEED_STANCES)[number];
export const NPC_RELATIONSHIP_SEED_LIST_MAX = 4;
export type NpcRelationshipSeedProposal = Readonly<{
  targetNpcId: string;
  stance: NpcRelationshipSeedStance;
  /** 只用于审批失败诊断，不进入关系组件。 */
  reason: string;
}>;

const NPC_ANCHOR_KEYS = ["selfConcept", "values", "speechStyle", "capabilityBoundaries", "taboos"] as const;
const NPC_GOAL_PROPOSAL_KEYS = ["horizon", "description", "priority", "reason"] as const;
const NPC_RELATIONSHIP_SEED_KEYS = ["targetNpcId", "stance", "reason"] as const;

function boundedCreationText(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= NPC_CREATION_TEXT_MAX_LENGTH;
}

function hasExactCreationKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key))
    && keys.every((key) => key in value);
}

/** Provider/approval boundary parser shared by opening and world-delta NPC creation. */
export function parseNpcCreationAnchors(value: unknown): NpcIdentityAnchors | null {
  if (!isRecord(value) || !hasExactCreationKeys(value, NPC_ANCHOR_KEYS)) return null;
  if (!boundedCreationText(value.selfConcept) || !boundedCreationText(value.speechStyle)) return null;
  const parseList = (raw: unknown, min: number): readonly string[] | null => {
    if (!Array.isArray(raw) || raw.length < min || raw.length > NPC_ANCHOR_LIST_MAX) return null;
    if (!raw.every(boundedCreationText)) return null;
    const values = raw as readonly string[];
    return new Set(values).size === values.length ? values : null;
  };
  const values = parseList(value.values, NPC_ANCHOR_LIST_MIN);
  const capabilityBoundaries = parseList(value.capabilityBoundaries, NPC_ANCHOR_LIST_MIN);
  const taboos = parseList(value.taboos, NPC_TABOO_LIST_MIN);
  if (values === null || capabilityBoundaries === null || taboos === null) return null;
  const anchors = {
    selfConcept: value.selfConcept,
    values,
    speechStyle: value.speechStyle,
    capabilityBoundaries,
    taboos,
  };
  return validateNpcIdentityAnchors(anchors).length === 0 ? anchors : null;
}

/** Provider/approval boundary parser; IDs and runtime status are intentionally absent. */
export function parseNpcGoalProposals(value: unknown): readonly NpcGoalProposal[] | null {
  if (!Array.isArray(value) || value.length < NPC_GOAL_LIST_MIN || value.length > NPC_GOAL_LIST_MAX) return null;
  const descriptions = new Set<string>();
  const proposals: NpcGoalProposal[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !hasExactCreationKeys(raw, NPC_GOAL_PROPOSAL_KEYS)) return null;
    if (!NPC_GOAL_HORIZONS.includes(raw.horizon as NpcGoalHorizon)) return null;
    if (!NPC_GOAL_PRIORITIES.includes(raw.priority as NpcGoalPriority)) return null;
    if (!boundedCreationText(raw.description) || !boundedCreationText(raw.reason)) return null;
    if (descriptions.has(raw.description)) return null;
    descriptions.add(raw.description);
    proposals.push({
      horizon: raw.horizon as NpcGoalHorizon,
      description: raw.description,
      priority: raw.priority as NpcGoalPriority,
      reason: raw.reason,
    });
  }
  return proposals;
}

/** Provider/approval boundary parser; seed targets are resolved only at approval. */
export function parseNpcRelationshipSeedProposals(value: unknown): readonly NpcRelationshipSeedProposal[] | null {
  if (!Array.isArray(value) || value.length > NPC_RELATIONSHIP_SEED_LIST_MAX) return null;
  const targetIds = new Set<string>();
  const seeds: NpcRelationshipSeedProposal[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !hasExactCreationKeys(raw, NPC_RELATIONSHIP_SEED_KEYS)) return null;
    if (!boundedCreationText(raw.targetNpcId)) return null;
    if (!NPC_RELATIONSHIP_SEED_STANCES.includes(raw.stance as NpcRelationshipSeedStance)) return null;
    if (!boundedCreationText(raw.reason)) return null;
    const targetNpcId = raw.targetNpcId.trim();
    if (targetIds.has(targetNpcId)) return null;
    targetIds.add(targetNpcId);
    seeds.push({
      targetNpcId,
      stance: raw.stance as NpcRelationshipSeedStance,
      reason: raw.reason.trim(),
    });
  }
  return seeds;
}

export type NpcDynamicStateComponent = Readonly<{
  isCompanion: boolean;
  met: boolean;
  emotion: NarrativeEmotion;
  goals: readonly NpcGoal[];
}>;

/** 知识来源判别联合：初始世界事实与经由某个已提交行动学到的事实。 */
export type NpcKnowledgeSource =
  | Readonly<{ kind: "initial_world"; learnedAtTurn: number }>
  | Readonly<{
      kind: "action";
      mode: FactChangeSource;
      actionId: string;
      learnedAtTurn: number;
      sourceNpcId?: NpcId;
    }>;

export type NpcKnowledgeEntry = Readonly<{
  factId: FactId;
  certainty: NpcKnowledgeCertainty;
  disclosure: NpcKnowledgeDisclosure;
  source: NpcKnowledgeSource;
}>;

/** entries 内每个 FactId 唯一：同一事实不得同时以两种来源重复存在。 */
export type NpcKnowledgeComponent = Readonly<{
  entries: readonly NpcKnowledgeEntry[];
}>;

export type RelationshipDimensions = Readonly<{
  affinity: number;
  trust: number;
  fear: number;
  hostility: number;
}>;

/** 维度键表与 RelationshipDimensions 字段集合双向锁定：多一维或漏一维都编译失败。 */
export type RelationshipDimensionKeyLock = Expect<
  IsExactly<RelationshipDimensionKey, keyof RelationshipDimensions>
>;

/** 关系来源判别联合：初始世界种子或某次已提交行动。 */
export type RelationshipSource =
  | Readonly<{ kind: "initial_world"; createdAtTurn: number; reasonKey: string }>
  | Readonly<{ kind: "action"; actionId: string; turnNumber: number }>;

/** evidenceId 由服务端从 actionId + fromId + toId + signal 确定性构造。 */
export type RelationshipEvidence = Readonly<{
  evidenceId: string;
  actionId: string;
  turnNumber: number;
  signal: RelationshipSignal;
  severity: RelationshipSeverity;
  /** 固定枚举/规则 key，不保存玩家原文。 */
  summaryKey: string;
}>;

export type RelationshipCommitment =
  | Readonly<{
      kind: "debt";
      commitmentId: string;
      direction: (typeof RELATIONSHIP_DEBT_DIRECTIONS)[number];
      status: RelationshipDebtStatus;
      description: string;
      source: RelationshipSource;
    }>
  | Readonly<{
      kind: "promise";
      commitmentId: string;
      promisor: (typeof RELATIONSHIP_PROMISORS)[number];
      status: RelationshipPromiseStatus;
      description: string;
      source: RelationshipSource;
    }>;

export type DirectedRelationshipEdge = Readonly<{
  targetId: PlayerEntityId | NpcId;
  dimensions: RelationshipDimensions;
  stage: RelationshipStage;
  trend: RelationshipTrend;
  commitments: readonly RelationshipCommitment[];
  /** 最近 RELATIONSHIP_EVIDENCE_CAP 条，稳定裁剪。 */
  evidence: readonly RelationshipEvidence[];
  origin: RelationshipSource;
  lastChangedAtTurn: number;
}>;

/** outgoing 边按 targetId 唯一并以 compareRelationshipTargetIds 稳定排序。 */
export type NpcRelationshipComponent = Readonly<{
  outgoing: readonly DirectedRelationshipEdge[];
}>;

export type NpcHistoryComponent = Readonly<{
  interactions: readonly NpcInteraction[];
}>;

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 关系边的稳定顺序：validator 与后续 projector/mutation 必须共用同一比较器，
 * 否则「已排序」与「写入顺序」会互相否定。
 */
export function compareRelationshipTargetIds(
  a: PlayerEntityId | NpcId,
  b: PlayerEntityId | NpcId,
): number {
  return compareIds(a, b);
}

// ---------------------------------------------------------------------------
// validator 失败：只有 code + path
// ---------------------------------------------------------------------------

export type NpcComponentValidationCode =
  | "invalid_component_shape"
  | "invalid_field_value"
  | "value_out_of_closed_set"
  | "number_out_of_range"
  | "anchor_count_out_of_range"
  | "duplicate_anchor_entry"
  | "duplicate_goal_id"
  | "duplicate_fact_id"
  | "duplicate_relationship_target"
  | "relationship_targets_unsorted"
  | "duplicate_commitment_id"
  | "duplicate_evidence_id"
  | "relationship_evidence_cap_exceeded"
  | "duplicate_history_action_id"
  | "history_cap_exceeded";

export type NpcComponentValidationIssue = Readonly<{
  code: NpcComponentValidationCode;
  path: string;
}>;

type Issues = NpcComponentValidationIssue[];
type UnknownRecord = Record<string, unknown>;

function issue(code: NpcComponentValidationCode, path: string): NpcComponentValidationIssue {
  return { code, path };
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 回合/序号一类的非负整数计数器。 */
function isTurnCounter(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isBlankText(value: string): boolean {
  return value.trim().length === 0;
}

function matchesEnum<T extends string>(value: unknown, table: readonly T[]): value is T {
  return isString(value) && (table as readonly string[]).includes(value);
}

/** exact keys：required 必须存在，allowed 之外一律视为多余。 */
function hasExactKeys(value: UnknownRecord, required: readonly string[], allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) return false;
  }
  return required.every((key) => key in value);
}

function isComponent(value: unknown, keys: readonly string[]): value is UnknownRecord {
  return isRecord(value) && hasExactKeys(value, keys, keys);
}

/** 必填文本字段：非字符串或全空白都算非法值。 */
function checkText(issues: Issues, value: unknown, path: string): void {
  if (!isString(value) || isBlankText(value)) issues.push(issue("invalid_field_value", path));
}

function checkTurnCounter(issues: Issues, value: unknown, path: string): void {
  if (!isTurnCounter(value)) issues.push(issue("number_out_of_range", path));
}

function checkClosedSet(issues: Issues, value: unknown, path: string, table: readonly string[]): void {
  if (!matchesEnum(value, table)) issues.push(issue("value_out_of_closed_set", path));
}

/** 数值型封闭值域（如 goal priority 阶梯）：非数值或不在表内都是同一个稳定 code。 */
function checkNumberClosedSet(issues: Issues, value: unknown, path: string, table: readonly number[]): void {
  if (!isFiniteNumber(value) || !table.includes(value)) issues.push(issue("value_out_of_closed_set", path));
}

function checkStringArray(issues: Issues, value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_field_value", path));
    return;
  }
  value.forEach((item, index) => {
    if (!isString(item) || isBlankText(item)) issues.push(issue("invalid_field_value", `${path}[${index}]`));
  });
}

/** 锚点列表：条目数、逐条非空与列表内去重。 */
function checkAnchorList(issues: Issues, value: unknown, path: string, min: number): void {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_field_value", path));
    return;
  }
  if (value.length < min || value.length > NPC_ANCHOR_LIST_MAX) {
    issues.push(issue("anchor_count_out_of_range", path));
  }
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (!isString(item) || isBlankText(item)) {
      issues.push(issue("invalid_field_value", `${path}[${index}]`));
      return;
    }
    if (seen.has(item)) issues.push(issue("duplicate_anchor_entry", `${path}[${index}]`));
    else seen.add(item);
  });
}

// ---------------------------------------------------------------------------
// identity anchors
// ---------------------------------------------------------------------------

const ANCHOR_KEYS = ["selfConcept", "values", "speechStyle", "capabilityBoundaries", "taboos"] as const;

export function validateNpcIdentityAnchors(
  value: unknown,
): readonly NpcComponentValidationIssue[] {
  if (!isComponent(value, ANCHOR_KEYS)) return [issue("invalid_component_shape", "anchors")];
  const issues: Issues = [];
  checkText(issues, value.selfConcept, "anchors.selfConcept");
  checkText(issues, value.speechStyle, "anchors.speechStyle");
  checkAnchorList(issues, value.values, "anchors.values", NPC_ANCHOR_LIST_MIN);
  checkAnchorList(issues, value.capabilityBoundaries, "anchors.capabilityBoundaries", NPC_ANCHOR_LIST_MIN);
  checkAnchorList(issues, value.taboos, "anchors.taboos", NPC_TABOO_LIST_MIN);
  return issues;
}

// ---------------------------------------------------------------------------
// dynamic state + goals
// ---------------------------------------------------------------------------

const DYNAMIC_STATE_KEYS = ["isCompanion", "met", "emotion", "goals"] as const;
const GOAL_KEYS = ["goalId", "horizon", "description", "priority", "status", "reason"] as const;

function validateGoal(issues: Issues, raw: unknown, path: string): void {
  if (!isComponent(raw, GOAL_KEYS)) {
    issues.push(issue("invalid_component_shape", path));
    return;
  }
  checkText(issues, raw.goalId, `${path}.goalId`);
  checkText(issues, raw.description, `${path}.description`);
  checkText(issues, raw.reason, `${path}.reason`);
  checkClosedSet(issues, raw.horizon, `${path}.horizon`, NPC_GOAL_HORIZONS);
  checkClosedSet(issues, raw.status, `${path}.status`, NPC_GOAL_STATUSES);
  checkNumberClosedSet(issues, raw.priority, `${path}.priority`, NPC_GOAL_PRIORITIES);
}

export function validateNpcDynamicState(
  value: unknown,
): readonly NpcComponentValidationIssue[] {
  if (!isComponent(value, DYNAMIC_STATE_KEYS)) return [issue("invalid_component_shape", "dynamicState")];
  const issues: Issues = [];
  if (!isBoolean(value.isCompanion)) issues.push(issue("invalid_field_value", "dynamicState.isCompanion"));
  if (!isBoolean(value.met)) issues.push(issue("invalid_field_value", "dynamicState.met"));
  checkClosedSet(issues, value.emotion, "dynamicState.emotion", NARRATIVE_EMOTIONS);
  if (!Array.isArray(value.goals)) {
    issues.push(issue("invalid_field_value", "dynamicState.goals"));
    return issues;
  }
  const seenGoalIds = new Set<string>();
  value.goals.forEach((raw, index) => {
    const path = `dynamicState.goals[${index}]`;
    validateGoal(issues, raw, path);
    if (isRecord(raw) && isString(raw.goalId) && !isBlankText(raw.goalId)) {
      if (seenGoalIds.has(raw.goalId)) issues.push(issue("duplicate_goal_id", `${path}.goalId`));
      else seenGoalIds.add(raw.goalId);
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------
// knowledge
// ---------------------------------------------------------------------------

const KNOWLEDGE_KEYS = ["entries"] as const;
const KNOWLEDGE_ENTRY_KEYS = ["factId", "certainty", "disclosure", "source"] as const;
const KNOWLEDGE_INITIAL_SOURCE_KEYS = ["kind", "learnedAtTurn"] as const;
const KNOWLEDGE_ACTION_SOURCE_KEYS = ["kind", "mode", "actionId", "learnedAtTurn"] as const;
const KNOWLEDGE_ACTION_SOURCE_KEYS_ALLOWED = [...KNOWLEDGE_ACTION_SOURCE_KEYS, "sourceNpcId"] as const;

function validateKnowledgeSource(issues: Issues, raw: unknown, path: string): void {
  if (!isRecord(raw) || !isString(raw.kind)) {
    issues.push(issue("invalid_component_shape", path));
    return;
  }
  if (raw.kind === "initial_world") {
    if (!hasExactKeys(raw, KNOWLEDGE_INITIAL_SOURCE_KEYS, KNOWLEDGE_INITIAL_SOURCE_KEYS)) {
      issues.push(issue("invalid_component_shape", path));
      return;
    }
    checkTurnCounter(issues, raw.learnedAtTurn, `${path}.learnedAtTurn`);
    return;
  }
  if (raw.kind === "action") {
    if (!hasExactKeys(raw, KNOWLEDGE_ACTION_SOURCE_KEYS, KNOWLEDGE_ACTION_SOURCE_KEYS_ALLOWED)) {
      issues.push(issue("invalid_component_shape", path));
      return;
    }
    checkClosedSet(issues, raw.mode, `${path}.mode`, FACT_CHANGE_SOURCES);
    checkText(issues, raw.actionId, `${path}.actionId`);
    checkTurnCounter(issues, raw.learnedAtTurn, `${path}.learnedAtTurn`);
    if (raw.sourceNpcId !== undefined) checkText(issues, raw.sourceNpcId, `${path}.sourceNpcId`);
    return;
  }
  checkClosedSet(issues, raw.kind, `${path}.kind`, NPC_KNOWLEDGE_SOURCE_KINDS);
}

function validateKnowledgeEntry(issues: Issues, raw: unknown, path: string): void {
  if (!isComponent(raw, KNOWLEDGE_ENTRY_KEYS)) {
    issues.push(issue("invalid_component_shape", path));
    return;
  }
  checkText(issues, raw.factId, `${path}.factId`);
  checkClosedSet(issues, raw.certainty, `${path}.certainty`, NPC_KNOWLEDGE_CERTAINTIES);
  checkClosedSet(issues, raw.disclosure, `${path}.disclosure`, NPC_KNOWLEDGE_DISCLOSURES);
  validateKnowledgeSource(issues, raw.source, `${path}.source`);
}

export function validateNpcKnowledge(
  value: unknown,
): readonly NpcComponentValidationIssue[] {
  if (!isComponent(value, KNOWLEDGE_KEYS)) return [issue("invalid_component_shape", "knowledge")];
  if (!Array.isArray(value.entries)) return [issue("invalid_field_value", "knowledge.entries")];
  const issues: Issues = [];
  const seenFactIds = new Set<string>();
  value.entries.forEach((raw, index) => {
    const path = `knowledge.entries[${index}]`;
    validateKnowledgeEntry(issues, raw, path);
    if (isRecord(raw) && isString(raw.factId) && !isBlankText(raw.factId)) {
      if (seenFactIds.has(raw.factId)) issues.push(issue("duplicate_fact_id", `${path}.factId`));
      else seenFactIds.add(raw.factId);
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------
// relationships
// ---------------------------------------------------------------------------

const RELATIONSHIP_KEYS = ["outgoing"] as const;
const EDGE_KEYS = [
  "targetId", "dimensions", "stage", "trend", "commitments", "evidence", "origin", "lastChangedAtTurn",
] as const;
const DEBT_COMMITMENT_KEYS = [
  "kind", "commitmentId", "direction", "status", "description", "source",
] as const;
const PROMISE_COMMITMENT_KEYS = [
  "kind", "commitmentId", "promisor", "status", "description", "source",
] as const;
const EVIDENCE_KEYS = ["evidenceId", "actionId", "turnNumber", "signal", "severity", "summaryKey"] as const;
const RELATIONSHIP_INITIAL_SOURCE_KEYS = ["kind", "createdAtTurn", "reasonKey"] as const;
const RELATIONSHIP_ACTION_SOURCE_KEYS = ["kind", "actionId", "turnNumber"] as const;

function validateRelationshipSource(issues: Issues, raw: unknown, path: string): void {
  if (!isRecord(raw) || !isString(raw.kind)) {
    issues.push(issue("invalid_component_shape", path));
    return;
  }
  if (raw.kind === "initial_world") {
    if (!hasExactKeys(raw, RELATIONSHIP_INITIAL_SOURCE_KEYS, RELATIONSHIP_INITIAL_SOURCE_KEYS)) {
      issues.push(issue("invalid_component_shape", path));
      return;
    }
    checkTurnCounter(issues, raw.createdAtTurn, `${path}.createdAtTurn`);
    checkText(issues, raw.reasonKey, `${path}.reasonKey`);
    return;
  }
  if (raw.kind === "action") {
    if (!hasExactKeys(raw, RELATIONSHIP_ACTION_SOURCE_KEYS, RELATIONSHIP_ACTION_SOURCE_KEYS)) {
      issues.push(issue("invalid_component_shape", path));
      return;
    }
    checkText(issues, raw.actionId, `${path}.actionId`);
    checkTurnCounter(issues, raw.turnNumber, `${path}.turnNumber`);
    return;
  }
  checkClosedSet(issues, raw.kind, `${path}.kind`, RELATIONSHIP_SOURCE_KINDS);
}

function validateEvidence(issues: Issues, raw: unknown, path: string): void {
  if (!isComponent(raw, EVIDENCE_KEYS)) {
    issues.push(issue("invalid_component_shape", path));
    return;
  }
  checkText(issues, raw.evidenceId, `${path}.evidenceId`);
  checkText(issues, raw.actionId, `${path}.actionId`);
  checkText(issues, raw.summaryKey, `${path}.summaryKey`);
  checkTurnCounter(issues, raw.turnNumber, `${path}.turnNumber`);
  checkClosedSet(issues, raw.signal, `${path}.signal`, RELATIONSHIP_SIGNALS);
  checkClosedSet(issues, raw.severity, `${path}.severity`, RELATIONSHIP_SEVERITIES);
}

function validateCommitment(issues: Issues, raw: unknown, path: string): void {
  if (!isRecord(raw) || !isString(raw.kind)) {
    issues.push(issue("invalid_component_shape", path));
    return;
  }
  if (raw.kind === "debt") {
    if (!hasExactKeys(raw, DEBT_COMMITMENT_KEYS, DEBT_COMMITMENT_KEYS)) {
      issues.push(issue("invalid_component_shape", path));
      return;
    }
    checkText(issues, raw.commitmentId, `${path}.commitmentId`);
    checkText(issues, raw.description, `${path}.description`);
    checkClosedSet(issues, raw.direction, `${path}.direction`, RELATIONSHIP_DEBT_DIRECTIONS);
    checkClosedSet(issues, raw.status, `${path}.status`, RELATIONSHIP_DEBT_STATUSES);
    validateRelationshipSource(issues, raw.source, `${path}.source`);
    return;
  }
  if (raw.kind === "promise") {
    if (!hasExactKeys(raw, PROMISE_COMMITMENT_KEYS, PROMISE_COMMITMENT_KEYS)) {
      issues.push(issue("invalid_component_shape", path));
      return;
    }
    checkText(issues, raw.commitmentId, `${path}.commitmentId`);
    checkText(issues, raw.description, `${path}.description`);
    checkClosedSet(issues, raw.promisor, `${path}.promisor`, RELATIONSHIP_PROMISORS);
    checkClosedSet(issues, raw.status, `${path}.status`, RELATIONSHIP_PROMISE_STATUSES);
    validateRelationshipSource(issues, raw.source, `${path}.source`);
    return;
  }
  checkClosedSet(issues, raw.kind, `${path}.kind`, RELATIONSHIP_COMMITMENT_KINDS);
}

function validateDimensions(issues: Issues, raw: unknown, path: string): void {
  if (!isComponent(raw, RELATIONSHIP_DIMENSION_KEYS)) {
    issues.push(issue("invalid_component_shape", path));
    return;
  }
  for (const key of RELATIONSHIP_DIMENSION_KEYS) {
    const at = `${path}.${key}`;
    const dimension = raw[key];
    if (!isFiniteNumber(dimension)) {
      issues.push(issue("invalid_field_value", at));
      continue;
    }
    if (dimension < RELATIONSHIP_DIMENSION_MIN || dimension > RELATIONSHIP_DIMENSION_MAX) {
      issues.push(issue("number_out_of_range", at));
    }
  }
}

function validateEdge(issues: Issues, raw: unknown, path: string): void {
  if (!isComponent(raw, EDGE_KEYS)) {
    issues.push(issue("invalid_component_shape", path));
    return;
  }
  checkText(issues, raw.targetId, `${path}.targetId`);
  validateDimensions(issues, raw.dimensions, `${path}.dimensions`);
  checkClosedSet(issues, raw.stage, `${path}.stage`, RELATIONSHIP_STAGES);
  checkClosedSet(issues, raw.trend, `${path}.trend`, RELATIONSHIP_TRENDS);
  checkTurnCounter(issues, raw.lastChangedAtTurn, `${path}.lastChangedAtTurn`);
  validateRelationshipSource(issues, raw.origin, `${path}.origin`);

  if (Array.isArray(raw.commitments)) {
    const seenCommitmentIds = new Set<string>();
    raw.commitments.forEach((commitment, index) => {
      const at = `${path}.commitments[${index}]`;
      validateCommitment(issues, commitment, at);
      if (isRecord(commitment) && isString(commitment.commitmentId) && !isBlankText(commitment.commitmentId)) {
        if (seenCommitmentIds.has(commitment.commitmentId)) {
          issues.push(issue("duplicate_commitment_id", `${at}.commitmentId`));
        } else {
          seenCommitmentIds.add(commitment.commitmentId);
        }
      }
    });
  } else {
    issues.push(issue("invalid_field_value", `${path}.commitments`));
  }

  if (!Array.isArray(raw.evidence)) {
    issues.push(issue("invalid_field_value", `${path}.evidence`));
    return;
  }
  if (raw.evidence.length > RELATIONSHIP_EVIDENCE_CAP) {
    issues.push(issue("relationship_evidence_cap_exceeded", `${path}.evidence`));
  }
  const seenEvidenceIds = new Set<string>();
  raw.evidence.forEach((entry, index) => {
    const at = `${path}.evidence[${index}]`;
    validateEvidence(issues, entry, at);
    if (isRecord(entry) && isString(entry.evidenceId) && !isBlankText(entry.evidenceId)) {
      if (seenEvidenceIds.has(entry.evidenceId)) issues.push(issue("duplicate_evidence_id", `${at}.evidenceId`));
      else seenEvidenceIds.add(entry.evidenceId);
    }
  });
}

export function validateNpcRelationships(
  value: unknown,
): readonly NpcComponentValidationIssue[] {
  if (!isComponent(value, RELATIONSHIP_KEYS)) return [issue("invalid_component_shape", "relationships")];
  if (!Array.isArray(value.outgoing)) return [issue("invalid_field_value", "relationships.outgoing")];
  const issues: Issues = [];
  const seenTargets = new Set<string>();
  let previous: string | undefined;
  value.outgoing.forEach((raw, index) => {
    const path = `relationships.outgoing[${index}]`;
    validateEdge(issues, raw, path);
    if (!isRecord(raw) || !isString(raw.targetId) || isBlankText(raw.targetId)) return;
    if (seenTargets.has(raw.targetId)) {
      issues.push(issue("duplicate_relationship_target", `${path}.targetId`));
    } else {
      seenTargets.add(raw.targetId);
    }
    if (previous !== undefined && compareIds(previous, raw.targetId) > 0) {
      issues.push(issue("relationship_targets_unsorted", `${path}.targetId`));
    }
    previous = raw.targetId;
  });
  return issues;
}

// ---------------------------------------------------------------------------
// history（沿用 Plan 2 的 NpcInteraction 形状，仍按 actionId 去重）
// ---------------------------------------------------------------------------

const HISTORY_KEYS = ["interactions"] as const;
// 交互记录仍沿用 Plan 2 的 NpcInteraction：本表是那份字段清单的逐字拷贝，
// 而 validateInteraction 用 exact-keys 判定，所以拷贝是承重的。NpcInteraction 新增
// 任何必需或可选字段而本表未同步时，所有合法记录都会在存档解析期被判成
// invalid_component_shape，且没有任何编译期信号——因此下面用类型锁住，不靠人记。
const INTERACTION_REQUIRED_KEYS = [
  "turnNumber", "actionId", "locationId", "dialogueAct", "topicSummary", "outcome",
  "relationshipDelta", "learnedFactIds", "summary",
] as const;
const INTERACTION_KEYS_ALLOWED = [...INTERACTION_REQUIRED_KEYS, "topic"] as const;

/** 字段清单与 NpcInteraction 的键集合必须逐项一致：漏一项或多一项都在 typecheck 阶段失败。 */
export type NpcInteractionKeyLock = Expect<
  IsExactly<keyof NpcInteraction, (typeof INTERACTION_REQUIRED_KEYS)[number] | "topic">
>;

// Task 2：entityStore.ts 的 isInteractionValue 与 validateInteraction 校验同一份 shape，
// 切换 record 时删除它或改为委托 validateNpcHistory，不要让拷贝作为第二事实来源存活。

function validateTopic(issues: Issues, raw: unknown, path: string): void {
  if (!isRecord(raw) || !isString(raw.kind)) {
    issues.push(issue("invalid_component_shape", path));
    return;
  }
  if (!matchesEnum(raw.kind, TOPIC_KINDS)) {
    issues.push(issue("value_out_of_closed_set", `${path}.kind`));
    return;
  }
  const required = raw.kind === "general" ? (["kind"] as const) : (["kind", TOPIC_ID_FIELDS[raw.kind]] as const);
  if (!hasExactKeys(raw, required, required)) {
    issues.push(issue("invalid_component_shape", path));
    return;
  }
  if (raw.kind !== "general") checkText(issues, raw[TOPIC_ID_FIELDS[raw.kind]], `${path}.${TOPIC_ID_FIELDS[raw.kind]}`);
}

function validateInteraction(issues: Issues, raw: unknown, path: string): void {
  if (!isRecord(raw) || !hasExactKeys(raw, INTERACTION_REQUIRED_KEYS, INTERACTION_KEYS_ALLOWED)) {
    issues.push(issue("invalid_component_shape", path));
    return;
  }
  checkTurnCounter(issues, raw.turnNumber, `${path}.turnNumber`);
  checkText(issues, raw.actionId, `${path}.actionId`);
  checkText(issues, raw.locationId, `${path}.locationId`);
  checkText(issues, raw.topicSummary, `${path}.topicSummary`);
  checkText(issues, raw.summary, `${path}.summary`);
  if (!isFiniteNumber(raw.relationshipDelta)) issues.push(issue("invalid_field_value", `${path}.relationshipDelta`));
  checkStringArray(issues, raw.learnedFactIds, `${path}.learnedFactIds`);
  if (!isString(raw.dialogueAct) || !DIALOGUE_ACT_VALUES.includes(raw.dialogueAct)) {
    issues.push(issue("value_out_of_closed_set", `${path}.dialogueAct`));
  }
  checkClosedSet(issues, raw.outcome, `${path}.outcome`, INTERACTION_OUTCOMES);
  if (raw.topic !== undefined) validateTopic(issues, raw.topic, `${path}.topic`);
}

export function validateNpcHistory(
  value: unknown,
): readonly NpcComponentValidationIssue[] {
  if (!isComponent(value, HISTORY_KEYS)) return [issue("invalid_component_shape", "history")];
  if (!Array.isArray(value.interactions)) return [issue("invalid_field_value", "history.interactions")];
  const issues: Issues = [];
  if (value.interactions.length > NPC_HISTORY_CAP) {
    issues.push(issue("history_cap_exceeded", "history.interactions"));
  }
  const seenActionIds = new Set<string>();
  value.interactions.forEach((raw, index) => {
    const path = `history.interactions[${index}]`;
    validateInteraction(issues, raw, path);
    if (isRecord(raw) && isString(raw.actionId) && !isBlankText(raw.actionId)) {
      if (seenActionIds.has(raw.actionId)) issues.push(issue("duplicate_history_action_id", `${path}.actionId`));
      else seenActionIds.add(raw.actionId);
    }
  });
  return issues;
}
