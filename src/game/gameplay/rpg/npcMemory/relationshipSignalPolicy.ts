import {
  RELATIONSHIP_COMMITMENT_KINDS,
  RELATIONSHIP_DEBT_DIRECTIONS,
  RELATIONSHIP_DIMENSION_KEYS,
  RELATIONSHIP_DIMENSION_MAX,
  RELATIONSHIP_DIMENSION_MIN,
  RELATIONSHIP_EVIDENCE_CAP,
  RELATIONSHIP_PROMISORS,
  RELATIONSHIP_STAGES,
  compareRelationshipTargetIds,
  type DirectedRelationshipEdge,
  type NpcRelationshipComponent,
  type RelationshipCommitment,
  type RelationshipDebtStatus,
  type RelationshipDimensionKey,
  type RelationshipDimensions,
  type RelationshipEvidence,
  type RelationshipPromiseStatus,
  type RelationshipSeverity,
  type RelationshipSignal,
  type RelationshipSource,
  type RelationshipStage,
  type RelationshipTrend,
} from "@/game/domain/entity";
import type { NpcId, PlayerEntityId } from "@/game/domain/worldEntity";

// ---------------------------------------------------------------------------
// Plan 3 Task 3A：关系规则层（gameplay/rpg/npcMemory）。
//
// 本模块是**唯一**能移动关系数值的场所：AI 与客户端只提交 `RelationshipSignal`，
// 数值 delta、severity、trend、stage 与 commitment 全部由下面的固定表与纯函数决定。
// 它只 import domain，绝不 import application / persistence / prompt，也绝不被
// domain 反向 import（分层：domain → gameplay/rpg → application）。
//
// 计划文本没有逐字规定的三处读法，本模块取更严格的一种：
// 1. cap 的度量对象是本次写入的 delta 之和，在 [-100,100] 边界 clamp **之前**判定：
//    边界只会让实际变化更小、不会更大，因此先判 cap 再 clamp 落在保守侧。
// 2. 「同一行动对同一边同一维度的累计变化还要受 cap 限制」按 incoming signal 的
//    severity 判定：同一 actionId 已写入的 delta 由证据条目（携带 actionId + signal）
//    从表中重建；累计幅度超出单维 cap 的格子裁到 0，再按维度逆序裁到总和 cap。
//    已写入的部分不回滚，因此累计只会更小、永远不会更大。
// 3. 「每个已提交 action 最多沿允许图移动一档」用边内既有证据实现：同一 actionId
//    在本边已有证据 ⇒ 本行动已用掉唯一一档 stage 预算，后续信号只写维度与证据。
//    这条判据只会低估、不会高估移动次数，因此不可能出现一个行动动两档。
//
// 初始种子（ally/rival/wary/indebted_to/protective_of → 保守初值 + open debt）属
// Task 6：本文件不预建种子表，避免同一事实出现第二个来源。
// ---------------------------------------------------------------------------

type Expect<T extends true> = T;
type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// ---------------------------------------------------------------------------
// 数值上下限
// ---------------------------------------------------------------------------

/** normal / major 两档 cap：单维绝对变化与四维绝对变化总和。 */
export const RELATIONSHIP_SIGNAL_CAPS = Object.freeze({
  normal: Object.freeze({ singleDimension: 5, total: 8 }),
  major: Object.freeze({ singleDimension: 12, total: 20 }),
} as const satisfies Readonly<
  Record<RelationshipSeverity, Readonly<{ singleDimension: number; total: number }>>
>);

export type RelationshipSignalCaps = (typeof RELATIONSHIP_SIGNAL_CAPS)[RelationshipSeverity];

/**
 * cap 表必须覆盖 domain 的 severity 封闭 union：新增一档 severity 而没有配 cap
 * 直接在 typecheck 失败。（cap 与 [-100,100] 的数值关系由测试断言：
 * esbuild 无法解析类型位置的 `<`，故不用类型级比较。）
 */
export type RelationshipCapsCoverageLock = Expect<
  IsExactly<keyof typeof RELATIONSHIP_SIGNAL_CAPS, RelationshipSeverity>
>;

// ---------------------------------------------------------------------------
// commitment：封闭操作集合与状态迁移表
// ---------------------------------------------------------------------------

export const RELATIONSHIP_COMMITMENT_OP_KINDS = Object.freeze([
  "open_debt", "open_promise", "fulfill", "forgive", "break", "release",
] as const);
export type RelationshipCommitmentOpKind = (typeof RELATIONSHIP_COMMITMENT_OP_KINDS)[number];

/** 结案类操作：只有这四个能作用于已存在的 commitment；`open_*` 是创建类。 */
export type RelationshipCommitmentStatusOp = Exclude<RelationshipCommitmentOpKind, "open_debt" | "open_promise">;

export const RELATIONSHIP_COMMITMENT_TARGETS = Object.freeze(["promise", "debt", "any_open"] as const);
export type RelationshipCommitmentTarget = (typeof RELATIONSHIP_COMMITMENT_TARGETS)[number];

export type RelationshipCommitmentKind = (typeof RELATIONSHIP_COMMITMENT_KINDS)[number];
export type RelationshipDebtDirection = (typeof RELATIONSHIP_DEBT_DIRECTIONS)[number];
export type RelationshipPromisor = (typeof RELATIONSHIP_PROMISORS)[number];
export type RelationshipCommitmentStatus = RelationshipDebtStatus | RelationshipPromiseStatus;

/** 状态迁移表：Record 覆盖四个结案操作，非法组合必须是 null，漏一格都编译失败。 */
const DEBT_STATUS_TRANSITIONS = {
  fulfill: "fulfilled",
  forgive: "forgiven",
  break: "broken",
  release: null,
} as const satisfies Readonly<Record<RelationshipCommitmentStatusOp, RelationshipDebtStatus | null>>;

const PROMISE_STATUS_TRANSITIONS = {
  fulfill: "fulfilled",
  forgive: null,
  break: "broken",
  release: "released",
} as const satisfies Readonly<Record<RelationshipCommitmentStatusOp, RelationshipPromiseStatus | null>>;

export type RelationshipCommitmentOperation =
  | Readonly<{
      kind: "open_debt";
      /** 同一行动内区分多笔债/多个承诺；参与确定性 ID，不携带玩家原文。 */
      openKey: string;
      direction: RelationshipDebtDirection;
      description: string;
    }>
  | Readonly<{ kind: "open_promise"; openKey: string; promisor: RelationshipPromisor; description: string }>
  | Readonly<{ kind: RelationshipCommitmentStatusOp; commitmentId: string }>;

/** 信号表里可选的承诺动作：与上面的公开 API 共用同一封闭操作名集合，不另立名字。 */
export type RelationshipSignalCommitmentRule =
  | Readonly<{ op: "open_debt"; openKey: string; direction: RelationshipDebtDirection; description: string }>
  | Readonly<{ op: "open_promise"; openKey: string; promisor: RelationshipPromisor; description: string }>
  | Readonly<{ op: RelationshipCommitmentStatusOp; target: RelationshipCommitmentTarget }>;

// ---------------------------------------------------------------------------
// signal 固定表
// ---------------------------------------------------------------------------

export type RelationshipSignalRule = Readonly<{
  severity: RelationshipSeverity;
  trend: RelationshipTrend;
  /** 四维有符号 delta；缺项即 0，不用 undefined 表达「无变化」。 */
  dimensions: RelationshipDimensions;
  /** 只写规则 key，不写玩家原文。 */
  summaryKey: string;
  commitment?: RelationshipSignalCommitmentRule;
}>;

function delta(affinity: number, trust: number, fear = 0, hostility = 0): RelationshipDimensions {
  return { affinity, trust, fear, hostility };
}

/**
 * signal → 固定变化。键集合由 `satisfies Record<RelationshipSignal, ...>` 锁死：
 * domain 的封闭 union 增删成员时，本表漏一项或多一项都在 typecheck 阶段失败，
 * 不存在「新增 signal 却静默零变化」的通道。
 */
const SIGNAL_RULES = {
  supported: {
    severity: "normal", trend: "improving", dimensions: delta(3, 2),
    summaryKey: "relationship.signal.supported",
  },
  challenged: {
    severity: "normal", trend: "worsening", dimensions: delta(-3, -1),
    summaryKey: "relationship.signal.challenged",
  },
  threatened: {
    severity: "major", trend: "worsening", dimensions: delta(-4, 0, 10, 4),
    summaryKey: "relationship.signal.threatened",
  },
  deceived: {
    severity: "major", trend: "worsening", dimensions: delta(-3, -12, 0, 5),
    summaryKey: "relationship.signal.deceived",
  },
  offered_help: {
    severity: "normal", trend: "improving", dimensions: delta(2, 3),
    summaryKey: "relationship.signal.offered_help",
  },
  reassured: {
    severity: "normal", trend: "improving", dimensions: delta(2, 2, -3),
    summaryKey: "relationship.signal.reassured",
  },
  refused: {
    severity: "normal", trend: "worsening", dimensions: delta(-2, -3),
    summaryKey: "relationship.signal.refused",
  },
  gave_item: {
    severity: "normal", trend: "improving", dimensions: delta(4, 1),
    summaryKey: "relationship.signal.gave_item",
    // 收了对方的东西 ⇒ 本 NPC（source）欠对方一笔
    commitment: {
      op: "open_debt",
      openKey: "gave_item",
      direction: "source_owes_target",
      description: "relationship.commitment.debt.received_gift",
    },
  },
  shared_fact: {
    severity: "normal", trend: "improving", dimensions: delta(1, 3),
    summaryKey: "relationship.signal.shared_fact",
  },
  fought_together: {
    severity: "major", trend: "improving", dimensions: delta(6, 6, 0, -6),
    summaryKey: "relationship.signal.fought_together",
  },
  betrayed: {
    severity: "major", trend: "worsening", dimensions: delta(0, -12, 0, 8),
    summaryKey: "relationship.signal.betrayed",
    commitment: { op: "break", target: "any_open" },
  },
  kept_promise: {
    severity: "major", trend: "improving", dimensions: delta(2, 10),
    summaryKey: "relationship.signal.kept_promise",
    commitment: { op: "fulfill", target: "promise" },
  },
  broke_promise: {
    severity: "major", trend: "worsening", dimensions: delta(-4, -10, 0, 4),
    summaryKey: "relationship.signal.broke_promise",
    commitment: { op: "break", target: "promise" },
  },
} as const satisfies Readonly<Record<RelationshipSignal, RelationshipSignalRule>>;

/** 关系信号规则表：只读，任何调用方都不得在运行时改写。 */
export const RELATIONSHIP_SIGNAL_POLICY: Readonly<Record<RelationshipSignal, RelationshipSignalRule>> =
  Object.freeze(SIGNAL_RULES);

/** 表 ↔ union 双向锁定，同时锁住「合法操作名 = 状态迁移表的键」。 */
export type RelationshipSignalTableLock = Expect<IsExactly<keyof typeof SIGNAL_RULES, RelationshipSignal>>;
export type RelationshipCommitmentStatusOpLock = Expect<
  IsExactly<RelationshipCommitmentStatusOp, keyof typeof DEBT_STATUS_TRANSITIONS>
>;

const RULE_BY_SIGNAL: Readonly<Record<string, RelationshipSignalRule | undefined>> = RELATIONSHIP_SIGNAL_POLICY;

function ruleFor(signal: RelationshipSignal | string): RelationshipSignalRule | undefined {
  return RULE_BY_SIGNAL[signal];
}

// ---------------------------------------------------------------------------
// stage：允许转换图 + 阈值/证据候选
// ---------------------------------------------------------------------------

/** 计划文本逐字给出的双向相邻对。 */
const STAGE_BIDIRECTIONAL_PAIRS: readonly (readonly [RelationshipStage, RelationshipStage])[] = [
  ["unknown", "acquainted"],
  ["acquainted", "cooperative"],
  ["acquainted", "wary"],
  ["cooperative", "trusted"],
  ["cooperative", "wary"],
  ["trusted", "bonded"],
  ["wary", "hostile"],
];

/** 单向降级：信任与羁绊可以一夜跌落，但恢复必须逐档。 */
const STAGE_ONE_WAY_DEMOTIONS: readonly (readonly [RelationshipStage, RelationshipStage])[] = [
  ["trusted", "wary"],
  ["bonded", "wary"],
];

/** stage → 允许的下一档。按 RELATIONSHIP_STAGES 顺序生成，因此同距离并列的裁决也确定。 */
export const RELATIONSHIP_STAGE_TRANSITIONS: Readonly<Record<RelationshipStage, readonly RelationshipStage[]>> =
  Object.freeze(
    RELATIONSHIP_STAGES.reduce((acc, stage) => {
      const neighbors = RELATIONSHIP_STAGES.filter((other) => other !== stage && isSpecifiedTransition(stage, other));
      acc[stage] = Object.freeze(neighbors);
      return acc;
    }, {} as Record<RelationshipStage, readonly RelationshipStage[]>),
  );

function isSpecifiedTransition(from: RelationshipStage, to: RelationshipStage): boolean {
  return STAGE_BIDIRECTIONAL_PAIRS.some(([a, b]) => (a === from && b === to) || (a === to && b === from))
    || STAGE_ONE_WAY_DEMOTIONS.some(([a, b]) => a === from && b === to);
}

export type RelationshipStageTableLock = Expect<
  IsExactly<keyof typeof RELATIONSHIP_STAGE_TRANSITIONS, RelationshipStage>
>;

/** 取值兜底：非表内 stage 一律视为「无路可走」，而不是抛 TypeError。 */
function stageNeighbors(stage: RelationshipStage): readonly RelationshipStage[] {
  return RELATIONSHIP_STAGE_TRANSITIONS[stage] ?? [];
}

export function isAllowedRelationshipStageTransition(from: RelationshipStage, to: RelationshipStage): boolean {
  if (from === to) return false;
  return stageNeighbors(from).includes(to);
}

type StageNode = Readonly<{ stage: RelationshipStage; first: RelationshipStage }>;

/**
 * 纯函数：把当前 stage 朝候选 stage 推进**最多一档**。
 * 相邻时直接落到候选；否则取最短路径的第一跳（BFS 按 RELATIONSHIP_STAGES 顺序展开，
 * 因此 wary → bonded 必走 cooperative，wary → trusted 也必须先 cooperative）。
 * 无可达路径时保持原 stage。
 */
export function resolveRelationshipStage(input: Readonly<{
  currentStage: RelationshipStage;
  candidate: RelationshipStage;
}>): RelationshipStage {
  const { currentStage, candidate } = input;
  if (currentStage === candidate) return currentStage;
  const visited = new Set<RelationshipStage>([currentStage]);
  let frontier: readonly StageNode[] = stageNeighbors(currentStage).map((stage) => ({
    stage,
    first: stage,
  }));
  while (frontier.length > 0) {
    const hit = frontier.find((node) => node.stage === candidate);
    if (hit !== undefined) return hit.first;
    const next: StageNode[] = [];
    for (const node of frontier) {
      if (visited.has(node.stage)) continue;
      visited.add(node.stage);
      for (const neighbor of stageNeighbors(node.stage)) {
        if (visited.has(neighbor)) continue;
        next.push({ stage: neighbor, first: node.first });
      }
    }
    frontier = next;
  }
  return currentStage;
}

/** 各档门槛；cooperative/acquainted 是计划未逐字规定的最低两档，取保守正向门（见测试）。 */
export const RELATIONSHIP_STAGE_GATES = Object.freeze({
  bonded: Object.freeze({ trust: 70, affinity: 60, positiveEvidence: 3, majorPositiveEvidence: 1 }),
  trusted: Object.freeze({ trust: 45, affinity: 35, positiveEvidence: 2 }),
  cooperative: Object.freeze({ trust: 20, affinity: 20, positiveEvidence: 1 }),
  wary: Object.freeze({ fear: 40, hostility: 25, affinityAtMost: -20 }),
  hostile: Object.freeze({ hostility: 60, affinityAtMost: -60 }),
} as const);

/** 正向证据 = 该 signal 的固定 trend 为 improving；不另立价性字段，避免第二事实来源。 */
function isPositiveEvidence(entry: RelationshipEvidence): boolean {
  return ruleFor(entry.signal)?.trend === "improving";
}

function isMajorPositiveEvidence(entry: RelationshipEvidence): boolean {
  const entryRule = ruleFor(entry.signal);
  return entryRule !== undefined && entryRule.trend === "improving" && entryRule.severity === "major";
}

/**
 * 纯候选裁决：只看维度与累计证据，不看相邻图、不看行动预算（那两个约束由
 * resolveRelationshipStage 与 applyRelationshipSignal 负责）。
 * 负向候选优先于正向候选：敌意压过羁绊、戒备压过信任。
 */
export function relationshipStageCandidate(input: Readonly<{
  dimensions: RelationshipDimensions;
  evidence: readonly RelationshipEvidence[];
}>): RelationshipStage {
  const { dimensions, evidence } = input;
  const positive = evidence.filter(isPositiveEvidence);
  const majorPositive = positive.filter(isMajorPositiveEvidence);
  if (dimensions.hostility >= RELATIONSHIP_STAGE_GATES.hostile.hostility
    || dimensions.affinity <= RELATIONSHIP_STAGE_GATES.hostile.affinityAtMost) {
    return "hostile";
  }
  if (dimensions.trust >= RELATIONSHIP_STAGE_GATES.bonded.trust
    && dimensions.affinity >= RELATIONSHIP_STAGE_GATES.bonded.affinity
    && positive.length >= RELATIONSHIP_STAGE_GATES.bonded.positiveEvidence
    && majorPositive.length >= RELATIONSHIP_STAGE_GATES.bonded.majorPositiveEvidence) {
    return "bonded";
  }
  if (dimensions.fear >= RELATIONSHIP_STAGE_GATES.wary.fear
    || dimensions.hostility >= RELATIONSHIP_STAGE_GATES.wary.hostility
    || dimensions.affinity <= RELATIONSHIP_STAGE_GATES.wary.affinityAtMost) {
    return "wary";
  }
  if (dimensions.trust >= RELATIONSHIP_STAGE_GATES.trusted.trust
    && dimensions.affinity >= RELATIONSHIP_STAGE_GATES.trusted.affinity
    && positive.length >= RELATIONSHIP_STAGE_GATES.trusted.positiveEvidence) {
    return "trusted";
  }
  if (dimensions.trust >= RELATIONSHIP_STAGE_GATES.cooperative.trust
    && dimensions.affinity >= RELATIONSHIP_STAGE_GATES.cooperative.affinity
    && positive.length >= RELATIONSHIP_STAGE_GATES.cooperative.positiveEvidence) {
    return "cooperative";
  }
  return evidence.length > 0 ? "acquainted" : "unknown";
}

// ---------------------------------------------------------------------------
// 稳定 ID 铸造：只由来源推导，禁止随机数与时间戳
// ---------------------------------------------------------------------------

export function mintRelationshipEvidenceId(input: Readonly<{
  actionId: string;
  fromNpcId: NpcId;
  targetId: PlayerEntityId | NpcId;
  signal: RelationshipSignal;
}>): string {
  return `ev:${input.actionId}:${input.fromNpcId}:${input.targetId}:${input.signal}`;
}

function sourceTag(source: RelationshipSource): string {
  return source.kind === "action" ? `action:${source.actionId}` : `initial:${source.reasonKey}`;
}

export function mintRelationshipCommitmentId(input: Readonly<{
  source: RelationshipSource;
  op: "open_debt" | "open_promise";
  openKey: string;
}>): string {
  return `cmt:${sourceTag(input.source)}:${input.op}:${input.openKey}`;
}

// ---------------------------------------------------------------------------
// 失败：与 gameplay/rpg 其它模块一致的稳定 code，不抛带上下文的字符串
// ---------------------------------------------------------------------------

export type RelationshipPolicyErrorCode =
  | "invalid_signal"
  | "invalid_action_source"
  | "invalid_turn_number"
  | "invalid_commitment_operation"
  | "self_edge_rejected"
  | "edge_target_mismatch"
  | "unknown_commitment"
  | "illegal_commitment_transition";

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function checkActionSource(actionId: string, turnNumber: number): RelationshipPolicyErrorCode | undefined {
  if (isBlank(actionId)) return "invalid_action_source";
  if (typeof turnNumber !== "number" || !Number.isInteger(turnNumber) || turnNumber < 0) return "invalid_turn_number";
  return undefined;
}

// ---------------------------------------------------------------------------
// delta 算术：cap 预算 + 边界 clamp
// ---------------------------------------------------------------------------

const REVERSED_DIMENSION_KEYS: readonly RelationshipDimensionKey[] = Object.freeze(
  [...RELATIONSHIP_DIMENSION_KEYS].reverse(),
);

function zeroDimensions(): Mutable<RelationshipDimensions> {
  return { affinity: 0, trust: 0, fear: 0, hostility: 0 };
}

function clampDimension(value: number): number {
  return Math.max(RELATIONSHIP_DIMENSION_MIN, Math.min(RELATIONSHIP_DIMENSION_MAX, value));
}

/** 把 incoming delta 缩到「prior + incoming」仍不超过 cap 的最大幅度（反向移动照常允许）。 */
function fitMagnitude(prior: number, wanted: number, cap: number): number {
  if (wanted === 0) return 0;
  const sign = Math.sign(wanted);
  for (let magnitude = Math.abs(wanted); magnitude > 0; magnitude -= 1) {
    if (Math.abs(prior + sign * magnitude) <= cap) return sign * magnitude;
  }
  return 0;
}

function cumulativeTotal(prior: RelationshipDimensions, next: RelationshipDimensions): number {
  return RELATIONSHIP_DIMENSION_KEYS.reduce((sum, key) => sum + Math.abs(prior[key] + next[key]), 0);
}

/**
 * 同一行动对同一边的累计变化受 cap 限制：先逐格压单维上限，再按维度逆序
 * （hostility → fear → trust → affinity，好感最后被动）裁到总和上限。
 */
function budgetDimensions(
  incoming: RelationshipDimensions,
  prior: RelationshipDimensions,
  severity: RelationshipSeverity,
): RelationshipDimensions {
  const caps = RELATIONSHIP_SIGNAL_CAPS[severity];
  const next = zeroDimensions();
  for (const key of RELATIONSHIP_DIMENSION_KEYS) {
    next[key] = fitMagnitude(prior[key], incoming[key], caps.singleDimension);
  }
  let excess = cumulativeTotal(prior, next) - caps.total;
  for (const key of REVERSED_DIMENSION_KEYS) {
    if (excess <= 0) break;
    const sign = Math.sign(next[key]);
    if (sign === 0) continue;
    while (excess > 0 && next[key] !== 0) {
      const candidate = next[key] - sign;
      const benefit = Math.abs(prior[key] + next[key]) - Math.abs(prior[key] + candidate);
      // 继续裁这一格反而让累计更大（与 prior 反号）：留给后面的维度
      if (benefit <= 0) break;
      next[key] = candidate;
      excess -= benefit;
    }
  }
  return Object.freeze(next);
}

function addDimensions(
  current: RelationshipDimensions,
  change: RelationshipDimensions,
): RelationshipDimensions {
  const next = zeroDimensions();
  for (const key of RELATIONSHIP_DIMENSION_KEYS) {
    next[key] = clampDimension(current[key] + change[key]);
  }
  return Object.freeze(next);
}

/** 同一 actionId 在本边已写入的信号：既用于幂等判定，也用于重建累计 delta。 */
function sameActionSignals(edge: DirectedRelationshipEdge, actionId: string): RelationshipSignal[] {
  return edge.evidence
    .filter((entry) => entry.actionId === actionId)
    .map((entry) => entry.signal)
    .filter((signal) => ruleFor(signal) !== undefined);
}

function priorActionDeltas(signals: readonly RelationshipSignal[]): RelationshipDimensions {
  const prior = zeroDimensions();
  for (const signal of signals) {
    const entryRule = ruleFor(signal);
    if (entryRule === undefined) continue;
    for (const key of RELATIONSHIP_DIMENSION_KEYS) {
      prior[key] += entryRule.dimensions[key];
    }
  }
  return prior;
}

// ---------------------------------------------------------------------------
// commitment 写入
// ---------------------------------------------------------------------------

function matchesTarget(
  commitment: RelationshipCommitment,
  target: RelationshipCommitmentTarget,
): boolean {
  if (target === "any_open") return true;
  return commitment.kind === target;
}

function isOpen(commitment: RelationshipCommitment): boolean {
  return commitment.status === "open";
}

function nextStatus(
  commitment: RelationshipCommitment,
  op: RelationshipCommitmentStatusOp,
): RelationshipCommitmentStatus | null {
  return commitment.kind === "debt" ? DEBT_STATUS_TRANSITIONS[op] : PROMISE_STATUS_TRANSITIONS[op];
}

/** 状态由迁移表给出；两类的取值交集外的那一档只可能出现在另一类上，故各自回落原值。 */
function withStatus(commitment: RelationshipCommitment, status: RelationshipCommitmentStatus): RelationshipCommitment {
  if (commitment.kind === "debt") {
    const debtStatus: RelationshipDebtStatus = status === "released" ? commitment.status : status;
    return { ...commitment, status: debtStatus };
  }
  const promiseStatus: RelationshipPromiseStatus = status === "forgiven" ? commitment.status : status;
  return { ...commitment, status: promiseStatus };
}

function openedDebt(input: Readonly<{
  openKey: string;
  direction: RelationshipDebtDirection;
  description: string;
  source: RelationshipSource;
}>): RelationshipCommitment {
  return {
    kind: "debt",
    commitmentId: mintRelationshipCommitmentId({ source: input.source, op: "open_debt", openKey: input.openKey }),
    direction: input.direction,
    status: "open",
    description: input.description,
    source: input.source,
  };
}

function openedPromise(input: Readonly<{
  openKey: string;
  promisor: RelationshipPromisor;
  description: string;
  source: RelationshipSource;
}>): RelationshipCommitment {
  return {
    kind: "promise",
    commitmentId: mintRelationshipCommitmentId({ source: input.source, op: "open_promise", openKey: input.openKey }),
    promisor: input.promisor,
    status: "open",
    description: input.description,
    source: input.source,
  };
}

/**
 * 信号表附带的承诺动作：无可结案对象时静默跳过（signal 本身仍然成立），绝不误判为错误；
 * 确定性 ID 使同一行动的重复开债天然幂等。
 */
function applyCommitmentRule(
  commitments: readonly RelationshipCommitment[],
  entry: RelationshipSignalCommitmentRule | undefined,
  source: RelationshipSource,
): readonly RelationshipCommitment[] {
  if (entry === undefined) return commitments;
  if (entry.op === "open_debt" || entry.op === "open_promise") {
    const opened = entry.op === "open_debt"
      ? openedDebt({ openKey: entry.openKey, direction: entry.direction, description: entry.description, source })
      : openedPromise({ openKey: entry.openKey, promisor: entry.promisor, description: entry.description, source });
    if (commitments.some((commitment) => commitment.commitmentId === opened.commitmentId)) return commitments;
    return Object.freeze([...commitments, opened]);
  }
  const index = commitments.findIndex((commitment) => matchesTarget(commitment, entry.target) && isOpen(commitment));
  if (index < 0) return commitments;
  const target = commitments[index];
  if (target === undefined) return commitments;
  const status = nextStatus(target, entry.op);
  if (status === null) return commitments;
  return Object.freeze(commitments.map((commitment, at) => (at === index ? withStatus(commitment, status) : commitment)));
}

// ---------------------------------------------------------------------------
// applyRelationshipSignal
// ---------------------------------------------------------------------------

export type RelationshipTargetId = PlayerEntityId | NpcId;

export type RelationshipSignalInput = Readonly<{
  /** 边所属 NPC：只参与证据 ID 派生，绝不写入对方。 */
  fromNpcId: NpcId;
  targetId: RelationshipTargetId;
  signal: RelationshipSignal;
  actionId: string;
  turnNumber: number;
}>;

export type ApplyRelationshipSignalInput = RelationshipSignalInput &
  Readonly<{ edge: DirectedRelationshipEdge | undefined }>;

export type ApplyRelationshipSignalResult =
  | Readonly<{ ok: true; changed: true; reason: "applied"; edge: DirectedRelationshipEdge }>
  | Readonly<{ ok: true; changed: false; reason: "duplicate_action_signal"; edge: DirectedRelationshipEdge }>
  | Readonly<{ ok: false; changed: false; code: RelationshipPolicyErrorCode }>;

function reject(code: RelationshipPolicyErrorCode): ApplyRelationshipSignalResult {
  return { ok: false, changed: false, code };
}

function emptyEdge(input: RelationshipSignalInput, origin: RelationshipSource): DirectedRelationshipEdge {
  return {
    targetId: input.targetId,
    dimensions: Object.freeze({ ...zeroDimensions() }),
    stage: "unknown",
    trend: "stable",
    commitments: Object.freeze([]),
    evidence: Object.freeze([]),
    origin,
    lastChangedAtTurn: input.turnNumber,
  };
}

function trimEvidence(evidence: readonly RelationshipEvidence[]): readonly RelationshipEvidence[] {
  if (evidence.length <= RELATIONSHIP_EVIDENCE_CAP) return Object.freeze([...evidence]);
  return Object.freeze(evidence.slice(evidence.length - RELATIONSHIP_EVIDENCE_CAP));
}

/**
 * 纯函数：输入当前边（不存在时传 undefined）与一个已提交行动的信号，输出新边或零写入。
 * 幂等键是 `actionId + fromId + targetId + signal`：重复应用返回同一对象、零写入。
 * 只写传进来的那一条边，方向性由签名本身保证。
 */
export function applyRelationshipSignal(input: ApplyRelationshipSignalInput): ApplyRelationshipSignalResult {
  if (input.fromNpcId === input.targetId) return reject("self_edge_rejected");
  const sourceCode = checkActionSource(input.actionId, input.turnNumber);
  if (sourceCode !== undefined) return reject(sourceCode);
  const signalRule = ruleFor(input.signal);
  if (signalRule === undefined) return reject("invalid_signal");
  if (input.edge !== undefined && input.edge.targetId !== input.targetId) return reject("edge_target_mismatch");

  const origin: RelationshipSource = { kind: "action", actionId: input.actionId, turnNumber: input.turnNumber };
  const base = input.edge ?? emptyEdge(input, origin);
  const alreadyApplied = sameActionSignals(base, input.actionId);
  if (alreadyApplied.includes(input.signal)) {
    return { ok: true, changed: false, reason: "duplicate_action_signal", edge: base };
  }

  const prior = priorActionDeltas(alreadyApplied);
  const change = budgetDimensions(signalRule.dimensions, prior, signalRule.severity);
  const dimensions = addDimensions(base.dimensions, change);
  const evidence = trimEvidence([
    ...base.evidence,
    Object.freeze({
      evidenceId: mintRelationshipEvidenceId(input),
      actionId: input.actionId,
      turnNumber: input.turnNumber,
      signal: input.signal,
      severity: signalRule.severity,
      summaryKey: signalRule.summaryKey,
    }),
  ]);
  // 本行动已经写过 ⇒ stage 已用掉唯一一档预算。
  const stage = alreadyApplied.length > 0
    ? base.stage
    : resolveRelationshipStage({
        currentStage: base.stage,
        candidate: relationshipStageCandidate({ dimensions, evidence }),
      });
  const edge: DirectedRelationshipEdge = Object.freeze({
    ...base,
    dimensions,
    stage,
    trend: signalRule.trend,
    commitments: applyCommitmentRule(base.commitments, signalRule.commitment, origin),
    evidence,
    lastChangedAtTurn: input.turnNumber,
  });
  return { ok: true, changed: true, reason: "applied", edge };
}

// ---------------------------------------------------------------------------
// applyRelationshipCommitment
// ---------------------------------------------------------------------------

export type ApplyRelationshipCommitmentInput = Readonly<{
  edge: DirectedRelationshipEdge;
  operation: RelationshipCommitmentOperation;
  actionId: string;
  turnNumber: number;
}>;

export type ApplyRelationshipCommitmentResult =
  | Readonly<{ ok: true; changed: true; reason: "applied"; edge: DirectedRelationshipEdge }>
  | Readonly<{ ok: true; changed: false; reason: "already_applied"; edge: DirectedRelationshipEdge }>
  | Readonly<{
      ok: false;
      changed: false;
      code: RelationshipPolicyErrorCode;
      /** 失败一律原样返回入参边：调用方可用对象同一性直接证明零写入。 */
      edge: DirectedRelationshipEdge;
    }>;

function commitmentFailure(
  code: RelationshipPolicyErrorCode,
  edge: DirectedRelationshipEdge,
): ApplyRelationshipCommitmentResult {
  return { ok: false, changed: false, code, edge };
}

/** 运行时守门：AI/客户端的 proposal 在到这里之前已被裁剪，但规则层自己也不信任输入。 */
function isValidOperation(operation: unknown): operation is RelationshipCommitmentOperation {
  if (typeof operation !== "object" || operation === null) return false;
  const record = operation as Readonly<Record<string, unknown>>;
  const kind = record.kind;
  if (typeof kind !== "string" || !(RELATIONSHIP_COMMITMENT_OP_KINDS as readonly string[]).includes(kind)) {
    return false;
  }
  if (kind === "open_debt") {
    return !isBlank(record.openKey)
      && !isBlank(record.description)
      && (RELATIONSHIP_DEBT_DIRECTIONS as readonly string[]).includes(String(record.direction));
  }
  if (kind === "open_promise") {
    return !isBlank(record.openKey)
      && !isBlank(record.description)
      && (RELATIONSHIP_PROMISORS as readonly string[]).includes(String(record.promisor));
  }
  return !isBlank(record.commitmentId);
}

/**
 * 承诺写入：只接受封闭的六类操作。ID 一律由 actionId（initial_world 用 reasonKey）
 * 确定性铸造，所以同一行动重放同一个 `open_*` 必然命中既有 ID ⇒ 零写入。
 * 未知 ID 与非法状态迁移返回稳定 code，且绝不部分写入。
 * 承诺操作只动 commitments 与 lastChangedAtTurn，不碰维度/stage/trend/evidence。
 */
export function applyRelationshipCommitment(
  input: ApplyRelationshipCommitmentInput,
): ApplyRelationshipCommitmentResult {
  const edge = input.edge;
  const sourceCode = checkActionSource(input.actionId, input.turnNumber);
  if (sourceCode !== undefined) return commitmentFailure(sourceCode, edge);
  const operation = input.operation;
  if (!isValidOperation(operation)) return commitmentFailure("invalid_commitment_operation", edge);

  if (operation.kind === "open_debt" || operation.kind === "open_promise") {
    const source: RelationshipSource = { kind: "action", actionId: input.actionId, turnNumber: input.turnNumber };
    const opened = operation.kind === "open_debt"
      ? openedDebt({
          openKey: operation.openKey,
          direction: operation.direction,
          description: operation.description,
          source,
        })
      : openedPromise({
          openKey: operation.openKey,
          promisor: operation.promisor,
          description: operation.description,
          source,
        });
    if (edge.commitments.some((commitment) => commitment.commitmentId === opened.commitmentId)) {
      return { ok: true, changed: false, reason: "already_applied", edge };
    }
    return {
      ok: true,
      changed: true,
      reason: "applied",
      edge: Object.freeze({
        ...edge,
        commitments: Object.freeze([...edge.commitments, opened]),
        lastChangedAtTurn: input.turnNumber,
      }),
    };
  }

  const target = edge.commitments.find((commitment) => commitment.commitmentId === operation.commitmentId);
  if (target === undefined) return commitmentFailure("unknown_commitment", edge);
  const status = nextStatus(target, operation.kind);
  if (status === null || !isOpen(target)) return commitmentFailure("illegal_commitment_transition", edge);
  return {
    ok: true,
    changed: true,
    reason: "applied",
    edge: Object.freeze({
      ...edge,
      commitments: Object.freeze(
        edge.commitments.map((commitment) =>
          commitment.commitmentId === operation.commitmentId ? withStatus(commitment, status) : commitment,
        ),
      ),
      lastChangedAtTurn: input.turnNumber,
    }),
  };
}

// ---------------------------------------------------------------------------
// 边集合工具：稳定 targetId 顺序 + 组件级写入
// ---------------------------------------------------------------------------

export function findRelationshipEdge(
  relationships: NpcRelationshipComponent,
  targetId: RelationshipTargetId,
): DirectedRelationshipEdge | undefined {
  return relationships.outgoing.find((edge) => edge.targetId === targetId);
}

/**
 * 插入或替换一条边，顺序由 domain 的比较器裁决；输入数组不被改写。
 * 只操作传进来的这份 outgoing，因此 A→B 的写入在结构上不可能触碰 B→A。
 */
export function upsertRelationshipEdge(
  outgoing: readonly DirectedRelationshipEdge[],
  edge: DirectedRelationshipEdge,
): readonly DirectedRelationshipEdge[] {
  const rest = outgoing.filter((candidate) => candidate.targetId !== edge.targetId);
  const at = rest.findIndex((candidate) => compareRelationshipTargetIds(candidate.targetId, edge.targetId) > 0);
  if (at < 0) return Object.freeze([...rest, edge]);
  return Object.freeze([...rest.slice(0, at), edge, ...rest.slice(at)]);
}

export type ApplyRelationshipSignalToComponentInput = RelationshipSignalInput &
  Readonly<{ relationships: NpcRelationshipComponent }>;

export type ApplyRelationshipSignalToComponentResult =
  | Readonly<{ ok: true; changed: boolean; relationships: NpcRelationshipComponent; edge: DirectedRelationshipEdge }>
  | Readonly<{
      ok: false;
      changed: false;
      code: RelationshipPolicyErrorCode;
      relationships: NpcRelationshipComponent;
    }>;

/** 组件级入口：按 targetId 定位唯一有向边，再交回纯函数裁决。 */
export function applyRelationshipSignalToComponent(
  input: ApplyRelationshipSignalToComponentInput,
): ApplyRelationshipSignalToComponentResult {
  const { relationships } = input;
  const existing = findRelationshipEdge(relationships, input.targetId);
  const result = applyRelationshipSignal({
    edge: existing,
    fromNpcId: input.fromNpcId,
    targetId: input.targetId,
    signal: input.signal,
    actionId: input.actionId,
    turnNumber: input.turnNumber,
  });
  if (!result.ok) return { ok: false, changed: false, code: result.code, relationships };
  if (!result.changed) return { ok: true, changed: false, relationships, edge: result.edge };
  return {
    ok: true,
    changed: true,
    relationships: { outgoing: upsertRelationshipEdge(relationships.outgoing, result.edge) },
    edge: result.edge,
  };
}
