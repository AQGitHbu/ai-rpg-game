import { describe, expect, it } from "vitest";
import { PLAYER_ENTITY_ID, asFactId, asLocationId, asNpcId, asPlayerEntityId } from "../worldEntity";
import type { FactId, LocationId, NpcId } from "../worldEntity";
import type { NpcEntry, NpcInteraction } from "../worldEntries";
import type { EntityRecord, NpcEntityRecord } from "./entityRecord";
import type {
  DirectedRelationshipEdge, NpcDynamicStateComponent, NpcGoal,
  NpcIdentityAnchors,
} from "./npcComponents";
import { createEntityStore } from "./entityStore";
import {
  LEGACY_IMPORT_REASON_KEY, importNpcLayers, npcLegacyGoalId, projectNpcEntry,
} from "./npcProjection";

// ---------------------------------------------------------------------------
// Task 2 的唯一事实源证明：分层组件才是事实，legacy NpcEntry 只由 projector 重建。
// 本文件的 record 一律用新形状手工构造，绝不经过 npcState。
// ---------------------------------------------------------------------------

/**
 * 编译期锁（只有 typecheck 牙齿，无运行时语义）：这是一次非分派的子集检查——
 * `keyof NpcEntityRecord` 必须整体落在下面七个键之内。
 * 能抓出：record 多出七键之外的任何键（例如重新带上 npcState）。
 * 抓不到缺分层组件：删掉或可选化某个键之后，剩下的键仍是七键的子集，锁照样为 true。
 * 那种漂移由 NpcEntityRecord 的必填键类型（构造处即 typecheck 失败）与 entityStore 的
 * 运行时组件签名校验（invalid_record_shape）负责。
 * 键类型退化成 never 时本锁同样为 true（`never extends …` 恒真），内层 `""` 子句只在
 * record 真的多出 `""` 键时为 false——那种情况外层子集检查已经拦下，内层不额外兜任何底。
 */
type NpcRecordKeys = keyof NpcEntityRecord;
type LayeredRecordLock = NpcRecordKeys extends
  "core" | "identity" | "position" | "dynamicState" | "knowledge" | "relationships" | "history"
  ? ("" extends NpcRecordKeys ? false : true)
  : false;
const layeredRecord: LayeredRecordLock = true;
void layeredRecord;

const LOC = asLocationId("loc_0");
const OTHER_NPC = asNpcId("npc_1");

function anchors(): NpcIdentityAnchors {
  return {
    selfConcept: "守夜人",
    values: ["守诺"],
    speechStyle: "短句",
    capabilityBoundaries: ["不会骑马"],
    taboos: ["不提旧主"],
  };
}

function interaction(actionId: string, turnNumber = 1, learnedFactIds: readonly FactId[] = []): NpcInteraction {
  return {
    turnNumber,
    actionId,
    locationId: LOC,
    dialogueAct: "ask",
    topicSummary: "打听井钥",
    outcome: "positive",
    relationshipDelta: 1,
    learnedFactIds,
    summary: `${actionId} 的交谈`,
  };
}

function edge(overrides: Partial<DirectedRelationshipEdge> & { targetId: string } = { targetId: PLAYER_ENTITY_ID }): DirectedRelationshipEdge {
  return {
    targetId: overrides.targetId,
    dimensions: { affinity: 12, trust: 30, fear: 0, hostility: 0 },
    stage: "cooperative",
    trend: "improving",
    commitments: [{
      kind: "debt",
      commitmentId: "cmt_1",
      direction: "target_owes_source",
      status: "open",
      description: "欠一次引路",
      source: { kind: "initial_world", createdAtTurn: 0, reasonKey: "opening_seed" },
    }],
    evidence: [{
      evidenceId: "ev_act_1",
      actionId: "act_1",
      turnNumber: 1,
      signal: "supported",
      severity: "normal",
      summaryKey: "supported",
    }],
    origin: { kind: "action", actionId: "act_1", turnNumber: 1 },
    lastChangedAtTurn: 1,
    ...(overrides.dimensions === undefined ? {} : { dimensions: overrides.dimensions }),
    ...(overrides.stage === undefined ? {} : { stage: overrides.stage }),
    ...(overrides.trend === undefined ? {} : { trend: overrides.trend }),
    ...(overrides.commitments === undefined ? {} : { commitments: overrides.commitments }),
    ...(overrides.evidence === undefined ? {} : { evidence: overrides.evidence }),
    ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
    ...(overrides.lastChangedAtTurn === undefined ? {} : { lastChangedAtTurn: overrides.lastChangedAtTurn }),
  } as DirectedRelationshipEdge;
}

function goals(): readonly NpcGoal[] {
  return [
    { goalId: "npc_0_goal_1", horizon: "short", description: "守住客栈", priority: 2, status: "active", reason: "家业" },
    { goalId: "npc_0_goal_2", horizon: "long", description: "找回弟弟", priority: 4, status: "blocked", reason: "线索断" },
    { goalId: "npc_0_goal_3", horizon: "long", description: "离开小镇", priority: 5, status: "completed", reason: "已达成" },
  ];
}

function record(overrides: Partial<{
  known: readonly FactId[];
  secret: readonly FactId[];
  history: readonly NpcInteraction[];
  affinity: number | undefined;
  emotion: NpcDynamicStateComponent["emotion"];
  met: boolean;
  isCompanion: boolean;
}> = {}): NpcEntityRecord {
  const knownFacts = overrides.known ?? [asFactId("fact_0"), asFactId("fact_1")];
  const secrets = new Set((overrides.secret ?? [asFactId("fact_1")]).map(String));
  const outgoing: readonly DirectedRelationshipEdge[] = overrides.affinity === undefined
    ? []
    : [edge({ targetId: PLAYER_ENTITY_ID, dimensions: {
      affinity: overrides.affinity, trust: 30, fear: 0, hostility: 0,
    }, commitments: [], evidence: [] })];
  return {
    core: { id: asNpcId("npc_0"), kind: "npc", name: "老周", createdAtTurn: 0, lifecycle: "active" },
    identity: { role: "掌柜", description: "客栈掌柜", tags: ["shopkeep"], anchors: anchors() },
    position: { locationId: LOC, locationOrder: 0 },
    dynamicState: {
      isCompanion: overrides.isCompanion ?? false,
      met: overrides.met ?? true,
      emotion: overrides.emotion ?? "warm",
      goals: goals(),
    },
    knowledge: {
      entries: knownFacts.map((factId) => ({
        factId,
        certainty: "known" as const,
        disclosure: secrets.has(String(factId)) ? ("secret" as const) : ("public" as const),
        source: { kind: "initial_world" as const, learnedAtTurn: 0 },
      })),
    },
    relationships: { outgoing },
    history: { interactions: overrides.history ?? [interaction("act_1")] },
  };
}

function legacyEntry(memory: NpcEntry["memory"], overrides: Partial<NpcEntry> = {}): NpcEntry {
  return {
    id: asNpcId("npc_0"),
    name: "老周",
    role: "掌柜",
    description: "客栈掌柜",
    locationId: LOC,
    isCompanion: false,
    tags: ["shopkeep"],
    met: true,
    memory,
    ...overrides,
  };
}

function legacyMemory(overrides: Partial<NpcEntry["memory"]> = {}): NpcEntry["memory"] {
  return {
    npcId: asNpcId("npc_0"),
    knownFactIds: [asFactId("fact_0")],
    hiddenFactIds: [],
    interactionHistory: [],
    relationship: { affinity: 0 },
    emotion: "neutral",
    goals: ["守住客栈"],
    ...overrides,
  };
}

/** store 的 missing_player 不变量要求每条记录集里都有玩家角色。 */
function playerRecord(): EntityRecord {
  return {
    core: { id: asPlayerEntityId(PLAYER_ENTITY_ID), kind: "player_character", name: "沈希", createdAtTurn: 0, lifecycle: "active" },
    identity: { identity: "走镖人", stats: { hp: 20, attack: 5, defense: 3 } },
    position: { locationId: LOC, locationOrder: 0 },
  };
}

describe("npc projection：分层组件是唯一事实源", () => {
  it("分层 record 可被 store 原样接受（上方编译期锁只排除七键之外的多余键）", () => {
    const npc = record({ affinity: 12 });
    const store = createEntityStore([npc, playerRecord()]);
    expect(store.records[0]).toBe(npc);
  });

  it("legacy memory 由分层组件精确重建", () => {
    const npc = record({ affinity: 12 });
    const entry = projectNpcEntry(npc);
    expect(entry.memory).toEqual({
      npcId: asNpcId("npc_0"),
      knownFactIds: [asFactId("fact_0"), asFactId("fact_1")],
      hiddenFactIds: [asFactId("fact_1")],
      interactionHistory: [interaction("act_1")],
      relationship: { affinity: 12 },
      emotion: "warm",
      goals: ["守住客栈", "找回弟弟"],
    });
    expect(entry.role).toBe("掌柜");
    expect(entry.description).toBe("客栈掌柜");
    expect(entry.tags).toEqual(["shopkeep"]);
    expect(entry.locationId).toBe(LOC);
    expect(entry.isCompanion).toBe(false);
    expect(entry.met).toBe(true);
  });

  it("没有指向玩家的边时 affinity 为 0；goals 只投影 active/blocked", () => {
    const npc = record({ affinity: undefined });
    expect(projectNpcEntry(npc).memory.relationship).toEqual({ affinity: 0 });
    const withCompanion = record({ affinity: -100, isCompanion: true, met: false });
    const projected = projectNpcEntry(withCompanion);
    expect(projected.memory.relationship).toEqual({ affinity: -100 });
    expect(projected.isCompanion).toBe(true);
    expect(projected.met).toBe(false);
  });

  it("hiddenFactIds 只取 disclosure=secret", () => {
    const npc = record({ secret: [] });
    const projected = projectNpcEntry(npc);
    expect(projected.memory.hiddenFactIds).toEqual([]);
    expect(projected.memory.knownFactIds).toEqual([asFactId("fact_0"), asFactId("fact_1")]);
  });
});

describe("npc projection：legacy 导入桥（保守 anchors / goal ID / initial knowledge / player edge）", () => {
  it("全新导入生成保守 anchors、按 npcId+ordinal 铸造 goalId、initial_world 知识与 player 边", () => {
    const entry = legacyEntry(legacyMemory({
      knownFactIds: [asFactId("fact_0")],
      hiddenFactIds: [asFactId("fact_secret")],
      relationship: { affinity: 7 },
      emotion: "guarded",
      goals: ["守住客栈", "找回弟弟"],
      interactionHistory: [interaction("act_1")],
    }));
    const layers = importNpcLayers({ entry, createdAtTurn: 3 });
    expect(layers.anchors).toEqual({
      selfConcept: LEGACY_IMPORT_REASON_KEY,
      values: [LEGACY_IMPORT_REASON_KEY],
      speechStyle: LEGACY_IMPORT_REASON_KEY,
      capabilityBoundaries: [LEGACY_IMPORT_REASON_KEY],
      taboos: [],
    });
    expect(layers.dynamicState).toEqual({
      isCompanion: false,
      met: true,
      emotion: "guarded",
      goals: [
        {
          goalId: npcLegacyGoalId("npc_0", 1), horizon: "short", description: "守住客栈",
          priority: 3, status: "active", reason: LEGACY_IMPORT_REASON_KEY,
        },
        {
          goalId: npcLegacyGoalId("npc_0", 2), horizon: "short", description: "找回弟弟",
          priority: 3, status: "active", reason: LEGACY_IMPORT_REASON_KEY,
        },
      ],
    });
    // 私密事实同样是「知道」，只是不对外披露：条目顺序取 legacy 已知顺序后追加仅隐藏的条目。
    expect(layers.knowledge.entries).toEqual([
      {
        factId: asFactId("fact_0"), certainty: "known", disclosure: "public",
        source: { kind: "initial_world", learnedAtTurn: 3 },
      },
      {
        factId: asFactId("fact_secret"), certainty: "known", disclosure: "secret",
        source: { kind: "initial_world", learnedAtTurn: 3 },
      },
    ]);
    expect(layers.relationships.outgoing).toEqual([edge({
      targetId: PLAYER_ENTITY_ID,
      dimensions: { affinity: 7, trust: 0, fear: 0, hostility: 0 },
      stage: "acquainted",
      trend: "stable",
      commitments: [],
      evidence: [],
      origin: { kind: "initial_world", createdAtTurn: 3, reasonKey: LEGACY_IMPORT_REASON_KEY },
      lastChangedAtTurn: 3,
    })]);
    expect(layers.history.interactions).toEqual([interaction("act_1")]);
    // 导入结果必须能被 projectNpcEntry 逐字重建回 legacy memory。
    expect(projectNpcEntry({ ...record(), ...layers, identity: { ...record().identity, anchors: layers.anchors } }).memory)
      .toEqual({ ...entry.memory, knownFactIds: [asFactId("fact_0"), asFactId("fact_secret")] });
  });

  it("兼容导入新建知识只使用 legacy_import 的 initial_world provenance", () => {
    const layers = importNpcLayers({
      entry: legacyEntry(legacyMemory({
        knownFactIds: [asFactId("fact_new")],
        hiddenFactIds: [],
      })),
      createdAtTurn: 8,
    });
    expect(layers.knowledge.entries).toEqual([{
      factId: asFactId("fact_new"),
      certainty: "known",
      disclosure: "public",
      source: { kind: "initial_world", learnedAtTurn: 8 },
    }]);
    expect(layers.knowledge.entries.every((entry) => entry.source.kind === "initial_world")).toBe(true);
  });

  it("未见过面且 affinity 为 0 的导入仍然建立 player 边（stage=unknown）", () => {
    const layers = importNpcLayers({
      entry: legacyEntry(legacyMemory(), { met: false }),
      createdAtTurn: 0,
    });
    expect(layers.relationships.outgoing).toEqual([edge({
      targetId: PLAYER_ENTITY_ID,
      dimensions: { affinity: 0, trust: 0, fear: 0, hostility: 0 },
      stage: "unknown",
      trend: "stable",
      commitments: [],
      evidence: [],
      origin: { kind: "initial_world", createdAtTurn: 0, reasonKey: LEGACY_IMPORT_REASON_KEY },
      lastChangedAtTurn: 0,
    })]);
  });

  it("player 边按 targetId 稳定排序，npc 边在前", () => {
    const previous: NpcEntityRecord = {
      ...record({ affinity: 5 }),
      relationships: { outgoing: [edge({ targetId: PLAYER_ENTITY_ID }), edge({ targetId: OTHER_NPC })] },
    };
    const layers = importNpcLayers({ entry: legacyEntry(legacyMemory({ relationship: { affinity: 9 } })), createdAtTurn: 0, previous });
    expect(layers.relationships.outgoing.map((entry) => entry.targetId)).toEqual([OTHER_NPC, PLAYER_ENTITY_ID]);
  });
});

describe("npc projection：previous store 的分层组件逐字保留", () => {
  it("legacy memory 未变时五个字段全部原样继承，不被重建", () => {
    const previous = record({ affinity: 12 });
    const entry = legacyEntry(projectNpcEntry(previous).memory);
    const layers = importNpcLayers({ entry, createdAtTurn: 9, previous });
    expect(layers.anchors).toEqual(previous.identity.anchors);
    expect(layers.dynamicState).toEqual(previous.dynamicState);
    expect(layers.knowledge).toEqual(previous.knowledge);
    expect(layers.relationships).toEqual(previous.relationships);
    expect(layers.history).toEqual(previous.history);
  });

  it("保留 legacy 无法表达的 trust/stage/commitments/evidence/origin 与知识 provenance", () => {
    const rich: NpcEntityRecord = {
      ...record({ affinity: 12 }),
      knowledge: {
        entries: [
          {
            factId: asFactId("fact_0"), certainty: "known", disclosure: "public",
            source: { kind: "action", mode: "player_told", actionId: "act_0", learnedAtTurn: 0 },
          },
          {
            factId: asFactId("fact_1"), certainty: "suspected", disclosure: "secret",
            source: { kind: "action", mode: "npc_revealed", actionId: "act_1", learnedAtTurn: 1, sourceNpcId: OTHER_NPC },
          },
        ],
      },
    };
    const layers = importNpcLayers({ entry: legacyEntry(projectNpcEntry(rich).memory), createdAtTurn: 9, previous: rich });
    expect(layers.knowledge).toEqual(rich.knowledge);
    expect(layers.relationships).toEqual(rich.relationships);
    expect(layers.anchors).toEqual(rich.identity.anchors);
  });

  it("兼容字段只映射显式 hidden：保留旧 disclosure 与 provenance，不静默降级 secret", () => {
    const previous: NpcEntityRecord = {
      ...record({ affinity: 12 }),
      knowledge: {
        entries: [
          {
            factId: asFactId("fact_0"), certainty: "known", disclosure: "secret",
            source: { kind: "action", mode: "player_told", actionId: "act_secret", learnedAtTurn: 4 },
          },
          {
            factId: asFactId("fact_1"), certainty: "suspected", disclosure: "conditional",
            source: { kind: "initial_world", learnedAtTurn: 1 },
          },
        ],
      },
    };
    const layers = importNpcLayers({
      entry: legacyEntry(legacyMemory({
        knownFactIds: [asFactId("fact_0"), asFactId("fact_1")],
        hiddenFactIds: [asFactId("fact_1")],
      })),
      createdAtTurn: 9,
      previous,
    });
    expect(layers.knowledge.entries).toEqual([
      {
        factId: asFactId("fact_0"), certainty: "known", disclosure: "secret",
        source: { kind: "action", mode: "player_told", actionId: "act_secret", learnedAtTurn: 4 },
      },
      {
        factId: asFactId("fact_1"), certainty: "suspected", disclosure: "secret",
        source: { kind: "initial_world", learnedAtTurn: 1 },
      },
    ]);
  });

  it("affinity 变化只改 player 边的 affinity 与 lastChangedAtTurn", () => {
    const rich = record({ affinity: 12 });
    const layers = importNpcLayers({
      entry: legacyEntry({ ...projectNpcEntry(rich).memory, relationship: { affinity: 20 } }),
      createdAtTurn: 9,
      previous: rich,
    });
    const playerEdge = layers.relationships.outgoing[0];
    const before = rich.relationships.outgoing[0];
    expect(playerEdge.dimensions).toEqual({ affinity: 20, trust: 30, fear: 0, hostility: 0 });
    expect(playerEdge.stage).toBe(before.stage);
    expect(playerEdge.trend).toBe(before.trend);
    expect(playerEdge.commitments).toEqual(before.commitments);
    expect(playerEdge.evidence).toEqual(before.evidence);
    expect(playerEdge.origin).toEqual(before.origin);
    expect(playerEdge.lastChangedAtTurn).toBe(9);
  });
});

describe("npc projection：地点与身份字段只透传", () => {
  it("projectNpcEntry 不携带任何分层组件正文", () => {
    const entry = projectNpcEntry(record({ affinity: 1 }));
    expect(entry.locationId).toBe(LOC as LocationId);
    expect(entry.id).toBe(asNpcId("npc_0") as NpcId);
    expect("anchors" in entry).toBe(false);
    expect("knowledge" in entry).toBe(false);
    const serialized = JSON.stringify(entry);
    for (const layeredKey of ["outgoing", "entries", "anchors", "dynamicState"]) {
      expect(serialized).not.toContain(`"${layeredKey}"`);
    }
  });
});
