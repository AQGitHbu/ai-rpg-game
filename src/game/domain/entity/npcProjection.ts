import { PLAYER_ENTITY_ID } from "../worldEntity";
import type { FactId } from "../worldEntity";
import type { NpcEntry, NpcMemory } from "../worldEntries";
import type { NpcEntityRecord } from "./entityRecord";
import {
  NPC_HISTORY_CAP,
  compareRelationshipTargetIds,
} from "./npcComponents";
import type {
  DirectedRelationshipEdge, NpcDynamicStateComponent, NpcGoal, NpcHistoryComponent,
  NpcIdentityAnchors, NpcKnowledgeComponent, NpcKnowledgeDisclosure, NpcKnowledgeEntry,
  NpcKnowledgeSource, NpcRelationshipComponent,
} from "./npcComponents";

// ---------------------------------------------------------------------------
// NPC 分层组件 ↔ legacy NpcEntry 的唯一投影通道（Plan 3 / Task 2）。
//
// 分层组件是唯一事实源：NpcEntry.memory 一律由 projectNpcMemory 重建。反方向的
// importNpcLayers 仅服务兼容投影与旧 fixture，将旧形状确定性导入分层组件；正式规则
// 写入只能通过 EntityMutation 的细粒度通道完成。
//
// 本文件属于 domain：不 import gameplay / application，不持 IO，纯函数。
// ---------------------------------------------------------------------------

/** 过渡桥造物的固定规则 key：不写入任何 AI 或玩家原文。 */
export const LEGACY_IMPORT_REASON_KEY = "legacy_import";

/** 目标 ID 由 npcId + ordinal 确定性铸造，规则层不保存自由文本。 */
export function npcGoalId(npcId: string, ordinal: number): string {
  return `${npcId}_goal_${ordinal}`;
}

/** @deprecated 仅供旧兼容夹具的 deterministic legacy adapter 使用。 */
export function npcLegacyGoalId(npcId: string, ordinal: number): string {
  return npcGoalId(npcId, ordinal);
}

export type NpcImportedLayers = Readonly<{
  anchors: NpcIdentityAnchors;
  dynamicState: NpcDynamicStateComponent;
  knowledge: NpcKnowledgeComponent;
  relationships: NpcRelationshipComponent;
  history: NpcHistoryComponent;
}>;

// ---------------------------------------------------------------------------
// 原语
// ---------------------------------------------------------------------------

function sameTextList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sameFactId(a: FactId, b: FactId): boolean {
  return String(a) === String(b);
}

function findFact<T extends Readonly<{ factId: FactId }>>(list: readonly T[], factId: FactId): T | undefined {
  return list.find((entry) => sameFactId(entry.factId, factId));
}

/** goals 的可表达子集：只有 active/blocked 才是玩家可见的「当前目标」。 */
function visibleGoals(goals: readonly NpcGoal[]): readonly string[] {
  return goals.filter((goal) => goal.status === "active" || goal.status === "blocked").map((goal) => goal.description);
}

function legacyGoal(npcId: string, index: number, description: string): NpcGoal {
  return {
    goalId: npcGoalId(npcId, index + 1),
    horizon: "short",
    description,
    priority: 3,
    status: "active",
    reason: LEGACY_IMPORT_REASON_KEY,
  };
}

function legacyImportAnchors(): NpcIdentityAnchors {
  return {
    selfConcept: LEGACY_IMPORT_REASON_KEY,
    values: [LEGACY_IMPORT_REASON_KEY],
    speechStyle: LEGACY_IMPORT_REASON_KEY,
    capabilityBoundaries: [LEGACY_IMPORT_REASON_KEY],
    taboos: [],
  };
}

// ---------------------------------------------------------------------------
// store → legacy
// ---------------------------------------------------------------------------

function playerEdgeOf(record: NpcEntityRecord): DirectedRelationshipEdge | undefined {
  return record.relationships.outgoing.find((edge) => edge.targetId === PLAYER_ENTITY_ID);
}

/** legacy memory 的唯一定义：任何其它位置都不得再拼一份。 */
export function projectNpcMemory(record: NpcEntityRecord): NpcMemory {
  return {
    npcId: record.core.id,
    knownFactIds: record.knowledge.entries.map((entry) => entry.factId),
    hiddenFactIds: record.knowledge.entries
      .filter((entry) => entry.disclosure === "secret")
      .map((entry) => entry.factId),
    interactionHistory: [...record.history.interactions],
    relationship: { affinity: playerEdgeOf(record)?.dimensions.affinity ?? 0 },
    emotion: record.dynamicState.emotion,
    goals: visibleGoals(record.dynamicState.goals),
  };
}

export function projectNpcEntry(record: NpcEntityRecord): NpcEntry {
  return {
    id: record.core.id,
    name: record.core.name,
    role: record.identity.role,
    description: record.identity.description,
    locationId: record.position.locationId,
    isCompanion: record.dynamicState.isCompanion,
    tags: [...record.identity.tags],
    met: record.dynamicState.met,
    memory: projectNpcMemory(record),
  };
}

/**
 * legacy 可表达范围的确定性归一：
 * - 「藏着某事」的前提是知道它，故 hidden 并入 known（顺序保持，缺的追加）；
 * - 交互历史按 actionId 保首位去重，并只留最近 NPC_HISTORY_CAP 条。
 */
export function normalizeLegacyNpcMemory(memory: NpcMemory): NpcMemory {
  const knownFactIds = [...memory.knownFactIds];
  for (const factId of memory.hiddenFactIds) {
    if (findFact(knownFactIds.map((id) => ({ factId: id })), factId) === undefined) knownFactIds.push(factId);
  }
  const seen = new Set<string>();
  const interactions = memory.interactionHistory.filter((entry) => {
    if (seen.has(entry.actionId)) return false;
    seen.add(entry.actionId);
    return true;
  });
  return {
    ...memory,
    knownFactIds,
    hiddenFactIds: [...memory.hiddenFactIds],
    interactionHistory: interactions.length > NPC_HISTORY_CAP
      ? interactions.slice(interactions.length - NPC_HISTORY_CAP)
      : interactions,
  };
}

export function normalizeLegacyNpcEntry(entry: NpcEntry): NpcEntry {
  return { ...entry, memory: normalizeLegacyNpcMemory(entry.memory) };
}

// ---------------------------------------------------------------------------
// legacy → 分层组件
// ---------------------------------------------------------------------------

/**
 * 兼容导入专用：legacy 只能表达 known/hidden FactId。
 *
 * 已有 entry 的 certainty、disclosure 和 source 都是分层事实；只有 legacy 明确给出的
 * hidden ID 才能把 disclosure 映射为 secret。legacy 新增的 ID 没有行动证据，只能显式
 * 构造 initial_world source，不能在这里创造 action-era provenance。
 */
function importLegacyKnowledge(input: Readonly<{
  memory: NpcMemory;
  turn: number;
  previous: readonly NpcKnowledgeEntry[];
}>): NpcKnowledgeComponent {
  const { memory, turn, previous } = input;
  const hidden = new Set(memory.hiddenFactIds.map(String));
  const entries = memory.knownFactIds.map((factId): NpcKnowledgeEntry => {
    const retained = findFact(previous, factId);
    const disclosure: NpcKnowledgeDisclosure = hidden.has(String(factId))
      ? "secret"
      : retained?.disclosure ?? "public";
    const source: NpcKnowledgeSource = retained?.source ?? { kind: "initial_world", learnedAtTurn: turn };
    return {
      factId,
      certainty: retained?.certainty ?? "known",
      disclosure,
      source,
    };
  });
  return { entries };
}

function importEdge(input: Readonly<{
  affinity: number;
  met: boolean;
  turn: number;
}>): DirectedRelationshipEdge {
  const { affinity, met, turn } = input;
  return {
    targetId: PLAYER_ENTITY_ID,
    dimensions: { affinity, trust: 0, fear: 0, hostility: 0 },
    stage: met ? "acquainted" : "unknown",
    trend: "stable",
    commitments: [],
    evidence: [],
    origin: { kind: "initial_world", createdAtTurn: turn, reasonKey: LEGACY_IMPORT_REASON_KEY },
    lastChangedAtTurn: turn,
  };
}

/**
 * 关系边只同步 legacy 能观察到的 affinity：其余维度、stage、trend、commitments、
 * evidence 与 origin 一律原样保留。零差量不建边（全新导入除外）。
 */
function compileRelationships(input: Readonly<{
  memory: NpcMemory;
  met: boolean;
  turn: number;
  previous: readonly DirectedRelationshipEdge[];
  freshImport: boolean;
}>): NpcRelationshipComponent {
  const { memory, met, turn, previous, freshImport } = input;
  const affinity = memory.relationship.affinity;
  const index = previous.findIndex((edge) => edge.targetId === PLAYER_ENTITY_ID);
  let outgoing: DirectedRelationshipEdge[];
  if (index >= 0) {
    const edge = previous[index]!;
    outgoing = edge.dimensions.affinity === affinity
      ? [...previous]
      : previous.map((entry, at) => at === index
        ? { ...entry, dimensions: { ...entry.dimensions, affinity }, lastChangedAtTurn: turn }
        : entry);
  } else if (freshImport || affinity !== 0) {
    outgoing = [...previous, importEdge({ affinity, met, turn })];
  } else {
    outgoing = [...previous];
  }
  return { outgoing: outgoing.sort((left, right) => compareRelationshipTargetIds(left.targetId, right.targetId)) };
}

function compileDynamicState(input: Readonly<{
  memory: NpcMemory;
  npcId: string;
  isCompanion: boolean;
  met: boolean;
  previous: NpcDynamicStateComponent | undefined;
}>): NpcDynamicStateComponent {
  const { memory, npcId, isCompanion, met, previous } = input;
  const goals = previous !== undefined && sameTextList(visibleGoals(previous.goals), memory.goals)
    ? previous.goals
    : memory.goals.map((description, index) => legacyGoal(npcId, index, description));
  return { isCompanion, met, emotion: memory.emotion, goals };
}

function buildLayers(input: Readonly<{
  entry: NpcEntry;
  createdAtTurn: number;
  previous: NpcEntityRecord | undefined;
}>): NpcImportedLayers {
  const { entry, createdAtTurn, previous } = input;
  const memory = normalizeLegacyNpcMemory(entry.memory);
  const normalized: NpcEntry = { ...entry, memory };
  const turn = createdAtTurn;
  const npcId = String(entry.id);
  return {
    anchors: previous?.identity.anchors ?? legacyImportAnchors(),
    dynamicState: compileDynamicState({
      memory,
      npcId,
      isCompanion: normalized.isCompanion,
      met: normalized.met,
      previous: previous?.dynamicState,
    }),
    knowledge: importLegacyKnowledge({
      memory,
      turn,
      previous: previous?.knowledge.entries ?? [],
    }),
    relationships: compileRelationships({
      memory,
      met: normalized.met,
      turn,
      previous: previous?.relationships.outgoing ?? [],
      freshImport: previous === undefined,
    }),
    history: { interactions: [...memory.interactionHistory] },
  };
}

/**
 * 兼容投影 → 分层组件。previous 存在时其组件逐字保留，只应用 legacy 可观察差量；
 * previous 缺省即全新导入：anchors / goalId / knowledge provenance / player 边
 * 全部按 legacy_import 确定性生成（Task 6 用显式创建材料替换生产路径的回退）。
 */
/** @internal Compatibility-only legacy projection adapter; runtime rules use narrow mutations. */
export function importNpcLayers(input: Readonly<{
  entry: NpcEntry;
  createdAtTurn: number;
  previous?: NpcEntityRecord;
}>): NpcImportedLayers {
  return buildLayers({
    entry: input.entry,
    createdAtTurn: input.createdAtTurn,
    previous: input.previous,
  });
}
