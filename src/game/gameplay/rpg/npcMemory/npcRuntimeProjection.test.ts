import { describe, expect, it } from "vitest";
import { PLAYER_ENTITY_ID, asFactId, asItemId, asLocationId, asNpcId } from "@/game/domain/worldEntity";
import type { FactId, NpcId } from "@/game/domain/worldEntity";
import { asEventId } from "@/game/domain/events";
import type { NpcEntry, NpcInteraction, NpcMemory } from "@/game/domain/worldEntries";
import {
  compareRelationshipTargetIds,
  importNpcLayers,
  projectNpcMemory,
  type DirectedRelationshipEdge,
  type EntityRecord,
  type FactEntityRecord,
  type ItemEntityRecord,
  type NpcEntityRecord,
  type NpcGoal,
  type NpcIdentityAnchors,
  type NpcKnowledgeCertainty,
  type NpcKnowledgeComponent,
  type NpcKnowledgeDisclosure,
  type NpcKnowledgeEntry,
  type NpcKnowledgeSource,
  type PlayerEntityRecord,
} from "@/game/domain/entity";
import { knowledgeVisibilityOf, type NpcKnowledgeVisibility } from "./npcKnowledge";
import type { RelationshipTargetId } from "./relationshipSignalPolicy";
import {
  NPC_PROFILE_INTERACTION_TAIL,
  NPC_RUNTIME_PROFILE_MODES,
  projectNpcRuntimeProfile,
  type NpcProfileErrorCode,
  type NpcProfilePromptInteraction,
  type NpcProfilePromptRelationshipEdge,
  type NpcRuntimeProfile,
  type NpcRuntimeProfileMode,
  type NpcRuntimeProfileRequest,
} from "./npcRuntimeProjection";
import {
  NPC_PROFILE_INTERACTION_TAIL as TAIL_VIA_FACADE,
  NPC_RUNTIME_PROFILE_MODES as MODES_VIA_FACADE,
  projectNpcRuntimeProfile as projectNpcRuntimeProfileViaFacade,
  type NpcProfilePromptRelationshipEdge as PromptEdgeViaFacade,
  type NpcRuntimeProfile as NpcRuntimeProfileViaFacade,
} from "./index";

// ---------------------------------------------------------------------------
// Plan 3 Task 4C：`projectNpcRuntimeProfile` 的独立证明。
//
// 本 selector 是 Task 5 / 7 / 8 唯一的 NPC 读取面，因此断言全部围绕四条承重结论：
// 1) **私密隔离是结构性的**：私密正文只存在 Fact 组件里，本模块只按**主体自己的**
//    条目取正文。另一 NPC 的 knowledge 组件不仅正文进不来，连 `entries` 被读一次
//    都会被 Proxy 访问日志抓住——不靠 canary 字符串侥幸通过。
// 2) **prompt 与 rule 是同一次遍历的两个视图**：两模式差量只允许出现在被明确授权的
//    三处（rule_required 正文、prompt 侧 active/blocked 目标过滤、以及**只进 rule 的
//    累计数值关系权威**：边 dimensions/evidence/commitments/origin/lastChangedAtTurn
//    与交互 relationshipDelta），其余字段必须逐字相同。
//    第三处由文档事实钉住（`docs/agent/运行时AI导演与场景表演.md:105`：关系以
//    「回合后档位 + 情绪 + 本轮 outcome」承载，绝不裸给数字），并且是**类型层面**的：
//    prompt 臂上读这些键是编译错误（见「编译探针」用例的 @ts-expect-error）。
// 3) **无明确参与者 ⇒ 不猜关系后果**：incoming 只做定点查表，绝不枚举 NPC 找指向主体的边。
// 4) **顺序即权威**：知识卡片沿用组件存储顺序（不重排、不按可见性分桶拼接），边一律走
//    domain 唯一比较器，交互取尾部最近 5 条（数组是旧→新）。
// ---------------------------------------------------------------------------

const NPC_A = asNpcId("npc_a");
const NPC_B = asNpcId("npc_b");
const NPC_C = asNpcId("npc_c");
const LOC = asLocationId("loc_0");
const FACT_PUBLIC = asFactId("fact_public");
const FACT_CONDITIONAL = asFactId("fact_conditional");
const FACT_SECRET = asFactId("fact_secret");
const FACT_OTHER_SECRET = asFactId("fact_other_secret");
const FACT_ORPHAN = asFactId("fact_orphan");
/** 表外披露档（domain union 里没有的值）引用的 Fact：它的正文同样必须在两种模式下缺席。 */
const FACT_OFF_TABLE = asFactId("fact_off_table");
const ITEM_1 = asItemId("item_1");

/** 另一 NPC 的私密事实正文：任何一份 profile 的任何一种模式都不得带上它。 */
const OTHER_SECRET_CANARY = "别组NPC的私密事实正文_CANARY";
/** 主体自己的私密事实正文：withheld 在两种模式下都只给 id。 */
const OWN_SECRET_PROSE = "主体自己的私密事实正文_OWN_SECRET";
const CONDITIONAL_PROSE = "条件披露的事实正文_CONDITIONAL";
const PUBLIC_PROSE = "公开事实正文_PUBLIC";
/** 表外 disclosure 那条 Fact 的正文：它只以 id 出现（withheld），正文永不出现。 */
const OFF_TABLE_PROSE = "表外披露档的事实正文_OFF_TABLE";

// ---------------------------------------------------------------------------
// 夹具：一律用分层组件形状手工构造（与 npcProjection.test.ts 同一口径）
// ---------------------------------------------------------------------------

function anchors(): NpcIdentityAnchors {
  return {
    selfConcept: "守夜人",
    values: ["守诺", "不欺"],
    speechStyle: "短句",
    capabilityBoundaries: ["不会骑马"],
    taboos: ["不提旧主"],
  };
}

function goal(goalId: string, status: NpcGoal["status"], description: string): NpcGoal {
  return { goalId, horizon: "short", description, priority: 2, status, reason: "家业" };
}

function interaction(actionId: string, turnNumber: number): NpcInteraction {
  return {
    eventId: asEventId(`evt:interact:${actionId}:${turnNumber}`),
    turnNumber,
    actionId,
    locationId: LOC,
    dialogueAct: "ask",
    topicSummary: `第 ${turnNumber} 回合打听井钥`,
    outcome: "positive",
    relationshipDelta: 1,
    learnedFactIds: [],
    summary: `${actionId} 的交谈`,
  };
}

function initialSource(learnedAtTurn = 0): NpcKnowledgeSource {
  return { kind: "initial_world", learnedAtTurn };
}

function entry(
  factId: FactId,
  disclosure: NpcKnowledgeDisclosure,
  certainty: NpcKnowledgeCertainty = "known",
): NpcKnowledgeEntry {
  return { factId, certainty, disclosure, source: initialSource() };
}

function edgeOf(
  targetId: RelationshipTargetId,
  overrides: Partial<DirectedRelationshipEdge> = {},
): DirectedRelationshipEdge {
  return {
    targetId,
    dimensions: { affinity: 20, trust: 30, fear: 0, hostility: 0 },
    stage: "cooperative",
    trend: "improving",
    commitments: [],
    evidence: [],
    origin: { kind: "action", actionId: "act_1", turnNumber: 1 },
    lastChangedAtTurn: 1,
    ...overrides,
  };
}

function npcRecord(
  id: NpcId,
  overrides: Partial<{
    anchors: NpcIdentityAnchors;
    isCompanion: boolean;
    met: boolean;
    emotion: NpcEntityRecord["dynamicState"]["emotion"];
    goals: readonly NpcGoal[];
    entries: readonly NpcKnowledgeEntry[];
    outgoing: readonly DirectedRelationshipEdge[];
    interactions: readonly NpcInteraction[];
    lifecycle: NpcEntityRecord["core"]["lifecycle"];
  }> = {},
): NpcEntityRecord {
  return {
    core: { id, kind: "npc", name: `名${id}`, createdAtTurn: 0, lifecycle: overrides.lifecycle ?? "active" },
    identity: { role: "掌柜", description: "客栈掌柜", tags: ["shopkeep"], anchors: overrides.anchors ?? anchors() },
    position: { locationId: LOC, locationOrder: 0 },
    dynamicState: {
      isCompanion: overrides.isCompanion ?? false,
      met: overrides.met ?? true,
      emotion: overrides.emotion ?? "warm",
      goals: overrides.goals ?? [],
    },
    knowledge: { entries: overrides.entries ?? [] },
    relationships: { outgoing: overrides.outgoing ?? [] },
    history: { interactions: overrides.interactions ?? [] },
  };
}

function factRecord(id: FactId, text: string): FactEntityRecord {
  return {
    core: { id, kind: "fact", name: `事实${id}`, createdAtTurn: 0, lifecycle: "active" },
    fact: { text, source: "generated", discovered: true, locationId: LOC },
  };
}

function itemRecord(): ItemEntityRecord {
  return {
    core: { id: ITEM_1, kind: "item", name: "井钥", createdAtTurn: 0, lifecycle: "active" },
    presentation: { description: "一把铜钥", kind: "token", tags: [] },
    possession: { owner: { kind: "none" }, quantity: 1, ownerOrder: 0 },
  };
}

function playerRecord(): PlayerEntityRecord {
  return {
    core: {
      id: PLAYER_ENTITY_ID, kind: "player_character", name: "侠客", createdAtTurn: 0, lifecycle: "active",
    },
    identity: { identity: "镖师", stats: { hp: 100, attack: 10, defense: 5 } },
    position: { locationId: LOC, locationOrder: 0 },
  };
}

/**
 * 主体：四类 goal 状态齐备、三条披露档齐备、七条交互、三条出边。
 * 两处顺序都刻意「不整齐」，用来证明 selector 不重排也不按可见性分桶拼接：
 * - 知识条目 conditional 在 public 之前；
 * - 出边按 npc_c → player_0 → npc_b 存储（与 domain 比较器顺序相反的前半）。
 */
function subjectA(): NpcEntityRecord {
  return npcRecord(NPC_A, {
    isCompanion: true,
    met: true,
    emotion: "warm",
    goals: [
      goal("g_active", "active", "守住客栈"),
      goal("g_abandoned", "abandoned", "离开小镇"),
      goal("g_blocked", "blocked", "找回弟弟"),
      goal("g_completed", "completed", "还清债务"),
    ],
    entries: [
      entry(FACT_CONDITIONAL, "conditional", "suspected"),
      entry(FACT_PUBLIC, "public"),
      entry(FACT_SECRET, "secret"),
    ],
    outgoing: [
      edgeOf(NPC_C, { stage: "wary" }),
      edgeOf(PLAYER_ENTITY_ID, { stage: "trusted" }),
      edgeOf(NPC_B),
    ],
    interactions: [1, 2, 3, 4, 5, 6, 7].map((turn) => interaction(`act_${turn}`, turn)),
  });
}

/**
 * 被指名的对手方：默认持有一条**真实**的 B→A 回边，但与 A→B 那条在 stage / 数值上
 * 明显不同——方向性用例靠对象身份区分两条边，镜像 bug 会让同一个对象占两个槽位。
 */
function counterpartB(entries: readonly NpcKnowledgeEntry[] = []): NpcEntityRecord {
  return npcRecord(NPC_B, {
    entries,
    outgoing: [edgeOf(NPC_A, {
      stage: "trusted",
      trend: "worsening",
      dimensions: { affinity: 5, trust: 40, fear: 10, hostility: 0 },
      lastChangedAtTurn: 2,
    })],
    interactions: [interaction("act_b_1", 1)],
  });
}

/** 无关 NPC：真的持有一条指向主体的边，并且知道一条私密事实。 */
function bystanderC(): NpcEntityRecord {
  return npcRecord(NPC_C, {
    entries: [entry(FACT_OTHER_SECRET, "secret")],
    outgoing: [edgeOf(NPC_A)],
    interactions: [interaction("act_c_1", 1)],
  });
}

function baseRecords(): EntityRecord[] {
  return [
    subjectA(),
    counterpartB(),
    bystanderC(),
    playerRecord(),
    itemRecord(),
    factRecord(FACT_PUBLIC, PUBLIC_PROSE),
    factRecord(FACT_CONDITIONAL, CONDITIONAL_PROSE),
    factRecord(FACT_SECRET, OWN_SECRET_PROSE),
    factRecord(FACT_OTHER_SECRET, OTHER_SECRET_CANARY),
  ];
}

function isNpc(record: EntityRecord): record is NpcEntityRecord {
  return record.core.kind === "npc";
}

function npcOf(records: readonly EntityRecord[], id: NpcId): NpcEntityRecord {
  const record = records.find((entry) => entry.core.id === id);
  if (record === undefined || !isNpc(record)) throw new Error(`missing npc ${id}`);
  return record;
}

function profileOf<M extends NpcRuntimeProfileMode>(
  records: readonly EntityRecord[],
  input: NpcRuntimeProfileRequest<M>,
): NpcRuntimeProfile<M> {
  // 字面量 mode 直接推断出臂：这正是「prompt 消费方拿不到数值权威」那条编译性质的前提。
  const result = projectNpcRuntimeProfile(records, input);
  if (!result.ok) throw new Error(`expected an ok profile, got ${result.code}`);
  return result.profile;
}

function codeOf(records: readonly EntityRecord[], input: NpcRuntimeProfileRequest): NpcProfileErrorCode {
  const result = projectNpcRuntimeProfile(records, input);
  if (result.ok) throw new Error("expected a rejected profile request");
  return result.code;
}

/**
 * profile 序列化后每一层（含数组元素）的自有键名：数值权威只要出现在任何深度都会被抓到，
 * 也不会因为「键在对象里但值为 undefined」而漏网。
 */
function keyNamesAtEveryLevel(profile: NpcRuntimeProfile): string[] {
  const collected: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, item] of Object.entries(value)) {
      collected.push(key);
      walk(item);
    }
  };
  walk(JSON.parse(JSON.stringify(profile)));
  return collected;
}

/** 授权差量之一：prompt 侧的关系边只剩定性三项（数值与账本留在 rule 视图）。 */
function qualitativeEdgeView(edge: DirectedRelationshipEdge): NpcProfilePromptRelationshipEdge {
  return { targetId: edge.targetId, stage: edge.stage, trend: edge.trend };
}

/** 授权差量之二：prompt 侧的交互丢掉本轮 relationshipDelta，其余字段（含 summary）原样保留。 */
function withoutRelationshipDelta(item: NpcInteraction): NpcProfilePromptInteraction {
  const { relationshipDelta: _dropped, ...rest } = item;
  return rest;
}

// ---------------------------------------------------------------------------
// 七个必读返回
// ---------------------------------------------------------------------------

describe("projectNpcRuntimeProfile — 七个必读返回", () => {
  it("一次返回锚点、动态目标/情绪、出边、入边、可说卡片、扣留 id 与最近 5 条交互", () => {
    const records = baseRecords();
    const profile = profileOf(records, { npcId: NPC_A, targetId: NPC_B, mode: "rule" });
    const subject = npcOf(records, NPC_A);

    // 锚点：同一对象引用，而不是重新拼一份。
    expect(profile.anchors).toBe(subject.identity.anchors);
    expect(profile.anchors.selfConcept).toBe("守夜人");
    expect(profile.anchors.taboos).toEqual(["不提旧主"]);

    // 动态状态与目标。
    expect(profile.dynamicState).toEqual({ isCompanion: true, met: true, emotion: "warm" });
    expect(profile.goals.map((item) => item.goalId)).toEqual(["g_active", "g_abandoned", "g_blocked", "g_completed"]);
    expect(profile.goals[0]).toBe(subject.dynamicState.goals[0]);

    // 指定 target 的出边与对方的回边：都是组件里那个对象本身。
    expect(profile.outgoingEdge).toBe(subject.relationships.outgoing.find((item) => item.targetId === NPC_B));
    expect(profile.incomingEdge).toBe(npcOf(records, NPC_B).relationships.outgoing[0]);
    expect(profile.incomingEdge?.targetId).toBe(NPC_A);

    // 可说卡片与扣留 id。
    expect(profile.factCards.map((card) => card.factId)).toEqual([FACT_CONDITIONAL, FACT_PUBLIC]);
    expect(profile.withheldFactIds).toEqual([FACT_SECRET]);

    // 最近 5 条交互：数组旧→新，取尾不取头。
    expect(profile.interactions.map((item) => item.actionId)).toEqual(["act_3", "act_4", "act_5", "act_6", "act_7"]);
    expect(profile.interactions.length).toBe(NPC_PROFILE_INTERACTION_TAIL);
    expect(NPC_PROFILE_INTERACTION_TAIL).toBe(5);
    expect(profile.npcId).toBe(NPC_A);
    expect(profile.targetId).toBe(NPC_B);
    expect(profile.mode).toBe("rule");
  });

  it("交互不足 5 条时全部返回且仍是旧→新", () => {
    const records: EntityRecord[] = [
      npcRecord(NPC_A, { interactions: [interaction("act_1", 1), interaction("act_2", 2)] }),
    ];
    const profile = profileOf(records, { npcId: NPC_A, mode: "rule" });
    expect(profile.interactions.map((item) => item.actionId)).toEqual(["act_1", "act_2"]);
  });

  it("profile 与其数组、卡片一律冻结（读取面不得被调用方改写）", () => {
    const profile = profileOf(baseRecords(), { npcId: NPC_A, targetId: NPC_B, mode: "rule" });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.goals)).toBe(true);
    expect(Object.isFrozen(profile.outgoingEdges)).toBe(true);
    expect(Object.isFrozen(profile.factCards)).toBe(true);
    expect(Object.isFrozen(profile.withheldFactIds)).toBe(true);
    expect(Object.isFrozen(profile.interactions)).toBe(true);
    expect(Object.isFrozen(profile.factCards[0])).toBe(true);
    expect(Object.isFrozen(profile.dynamicState)).toBe(true);
  });

  it("模式取值表是封闭两项", () => {
    expect(NPC_RUNTIME_PROFILE_MODES).toEqual(["prompt", "rule"]);
  });
});

// ---------------------------------------------------------------------------
// 私密知识隔离
// ---------------------------------------------------------------------------

describe("projectNpcRuntimeProfile — 私密知识隔离", () => {
  it("另一 NPC 的私密事实正文与引用在两种模式下都不出现", () => {
    const records = baseRecords();
    for (const mode of NPC_RUNTIME_PROFILE_MODES) {
      const serialized = JSON.stringify(profileOf(records, { npcId: NPC_A, targetId: NPC_B, mode }));
      // 主体自己的出边自然会写到 npc_c 这个 id（关系不是秘密）；被钉死的是**别人的知识条目**
      // 及其正文引用：两者都只能从 npc_c 的 knowledge 组件里读出来。
      expect(serialized).not.toContain(OTHER_SECRET_CANARY);
      expect(serialized).not.toContain(String(FACT_OTHER_SECRET));
    }
  });

  it("从不读取其他 NPC 的 knowledge 组件（连 entries 都不碰）", () => {
    const touched: string[] = [];
    const poisoned = bystanderC();
    const spy = new Proxy(poisoned.knowledge, {
      get(target, key) {
        touched.push(String(key));
        return Reflect.get(target, key);
      },
    });
    const records: EntityRecord[] = [
      subjectA(),
      counterpartB(),
      { ...poisoned, knowledge: spy as NpcKnowledgeComponent },
      ...baseRecords().filter((record): record is FactEntityRecord => record.core.kind === "fact"),
    ];
    for (const mode of NPC_RUNTIME_PROFILE_MODES) {
      const profile = profileOf(records, { npcId: NPC_A, targetId: NPC_B, mode });
      expect(JSON.stringify(profile)).not.toContain(OTHER_SECRET_CANARY);
    }
    expect(touched).toEqual([]);
  });

  it("主体自己的 secret 条目只以 id 出现，两种模式都不给正文", () => {
    const records = baseRecords();
    for (const mode of NPC_RUNTIME_PROFILE_MODES) {
      const profile = profileOf(records, { npcId: NPC_A, targetId: NPC_B, mode });
      const serialized = JSON.stringify(profile);
      expect(serialized).not.toContain(OWN_SECRET_PROSE);
      expect(profile.withheldFactIds).toEqual([FACT_SECRET]);
      expect(profile.factCards.some((card) => card.factId === FACT_SECRET)).toBe(false);
    }
  });

  it("withheld 分区与 npcKnowledge 的可见性权威同源", () => {
    const records = baseRecords();
    const subject = npcOf(records, NPC_A);
    const profile = profileOf(records, { npcId: NPC_A, mode: "rule" });
    const withheldFromEntries = subject.knowledge.entries
      .filter((item) => knowledgeVisibilityOf(item) === "withheld")
      .map((item) => item.factId);
    expect(profile.withheldFactIds).toEqual(withheldFromEntries);
    const visibilities = new Set<NpcKnowledgeVisibility>(profile.factCards.map((card) => card.visibility));
    expect(visibilities).toEqual(new Set<NpcKnowledgeVisibility>(["rule_required", "shareable"]));
  });

  it("存储条目 disclosure 在表外时按 withheld 处理：只给 id，两种模式都不给正文", () => {
    // 钉住 `npcKnowledge.ts:222-226` 的失败封闭语义（表外披露档没有「默认可说」兜底）：
    // 既有的 canary 与 Proxy 用例只覆盖表内的 secret，覆盖不到「值根本不在表上」这一格。
    const offTable = entry(FACT_OFF_TABLE, "private" as NpcKnowledgeDisclosure);
    const records: EntityRecord[] = [
      npcRecord(NPC_A, { entries: [offTable, entry(FACT_PUBLIC, "public")] }),
      factRecord(FACT_OFF_TABLE, OFF_TABLE_PROSE),
      factRecord(FACT_PUBLIC, PUBLIC_PROSE),
    ];
    // 可见性权威本身：表外值 → withheld，读取面不复抄第二张表。
    expect(knowledgeVisibilityOf(offTable)).toBe("withheld");
    for (const mode of NPC_RUNTIME_PROFILE_MODES) {
      const profile = profileOf(records, { npcId: NPC_A, mode });
      expect(profile.withheldFactIds).toEqual([FACT_OFF_TABLE]);
      expect(profile.factCards.map((card) => card.factId)).toEqual([FACT_PUBLIC]);
      const serialized = JSON.stringify(profile);
      expect(serialized).not.toContain(OFF_TABLE_PROSE);
      // 表外条目连 Fact 记录都不查：正文与它的 id 一起被挡在卡片之外，只留在 withheld 里。
      expect(serialized).toContain(String(FACT_OFF_TABLE));
    }
    // 正控制：同一夹具只把 disclosure 换成表内 public，正文就确实会进来，
    // 所以上面的「不含」不是夹具坏了造成的空断言。
    const controlRecords: EntityRecord[] = [
      npcRecord(NPC_A, { entries: [entry(FACT_OFF_TABLE, "public"), entry(FACT_PUBLIC, "public")] }),
      ...records.slice(1),
    ];
    const control = profileOf(controlRecords, { npcId: NPC_A, mode: "rule" });
    expect(control.factCards.map((card) => card.factId)).toEqual([FACT_OFF_TABLE, FACT_PUBLIC]);
    expect(control.factCards[0]?.text).toBe(OFF_TABLE_PROSE);
  });

  it("引用的 Fact 记录不在 records 里时只给结构化值、不给正文", () => {
    const records: EntityRecord[] = [
      npcRecord(NPC_A, { entries: [entry(FACT_ORPHAN, "public"), entry(FACT_PUBLIC, "public")] }),
      factRecord(FACT_PUBLIC, PUBLIC_PROSE),
    ];
    const profile = profileOf(records, { npcId: NPC_A, mode: "rule" });
    expect(profile.factCards.map((card) => card.factId)).toEqual([FACT_ORPHAN, FACT_PUBLIC]);
    expect("text" in profile.factCards[0]).toBe(false);
    expect(profile.factCards[1].text).toBe(PUBLIC_PROSE);
  });
});

// ---------------------------------------------------------------------------
// prompt 与 rule：一次遍历的两个视图
// ---------------------------------------------------------------------------

describe("projectNpcRuntimeProfile — prompt 与 rule 是同一次遍历的两个视图", () => {
  it("rule_required 正文只在 rule 模式出现，数值关系权威只进 rule 视图，其余字段逐字相同", () => {
    const records = baseRecords();
    const rule = profileOf(records, { npcId: NPC_A, targetId: NPC_B, mode: "rule" });
    const prompt = profileOf(records, { npcId: NPC_A, targetId: NPC_B, mode: "prompt" });

    // 卡片集合与顺序完全一致：模式只决定正文，不决定可见性分区。
    expect(prompt.factCards.map((card) => card.factId)).toEqual(rule.factCards.map((card) => card.factId));
    expect(prompt.factCards.map((card) => card.visibility)).toEqual(rule.factCards.map((card) => card.visibility));
    const conditionalRule = rule.factCards.find((card) => card.visibility === "rule_required");
    const conditionalPrompt = prompt.factCards.find((card) => card.visibility === "rule_required");
    expect(conditionalRule?.text).toBe(CONDITIONAL_PROSE);
    expect("text" in (conditionalPrompt ?? {})).toBe(false);
    expect(conditionalPrompt?.certainty).toBe("suspected");
    expect(conditionalPrompt?.source).toBe(conditionalRule?.source);
    expect(conditionalPrompt?.disclosure).toBe(conditionalRule?.disclosure);

    // 边的集合与顺序同样一致：模式只决定每条边交出多少，不决定交出几条。
    expect(prompt.outgoingEdges.map((item) => item.targetId))
      .toEqual(rule.outgoingEdges.map((item) => item.targetId));
    expect(prompt.outgoingEdge?.targetId).toBe(rule.outgoingEdge?.targetId);
    expect(prompt.incomingEdge?.targetId).toBe(rule.incomingEdge?.targetId);
    // rule 侧交出的仍是组件里那个对象（引用即权威）；prompt 侧必须是重新构造的窄视图，
    // 把原对象交出去等于把 dimensions/evidence/commitments 一起交出去。
    expect(rule.outgoingEdge).toBe(npcOf(records, NPC_A).relationships.outgoing.find((item) => item.targetId === NPC_B));
    expect(prompt.outgoingEdge).not.toBe(rule.outgoingEdge);
    expect(prompt.incomingEdge).not.toBe(rule.incomingEdge);
    expect(Object.keys(prompt.outgoingEdge ?? {}).sort()).toEqual(["stage", "targetId", "trend"]);
    expect(Object.isFrozen(prompt.outgoingEdge)).toBe(true);
    // 交互：条数与顺序不变，只少 relationshipDelta 这一个键。
    expect(prompt.interactions.map((item) => item.actionId)).toEqual(rule.interactions.map((item) => item.actionId));
    expect(Object.keys(prompt.interactions[0] ?? {}).sort())
      .toEqual(Object.keys(rule.interactions[0]).filter((key) => key !== "relationshipDelta").sort());
    // summary 刻意保留（它内嵌「关系+N」的文本改写归 Task 8），所以这里断言它没被动过。
    expect(prompt.interactions[0]?.summary).toBe(rule.interactions[0]?.summary);

    // 把 rule 视图只按三处授权差量变换，结果必须与 prompt 视图完全相等。
    const expectedPrompt = {
      ...rule,
      mode: "prompt",
      goals: rule.goals.filter((item) => item.status === "active" || item.status === "blocked"),
      factCards: rule.factCards.map((card) => (card.visibility === "shareable" ? card : { ...card, text: undefined })),
      outgoingEdges: rule.outgoingEdges.map(qualitativeEdgeView),
      outgoingEdge: rule.outgoingEdge === undefined ? undefined : qualitativeEdgeView(rule.outgoingEdge),
      incomingEdge: rule.incomingEdge === undefined ? undefined : qualitativeEdgeView(rule.incomingEdge),
      interactions: rule.interactions.map(withoutRelationshipDelta),
    };
    expect(JSON.parse(JSON.stringify(prompt))).toEqual(JSON.parse(JSON.stringify(expectedPrompt)));
  });

  it("prompt 档案任何深度都不出现 dimensions / evidence / relationshipDelta 键", () => {
    const records = baseRecords();
    // 正控制先跑：同一份输入在 rule 模式下这些键确实存在，否则下面的「不含」是空断言。
    const ruleKeys = keyNamesAtEveryLevel(profileOf(records, { npcId: NPC_A, targetId: NPC_B, mode: "rule" }));
    expect(ruleKeys).toContain("dimensions");
    expect(ruleKeys).toContain("evidence");
    expect(ruleKeys).toContain("relationshipDelta");

    for (const fixture of [
      { npcId: NPC_A, targetId: NPC_B, mode: "prompt" } as const,
      { npcId: NPC_A, mode: "prompt" } as const,
    ]) {
      const profile = profileOf(records, fixture);
      const keys = keyNamesAtEveryLevel(profile);
      // 三项点名权威：累计数值、逐笔账本、本轮数值。
      expect(keys).not.toContain("dimensions");
      expect(keys).not.toContain("evidence");
      expect(keys).not.toContain("relationshipDelta");
      // 连带四个数值维度名与 rule 侧的关系账本/来源也不再出现：prompt 侧没有任何通道能读出数字。
      expect(keys).not.toContain("affinity");
      expect(keys).not.toContain("trust");
      expect(keys).not.toContain("fear");
      expect(keys).not.toContain("hostility");
      expect(keys).not.toContain("commitments");
      expect(keys).not.toContain("lastChangedAtTurn");
      const serialized = JSON.stringify(profile);
      expect(serialized).not.toContain("origin");
      // 定性承载仍在：档位与趋势是 prompt 侧唯一的关系表达。
      expect(keys).toContain("stage");
      expect(keys).toContain("trend");
    }
  });

  it("编译探针：prompt 档案上读数值关系权威是类型错误，rule 档案读得到", () => {
    const records = baseRecords();
    const prompt = profileOf(records, { npcId: NPC_A, targetId: NPC_B, mode: "prompt" });
    // @ts-expect-error prompt 臂的边没有 dimensions：累计数值只进 rule 视图
    const promptAffinity = prompt.outgoingEdge?.dimensions;
    // @ts-expect-error prompt 臂的边没有 evidence：逐笔账本只进 rule 视图
    const promptEvidence = prompt.incomingEdge?.evidence;
    // @ts-expect-error prompt 臂的出边列表元素同样没有 dimensions
    const promptListed = prompt.outgoingEdges[0]?.dimensions;
    // @ts-expect-error prompt 臂的交互不带 relationshipDelta
    const promptDelta = prompt.interactions[0]?.relationshipDelta;
    expect([promptAffinity, promptEvidence, promptListed, promptDelta]).toEqual([
      undefined, undefined, undefined, undefined,
    ]);

    // mode 未窄化（默认联合）时同样读不到：消费方必须先按字面量 mode 取臂，或显式 cast。
    const unresolved: NpcRuntimeProfileRequest = { npcId: NPC_A, targetId: NPC_B, mode: "prompt" };
    const erased = profileOf(records, unresolved);
    // @ts-expect-error 未窄化 mode 的档案读不到 dimensions
    const erasedAffinity = erased.outgoingEdge?.dimensions;
    // @ts-expect-error 未窄化 mode 的档案读不到 relationshipDelta
    const erasedDelta = erased.interactions[0]?.relationshipDelta;
    // 这一行的运行时断言只是配套事实；真正被钉住的是上面两条指令（删掉它们 typecheck 即报错）。
    expect([erasedAffinity, erasedDelta]).toEqual([undefined, undefined]);

    // rule 臂是正向对照：删掉上面的 @ts-expect-error 指令会让 typecheck 报「未使用的指令」，
    // 而这里的断言保证窄化没有把 rule 侧权威一起削掉。
    const rule = profileOf(records, { npcId: NPC_A, targetId: NPC_B, mode: "rule" });
    expect(rule.outgoingEdge?.dimensions.affinity).toBe(20);
    expect(rule.incomingEdge?.dimensions.affinity).toBe(5);
    expect(rule.outgoingEdges[0]?.evidence).toEqual([]);
    expect(rule.interactions[0]?.relationshipDelta).toBe(1);
  });

  it("shareable 正文两种模式都给，且正文取自 Fact 组件而非 core.name", () => {
    const fact = factRecord(FACT_PUBLIC, PUBLIC_PROSE);
    const records: EntityRecord[] = [
      npcRecord(NPC_A, { entries: [entry(FACT_PUBLIC, "public")] }),
      { ...fact, core: { ...fact.core, name: "绝不会被当作正文的名字" } },
    ];
    for (const mode of NPC_RUNTIME_PROFILE_MODES) {
      const profile = profileOf(records, { npcId: NPC_A, mode });
      expect(profile.factCards[0].text).toBe(PUBLIC_PROSE);
    }
  });

  it("prompt 模式的目标与兼容投影 npcProjection 的 active/blocked 口径一致", () => {
    const subject = subjectA();
    const prompt = profileOf([subject], { npcId: NPC_A, mode: "prompt" });
    expect(prompt.goals.map((item) => item.description)).toEqual(projectNpcMemory(subject).goals);
    expect(prompt.goals.map((item) => item.status)).toEqual(["active", "blocked"]);
    expect(prompt.goals[0]).toBe(subject.dynamicState.goals[0]);
  });
});

// ---------------------------------------------------------------------------
// 确定性
// ---------------------------------------------------------------------------

describe("projectNpcRuntimeProfile — 确定性排序", () => {
  it("同一输入两次调用逐字节相同", () => {
    const records = baseRecords();
    const first = projectNpcRuntimeProfile(records, { npcId: NPC_A, targetId: NPC_B, mode: "prompt" });
    const second = projectNpcRuntimeProfile(records, { npcId: NPC_A, targetId: NPC_B, mode: "prompt" });
    expect(first.ok).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("出边列表按 compareRelationshipTargetIds 排序，而不是照抄存储顺序", () => {
    const records = baseRecords();
    const stored = npcOf(records, NPC_A).relationships.outgoing;
    expect(stored.map((item) => item.targetId)).toEqual([NPC_C, PLAYER_ENTITY_ID, NPC_B]);
    const profile = profileOf(records, { npcId: NPC_A, targetId: NPC_B, mode: "rule" });
    expect(profile.outgoingEdges.map((item) => item.targetId)).toEqual([NPC_B, NPC_C, PLAYER_ENTITY_ID]);
    expect(profile.outgoingEdges.map((item) => item.targetId)).toEqual(
      [...stored.map((item) => item.targetId)].sort((left, right) => compareRelationshipTargetIds(left, right)),
    );
    // 只换顺序，不复制边。
    expect(profile.outgoingEdges[0]).toBe(stored[2]);
  });

  it("知识卡片沿用组件存储顺序，绝不按可见性或确定度重排", () => {
    const records: EntityRecord[] = [
      npcRecord(NPC_A, {
        entries: [
          entry(FACT_CONDITIONAL, "conditional", "known"),
          entry(FACT_PUBLIC, "public", "suspected"),
          entry(FACT_SECRET, "secret", "known"),
        ],
      }),
      factRecord(FACT_PUBLIC, PUBLIC_PROSE),
      factRecord(FACT_CONDITIONAL, CONDITIONAL_PROSE),
      factRecord(FACT_SECRET, OWN_SECRET_PROSE),
    ];
    const profile = profileOf(records, { npcId: NPC_A, mode: "rule" });
    expect(profile.factCards.map((card) => card.factId)).toEqual([FACT_CONDITIONAL, FACT_PUBLIC]);
    expect(profile.factCards.map((card) => card.certainty)).toEqual(["known", "suspected"]);
    expect(profile.withheldFactIds).toEqual([FACT_SECRET]);
  });

  it("结果不受 records 数组顺序影响", () => {
    const records = baseRecords();
    const forward = profileOf(records, { npcId: NPC_A, targetId: NPC_B, mode: "rule" });
    const backward = profileOf([...records].reverse(), { npcId: NPC_A, targetId: NPC_B, mode: "rule" });
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });
});

// ---------------------------------------------------------------------------
// 参与者与方向性
// ---------------------------------------------------------------------------

describe("projectNpcRuntimeProfile — 参与者与方向性", () => {
  it("未指名 targetId 时既无出边也无回边，即使 npc_c 真的持有指向主体的边", () => {
    const profile = profileOf(baseRecords(), { npcId: NPC_A, mode: "rule" });
    expect("outgoingEdge" in profile).toBe(false);
    expect("incomingEdge" in profile).toBe(false);
    expect(profile.outgoingEdge).toBeUndefined();
    expect(profile.incomingEdge).toBeUndefined();
    // 主体自己的边列表照旧可见：它是主体组件的一部分，不是猜出来的关系后果。
    expect(profile.outgoingEdges.length).toBe(3);
    expect(profile.targetId).toBeUndefined();
  });

  it("指名 target 存在但两个方向都没有边：成功且两边皆空，不是错误", () => {
    const records: EntityRecord[] = [npcRecord(NPC_A), npcRecord(NPC_B)];
    const profile = profileOf(records, { npcId: NPC_A, targetId: NPC_B, mode: "rule" });
    expect("outgoingEdge" in profile).toBe(false);
    expect("incomingEdge" in profile).toBe(false);
    expect(profile.outgoingEdges).toEqual([]);
  });

  it("A→B 与 B→A 各归各槽：出边永不镜像进回边，反之亦然", () => {
    const records = baseRecords();
    const edgeAB = npcOf(records, NPC_A).relationships.outgoing.find((item) => item.targetId === NPC_B);
    const edgeBA = npcOf(records, NPC_B).relationships.outgoing.find((item) => item.targetId === NPC_A);
    expect(edgeAB).toBeDefined();
    expect(edgeBA).toBeDefined();
    expect(edgeAB).not.toBe(edgeBA);

    const fromA = profileOf(records, { npcId: NPC_A, targetId: NPC_B, mode: "rule" });
    const fromB = profileOf(records, { npcId: NPC_B, targetId: NPC_A, mode: "rule" });
    expect(fromA.outgoingEdge).toBe(edgeAB);
    expect(fromA.incomingEdge).toBe(edgeBA);
    expect(fromB.outgoingEdge).toBe(edgeBA);
    expect(fromB.incomingEdge).toBe(edgeAB);
    // 两条边各自的数值没有被互相污染：镜像 bug 会让两个槽位指向同一个对象。
    expect(fromA.outgoingEdge?.dimensions.affinity).toBe(20);
    expect(fromA.incomingEdge?.dimensions.affinity).toBe(5);
    // B 的出边只有指向 A 的那条：绝不因为 A 有出边就在 B 上凭空造一条。
    expect(fromB.outgoingEdges.map((item) => item.targetId)).toEqual([NPC_A]);
  });

  it("指名 target 为玩家时出边存在、回边不存在（玩家记录不持有关系组件，也不去枚举别人）", () => {
    const profile = profileOf(baseRecords(), { npcId: NPC_A, targetId: PLAYER_ENTITY_ID, mode: "rule" });
    expect(profile.outgoingEdge?.targetId).toBe(PLAYER_ENTITY_ID);
    expect("incomingEdge" in profile).toBe(false);
  });

  it("把自己当 target 时失败关闭：关系结论必须发生在两个参与者之间", () => {
    // 不自守门的话，同一条自边会同时落进出边与回边两个槽位——方向性测试禁的正是这种镜像。
    const records: EntityRecord[] = [npcRecord(NPC_A, { outgoing: [edgeOf(NPC_A)] })];
    expect(codeOf(records, { npcId: NPC_A, targetId: NPC_A, mode: "rule" })).toBe("target_not_found");
  });

  it("指向不存在或不可当目标的 target 时失败关闭，绝不降级成「无关系」的 profile", () => {
    const records = baseRecords();
    const ghostTarget = asNpcId("npc_ghost");
    expect(codeOf(records, { npcId: NPC_A, targetId: ghostTarget, mode: "rule" })).toBe("target_not_found");
    expect(codeOf(records, { npcId: NPC_A, targetId: ITEM_1 as unknown as RelationshipTargetId, mode: "rule" }))
      .toBe("target_not_found");
    expect(codeOf(records, { npcId: NPC_A, targetId: FACT_PUBLIC as unknown as RelationshipTargetId, mode: "rule" }))
      .toBe("target_not_found");
  });
});

// ---------------------------------------------------------------------------
// 失败关闭
// ---------------------------------------------------------------------------

describe("projectNpcRuntimeProfile — 失败关闭的封闭 code", () => {
  it("未知 npcId → npc_not_found", () => {
    expect(codeOf(baseRecords(), { npcId: asNpcId("npc_ghost"), mode: "rule" })).toBe("npc_not_found");
  });

  it("非 NPC 记录 → not_an_npc（物品、玩家本体与 Fact 都不给 profile）", () => {
    const records = baseRecords();
    expect(codeOf(records, { npcId: ITEM_1 as unknown as NpcId, mode: "rule" })).toBe("not_an_npc");
    expect(codeOf(records, { npcId: PLAYER_ENTITY_ID as unknown as NpcId, mode: "rule" })).toBe("not_an_npc");
    expect(codeOf(records, { npcId: FACT_PUBLIC as unknown as NpcId, mode: "rule" })).toBe("not_an_npc");
  });

  it("表外 mode、缺省 mode 与只挂在原型链上的 mode 都返回 invalid_mode", () => {
    const records = baseRecords();
    const inherited = Object.create({ npcId: NPC_A, mode: "prompt" }) as NpcRuntimeProfileRequest;
    expect(codeOf(records, inherited)).toBe("invalid_mode");
    expect(codeOf(records, { npcId: NPC_A, mode: "toString" as NpcRuntimeProfileRequest["mode"] })).toBe("invalid_mode");
    expect(codeOf(records, { npcId: NPC_A, mode: "" as NpcRuntimeProfileRequest["mode"] })).toBe("invalid_mode");
    expect(codeOf(records, { npcId: NPC_A } as unknown as NpcRuntimeProfileRequest)).toBe("invalid_mode");
  });

  it("空白 npcId 不进入查表，直接 npc_not_found", () => {
    expect(codeOf(baseRecords(), { npcId: "   " as NpcId, mode: "rule" })).toBe("npc_not_found");
  });

  it("空白或非字符串的 targetId 失败关闭为 target_not_found，绝不降级成「无关系」profile", () => {
    // 未知 id 会 target_not_found，而 `""` / `"   "` 曾经被当成「没有参与者」：
    // 损坏的调用方于是静默拿到一份没有关系结论的档案。空白同样是「给了但坏了」。
    const records = baseRecords();
    const broken = [
      "",
      "   ",
      "\t\n",
      42,
      Number.NaN,
      {},
      [],
      asNpcId("   "),
    ] as unknown as RelationshipTargetId[];
    for (const targetId of broken) {
      for (const mode of NPC_RUNTIME_PROFILE_MODES) {
        expect(codeOf(records, { npcId: NPC_A, targetId, mode })).toBe("target_not_found");
      }
      const result = projectNpcRuntimeProfile(records, { npcId: NPC_A, targetId, mode: "rule" });
      expect(result.ok).toBe(false);
      expect("profile" in result).toBe(false);
    }
    // 正控制：缺省与显式 undefined 才是「无明确参与者」，那是合法读法，不是坏输入。
    for (const input of [
      { npcId: NPC_A, mode: "rule" } as NpcRuntimeProfileRequest,
      { npcId: NPC_A, mode: "rule", targetId: undefined } as NpcRuntimeProfileRequest,
    ]) {
      const result = projectNpcRuntimeProfile(records, input);
      expect(result.ok).toBe(true);
      if (result.ok) expect("outgoingEdge" in result.profile).toBe(false);
    }
  });

  it("失败结果不携带任何部分 profile", () => {
    const requests = [
      { npcId: asNpcId("npc_ghost"), mode: "rule" },
      { npcId: ITEM_1 as unknown as NpcId, mode: "rule" },
      { npcId: NPC_A, targetId: asNpcId("npc_ghost"), mode: "rule" },
      { npcId: NPC_A, mode: "chaotic" as NpcRuntimeProfileRequest["mode"] },
    ] satisfies readonly NpcRuntimeProfileRequest[];
    for (const request of requests) {
      const result = projectNpcRuntimeProfile(baseRecords(), request);
      expect(result.ok).toBe(false);
      expect("profile" in result).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 只读分层组件
// ---------------------------------------------------------------------------

describe("projectNpcRuntimeProfile — 分层组件是唯一读取权威", () => {
  it("兼容 memory 与组件冲突时以组件为准", () => {
    const legacyMemory: NpcMemory = {
      npcId: NPC_A,
      knownFactIds: [FACT_OTHER_SECRET],
      hiddenFactIds: [],
      interactionHistory: [interaction("act_legacy", 99)],
      relationship: { affinity: 77 },
      emotion: "afraid",
      goals: ["兼容层旧目标"],
    };
    const legacyEntry: NpcEntry = {
      id: NPC_A, name: "老周", role: "掌柜", description: "", locationId: LOC,
      isCompanion: false, tags: [], met: false, memory: legacyMemory,
    };
    const layers = importNpcLayers({ entry: legacyEntry, createdAtTurn: 0 });
    const subject = npcRecord(NPC_A, {
      anchors: layers.anchors,
      emotion: "warm",
      goals: [goal("g_active", "active", "组件目标")],
      entries: [entry(FACT_PUBLIC, "public")],
      outgoing: [edgeOf(PLAYER_ENTITY_ID)],
      interactions: [interaction("act_component", 3)],
    });
    const records: EntityRecord[] = [
      subject,
      playerRecord(),
      factRecord(FACT_PUBLIC, PUBLIC_PROSE),
      factRecord(FACT_OTHER_SECRET, OTHER_SECRET_CANARY),
    ];
    // 前置事实：兼容层的原文确实与分层组件冲突（否则本用例是空断言）。
    expect(legacyMemory.goals).toEqual(["兼容层旧目标"]);
    expect(legacyMemory.knownFactIds).toEqual([FACT_OTHER_SECRET]);
    expect(legacyMemory.emotion).toBe("afraid");
    expect(projectNpcMemory(subject).goals).toEqual(["组件目标"]);
    expect(projectNpcMemory(subject).knownFactIds).toEqual([FACT_PUBLIC]);
    for (const mode of NPC_RUNTIME_PROFILE_MODES) {
      const profile = profileOf(records, { npcId: NPC_A, targetId: PLAYER_ENTITY_ID, mode });
      const serialized = JSON.stringify(profile);
      expect(serialized).toContain("组件目标");
      expect(serialized).not.toContain("兼容层旧目标");
      expect(serialized).not.toContain("act_legacy");
      expect(serialized).not.toContain("afraid");
      expect(serialized).not.toContain(OTHER_SECRET_CANARY);
      expect(profile.interactions.map((item) => item.actionId)).toEqual(["act_component"]);
    }
    // 组件边确实压过了兼容层的 `relationship.affinity: 77`——但这条数值权威只走 rule 臂。
    expect(profileOf(records, { npcId: NPC_A, targetId: PLAYER_ENTITY_ID, mode: "rule" })
      .outgoingEdge?.dimensions.affinity).toBe(20);
    // prompt 臂同一条边：定性照给，数字一个都不给（77 与 20 都不许出现在档案里）。
    const promptCompat = profileOf(records, { npcId: NPC_A, targetId: PLAYER_ENTITY_ID, mode: "prompt" });
    expect(promptCompat.outgoingEdge).toEqual({
      targetId: PLAYER_ENTITY_ID, stage: "cooperative", trend: "improving",
    });
    expect(JSON.stringify(promptCompat)).not.toContain("affinity");
  });
});

// ---------------------------------------------------------------------------
// facade 出口
// ---------------------------------------------------------------------------

describe("npcMemory facade 暴露运行时投影", () => {
  it("selector 与常量经 index.ts 对 3B/5/7/8 开放且指向同一实现", () => {
    expect(typeof projectNpcRuntimeProfileViaFacade).toBe("function");
    expect(projectNpcRuntimeProfileViaFacade).toBe(projectNpcRuntimeProfile);
    expect(TAIL_VIA_FACADE).toBe(NPC_PROFILE_INTERACTION_TAIL);
    expect(MODES_VIA_FACADE).toEqual([...NPC_RUNTIME_PROFILE_MODES]);
    const viaFacade = projectNpcRuntimeProfileViaFacade(baseRecords(), {
      npcId: NPC_A, targetId: NPC_B, mode: "rule",
    } satisfies NpcRuntimeProfileRequest);
    expect(viaFacade.ok).toBe(true);
    // 新的分臂类型也必须只经 facade 可达（Task 8 不许 deep-import 内部文件），
    // 并且要与 selector 真正交出的形状一致：定性三项，不多不少。
    const qualitative: PromptEdgeViaFacade = { targetId: NPC_B, stage: "cooperative", trend: "improving" };
    const promptProfile: NpcRuntimeProfileViaFacade<"prompt"> = profileOf(baseRecords(), {
      npcId: NPC_A, targetId: NPC_B, mode: "prompt",
    });
    expect(promptProfile.outgoingEdge).toEqual(qualitative);
    expect(Object.keys(qualitative)).toHaveLength(3);
  });
});
