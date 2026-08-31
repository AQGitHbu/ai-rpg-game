import { describe, expect, it } from "vitest";
import {
  RELATIONSHIP_DIMENSION_KEYS,
  RELATIONSHIP_DIMENSION_MAX,
  RELATIONSHIP_DIMENSION_MIN,
  RELATIONSHIP_EVIDENCE_CAP,
  RELATIONSHIP_SIGNALS,
  RELATIONSHIP_STAGES,
  validateNpcRelationships,
  compareRelationshipTargetIds,
  type DirectedRelationshipEdge,
  type NpcRelationshipComponent,
  type RelationshipDimensions,
  type RelationshipEvidence,
  type RelationshipSignal,
  type RelationshipStage,
  type RelationshipTrend,
} from "@/game/domain/entity";
import { PLAYER_ENTITY_ID, asNpcId, type NpcId, type PlayerEntityId } from "@/game/domain/worldEntity";
import {
  RELATIONSHIP_SIGNAL_CAPS,
  RELATIONSHIP_SIGNAL_POLICY,
  RELATIONSHIP_STAGE_GATES,
  RELATIONSHIP_STAGE_TRANSITIONS,
  applyRelationshipCommitment,
  applyRelationshipSignal,
  applyRelationshipSignalToComponent,
  isAllowedRelationshipStageTransition,
  mintRelationshipCommitmentId,
  mintRelationshipEvidenceId,
  relationshipStageCandidate,
  resolveRelationshipStage,
  upsertRelationshipEdge,
  type ApplyRelationshipCommitmentResult,
  type ApplyRelationshipSignalResult,
  type RelationshipCommitmentOperation,
} from "./relationshipSignalPolicy";

// ---------------------------------------------------------------------------
// Task 3A：关系信号规则表的独立证明。
//
// 所有断言都走 applyRelationshipSignal / applyRelationshipCommitment 的真实输出：
// 测试自己携带一份从计划文本抄写的期望数值表与允许转换图（另一份编码），
// 因此「实现把表抄回测试」不成立；数值上下限、幂等、速度与方向性都在函数结果上验证。
// 每一条产出的边都再过一次 domain validator，规则层不得产出非法记录。
// ---------------------------------------------------------------------------

const NPC_A = asNpcId("npc_a");
const NPC_B = asNpcId("npc_b");
const NPC_C = asNpcId("npc_c");
const NPC_D = asNpcId("npc_d");

const ZERO_DIMENSIONS: RelationshipDimensions = { affinity: 0, trust: 0, fear: 0, hostility: 0 };

/** 期望维度表：逐格抄自计划「每个 signal 映射固定维度变化」的要求，与实现无共享常量。 */
const EXPECTED_SIGNAL_EFFECT: Readonly<Record<RelationshipSignal, Readonly<{
  dimensions: RelationshipDimensions;
  severity: "normal" | "major";
  trend: RelationshipTrend;
}>>> = {
  supported: { dimensions: { affinity: 3, trust: 2, fear: 0, hostility: 0 }, severity: "normal", trend: "improving" },
  challenged: { dimensions: { affinity: -3, trust: -1, fear: 0, hostility: 0 }, severity: "normal", trend: "worsening" },
  threatened: { dimensions: { affinity: -4, trust: 0, fear: 10, hostility: 4 }, severity: "major", trend: "worsening" },
  deceived: { dimensions: { affinity: -3, trust: -12, fear: 0, hostility: 5 }, severity: "major", trend: "worsening" },
  offered_help: { dimensions: { affinity: 2, trust: 3, fear: 0, hostility: 0 }, severity: "normal", trend: "improving" },
  reassured: { dimensions: { affinity: 2, trust: 2, fear: -3, hostility: 0 }, severity: "normal", trend: "improving" },
  refused: { dimensions: { affinity: -2, trust: -3, fear: 0, hostility: 0 }, severity: "normal", trend: "worsening" },
  gave_item: { dimensions: { affinity: 4, trust: 1, fear: 0, hostility: 0 }, severity: "normal", trend: "improving" },
  shared_fact: { dimensions: { affinity: 1, trust: 3, fear: 0, hostility: 0 }, severity: "normal", trend: "improving" },
  fought_together: { dimensions: { affinity: 6, trust: 6, fear: 0, hostility: -6 }, severity: "major", trend: "improving" },
  betrayed: { dimensions: { affinity: 0, trust: -12, fear: 0, hostility: 8 }, severity: "major", trend: "worsening" },
  kept_promise: { dimensions: { affinity: 2, trust: 10, fear: 0, hostility: 0 }, severity: "major", trend: "improving" },
  broke_promise: { dimensions: { affinity: -4, trust: -10, fear: 0, hostility: 4 }, severity: "major", trend: "worsening" },
};

/** 计划文本逐字给出的允许转换：双向对 + 两条单向降级。 */
const SPEC_BIDIRECTIONAL: readonly (readonly [RelationshipStage, RelationshipStage])[] = [
  ["unknown", "acquainted"],
  ["acquainted", "cooperative"],
  ["acquainted", "wary"],
  ["cooperative", "trusted"],
  ["cooperative", "wary"],
  ["trusted", "bonded"],
  ["wary", "hostile"],
];
const SPEC_ONE_WAY: readonly (readonly [RelationshipStage, RelationshipStage])[] = [
  ["trusted", "wary"],
  ["bonded", "wary"],
];

function pairKey(from: RelationshipStage, to: RelationshipStage): string {
  return `${from}>${to}`;
}

const SPEC_ALLOWED = new Set<string>(
  SPEC_BIDIRECTIONAL.flatMap(([a, b]) => [pairKey(a, b), pairKey(b, a)]).concat(
    SPEC_ONE_WAY.map(([a, b]) => pairKey(a, b)),
  ),
);

const SPEC_ADJACENCY = RELATIONSHIP_STAGES.reduce((acc, stage) => {
  acc.set(stage, RELATIONSHIP_STAGES.filter((other) => SPEC_ALLOWED.has(pairKey(stage, other))));
  return acc;
}, new Map<RelationshipStage, RelationshipStage[]>());

/** 测试侧独立 BFS：只用来断言「最多一档 + 距离必须缩短」，不参与实现。 */
function specDistance(from: RelationshipStage, to: RelationshipStage): number | null {
  if (from === to) return 0;
  const seen = new Map<RelationshipStage, number>([[from, 0]]);
  let frontier = [from];
  while (frontier.length > 0) {
    const nextFrontier: RelationshipStage[] = [];
    for (const current of frontier) {
      for (const neighbor of SPEC_ADJACENCY.get(current) ?? []) {
        if (seen.has(neighbor)) continue;
        seen.set(neighbor, (seen.get(current) ?? 0) + 1);
        if (neighbor === to) return seen.get(neighbor) ?? null;
        nextFrontier.push(neighbor);
      }
    }
    frontier = nextFrontier;
  }
  return null;
}

function edgeOf(overrides: Partial<DirectedRelationshipEdge> = {}): DirectedRelationshipEdge {
  return {
    targetId: NPC_B,
    dimensions: ZERO_DIMENSIONS,
    stage: "unknown",
    trend: "stable",
    commitments: [],
    evidence: [],
    origin: { kind: "action", actionId: "act_origin", turnNumber: 0 },
    lastChangedAtTurn: 0,
    ...overrides,
  };
}

function evidenceOf(
  signal: RelationshipSignal,
  actionId: string,
  turnNumber: number,
  fromNpcId: NpcId = NPC_A,
  targetId: PlayerEntityId | NpcId = NPC_B,
): RelationshipEvidence {
  const rule = RELATIONSHIP_SIGNAL_POLICY[signal];
  return {
    evidenceId: mintRelationshipEvidenceId({ actionId, fromNpcId, targetId, signal }),
    actionId,
    turnNumber,
    signal,
    severity: rule.severity,
    summaryKey: rule.summaryKey,
  };
}

function dimsOf(overrides: Partial<RelationshipDimensions> = {}): RelationshipDimensions {
  return { ...ZERO_DIMENSIONS, ...overrides };
}

function totalMagnitude(dimensions: RelationshipDimensions): number {
  return RELATIONSHIP_DIMENSION_KEYS.reduce((sum, key) => sum + Math.abs(dimensions[key]), 0);
}

/** 规则层的输入是未受信字符串：任何挂在 Object.prototype 上的键名都必须走「未知成员」分支。 */
const PROTOTYPE_KEYS: readonly string[] = [
  "toString", "constructor", "hasOwnProperty", "valueOf", "isPrototypeOf", "__proto__",
];

/** 尝试改写的结果：true 表示运行时守门生效（写入抛错），false 表示改写成功了。 */
function writeRejected(write: () => void): boolean {
  try {
    write();
    return false;
  } catch {
    return true;
  }
}

/** 手工伪造一条证据：signal 字段故意放原型链键名，模拟绕过 validator 的持久化数据。 */
function bogusEvidence(signal: string, actionId: string): RelationshipEvidence {
  return {
    evidenceId: `ev:${actionId}:bogus:${signal}`,
    actionId,
    turnNumber: 1,
    signal: signal as RelationshipSignal,
    severity: "major",
    summaryKey: "relationship.signal.bogus",
  };
}

function accepted(result: ApplyRelationshipSignalResult, label: string): DirectedRelationshipEdge {
  if (!result.ok) throw new Error(`${label}: policy rejected with ${result.code}`);
  return result.edge;
}

function applySignal(input: {
  signal: RelationshipSignal;
  actionId: string;
  turnNumber?: number;
  edge?: DirectedRelationshipEdge | undefined;
  fromNpcId?: NpcId;
  targetId?: PlayerEntityId | NpcId;
}): DirectedRelationshipEdge {
  const result = applyRelationshipSignal({
    edge: input.edge,
    fromNpcId: input.fromNpcId ?? NPC_A,
    targetId: input.targetId ?? NPC_B,
    signal: input.signal,
    actionId: input.actionId,
    turnNumber: input.turnNumber ?? 1,
  });
  return accepted(result, `apply ${input.signal}`);
}

function expectValidEdge(edge: DirectedRelationshipEdge, label: string): void {
  expect(validateNpcRelationships({ outgoing: [edge] }), label).toEqual([]);
}

function expectValidComponent(relationships: NpcRelationshipComponent, label: string): void {
  expect(validateNpcRelationships(relationships), label).toEqual([]);
}

describe("signal 表覆盖封闭 union 与数值上下限", () => {
  it("domain 的每个 signal 都有规则条目，且条目集合不额外扩张", () => {
    expect([...RELATIONSHIP_SIGNALS]).toHaveLength(13);
    expect(Object.keys(RELATIONSHIP_SIGNAL_POLICY).sort()).toEqual([...RELATIONSHIP_SIGNALS].sort());
  });

  it("每条规则都落在自己 severity 的单维与总和 cap 内", () => {
    for (const signal of RELATIONSHIP_SIGNALS) {
      const rule = RELATIONSHIP_SIGNAL_POLICY[signal];
      const caps = RELATIONSHIP_SIGNAL_CAPS[rule.severity];
      for (const key of RELATIONSHIP_DIMENSION_KEYS) {
        expect(Number.isInteger(rule.dimensions[key]), `${signal}.${key}`).toBe(true);
        expect(Math.abs(rule.dimensions[key]), `${signal}.${key} <= ${caps.singleDimension}`).toBeLessThanOrEqual(
          caps.singleDimension,
        );
      }
      expect(totalMagnitude(rule.dimensions), `${signal} total <= ${caps.total}`).toBeLessThanOrEqual(caps.total);
      expect(rule.summaryKey.length, `${signal}.summaryKey`).toBeGreaterThan(0);
    }
  });

  it("trend 与维度净方向一致：improving 只出现在好感/信任上升的规则上", () => {
    for (const signal of RELATIONSHIP_SIGNALS) {
      const rule = RELATIONSHIP_SIGNAL_POLICY[signal];
      const net = rule.dimensions.affinity + rule.dimensions.trust;
      if (rule.trend === "improving") expect(net, signal).toBeGreaterThan(0);
      if (rule.trend === "worsening") expect(net, signal).toBeLessThan(0);
    }
  });

  it("cap 常量本身就是计划里的四档数字", () => {
    expect(RELATIONSHIP_SIGNAL_CAPS).toEqual({
      normal: { singleDimension: 5, total: 8 },
      major: { singleDimension: 12, total: 20 },
    });
    // cap 必须留在 domain 的 clamp 闭区间内，否则「先 cap 后 clamp」会互相否定
    expect(RELATIONSHIP_DIMENSION_MIN).toBeLessThan(0);
    expect(RELATIONSHIP_DIMENSION_MAX).toBeGreaterThan(0);
    for (const caps of [RELATIONSHIP_SIGNAL_CAPS.normal, RELATIONSHIP_SIGNAL_CAPS.major]) {
      expect(caps.singleDimension).toBeLessThanOrEqual(RELATIONSHIP_DIMENSION_MAX);
      expect(caps.total).toBeLessThanOrEqual(RELATIONSHIP_DIMENSION_MAX - RELATIONSHIP_DIMENSION_MIN);
    }
  });
});

describe("applyRelationshipSignal 逐 signal 的固定变化", () => {
  for (const signal of RELATIONSHIP_SIGNALS) {
    it(`${signal}：从中立边产出固定四维变化、severity 与 trend`, () => {
      const expected = EXPECTED_SIGNAL_EFFECT[signal];
      const edge = applySignal({ signal, actionId: `act_${signal}`, turnNumber: 4 });
      expect(edge.dimensions, signal).toEqual(expected.dimensions);
      expect(edge.trend, signal).toBe(expected.trend);
      expect(edge.evidence).toHaveLength(1);
      expect(edge.evidence[0]?.signal).toBe(signal);
      expect(edge.evidence[0]?.severity).toBe(expected.severity);
      expect(edge.evidence[0]?.actionId).toBe(`act_${signal}`);
      expect(edge.evidence[0]?.turnNumber).toBe(4);
      expect(edge.lastChangedAtTurn).toBe(4);
      expectValidEdge(edge, signal);
    });
  }

  it("证据条目由 action 来源确定性铸造，字段与 domain 形状一致", () => {
    const edge = applySignal({ signal: "supported", actionId: "act_7", turnNumber: 7 });
    const entry = edge.evidence[0];
    expect(entry?.evidenceId).toBe(mintRelationshipEvidenceId({
      actionId: "act_7", fromNpcId: NPC_A, targetId: NPC_B, signal: "supported",
    }));
    expect(entry?.evidenceId).toContain("act_7");
    expect(entry?.summaryKey).toBe(RELATIONSHIP_SIGNAL_POLICY.supported.summaryKey);
    // 同一输入重跑必须得到完全相同的 id：禁止随机数或时间戳
    const again = applySignal({ signal: "supported", actionId: "act_7", turnNumber: 7 });
    expect(again.evidence[0]?.evidenceId).toBe(entry?.evidenceId);
  });

  it("新建边以行动来源为 origin，未知 stage 最多升一档", () => {
    const edge = applySignal({ signal: "supported", actionId: "act_new" });
    expect(edge.origin).toEqual({ kind: "action", actionId: "act_new", turnNumber: 1 });
    expect(edge.stage).toBe("acquainted");
    expect(edge.targetId).toBe(NPC_B);
  });
});

describe("上下限与 cap", () => {
  it("clamp 到 [-100,100]：正向饱和不会越界", () => {
    const edge = applySignal({
      signal: "fought_together",
      actionId: "act_max",
      edge: edgeOf({ dimensions: dimsOf({ affinity: 98, trust: 98 }) }),
    });
    expect(edge.dimensions).toEqual({ affinity: 100, trust: 100, fear: 0, hostility: -6 });
    expectValidEdge(edge, "clamped high");
  });

  it("clamp 到 [-100,100]：负向饱和不会越界", () => {
    const edge = applySignal({
      signal: "deceived",
      actionId: "act_min",
      edge: edgeOf({ dimensions: dimsOf({ affinity: -99, trust: -95, hostility: 96 }) }),
    });
    expect(edge.dimensions).toEqual({ affinity: -100, trust: -100, fear: 0, hostility: 100 });
  });

  it("连续 40 次不同 action 后四维仍在闭区间内且记录合法", () => {
    let edge = edgeOf();
    for (let index = 0; index < 40; index += 1) {
      edge = accepted(applyRelationshipSignal({
        edge,
        fromNpcId: NPC_A,
        targetId: NPC_B,
        signal: index % 2 === 0 ? "kept_promise" : "supported",
        actionId: `act_loop_${index}`,
        turnNumber: index + 1,
      }), `loop ${index}`);
    }
    for (const key of RELATIONSHIP_DIMENSION_KEYS) {
      expect(edge.dimensions[key]).toBeLessThanOrEqual(100);
      expect(edge.dimensions[key]).toBeGreaterThanOrEqual(-100);
    }
    expect(edge.evidence).toHaveLength(RELATIONSHIP_EVIDENCE_CAP);
    expectValidEdge(edge, "after 40 actions");
  });

  it("同一 action 对同一边的累计变化还要受单维 cap 约束", () => {
    let edge = edgeOf();
    edge = accepted(applyRelationshipSignal({
      edge, fromNpcId: NPC_A, targetId: NPC_B, signal: "kept_promise", actionId: "act_pair", turnNumber: 9,
    }), "major first");
    expect(edge.dimensions).toEqual(dimsOf({ affinity: 2, trust: 10 }));
    const second = accepted(applyRelationshipSignal({
      edge, fromNpcId: NPC_A, targetId: NPC_B, signal: "supported", actionId: "act_pair", turnNumber: 9,
    }), "normal second");
    // incoming 为 normal：单维累计上限 5、总和上限 8；major 已经用完预算 ⇒ 维度不再移动
    expect(second.dimensions).toEqual(dimsOf({ affinity: 2, trust: 10 }));
    expect(second.evidence).toHaveLength(2);
    expectValidEdge(second, "same action two signals");
  });

  it("同一 action 的 normal 信号之间总和 cap 为 8，超出部分按维度顺序裁剪", () => {
    let edge = edgeOf();
    edge = accepted(applyRelationshipSignal({
      edge, fromNpcId: NPC_A, targetId: NPC_B, signal: "supported", actionId: "act_sum", turnNumber: 3,
    }), "supported");
    const total = accepted(applyRelationshipSignal({
      edge, fromNpcId: NPC_A, targetId: NPC_B, signal: "shared_fact", actionId: "act_sum", turnNumber: 3,
    }), "shared_fact");
    // supported(+3,+2) + shared_fact(+1,+3) = (+4,+5) 合计 9 > 8 ⇒ trust 侧裁掉 1
    expect(total.dimensions).toEqual(dimsOf({ affinity: 4, trust: 4 }));
    expect(totalMagnitude(total.dimensions)).toBeLessThanOrEqual(RELATIONSHIP_SIGNAL_CAPS.normal.total);
    expectValidEdge(total, "same action total cap");
  });

  it("边界饱和后仍写入证据，但维度不动", () => {
    const edge = applySignal({
      signal: "supported",
      actionId: "act_saturated",
      edge: edgeOf({ dimensions: dimsOf({ affinity: 100, trust: 100 }) }),
    });
    expect(edge.dimensions).toEqual(dimsOf({ affinity: 100, trust: 100 }));
    expect(edge.evidence).toHaveLength(1);
    expect(edge.trend).toBe("improving");
  });
});

describe("幂等", () => {
  it("同一 actionId + from + target + signal 重复应用零写入并返回同一对象", () => {
    const first = accepted(applyRelationshipSignal({
      edge: edgeOf(), fromNpcId: NPC_A, targetId: NPC_B, signal: "supported", actionId: "act_once", turnNumber: 2,
    }), "first");
    const again = applyRelationshipSignal({
      edge: first, fromNpcId: NPC_A, targetId: NPC_B, signal: "supported", actionId: "act_once", turnNumber: 2,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.changed).toBe(false);
    expect(again.reason).toBe("duplicate_action_signal");
    expect(again.edge).toBe(first);
  });

  it("同一 action 的第二个不同 signal 允许写入", () => {
    let edge = applySignal({ signal: "supported", actionId: "act_multi", turnNumber: 5 });
    edge = accepted(applyRelationshipSignal({
      edge, fromNpcId: NPC_A, targetId: NPC_B, signal: "challenged", actionId: "act_multi", turnNumber: 5,
    }), "second signal");
    expect(edge.evidence.map((entry) => entry.signal)).toEqual(["supported", "challenged"]);
  });

  it("不同 actionId 的同一 signal 各自留证", () => {
    let edge = applySignal({ signal: "supported", actionId: "act_a1", turnNumber: 1 });
    edge = accepted(applyRelationshipSignal({
      edge, fromNpcId: NPC_A, targetId: NPC_B, signal: "supported", actionId: "act_a2", turnNumber: 2,
    }), "second action");
    expect(edge.evidence).toHaveLength(2);
    expect(edge.dimensions).toEqual(dimsOf({ affinity: 6, trust: 4 }));
  });

  it("同一 actionId + signal 指向不同 target 时各自成立（幂等键含 target）", () => {
    const toB = applySignal({ signal: "supported", actionId: "act_split", targetId: NPC_B });
    const toC = applySignal({ signal: "supported", actionId: "act_split", targetId: NPC_C });
    expect(toB.evidence[0]?.evidenceId).not.toBe(toC.evidence[0]?.evidenceId);
    expect(toB.targetId).toBe(NPC_B);
    expect(toC.targetId).toBe(NPC_C);
  });
});

describe("方向性与排序", () => {
  it("A→B 的写入绝不触碰同一 NPC 的另一条边", () => {
    const playerEdge = edgeOf({ targetId: PLAYER_ENTITY_ID });
    const otherEdge = edgeOf({ targetId: NPC_C, dimensions: dimsOf({ affinity: 12, trust: 7 }), stage: "cooperative" });
    const relationships: NpcRelationshipComponent = { outgoing: [playerEdge, otherEdge] };
    const result = applyRelationshipSignalToComponent({
      relationships,
      fromNpcId: NPC_A,
      targetId: PLAYER_ENTITY_ID,
      signal: "supported",
      actionId: "act_dir",
      turnNumber: 6,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    const untouched = result.relationships.outgoing.find((edge) => edge.targetId === NPC_C);
    expect(untouched).toBe(otherEdge);
    expect(result.relationships.outgoing.find((edge) => edge.targetId === PLAYER_ENTITY_ID)?.dimensions)
      .toEqual(dimsOf({ affinity: 3, trust: 2 }));
    expectValidComponent(result.relationships, "two-edge component");
  });

  it("反向边不会被自动创建，也只由指向该目标的信号建立", () => {
    const forward: NpcRelationshipComponent = { outgoing: [edgeOf({ targetId: NPC_B })] };
    const applied = applyRelationshipSignalToComponent({
      relationships: forward,
      fromNpcId: NPC_A,
      targetId: NPC_B,
      signal: "threatened",
      actionId: "act_forward",
      turnNumber: 2,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.relationships.outgoing.map((edge) => edge.targetId)).toEqual([NPC_B]);

    const reversed: NpcRelationshipComponent = { outgoing: [edgeOf({ targetId: NPC_A })] };
    expect(reversed.outgoing[0]?.dimensions).toEqual(ZERO_DIMENSIONS);
    const reverseResult = applyRelationshipSignalToComponent({
      relationships: reversed,
      fromNpcId: NPC_B,
      targetId: NPC_A,
      signal: "reassured",
      actionId: "act_reverse",
      turnNumber: 3,
    });
    expect(reverseResult.ok).toBe(true);
    if (!reverseResult.ok) return;
    expect(reverseResult.relationships.outgoing).toHaveLength(1);
    expect(reverseResult.relationships.outgoing[0]?.dimensions).toEqual(dimsOf({ affinity: 2, trust: 2, fear: -3 }));
  });

  it("新边按 domain 稳定 targetId 比较器插入，替换原位不改变顺序", () => {
    const base: DirectedRelationshipEdge[] = [
      edgeOf({ targetId: NPC_B }),
      edgeOf({ targetId: NPC_D, dimensions: dimsOf({ trust: 4 }) }),
    ];
    const inserted = upsertRelationshipEdge(base, edgeOf({ targetId: NPC_C }));
    expect(inserted.map((edge) => edge.targetId)).toEqual([NPC_B, NPC_C, NPC_D]);
    for (let index = 1; index < inserted.length; index += 1) {
      const previous = inserted[index - 1];
      const current = inserted[index];
      if (previous === undefined || current === undefined) continue;
      expect(compareRelationshipTargetIds(previous.targetId, current.targetId)).toBeLessThanOrEqual(0);
    }
    const replaced = upsertRelationshipEdge(inserted, edgeOf({ targetId: NPC_C, dimensions: dimsOf({ fear: 9 }) }));
    expect(replaced.map((edge) => edge.targetId)).toEqual([NPC_B, NPC_C, NPC_D]);
    expect(replaced[1]?.dimensions).toEqual(dimsOf({ fear: 9 }));
    expect(base).toHaveLength(2);
  });

  it("目标缺失时组件写入会新建边，并保持整体有序", () => {
    const empty: NpcRelationshipComponent = { outgoing: [] };
    const result = applyRelationshipSignalToComponent({
      relationships: empty,
      fromNpcId: NPC_A,
      targetId: NPC_D,
      signal: "gave_item",
      actionId: "act_create",
      turnNumber: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relationships.outgoing.map((edge) => edge.targetId)).toEqual([NPC_D]);
    expectValidComponent(result.relationships, "created edge");
  });

  it("自环与错边都被稳定错误拒绝", () => {
    const self = applyRelationshipSignal({
      edge: undefined, fromNpcId: NPC_A, targetId: NPC_A, signal: "supported", actionId: "act_self", turnNumber: 1,
    });
    expect(self.ok).toBe(false);
    if (self.ok) return;
    expect(self.code).toBe("self_edge_rejected");

    const mismatch = applyRelationshipSignal({
      edge: edgeOf({ targetId: NPC_C }),
      fromNpcId: NPC_A,
      targetId: NPC_B,
      signal: "supported",
      actionId: "act_mismatch",
      turnNumber: 1,
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.code).toBe("edge_target_mismatch");
  });

  it("非法 action 来源与未知 signal 返回稳定错误码", () => {
    const badSignal = applyRelationshipSignal({
      edge: edgeOf(), fromNpcId: NPC_A, targetId: NPC_B, signal: "charmed" as RelationshipSignal,
      actionId: "act_bad", turnNumber: 1,
    });
    expect(badSignal.ok).toBe(false);
    if (badSignal.ok) return;
    expect(badSignal.code).toBe("invalid_signal");

    const badAction = applyRelationshipSignal({
      edge: edgeOf(), fromNpcId: NPC_A, targetId: NPC_B, signal: "supported", actionId: "  ", turnNumber: 1,
    });
    expect(badAction.ok).toBe(false);
    if (badAction.ok) return;
    expect(badAction.code).toBe("invalid_action_source");

    const badTurn = applyRelationshipSignal({
      edge: edgeOf(), fromNpcId: NPC_A, targetId: NPC_B, signal: "supported", actionId: "act_ok", turnNumber: 1.5,
    });
    expect(badTurn.ok).toBe(false);
    if (badTurn.ok) return;
    expect(badTurn.code).toBe("invalid_turn_number");
  });
});

describe("闭集守门：原型链键不得穿透任何表查找", () => {
  it("signal 取 Object.prototype 键名时返回稳定 invalid_signal，而不是抛 TypeError 或静默写入", () => {
    for (const key of PROTOTYPE_KEYS) {
      const result = applyRelationshipSignal({
        edge: edgeOf(), fromNpcId: NPC_A, targetId: NPC_B, signal: key as RelationshipSignal,
        actionId: "act_proto", turnNumber: 1,
      });
      expect(result.ok, key).toBe(false);
      if (result.ok) continue;
      expect(result.code, key).toBe("invalid_signal");
    }
  });

  it("证据条目携带原型链 signal 时，同行动累计 delta 既不抛错也不变 NaN", () => {
    const polluted = edgeOf({
      stage: "acquainted",
      evidence: [bogusEvidence("toString", "act_polluted"), bogusEvidence("constructor", "act_polluted")],
    });
    const edge = applySignal({ signal: "supported", actionId: "act_polluted", turnNumber: 2, edge: polluted });
    expect(edge.dimensions).toEqual(dimsOf({ affinity: 3, trust: 2 }));
    for (const key of RELATIONSHIP_DIMENSION_KEYS) {
      expect(Number.isFinite(edge.dimensions[key]), `${key} 必须是有限数`).toBe(true);
    }
    // 这条边本身就带非法 signal：它只能来自绕过 validator 的持久化记录（validator 确实会拒绝），
    // 规则层的义务是不抛错、不把累计值变成 NaN，而不是替它清洗数据。
    expect(validateNpcRelationships({ outgoing: [edge] }).length).toBeGreaterThan(0);
  });

  it("stage 取原型链键名时保持原 stage、迁移判定为 false", () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(
        resolveRelationshipStage({ currentStage: key as RelationshipStage, candidate: "hostile" }), key,
      ).toBe(key);
      expect(isAllowedRelationshipStageTransition(key as RelationshipStage, "wary"), key).toBe(false);
      expect(isAllowedRelationshipStageTransition("wary", key as RelationshipStage), key).toBe(false);
    }
  });

  it("输入同一性：拒绝时原样回传入参组件，成功时不外借策略表的嵌套行对象", () => {
    const relationships: NpcRelationshipComponent = { outgoing: [edgeOf()] };
    const keysBefore = Object.keys(RELATIONSHIP_SIGNAL_POLICY);
    const rejected = applyRelationshipSignalToComponent({
      relationships, fromNpcId: NPC_A, targetId: NPC_B, signal: "toString" as RelationshipSignal,
      actionId: "act_identity", turnNumber: 1,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe("invalid_signal");
    expect(rejected.relationships).toBe(relationships);
    expect(rejected.relationships.outgoing).toBe(relationships.outgoing);
    expect(Object.keys(RELATIONSHIP_SIGNAL_POLICY)).toEqual(keysBefore);
    expect(Object.keys(RELATIONSHIP_SIGNAL_POLICY)).not.toContain("toString");
    expect(Object.prototype.hasOwnProperty.call(RELATIONSHIP_SIGNAL_POLICY, "toString")).toBe(false);

    const applied = applySignal({ signal: "supported", actionId: "act_identity_2" });
    const written = applied.evidence[0];
    expect(written?.summaryKey).toBe(RELATIONSHIP_SIGNAL_POLICY.supported.summaryKey);
    expect(written).not.toBe(RELATIONSHIP_SIGNAL_POLICY.supported);
    expect(applied.dimensions).not.toBe(RELATIONSHIP_SIGNAL_POLICY.supported.dimensions);
  });
});

describe("证据上限 12", () => {
  function edgeWithEvidence(count: number): DirectedRelationshipEdge {
    const evidence = RELATIONSHIP_SIGNALS.map((signal, index) =>
      evidenceOf(signal, `act_ev_${index}`, index + 1),
    ).slice(0, count);
    return edgeOf({ evidence, stage: "acquainted", dimensions: dimsOf({ affinity: 5, trust: 5 }) });
  }

  it("满 12 条后写入新证据会稳定裁掉最旧一条", () => {
    const full = edgeWithEvidence(RELATIONSHIP_EVIDENCE_CAP);
    const oldestId = full.evidence[0]?.evidenceId;
    const edge = applySignal({ signal: "refused", actionId: "act_ev_12", turnNumber: 13, edge: full });
    expect(edge.evidence).toHaveLength(RELATIONSHIP_EVIDENCE_CAP);
    expect(edge.evidence.map((entry) => entry.evidenceId)).not.toContain(oldestId);
    expect(edge.evidence[edge.evidence.length - 1]?.actionId).toBe("act_ev_12");
    expectValidEdge(edge, "evidence at cap");
  });

  it("规则层永不产出超过上限的证据", () => {
    let edge = edgeWithEvidence(RELATIONSHIP_EVIDENCE_CAP - 1);
    edge = applySignal({ signal: "betrayed", actionId: "act_ev_last", turnNumber: 12, edge });
    expect(edge.evidence.length).toBeLessThanOrEqual(RELATIONSHIP_EVIDENCE_CAP);
    expect(new Set(edge.evidence.map((entry) => entry.evidenceId)).size).toBe(edge.evidence.length);
  });
});

describe("stage 候选由阈值与累计证据共同裁决", () => {
  const positive = (signals: readonly RelationshipSignal[], actionPrefix: string): RelationshipEvidence[] =>
    signals.map((signal, index) => evidenceOf(signal, `${actionPrefix}_${index}`, index + 1));

  it("无任何证据时候选为 unknown", () => {
    expect(relationshipStageCandidate({ dimensions: ZERO_DIMENSIONS, evidence: [] })).toBe("unknown");
  });

  it("有证据但维度不足时为 acquainted", () => {
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: -3, trust: -1 }),
      evidence: positive(["challenged"], "act_acq"),
    })).toBe("acquainted");
  });

  it("cooperative 需要 trust≥20、affinity≥20 且一条正向证据", () => {
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 21, trust: 20 }),
      evidence: positive(["supported"], "act_coop"),
    })).toBe("cooperative");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 25, trust: 25 }),
      evidence: positive(["challenged"], "act_coop_neg"),
    })).toBe("acquainted");
  });

  it("trusted 需要 trust≥45、affinity≥35 且两条正向证据", () => {
    const dimensions = dimsOf({ affinity: 40, trust: 50 });
    expect(relationshipStageCandidate({ dimensions, evidence: positive(["supported"], "act_t1") })).toBe("cooperative");
    expect(relationshipStageCandidate({
      dimensions,
      evidence: positive(["supported", "offered_help"], "act_t2"),
    })).toBe("trusted");
  });

  it("bonded 需要 trust≥70、affinity≥60、三条正向证据且至少一条 major", () => {
    const dimensions = dimsOf({ affinity: 70, trust: 80 });
    const threeNormal = positive(["supported", "offered_help", "gave_item"], "act_b");
    expect(relationshipStageCandidate({ dimensions, evidence: threeNormal })).toBe("trusted");
    expect(relationshipStageCandidate({
      dimensions,
      evidence: positive(["supported", "offered_help", "fought_together"], "act_b2"),
    })).toBe("bonded");
    expect(relationshipStageCandidate({
      dimensions,
      evidence: positive(["supported", "fought_together"], "act_b3"),
    })).toBe("trusted");
  });

  it("wary 与 hostile 的三条/两条候选条件各自成立", () => {
    expect(relationshipStageCandidate({ dimensions: dimsOf({ fear: 40 }), evidence: positive(["supported"], "act_w1") }))
      .toBe("wary");
    expect(relationshipStageCandidate({ dimensions: dimsOf({ hostility: 25 }), evidence: [] })).toBe("wary");
    expect(relationshipStageCandidate({ dimensions: dimsOf({ affinity: -20 }), evidence: [] })).toBe("wary");
    expect(relationshipStageCandidate({ dimensions: dimsOf({ hostility: 60 }), evidence: [] })).toBe("hostile");
    expect(relationshipStageCandidate({ dimensions: dimsOf({ affinity: -60 }), evidence: [] })).toBe("hostile");
  });

  it("负向候选优先于正向候选：敌意压过亲密度", () => {
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 70, trust: 80, hostility: 60 }),
      evidence: positive(["supported", "offered_help", "fought_together"], "act_mix"),
    })).toBe("hostile");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 50, trust: 60, fear: 45 }),
      evidence: positive(["supported", "offered_help"], "act_mix2"),
    })).toBe("wary");
  });

  it("wary 压过 bonded：reviewer 反例必须判为 wary", () => {
    const bondedEvidence = positive(["supported", "offered_help", "fought_together"], "act_bw");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 60, trust: 70, fear: 45, hostility: 30 }),
      evidence: bondedEvidence,
    })).toBe("wary");
  });

  it("wary 与 bonded 直接对撞：三条 wary 触发条件各自都压过 bonded", () => {
    const bondedEvidence = positive(["supported", "offered_help", "kept_promise"], "act_bw2");
    const bondedOnly = dimsOf({ affinity: 60, trust: 70 });
    expect(relationshipStageCandidate({ dimensions: bondedOnly, evidence: bondedEvidence })).toBe("bonded");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 60, trust: 70, fear: 40 }), evidence: bondedEvidence,
    })).toBe("wary");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 60, trust: 70, hostility: 25 }), evidence: bondedEvidence,
    })).toBe("wary");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: -20, trust: 80 }), evidence: bondedEvidence,
    })).toBe("wary");
  });

  it("降低信任不是制造 bonded 的开关：同一恐惧峰值下 70 与 60 都必须是 wary", () => {
    const bondedEvidence = positive(["supported", "offered_help", "fought_together"], "act_mono");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 60, trust: 60, fear: 45, hostility: 30 }),
      evidence: bondedEvidence,
    })).toBe("wary");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 60, trust: 70, fear: 45, hostility: 30 }),
      evidence: bondedEvidence,
    })).toBe("wary");
  });

  it("裁决顺序逐档相邻：wary 阈值之下仍是 bonded，bonded 阈值之下仍是 trusted", () => {
    const bondedEvidence = positive(["supported", "offered_help", "fought_together"], "act_order");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 60, trust: 70, fear: 39, hostility: 24 }), evidence: bondedEvidence,
    })).toBe("bonded");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 60, trust: 70, hostility: 59 }), evidence: bondedEvidence,
    })).toBe("wary");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 60, trust: 70, hostility: 60 }), evidence: bondedEvidence,
    })).toBe("hostile");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 60, trust: 69 }), evidence: bondedEvidence,
    })).toBe("trusted");
  });

  it("trusted 的 trust/affinity 门是闭区间下界：44 与 34 都差一档", () => {
    const twoPositive = positive(["supported", "offered_help"], "act_tb");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 40, trust: 45 }), evidence: twoPositive,
    })).toBe("trusted");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 40, trust: 44 }), evidence: twoPositive,
    })).toBe("cooperative");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 35, trust: 50 }), evidence: twoPositive,
    })).toBe("trusted");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 34, trust: 50 }), evidence: twoPositive,
    })).toBe("cooperative");
  });

  it("bonded 的 trust/affinity 门是闭区间下界：69 与 59 都跌回 trusted", () => {
    const threeWithMajor = positive(["supported", "offered_help", "kept_promise"], "act_bb");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 70, trust: 70 }), evidence: threeWithMajor,
    })).toBe("bonded");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 70, trust: 69 }), evidence: threeWithMajor,
    })).toBe("trusted");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 60, trust: 80 }), evidence: threeWithMajor,
    })).toBe("bonded");
    expect(relationshipStageCandidate({
      dimensions: dimsOf({ affinity: 59, trust: 80 }), evidence: threeWithMajor,
    })).toBe("trusted");
  });
});

describe("允许转换图与速度", () => {
  it("导出表与计划文本的双向对 + 单向降级逐格一致", () => {
    expect(Object.keys(RELATIONSHIP_STAGE_TRANSITIONS).sort()).toEqual([...RELATIONSHIP_STAGES].sort());
    for (const stage of RELATIONSHIP_STAGES) {
      expect([...RELATIONSHIP_STAGE_TRANSITIONS[stage]].sort(), stage)
        .toEqual([...(SPEC_ADJACENCY.get(stage) ?? [])].sort());
    }
  });

  it("邻居数组严格按 RELATIONSHIP_STAGES 排序：BFS 的并列裁决因此确定", () => {
    for (const stage of RELATIONSHIP_STAGES) {
      const expectedOrdered = RELATIONSHIP_STAGES.filter((other) => other !== stage && SPEC_ALLOWED.has(pairKey(stage, other)));
      expect([...RELATIONSHIP_STAGE_TRANSITIONS[stage]], `${stage} 邻居顺序`).toEqual(expectedOrdered);
    }
  });

  it("7×7 矩阵：isAllowedRelationshipStageTransition 与规格逐格一致", () => {
    for (const from of RELATIONSHIP_STAGES) {
      for (const to of RELATIONSHIP_STAGES) {
        expect(isAllowedRelationshipStageTransition(from, to), `${from}->${to}`)
          .toBe(from !== to && SPEC_ALLOWED.has(pairKey(from, to)));
      }
    }
  });

  it("7×7 矩阵：resolveRelationshipStage 最多一档、不跳级、不越图", () => {
    for (const from of RELATIONSHIP_STAGES) {
      for (const to of RELATIONSHIP_STAGES) {
        const next = resolveRelationshipStage({ currentStage: from, candidate: to });
        const label = `${from}|${to}`;
        if (from === to) {
          expect(next, label).toBe(from);
          continue;
        }
        const distance = specDistance(from, to);
        expect(distance, label).not.toBeNull();
        if (distance === null) continue;
        if (distance === 1) {
          expect(next, label).toBe(to);
          continue;
        }
        expect(next, label).not.toBe(to);
        expect(next, label).not.toBe(from);
        expect(SPEC_ALLOWED.has(pairKey(from, next)), `${label} 必须落在允许图上`).toBe(true);
        expect(specDistance(next, to), `${label} 距离必须缩短`).toBe(distance - 1);
      }
    }
  });

  it("wary 恢复信任必须逐档：先退到 acquainted，经 cooperative 才可能到 trusted，绝不跳级", () => {
    let edge = edgeOf({
      stage: "wary",
      dimensions: dimsOf({ affinity: -21, fear: 0, hostility: 0 }),
      evidence: [evidenceOf("challenged", "act_wary_seed", 1)],
    });
    const stages: RelationshipStage[] = [];
    const cycle: readonly RelationshipSignal[] = ["kept_promise", "fought_together"];
    for (let index = 0; index < 16; index += 1) {
      const signal = cycle[index % 2] ?? "supported";
      edge = applySignal({ signal, actionId: `act_recover_${index}`, turnNumber: index + 2, edge });
      stages.push(edge.stage);
    }
    // 第一步只能沿允许图退一档，直接升到 trusted/bonded 属于跳级
    expect(stages[0]).toBe("acquainted");
    expect(stages).not.toContain("bonded");
    const firstCooperative = stages.indexOf("cooperative");
    const firstTrusted = stages.indexOf("trusted");
    expect(firstCooperative).toBeGreaterThanOrEqual(0);
    expect(firstTrusted).toBeGreaterThan(firstCooperative);
    expect(stages[stages.length - 1]).toBe("trusted");
    for (let index = 1; index < stages.length; index += 1) {
      const previous = stages[index - 1];
      const current = stages[index];
      if (previous === undefined || current === undefined) continue;
      expect(previous === current || isAllowedRelationshipStageTransition(previous, current), `${previous}->${current}`)
        .toBe(true);
    }
  });

  it("每个已提交 action 最多移动一档：同一 action 的第二个信号不再升档", () => {
    const seed = edgeOf({
      stage: "wary",
      dimensions: dimsOf({ affinity: 30, trust: 36 }),
      evidence: [evidenceOf("supported", "act_stage_seed", 1)],
    });
    const first = applySignal({ signal: "supported", actionId: "act_same_turn", turnNumber: 5, edge: seed });
    // 候选 cooperative（trusted 还差 trust），wary→cooperative 允许一档
    expect(first.dimensions).toEqual(dimsOf({ affinity: 33, trust: 38 }));
    expect(first.stage).toBe("cooperative");
    const frozen = applySignal({ signal: "kept_promise", actionId: "act_same_turn", turnNumber: 5, edge: first });
    // 候选已到 trusted 且 cooperative→trusted 合法，但本行动已移动过一档 ⇒ 冻结
    expect(relationshipStageCandidate({ dimensions: frozen.dimensions, evidence: frozen.evidence })).toBe("trusted");
    expect(frozen.dimensions).toEqual(dimsOf({ affinity: 35, trust: 48 }));
    expect(frozen.stage).toBe("cooperative");
    expect(frozen.evidence).toHaveLength(3);
    expectValidEdge(frozen, "stage frozen within action");
    const nextAction = applySignal({ signal: "kept_promise", actionId: "act_next_turn", turnNumber: 6, edge: frozen });
    expect(nextAction.stage).toBe("trusted");
  });

  it("阈值满足但证据门槛不满足时保持原 stage", () => {
    const edge = applySignal({
      signal: "kept_promise",
      actionId: "act_gate",
      turnNumber: 3,
      edge: edgeOf({ stage: "cooperative", dimensions: dimsOf({ affinity: 40, trust: 60 }) }),
    });
    // trust/affinity 已达 trusted，但只有这一条正向证据 ⇒ 候选仍是 cooperative
    expect(edge.stage).toBe("cooperative");
    expect(relationshipStageCandidate({ dimensions: edge.dimensions, evidence: edge.evidence })).toBe("cooperative");
  });

  it("从 unknown 跌到 hostile 也必须逐档：先 acquainted，再 wary，才可能 hostile", () => {
    let edge = edgeOf();
    const stages: RelationshipStage[] = [];
    const cycle: readonly RelationshipSignal[] = ["threatened", "deceived", "betrayed"];
    for (let index = 0; index < 12; index += 1) {
      const signal = cycle[index % 3] ?? "threatened";
      edge = applySignal({ signal, actionId: `act_neg_${index}`, turnNumber: index + 1, edge });
      stages.push(edge.stage);
    }
    expect(stages[0]).toBe("acquainted");
    expect(stages.indexOf("hostile")).toBeGreaterThan(stages.indexOf("wary"));
    expect(stages).not.toContain("trusted");
    expect(stages).not.toContain("cooperative");
    for (let index = 1; index < stages.length; index += 1) {
      const previous = stages[index - 1];
      const current = stages[index];
      if (previous === undefined || current === undefined) continue;
      expect(previous === current || isAllowedRelationshipStageTransition(previous, current), `${previous}->${current}`)
        .toBe(true);
    }
    expectValidEdge(edge, "hostile chain");
  });
});

describe("commitment 操作", () => {
  function openDebtEdge(): DirectedRelationshipEdge {
    return applySignal({ signal: "gave_item", actionId: "act_gift", turnNumber: 2 });
  }

  function openPromiseEdge(): DirectedRelationshipEdge {
    const source = { kind: "action", actionId: "act_seed", turnNumber: 1 } as const;
    return edgeOf({
      stage: "acquainted",
      commitments: [{
        kind: "promise",
        commitmentId: mintRelationshipCommitmentId({ source, op: "open_promise", openKey: "escort" }),
        promisor: "target",
        status: "open",
        description: "relationship.commitment.promise.escort",
        source,
      }],
    });
  }

  it("gave_item 由信号表开一条 source_owes_target 的 open debt", () => {
    const edge = openDebtEdge();
    expect(edge.commitments).toHaveLength(1);
    const debt = edge.commitments[0];
    expect(debt?.kind).toBe("debt");
    if (debt?.kind !== "debt") return;
    expect(debt.direction).toBe("source_owes_target");
    expect(debt.status).toBe("open");
    expect(debt.source).toEqual({ kind: "action", actionId: "act_gift", turnNumber: 2 });
    expect(debt.commitmentId).toContain("act_gift");
    expectValidEdge(edge, "edge with opened debt");
  });

  it("同一行动的重复信号不会开出第二条债务，ID 完全由来源推导", () => {
    const edge = openDebtEdge();
    const again = applyRelationshipSignal({
      edge, fromNpcId: NPC_A, targetId: NPC_B, signal: "gave_item", actionId: "act_gift", turnNumber: 2,
    });
    expect(again.ok && again.changed).toBe(false);
    const secondGift = applySignal({ signal: "gave_item", actionId: "act_gift_2", turnNumber: 3, edge });
    expect(secondGift.commitments).toHaveLength(2);
    const ids = secondGift.commitments.map((commitment) => commitment.commitmentId);
    expect(new Set(ids).size).toBe(2);
    expectValidEdge(secondGift, "two debts from two actions");
  });

  it("kept_promise 结案最近一条 open promise，没有可结案对象时仍写入维度", () => {
    const withPromise = openPromiseEdge();
    const kept = applySignal({ signal: "kept_promise", actionId: "act_keep", turnNumber: 4, edge: withPromise });
    expect(kept.commitments[0]?.status).toBe("fulfilled");
    const without = applySignal({ signal: "kept_promise", actionId: "act_keep_2", turnNumber: 5 });
    expect(without.commitments).toEqual([]);
    expect(without.dimensions.trust).toBe(EXPECTED_SIGNAL_EFFECT.kept_promise.dimensions.trust);
  });

  it("broke_promise 只破坏 promise，不动同一边上的 debt", () => {
    const source = { kind: "action", actionId: "act_seed", turnNumber: 1 } as const;
    const edge = edgeOf({
      stage: "acquainted",
      commitments: [
        {
          kind: "debt",
          commitmentId: mintRelationshipCommitmentId({ source, op: "open_debt", openKey: "gift" }),
          direction: "target_owes_source",
          status: "open",
          description: "relationship.commitment.debt.gift",
          source,
        },
        {
          kind: "promise",
          commitmentId: mintRelationshipCommitmentId({ source, op: "open_promise", openKey: "escort" }),
          promisor: "target",
          status: "open",
          description: "relationship.commitment.promise.escort",
          source,
        },
      ],
    });
    const broken = applySignal({ signal: "broke_promise", actionId: "act_break", turnNumber: 6, edge });
    expect(broken.commitments.map((commitment) => commitment.status)).toEqual(["open", "broken"]);
    const betrayed = applySignal({ signal: "betrayed", actionId: "act_betray", turnNumber: 7, edge });
    expect(betrayed.commitments.map((commitment) => commitment.status)).toEqual(["broken", "open"]);
    expectValidEdge(broken, "broken promise");
  });

  it("applyRelationshipCommitment 对 debt 的三个结案操作各自命中计划允许的迁移（release 见下一用例）", () => {
    const debt = openDebtEdge();
    const debtId = debt.commitments[0]?.commitmentId ?? "";
    const cases: readonly (readonly [
      "fulfill" | "forgive" | "break",
      string,
    ])[] = [["fulfill", "fulfilled"], ["forgive", "forgiven"], ["break", "broken"]];
    for (const [kind, status] of cases) {
      const result = applyRelationshipCommitment({
        edge: debt,
        operation: { kind, commitmentId: debtId },
        actionId: "act_resolve",
        turnNumber: 9,
      });
      expect(result.ok, kind).toBe(true);
      if (!result.ok) continue;
      expect(result.changed, kind).toBe(true);
      expect(result.edge.commitments[0]?.status, kind).toBe(status);
      expect(result.edge.dimensions).toEqual(debt.dimensions);
      expect(result.edge.stage).toBe(debt.stage);
      expect(result.edge.lastChangedAtTurn).toBe(9);
      expectValidEdge(result.edge, kind);
    }
  });

  it("release 只作用于 promise，forgive 与 release 互斥", () => {
    const promiseEdge = openPromiseEdge();
    const promiseId = promiseEdge.commitments[0]?.commitmentId ?? "";
    const released = applyRelationshipCommitment({
      edge: promiseEdge, operation: { kind: "release", commitmentId: promiseId }, actionId: "act_release", turnNumber: 8,
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.edge.commitments[0]?.status).toBe("released");
    expectValidEdge(released.edge, "released promise");

    const forgiven = applyRelationshipCommitment({
      edge: promiseEdge, operation: { kind: "forgive", commitmentId: promiseId }, actionId: "act_forgive", turnNumber: 8,
    });
    expect(forgiven.ok).toBe(false);
    if (forgiven.ok) return;
    expect(forgiven.code).toBe("illegal_commitment_transition");

    const debtEdge = openDebtEdge();
    const debtId = debtEdge.commitments[0]?.commitmentId ?? "";
    const debtRelease = applyRelationshipCommitment({
      edge: debtEdge, operation: { kind: "release", commitmentId: debtId }, actionId: "act_release_debt", turnNumber: 8,
    });
    expect(debtRelease.ok).toBe(false);
    if (debtRelease.ok) return;
    expect(debtRelease.code).toBe("illegal_commitment_transition");
  });

  it("未知 commitmentId 与非法状态迁移零写入并返回稳定错误", () => {
    const debt = openDebtEdge();
    const unknown = applyRelationshipCommitment({
      edge: debt, operation: { kind: "fulfill", commitmentId: "cmt:action:nowhere:open_debt:x" },
      actionId: "act_unknown", turnNumber: 3,
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.code).toBe("unknown_commitment");

    const debtId = debt.commitments[0]?.commitmentId ?? "";
    const first = applyRelationshipCommitment({
      edge: debt, operation: { kind: "fulfill", commitmentId: debtId }, actionId: "act_f1", turnNumber: 4,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyRelationshipCommitment({
      edge: first.edge, operation: { kind: "fulfill", commitmentId: debtId }, actionId: "act_f2", turnNumber: 5,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("illegal_commitment_transition");
    expect(second.edge).toBe(first.edge);
  });

  it("非法操作名与非法 action 来源返回稳定错误", () => {
    const debt = openDebtEdge();
    const badOp = applyRelationshipCommitment({
      edge: debt,
      operation: { kind: "erase", commitmentId: debt.commitments[0]?.commitmentId ?? "" } as unknown as RelationshipCommitmentOperation,
      actionId: "act_bad_op",
      turnNumber: 1,
    });
    expect(badOp.ok).toBe(false);
    if (badOp.ok) return;
    expect(badOp.code).toBe("invalid_commitment_operation");

    const badSource: ApplyRelationshipCommitmentResult = applyRelationshipCommitment({
      edge: debt, operation: { kind: "fulfill", commitmentId: debt.commitments[0]?.commitmentId ?? "" },
      actionId: "", turnNumber: 1,
    });
    expect(badSource.ok).toBe(false);
    if (badSource.ok) return;
    expect(badSource.code).toBe("invalid_action_source");

    const badTurn = applyRelationshipCommitment({
      edge: debt, operation: { kind: "fulfill", commitmentId: debt.commitments[0]?.commitmentId ?? "" },
      actionId: "act_turn", turnNumber: -2,
    });
    expect(badTurn.ok).toBe(false);
    if (badTurn.ok) return;
    expect(badTurn.code).toBe("invalid_turn_number");
  });

  it("open_debt / open_promise 幂等：同 action + openKey 重放零写入", () => {
    const base = edgeOf({ stage: "acquainted" });
    const opened = applyRelationshipCommitment({
      edge: base,
      operation: { kind: "open_debt", openKey: "loan", direction: "target_owes_source", description: "relationship.commitment.debt.loan" },
      actionId: "act_open",
      turnNumber: 4,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.edge.commitments).toHaveLength(1);
    expect(opened.edge.commitments[0]?.commitmentId).toBe(mintRelationshipCommitmentId({
      source: { kind: "action", actionId: "act_open", turnNumber: 4 }, op: "open_debt", openKey: "loan",
    }));
    const replay = applyRelationshipCommitment({
      edge: opened.edge,
      operation: { kind: "open_debt", openKey: "loan", direction: "target_owes_source", description: "relationship.commitment.debt.loan" },
      actionId: "act_open",
      turnNumber: 4,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.changed).toBe(false);
    expect(replay.reason).toBe("already_applied");
    expect(replay.edge).toBe(opened.edge);

    const promise = applyRelationshipCommitment({
      edge: base,
      operation: { kind: "open_promise", openKey: "guide", promisor: "source", description: "relationship.commitment.promise.guide" },
      actionId: "act_promise",
      turnNumber: 5,
    });
    expect(promise.ok).toBe(true);
    if (!promise.ok) return;
    expect(promise.edge.commitments[0]?.kind).toBe("promise");
    expectValidEdge(promise.edge, "opened promise");
  });

  it("commitment 操作绝不改动数值、stage 与 trend，也不接受不存在的边", () => {
    const debt = openDebtEdge();
    const result = applyRelationshipCommitment({
      edge: { ...debt, stage: "cooperative", trend: "worsening" },
      operation: { kind: "break", commitmentId: debt.commitments[0]?.commitmentId ?? "" },
      actionId: "act_break_only",
      turnNumber: 11,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edge.dimensions).toEqual(debt.dimensions);
    expect(result.edge.stage).toBe("cooperative");
    expect(result.edge.trend).toBe("worsening");
    expect(result.edge.evidence).toBe(debt.evidence);
  });
});

describe("模块 facade 暴露同一实现", () => {
  it("index 只重导出组件入口，裸 applyRelationshipSignal 不在公开面上", async () => {
    const facade = await import("./index");
    expect(facade.applyRelationshipSignalToComponent).toBe(applyRelationshipSignalToComponent);
    expect(facade.RELATIONSHIP_SIGNAL_POLICY).toBe(RELATIONSHIP_SIGNAL_POLICY);
    // 裸函数接受 edge: undefined，分不清「还没有边」与「调用方跳过了查边」，所以不给门面。
    expect("applyRelationshipSignal" in facade).toBe(false);
  });
});

// 放在文件最后：下面的改写尝试若失败（未冻结），会污染同一模块实例的其它用例。
describe("导出的规则表深冻结", () => {
  it("嵌套 dimensions / commitment 行同样不可改写，规则行为不受改写尝试影响", () => {
    const supported = RELATIONSHIP_SIGNAL_POLICY.supported;
    const gaveItem = RELATIONSHIP_SIGNAL_POLICY.gave_item;
    expect(Object.isFrozen(supported), "行本身").toBe(true);
    expect(Object.isFrozen(supported.dimensions), "嵌套 dimensions").toBe(true);
    expect(Object.isFrozen(gaveItem.commitment), "嵌套 commitment 规则").toBe(true);
    expect(Object.isFrozen(RELATIONSHIP_SIGNAL_CAPS.normal)).toBe(true);
    expect(Object.isFrozen(RELATIONSHIP_STAGE_GATES.bonded)).toBe(true);

    expect(writeRejected(() => {
      (supported.dimensions as { affinity: number }).affinity = 99;
    }), "改写 dimensions.affinity").toBe(true);
    expect(writeRejected(() => {
      (supported as { summaryKey: string }).summaryKey = "hacked";
    }), "改写 summaryKey").toBe(true);
    expect(writeRejected(() => {
      (gaveItem.commitment as { openKey: string }).openKey = "hacked";
    }), "改写 commitment 规则").toBe(true);
    expect(writeRejected(() => {
      (RELATIONSHIP_SIGNAL_CAPS.normal as { singleDimension: number }).singleDimension = 500;
    }), "改写 caps 行").toBe(true);
    expect(writeRejected(() => {
      (RELATIONSHIP_STAGE_GATES.bonded as { trust: number }).trust = 0;
    }), "改写 stage 门行").toBe(true);

    expect(RELATIONSHIP_SIGNAL_CAPS.normal.singleDimension).toBe(5);
    expect(RELATIONSHIP_STAGE_GATES.bonded.trust).toBe(70);
    const edge = applySignal({ signal: "supported", actionId: "act_after_freeze" });
    expect(edge.dimensions).toEqual(dimsOf({ affinity: 3, trust: 2 }));
    const debt = applySignal({ signal: "gave_item", actionId: "act_after_freeze_debt" });
    const openedDebt = debt.commitments[0];
    expect(openedDebt?.commitmentId).toContain("gave_item");
    expect(openedDebt?.kind).toBe("debt");
    if (openedDebt?.kind !== "debt") return;
    expect(openedDebt.direction).toBe("source_owes_target");
  });
});
