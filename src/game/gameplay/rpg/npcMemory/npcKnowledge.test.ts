import { describe, expect, it } from "vitest";
import {
  FACT_CHANGE_SOURCES,
  NPC_KNOWLEDGE_DISCLOSURES,
  validateNpcKnowledge,
  type NpcKnowledgeCertainty,
  type NpcKnowledgeComponent,
  type NpcKnowledgeDisclosure,
  type NpcKnowledgeEntry,
} from "@/game/domain/entity";
import { asFactId, asNpcId, type FactId, type NpcId } from "@/game/domain/worldEntity";
import type { FactChange, FactChangeSource } from "@/game/domain/resolvedEvent";
import {
  KNOWLEDGE_DISCLOSURE_VISIBILITY,
  createNpcKnowledgeEntry,
  createNpcKnowledgeSource,
  findKnowledgeEntry,
  knowledgeVisibilityOf,
  knowledgeWritesFromFactChange,
  partitionKnowledgeByVisibility,
  setNpcKnowledgeDisclosure,
  writeNpcKnowledge,
  type NpcKnowledgeReferences,
  type NpcKnowledgeSourceInput,
} from "./npcKnowledge";

// ---------------------------------------------------------------------------
// Plan 3 Task 4A：知识 entry 语义的独立证明（gameplay/rpg/npcMemory）。
//
// 三条总原则贯穿全部断言：
// 1) **每条产出都过 domain validator**：`legal` 用在每一次成功写入之后。
//    domain 的 validator 是 exact-key 判定，所以「兼容 memory 混进新组件」
//    （knownFactIds/hiddenFactIds 等平行写入口）会立刻被判成 invalid_component_shape
//    ——反平行写规则因此不是靠约定，而是被断言钉住的。
// 2) **零写入 = 对象同一性**：所有拒绝与幂等分支都必须把入参 component 原样返回，
//    `toBe(input)` 是唯一可信的「没有偷偷改写」证据。
// 3) **未受信字符串**：mode/certainty/disclosure/factId/npcId 都可能是持久化或 AI 产物，
//    原型链键名（"toString"/"constructor"/"__proto__"）一律落到稳定 code。
// ---------------------------------------------------------------------------

const NPC_A = asNpcId("npc_a");
const NPC_B = asNpcId("npc_b");
const FACT_1 = asFactId("fact_1");
const FACT_2 = asFactId("fact_2");
const SECRET_FACT = asFactId("fact_secret");

const REFERENCES: NpcKnowledgeReferences = {
  factIds: new Set<string>([String(FACT_1), String(FACT_2), String(SECRET_FACT)]),
  npcIds: new Set<string>([String(NPC_A), String(NPC_B)]),
};

const EVIDENCE = { actionId: "act_7", turnNumber: 3 };

function legal(knowledge: NpcKnowledgeComponent): void {
  expect(validateNpcKnowledge(knowledge)).toEqual([]);
  // 组件只有 entries 一个字段：出现任何兼容 memory 字段都是平行写。
  expect(Object.keys(knowledge)).toEqual(["entries"]);
}

function componentOf(...entries: readonly NpcKnowledgeEntry[]): NpcKnowledgeComponent {
  return { entries };
}

function entryOf(input: Readonly<{
  factId: FactId;
  certainty?: NpcKnowledgeCertainty;
  disclosure?: NpcKnowledgeDisclosure;
  source?: NpcKnowledgeSourceInput;
}>): NpcKnowledgeEntry {
  const result = createNpcKnowledgeEntry({
    factId: input.factId,
    certainty: input.certainty ?? "known",
    disclosure: input.disclosure ?? "public",
    source: input.source ?? { kind: "initial_world", turnNumber: 0 },
  });
  if (!result.ok) throw new Error(`fixture entry rejected: ${result.code}`);
  return result.entry;
}

const INITIAL_SOURCE: NpcKnowledgeSourceInput = { kind: "initial_world", turnNumber: 0 };
const ACTION_SOURCE: NpcKnowledgeSourceInput = { kind: "action", ...EVIDENCE, mode: "scene_witness" };

function write(input: Partial<Parameters<typeof writeNpcKnowledge>[0]> = {}) {
  return writeNpcKnowledge({
    npcId: input.npcId ?? NPC_A,
    knowledge: input.knowledge ?? { entries: [] },
    factId: input.factId ?? FACT_1,
    certainty: input.certainty ?? "known",
    disclosure: input.disclosure ?? "public",
    source: input.source ?? ACTION_SOURCE,
    references: input.references ?? REFERENCES,
  });
}

// ---------------------------------------------------------------------------
// 1) 来源构造：initial_world 与 action（含真实 {actionId, turnNumber}）
// ---------------------------------------------------------------------------

describe("createNpcKnowledgeSource", () => {
  it("背景知识用 initial_world，不伪造 actionId", () => {
    const result = createNpcKnowledgeSource({ kind: "initial_world", turnNumber: 0 });
    expect(result).toEqual({ ok: true, source: { kind: "initial_world", learnedAtTurn: 0 } });
  });

  it("行动来源逐字带上 mode + actionId + learnedAtTurn", () => {
    const result = createNpcKnowledgeSource({ kind: "action", ...EVIDENCE, mode: "player_told" });
    expect(result).toEqual({
      ok: true,
      source: { kind: "action", mode: "player_told", actionId: "act_7", learnedAtTurn: 3 },
    });
  });

  it("npc_revealed 记录透露者，其余 mode 一律不带 sourceNpcId", () => {
    expect(createNpcKnowledgeSource({
      kind: "action", ...EVIDENCE, mode: "npc_revealed", sourceNpcId: NPC_B,
    })).toEqual({
      ok: true,
      source: { kind: "action", mode: "npc_revealed", actionId: "act_7", learnedAtTurn: 3, sourceNpcId: NPC_B },
    });
    expect(createNpcKnowledgeSource({
      kind: "action", ...EVIDENCE, mode: "player_told", sourceNpcId: NPC_B,
    })).toEqual({ ok: false, code: "invalid_source_npc" });
    expect(createNpcKnowledgeSource({ kind: "action", ...EVIDENCE, mode: "npc_revealed" }))
      .toEqual({ ok: false, code: "invalid_source_npc" });
  });

  it("缺证据/非法证据一律拒绝，绝不退化成 initial_world", () => {
    expect(createNpcKnowledgeSource({ kind: "action", mode: "scene_witness", turnNumber: 3 } as never))
      .toEqual({ ok: false, code: "invalid_action_source" });
    expect(createNpcKnowledgeSource({ kind: "action", ...EVIDENCE, actionId: "  ", mode: "scene_witness" }))
      .toEqual({ ok: false, code: "invalid_action_source" });
    expect(createNpcKnowledgeSource({ kind: "action", ...EVIDENCE, turnNumber: -1, mode: "scene_witness" }))
      .toEqual({ ok: false, code: "invalid_turn_number" });
    expect(createNpcKnowledgeSource({ kind: "action", ...EVIDENCE, turnNumber: 1.5, mode: "scene_witness" }))
      .toEqual({ ok: false, code: "invalid_turn_number" });
    expect(createNpcKnowledgeSource({ kind: "initial_world", turnNumber: Number.NaN } as never))
      .toEqual({ ok: false, code: "invalid_turn_number" });
  });

  it("mode 与 kind 都是闭集：表外值与原型链键名给稳定 code", () => {
    expect(createNpcKnowledgeSource({ kind: "action", ...EVIDENCE, mode: "everything_known" as FactChangeSource }))
      .toEqual({ ok: false, code: "invalid_mode" });
    expect(createNpcKnowledgeSource({ kind: "action", ...EVIDENCE, mode: "toString" as FactChangeSource }))
      .toEqual({ ok: false, code: "invalid_mode" });
    expect(createNpcKnowledgeSource({ kind: "event", ...EVIDENCE } as never))
      .toEqual({ ok: false, code: "invalid_source_kind" });
    expect(createNpcKnowledgeSource({ kind: "constructor" } as never))
      .toEqual({ ok: false, code: "invalid_source_kind" });
  });

  it("domain 的 mode union 每一项都有来源策略（漏一格编译失败、多一格测试失败）", () => {
    const covered = new Set<string>(["scene_witness", "player_told", "npc_revealed", "public_broadcast", "faction_shared"]);
    expect(FACT_CHANGE_SOURCES.every((mode) => covered.has(mode))).toBe(true);
    for (const mode of FACT_CHANGE_SOURCES) {
      const source = mode === "npc_revealed"
        ? { kind: "action" as const, ...EVIDENCE, mode, sourceNpcId: NPC_B }
        : { kind: "action" as const, ...EVIDENCE, mode };
      expect(createNpcKnowledgeSource(source).ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2) entry 构造
// ---------------------------------------------------------------------------

describe("createNpcKnowledgeEntry", () => {
  it("两种来源都能构造合法 entry", () => {
    for (const source of [INITIAL_SOURCE, ACTION_SOURCE]) {
      const result = createNpcKnowledgeEntry({
        factId: FACT_1, certainty: "suspected", disclosure: "conditional", source,
      });
      expect(result.ok).toBe(true);
      if (result.ok) legal(componentOf(result.entry));
    }
  });

  it("certainty / disclosure 只认 domain 闭集", () => {
    expect(createNpcKnowledgeEntry({
      factId: FACT_1, certainty: "certain" as NpcKnowledgeCertainty, disclosure: "public", source: INITIAL_SOURCE,
    })).toEqual({ ok: false, code: "invalid_certainty" });
    expect(createNpcKnowledgeEntry({
      factId: FACT_1, certainty: "known", disclosure: "valueOf" as NpcKnowledgeDisclosure, source: INITIAL_SOURCE,
    })).toEqual({ ok: false, code: "invalid_disclosure" });
  });

  it("空 factId 与非法来源都拒绝", () => {
    expect(createNpcKnowledgeEntry({
      factId: asFactId("  "), certainty: "known", disclosure: "public", source: INITIAL_SOURCE,
    })).toEqual({ ok: false, code: "unknown_fact" });
    expect(createNpcKnowledgeEntry({
      factId: FACT_1, certainty: "known", disclosure: "public", source: { kind: "initial_world", turnNumber: -2 },
    })).toEqual({ ok: false, code: "invalid_turn_number" });
  });
});

// ---------------------------------------------------------------------------
// 3) 引用校验 + 幂等 + certainty 单调 + disclosure 显式
// ---------------------------------------------------------------------------

describe("writeNpcKnowledge", () => {
  it("未知 Fact / 未知 NPC / 未知来源 NPC 都零写入且原样返回组件", () => {
    const knowledge = { entries: [] };
    expect(write({ knowledge, factId: asFactId("fact_ghost") }))
      .toEqual({ ok: false, changed: false, code: "unknown_fact", knowledge });
    expect(write({ knowledge, npcId: asNpcId("npc_ghost") }))
      .toEqual({ ok: false, changed: false, code: "unknown_npc", knowledge });
    expect(write({
      knowledge,
      source: { kind: "action", ...EVIDENCE, mode: "npc_revealed", sourceNpcId: asNpcId("npc_ghost") },
    })).toEqual({ ok: false, changed: false, code: "unknown_source_npc", knowledge });
    expect(knowledge.entries).toHaveLength(0);
  });

  it("原型链键名不能冒充引用", () => {
    const knowledge = { entries: [] };
    expect(write({ knowledge, factId: asFactId("toString") }).ok).toBe(false);
    expect(write({ knowledge, npcId: asNpcId("constructor") }).ok).toBe(false);
    expect(write({ knowledge, source: {
      kind: "action", ...EVIDENCE, mode: "npc_revealed", sourceNpcId: asNpcId("__proto__"),
    } }).ok).toBe(false);
    legal(knowledge);
    expect(knowledge.entries).toHaveLength(0);
  });

  it("引用上下文缺失或非 Set 即拒绝：不存在「跳过查表」的调用形态", () => {
    const missing = writeNpcKnowledge({
      npcId: NPC_A, knowledge: { entries: [] }, factId: FACT_1, certainty: "known",
      disclosure: "public", source: ACTION_SOURCE,
      references: undefined as unknown as NpcKnowledgeReferences,
    });
    expect(missing).toMatchObject({ ok: false, code: "invalid_reference_context" });
    const notASet = writeNpcKnowledge({
      npcId: NPC_A, knowledge: { entries: [] }, factId: FACT_1, certainty: "known",
      disclosure: "public", source: ACTION_SOURCE,
      references: { factIds: new Set([String(FACT_1)]), npcIds: [String(NPC_A)] } as unknown as NpcKnowledgeReferences,
    });
    expect(notASet).toMatchObject({ ok: false, code: "invalid_reference_context" });
  });

  it("同一 Fact 幂等：第二次写入零变化、返回同一对象", () => {
    const first = write({});
    if (!first.ok) throw new Error("first write should succeed");
    legal(first.knowledge);
    const again = write({ knowledge: first.knowledge });
    expect(again).toMatchObject({ ok: true, changed: false, reason: "already_known" });
    expect(again.ok && again.knowledge).toBe(first.knowledge);
    expect(again.ok && again.entry).toBe(first.entry);
    expect(again.ok && again.knowledge.entries).toHaveLength(1);
  });

  it("同 Fact 重放不会因来源不同而产生第二条条目", () => {
    const initial = write({ source: INITIAL_SOURCE });
    if (!initial.ok) throw new Error("initial write should succeed");
    const replay = write({ knowledge: initial.knowledge, source: ACTION_SOURCE });
    expect(replay).toMatchObject({ ok: true, changed: false, reason: "already_known" });
    if (replay.ok && !replay.changed) expect(replay.entry.source).toEqual({ kind: "initial_world", learnedAtTurn: 0 });
  });

  it("certainty 只能升：suspected → known 改写 certainty，来源与披露原样保留", () => {
    const suspected = write({ certainty: "suspected", disclosure: "secret", source: INITIAL_SOURCE });
    if (!suspected.ok) throw new Error("suspected write should succeed");
    const upgraded = write({ knowledge: suspected.knowledge, certainty: "known", disclosure: "public" });
    expect(upgraded).toMatchObject({ ok: true, changed: true, reason: "certainty_upgraded" });
    if (upgraded.ok) {
      legal(upgraded.knowledge);
      expect(upgraded.entry).toEqual({
        factId: FACT_1,
        certainty: "known",
        disclosure: "secret",
        source: { kind: "initial_world", learnedAtTurn: 0 },
      });
    }
  });

  it("known → suspected 永不隐式降级：拒绝且组件不变", () => {
    const known = write({});
    if (!known.ok) throw new Error("known write should succeed");
    const demotion = write({ knowledge: known.knowledge, certainty: "suspected" });
    expect(demotion).toEqual({ ok: false, changed: false, code: "certainty_demotion_rejected", knowledge: known.knowledge });
    if (demotion.ok) throw new Error("demotion must be rejected");
    // 提供了组件的拒绝**必须**带回调用方那个对象：undefined 只允许出现在 invalid_component 臂上。
    const untouched = demotion.knowledge;
    if (untouched === undefined) throw new Error("rejection must return the caller's own component");
    expect(untouched).toBe(known.knowledge);
    expect(untouched.entries[0]?.certainty).toBe("known");
  });

  it("disclosure 只能由显式规则改变：普通写入不动既有披露", () => {
    const seeded = write({ disclosure: "conditional" });
    if (!seeded.ok) throw new Error("seed write should succeed");
    const rewritten = write({ knowledge: seeded.knowledge, disclosure: "public", certainty: "known" });
    expect(rewritten).toMatchObject({ ok: true, changed: false, reason: "already_known" });
    if (rewritten.ok && !rewritten.changed) expect(rewritten.entry.disclosure).toBe("conditional");

    const changed = setNpcKnowledgeDisclosure({
      npcId: NPC_A, knowledge: seeded.knowledge, factId: FACT_1, disclosure: "secret",
      actionId: EVIDENCE.actionId, turnNumber: EVIDENCE.turnNumber, references: REFERENCES,
    });
    expect(changed.ok).toBe(true);
    if (changed.ok && changed.changed) {
      legal(changed.knowledge);
      expect(changed.entry).toEqual({ ...seeded.entry, disclosure: "secret" });
      expect(changed.knowledge.entries).toHaveLength(1);
    }
  });

  it("显式披露规则：未知 Fact、非法取值、非法证据都零写入", () => {
    const seeded = write({});
    if (!seeded.ok) throw new Error("seed write should succeed");
    const base = {
      npcId: NPC_A, knowledge: seeded.knowledge, disclosure: "secret" as NpcKnowledgeDisclosure,
      actionId: EVIDENCE.actionId, turnNumber: EVIDENCE.turnNumber, references: REFERENCES,
    };
    const ghost = setNpcKnowledgeDisclosure({ ...base, factId: asFactId("fact_ghost") });
    expect(ghost).toEqual({ ok: false, changed: false, code: "unknown_fact", knowledge: seeded.knowledge });
    const notKnown = setNpcKnowledgeDisclosure({ ...base, factId: FACT_2 });
    expect(notKnown).toMatchObject({ ok: false, code: "knowledge_entry_not_found" });
    expect(setNpcKnowledgeDisclosure({ ...base, factId: FACT_1, disclosure: "private" as NpcKnowledgeDisclosure }))
      .toMatchObject({ ok: false, code: "invalid_disclosure" });
    expect(setNpcKnowledgeDisclosure({ ...base, factId: FACT_1, actionId: "" }))
      .toMatchObject({ ok: false, code: "invalid_action_source" });
    expect(setNpcKnowledgeDisclosure({ ...base, factId: FACT_1, turnNumber: 2.5 }))
      .toMatchObject({ ok: false, code: "invalid_turn_number" });
    expect(setNpcKnowledgeDisclosure({ ...base, factId: FACT_1, npcId: asNpcId("npc_ghost") }))
      .toMatchObject({ ok: false, code: "unknown_npc" });
    const firstSet = setNpcKnowledgeDisclosure({ ...base, factId: FACT_1 });
    expect(firstSet).toMatchObject({ ok: true, changed: true, reason: "disclosure_set" });
    if (firstSet.ok && firstSet.changed) {
      // 显式披露规则只动披露：certainty 与首次来源逐字保留。
      expect(firstSet.entry.certainty).toBe("known");
      expect(firstSet.entry.source).toEqual({ kind: "action", mode: "scene_witness", actionId: "act_7", learnedAtTurn: 3 });
      expect(setNpcKnowledgeDisclosure({ ...base, knowledge: firstSet.knowledge, factId: FACT_1 }))
        .toMatchObject({ ok: true, changed: false, reason: "already_disclosure" });
    }
  });

  it("写入只追加/只替换本 NPC 的条目，不动既有顺序", () => {
    const first = write({ factId: FACT_1 });
    if (!first.ok) throw new Error("first write should succeed");
    const second = write({ knowledge: first.knowledge, factId: FACT_2, source: INITIAL_SOURCE });
    expect(second.ok).toBe(true);
    if (second.ok) {
      legal(second.knowledge);
      expect(second.knowledge.entries.map((entry) => String(entry.factId))).toEqual(["fact_1", "fact_2"]);
      expect(second.knowledge.entries[0]).toBe(first.entry);
      expect(findKnowledgeEntry(second.knowledge, FACT_2)?.certainty).toBe("known");
      expect(findKnowledgeEntry(second.knowledge, SECRET_FACT)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 4) FactChange.source / audience → knowledge source mode 的完整映射
// ---------------------------------------------------------------------------

function factChange(input: Partial<FactChange> = {}): FactChange {
  return { factId: FACT_1, change: "discovered", source: "scene_witness", ...input };
}

function broadcast(
  change: FactChange,
  request: Partial<Parameters<typeof knowledgeWritesFromFactChange>[1]> = {},
  references: NpcKnowledgeReferences = REFERENCES,
) {
  return knowledgeWritesFromFactChange(
    change,
    { ...EVIDENCE, ...request },
    references,
  );
}

describe("knowledgeWritesFromFactChange", () => {
  it("五种 source 各自映射到自己的 mode，且都要求显式 audience", () => {
    for (const source of FACT_CHANGE_SOURCES) {
      const result = broadcast(
        factChange({ source, audience: [NPC_A] }),
        source === "npc_revealed" ? { speakerNpcId: NPC_B } : {},
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.writes).toHaveLength(1);
      expect(result.writes[0]).toEqual({
        npcId: NPC_A,
        factId: FACT_1,
        certainty: "known",
        disclosure: "public",
        source: source === "npc_revealed"
          ? { kind: "action", mode: source, actionId: "act_7", turnNumber: 3, sourceNpcId: NPC_B }
          : { kind: "action", mode: source, actionId: "act_7", turnNumber: 3 },
      });
    }
  });

  it("无 audience、隐藏类变化、非法 source 都保持零写入", () => {
    expect(broadcast(factChange())).toEqual({ ok: true, writes: [], skipped: [], reason: "no_audience" });
    expect(broadcast(factChange({ audience: [] })))
      .toEqual({ ok: true, writes: [], skipped: [], reason: "no_audience" });
    expect(broadcast(factChange({ change: "hidden", audience: [NPC_A] })))
      .toEqual({ ok: true, writes: [], skipped: [], reason: "change_is_not_additive" });
    expect(broadcast(factChange({ source: "city_gossip" as FactChangeSource, audience: [NPC_A] })))
      .toEqual({ ok: false, code: "invalid_mode", writes: [], skipped: [] });
    expect(broadcast(factChange({ change: "erased" as FactChange["change"], audience: [NPC_A] })))
      .toEqual({ ok: false, code: "invalid_change_kind", writes: [], skipped: [] });
    expect(broadcast(factChange({ audience: [NPC_A] }), { actionId: "" }))
      .toEqual({ ok: false, code: "invalid_action_source", writes: [], skipped: [] });
    expect(broadcast(factChange({ audience: [NPC_A] }), { turnNumber: -3 }))
      .toEqual({ ok: false, code: "invalid_turn_number", writes: [], skipped: [] });
  });

  it("未知 Fact 整条拒绝；未知 NPC 只跳过自己，其余 audience 仍写入", () => {
    expect(broadcast(factChange({ factId: asFactId("fact_ghost"), audience: [NPC_A] })))
      .toEqual({ ok: false, code: "unknown_fact", writes: [], skipped: [] });
    const result = broadcast(factChange({ audience: [asNpcId("npc_ghost"), NPC_A, "toString" as NpcId] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.writes.map((item) => String(item.npcId))).toEqual(["npc_a"]);
      expect(result.skipped.map((item) => item.code)).toEqual(["unknown_npc", "unknown_npc"]);
    }
  });

  it("audience 去重且保留首次顺序", () => {
    const result = broadcast(factChange({ audience: [NPC_B, NPC_A, NPC_B] }));
    expect(result.ok && result.writes.map((item) => String(item.npcId))).toEqual(["npc_b", "npc_a"]);
  });

  it("sourceNpcId 不等于自动传播 audience：透露者不会因此知道自己透露的事实", () => {
    const result = broadcast(factChange({ source: "npc_revealed", audience: [NPC_A] }), { speakerNpcId: NPC_B });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.writes.map((item) => String(item.npcId))).toEqual(["npc_a"]);
      expect(result.writes[0]?.source).toMatchObject({ mode: "npc_revealed", sourceNpcId: NPC_B });
    }
    // 显式把透露者列进 audience 才写它。
    const explicit = broadcast(
      factChange({ source: "npc_revealed", audience: [NPC_A, NPC_B] }),
      { speakerNpcId: NPC_B },
    );
    expect(explicit.ok && explicit.writes.map((item) => String(item.npcId))).toEqual(["npc_a", "npc_b"]);
  });

  it("npc_revealed 缺透露者或透露者不存在都拒绝；非透露类 source 不得挂 sourceNpcId", () => {
    expect(broadcast(factChange({ source: "npc_revealed", audience: [NPC_A] })))
      .toEqual({ ok: false, code: "invalid_source_npc", writes: [], skipped: [] });
    expect(broadcast(factChange({ source: "npc_revealed", audience: [NPC_A] }), { speakerNpcId: asNpcId("npc_ghost") }))
      .toEqual({ ok: false, code: "unknown_source_npc", writes: [], skipped: [] });
    expect(broadcast(factChange({ source: "public_broadcast", audience: [NPC_A] }), { speakerNpcId: NPC_B }))
      .toEqual({ ok: false, code: "invalid_source_npc", writes: [], skipped: [] });
  });

  it("映射产物可直接喂给 writeNpcKnowledge，且重放幂等", () => {
    const result = broadcast(factChange({ audience: [NPC_A, NPC_B] }), { disclosure: "secret", certainty: "suspected" });
    if (!result.ok) throw new Error("broadcast should map writes");
    const components = new Map([
      [String(NPC_A), { entries: [] } as NpcKnowledgeComponent],
      [String(NPC_B), { entries: [] } as NpcKnowledgeComponent],
    ]);
    for (const item of result.writes) {
      const current = components.get(String(item.npcId))!;
      const applied = writeNpcKnowledge({
        npcId: item.npcId,
        knowledge: current,
        factId: item.factId,
        certainty: item.certainty,
        disclosure: item.disclosure,
        source: item.source,
        references: REFERENCES,
      });
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        legal(applied.knowledge);
        components.set(String(item.npcId), applied.knowledge);
      }
    }
    expect([...components.values()].map((knowledge) => knowledge.entries).flat()).toHaveLength(2);
    for (const item of result.writes) {
      const replayed = writeNpcKnowledge({
        npcId: item.npcId,
        knowledge: components.get(String(item.npcId))!,
        factId: item.factId,
        certainty: item.certainty,
        disclosure: item.disclosure,
        source: item.source,
        references: REFERENCES,
      });
      expect(replayed).toMatchObject({ ok: true, changed: false, reason: "already_known" });
    }
  });
});

// ---------------------------------------------------------------------------
// 5) secret 隔离（Task 4B 的投影必须复用这一份判定）
// ---------------------------------------------------------------------------

describe("visibility", () => {
  it("三种披露各有封闭去向，只有 public 能进其他 NPC 的读取面", () => {
    expect(Object.keys(KNOWLEDGE_DISCLOSURE_VISIBILITY)).toEqual([...NPC_KNOWLEDGE_DISCLOSURES]);
    expect(knowledgeVisibilityOf(entryOf({ factId: FACT_1, disclosure: "public" }))).toBe("shareable");
    expect(knowledgeVisibilityOf(entryOf({ factId: FACT_1, disclosure: "conditional" }))).toBe("rule_required");
    expect(knowledgeVisibilityOf(entryOf({ factId: FACT_1, disclosure: "secret" }))).toBe("withheld");
    expect(KNOWLEDGE_DISCLOSURE_VISIBILITY.secret.mayEnterOtherNpcProjection).toBe(false);
    expect(KNOWLEDGE_DISCLOSURE_VISIBILITY.conditional.mayEnterOtherNpcProjection).toBe(false);
    expect(KNOWLEDGE_DISCLOSURE_VISIBILITY.public.mayEnterOtherNpcProjection).toBe(true);
  });

  it("分区只覆盖主体自己的条目：secret 永不进入可分享面", () => {
    const knowledge = componentOf(
      entryOf({ factId: FACT_1, disclosure: "public" }),
      entryOf({ factId: SECRET_FACT, disclosure: "secret" }),
      entryOf({ factId: FACT_2, disclosure: "conditional" }),
    );
    const partitions = partitionKnowledgeByVisibility(knowledge);
    expect(partitions.shareable.map((entry) => String(entry.factId))).toEqual(["fact_1"]);
    expect(partitions.ruleRequired.map((entry) => String(entry.factId))).toEqual(["fact_2"]);
    expect(partitions.withheld.map((entry) => String(entry.factId))).toEqual(["fact_secret"]);
    // 三分区互斥且完整覆盖，任何一条都不会既被扣留又被分享。
    const all = [...partitions.shareable, ...partitions.ruleRequired, ...partitions.withheld];
    expect(new Set(all.map((entry) => String(entry.factId))).size).toBe(knowledge.entries.length);
  });

  it("NPC A 的 secret 不会因为传播链出现在 NPC B 的组件里", () => {
    const withSecret = write({ knowledge: componentOf(entryOf({ factId: FACT_1 })), factId: SECRET_FACT, disclosure: "secret" });
    if (!withSecret.ok) throw new Error("secret write should succeed");
    const broadcastOther = broadcast(factChange({ factId: FACT_2, audience: [NPC_B] }));
    if (!broadcastOther.ok) throw new Error("broadcast should map writes");
    let otherKnowledge: NpcKnowledgeComponent = { entries: [] };
    for (const item of broadcastOther.writes) {
      const applied = writeNpcKnowledge({
        npcId: item.npcId,
        knowledge: otherKnowledge,
        factId: item.factId,
        certainty: item.certainty,
        disclosure: item.disclosure,
        source: item.source,
        references: REFERENCES,
      });
      expect(applied.ok).toBe(true);
      if (applied.ok) otherKnowledge = applied.knowledge;
    }
    expect(otherKnowledge.entries.map((entry) => String(entry.factId))).toEqual(["fact_2"]);
    expect(partitionKnowledgeByVisibility(otherKnowledge).withheld).toEqual([]);
    // A 的 secret 仍在 A 自己组件的 withheld 分区里。
    expect(partitionKnowledgeByVisibility(withSecret.knowledge).withheld.map((entry) => String(entry.factId)))
      .toEqual(["fact_secret"]);
  });
});

// ---------------------------------------------------------------------------
// 6) 引用只认自有属性 + 兼容读模型的重建顺序
// ---------------------------------------------------------------------------

describe("references and compatibility", () => {
  it("挂在原型链上的 factId / sourceNpcId 不算提供了引用", () => {
    // factId 只继承自原型：空白判定守不住继承来的键，必须落到 unknown_fact。
    const inheritedFact = Object.assign(Object.create({ factId: FACT_1 }), {
      npcId: NPC_A, knowledge: { entries: [] }, certainty: "known",
      disclosure: "public", source: ACTION_SOURCE, references: REFERENCES,
    });
    expect(writeNpcKnowledge(inheritedFact as never)).toMatchObject({ ok: false, code: "unknown_fact" });

    // npc_revealed 的透露者只挂在原型链上：等于没有提供透露者，而不是拿去查存在性。
    const inheritedSpeaker = Object.assign(Object.create({ sourceNpcId: NPC_B }), {
      kind: "action", mode: "npc_revealed", actionId: "act_7", turnNumber: 3,
    });
    expect(write({ source: inheritedSpeaker as never }))
      .toMatchObject({ ok: false, code: "invalid_source_npc" });

    // 反过来：无说话人的 mode 上继承来的 sourceNpcId 也必须完全不可见（不误判未知 NPC）。
    const ghostOnProto = Object.assign(Object.create({ sourceNpcId: asNpcId("npc_ghost") }), {
      kind: "action", mode: "scene_witness", actionId: "act_7", turnNumber: 3,
    });
    const allowed = write({ source: ghostOnProto as never });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) legal(allowed.knowledge);
  });

  it("缺失 knowledge 不会伪造出空组件：漏传是显式失败而不是「成功写入」", () => {
    const missing = {
      npcId: NPC_A, factId: FACT_1, certainty: "known",
      disclosure: "public", source: ACTION_SOURCE, references: REFERENCES,
    };
    // 零写入的证据是**对象同一性**，所以本模块绝不 `?? { entries: [] }` 造一份新组件：
    // 伪造出来的空组件会让「漏传 knowledge」看起来像一次成功写入。
    // 但漏传也不得逃成裸 TypeError——规则层的契约是「永远返回封闭 code」，
    // 调用方因此不需要为一条规则判断包 try/catch（Task 4A 复审加固 #1）。
    const rejected = writeNpcKnowledge(missing as never);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("missing component must not pass");
    expect(rejected.changed).toBe(false);
    expect(rejected.code).toBe("invalid_component");
    expect(rejected.knowledge).toBeUndefined();
  });

  it("既有组件里的表外既有取值走 knowledge_entry_not_found，写入口不得借道改写", () => {
    const corruptedCertainty = componentOf({
      factId: FACT_1,
      certainty: "absolute" as NpcKnowledgeCertainty,
      disclosure: "public",
      source: { kind: "initial_world", learnedAtTurn: 0 },
    });
    expect(write({ knowledge: corruptedCertainty, certainty: "known" }))
      .toEqual({ ok: false, changed: false, code: "knowledge_entry_not_found", knowledge: corruptedCertainty });

    const corruptedDisclosure = componentOf({
      factId: FACT_1,
      certainty: "known",
      disclosure: "restricted" as NpcKnowledgeDisclosure,
      source: { kind: "initial_world", learnedAtTurn: 0 },
    });
    expect(write({ knowledge: corruptedDisclosure, certainty: "suspected" }))
      .toMatchObject({ ok: false, changed: false, code: "knowledge_entry_not_found" });
    // 显式披露规则同样不能把损坏值顺手改写成合法值：那等于第二条写入通道。
    expect(setNpcKnowledgeDisclosure({
      npcId: NPC_A, knowledge: corruptedDisclosure, factId: FACT_1, disclosure: "secret",
      actionId: EVIDENCE.actionId, turnNumber: EVIDENCE.turnNumber, references: REFERENCES,
    })).toEqual({
      ok: false, changed: false, code: "knowledge_entry_not_found", knowledge: corruptedDisclosure,
    });
    expect(corruptedDisclosure.entries[0]?.disclosure).toBe("restricted");
    expect(corruptedDisclosure.entries[0]?.certainty).toBe("known");
    expect(corruptedCertainty.entries[0]?.certainty).toBe("absolute");
  });

  it("条目顺序 = 习得顺序：重放与 certainty 升级都不重排，兼容 memory 只能由它重建", () => {
    const first = write({ factId: FACT_2, certainty: "suspected" });
    if (!first.ok) throw new Error("first write should succeed");
    const second = write({ knowledge: first.knowledge, factId: FACT_1 });
    if (!second.ok) throw new Error("second write should succeed");
    const upgraded = write({ knowledge: second.knowledge, factId: FACT_2, certainty: "known", disclosure: "secret" });
    if (!upgraded.ok) throw new Error("upgrade should succeed");
    const replayed = write({ knowledge: upgraded.knowledge, factId: FACT_1 });
    expect(replayed).toMatchObject({ ok: true, changed: false, reason: "already_known" });

    const order = upgraded.knowledge.entries.map((entry) => String(entry.factId));
    expect(order).toEqual(["fact_2", "fact_1"]);
    legal(upgraded.knowledge);

    // 兼容读模型（knownFactIds / hiddenFactIds）是这份顺序的投影，不是第二个写入口：
    // certainty 升级不动披露，所以 hidden 列表此时仍为空。
    expect(projectNpcMemoryFrom(order, upgraded.knowledge)).toEqual({
      knownFactIds: ["fact_2", "fact_1"],
      hiddenFactIds: [],
    });
    // 只有显式披露规则能把它变成扣留项。
    const hidden = setNpcKnowledgeDisclosure({
      npcId: NPC_A, knowledge: upgraded.knowledge, factId: FACT_2, disclosure: "secret",
      actionId: EVIDENCE.actionId, turnNumber: EVIDENCE.turnNumber, references: REFERENCES,
    });
    if (!hidden.ok || !hidden.changed) throw new Error("disclosure rule should apply");
    expect(projectNpcMemoryFrom(order, hidden.knowledge)).toEqual({
      knownFactIds: ["fact_2", "fact_1"],
      hiddenFactIds: ["fact_2"],
    });
    const polluted = { ...hidden.knowledge, memory: { knownFactIds: order } };
    expect(validateNpcKnowledge(polluted)).toEqual([{ code: "invalid_component_shape", path: "knowledge" }]);
  });
});

/** 兼容读模型的唯一定义：knownFactIds 逐字取 entries 顺序，hiddenFactIds 取 secret 条目。 */
function projectNpcMemoryFrom(
  order: readonly string[],
  knowledge: NpcKnowledgeComponent,
): Readonly<{ knownFactIds: readonly string[]; hiddenFactIds: readonly string[] }> {
  return {
    knownFactIds: order,
    hiddenFactIds: knowledge.entries.filter((entry) => entry.disclosure === "secret").map((entry) => String(entry.factId)),
  };
}

// ---------------------------------------------------------------------------
// 7) Task 4A 复审加固：#1 组件本体的稳定 code、#3 同一对象上不得混用两把读取门
// ---------------------------------------------------------------------------

describe("npcKnowledge 的失败一律是封闭 code（复审加固 #1）", () => {
  /** 不经 `write` 夹具：它的 `?? { entries: [] }` 缺省会替调用方伪造组件。 */
  function writeRaw(knowledge: unknown) {
    return writeNpcKnowledge({
      npcId: NPC_A, knowledge: knowledge as never, factId: FACT_1, certainty: "known",
      disclosure: "public", source: ACTION_SOURCE, references: REFERENCES,
    });
  }

  /** 组件本体不是组件的每一种形状：调用方拿到 code，而不是 TypeError。 */
  function expectInvalidComponent(
    label: string,
    knowledge: unknown,
  ): void {
    const notAForgedComponent = knowledge;
    const written = writeRaw(knowledge);
    expect(written.ok, label).toBe(false);
    if (!written.ok) {
      expect(written.code, label).toBe("invalid_component");
      expect(written.changed, label).toBe(false);
    }
    const disclosed = setNpcKnowledgeDisclosure({
      npcId: NPC_A, knowledge: knowledge as never, factId: FACT_1, disclosure: "secret",
      actionId: EVIDENCE.actionId, turnNumber: EVIDENCE.turnNumber, references: REFERENCES,
    });
    expect(disclosed.ok, label).toBe(false);
    if (!disclosed.ok) expect(disclosed.code, label).toBe("invalid_component");
    // 「没有写入」的证据仍然是对象同一性：能原样带回的一律带回调用方自己那个对象。
    if (typeof notAForgedComponent === "object" && notAForgedComponent !== null) {
      if (!written.ok) expect(written.knowledge, label).toBe(notAForgedComponent);
      if (!disclosed.ok) expect(disclosed.knowledge, label).toBe(notAForgedComponent);
    }
  }

  it("knowledge 缺字段 / 为 null / 为数组 / entries 只挂在原型链上，全部落到 invalid_component", () => {
    expectInvalidComponent("缺 entries", {});
    expectInvalidComponent("entries 非数组", { entries: "fact_1" });
    expectInvalidComponent("entries 只继承", Object.create({ entries: [] }));
    expectInvalidComponent("undefined", undefined);
    expectInvalidComponent("null", null);
    expectInvalidComponent("数组", []);
    expectInvalidComponent("字符串", "fact_1");
  });

  it("合法组件照常写入：本项加固没有把空 entries 组件误判成缺失", () => {
    const result = write({ knowledge: { entries: [] } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(true);
  });
});

describe("同一 input 对象的读取共用一把门（复审加固 #3）", () => {
  it("继承来的 certainty / disclosure 不算声明：写入口与细构造函数都拒绝", () => {
    const inheritedCertainty = Object.assign(Object.create({ certainty: "known", disclosure: "public" }), {
      npcId: NPC_A, knowledge: { entries: [] }, factId: FACT_1,
      source: ACTION_SOURCE, references: REFERENCES,
    });
    expect(writeNpcKnowledge(inheritedCertainty as never))
      .toMatchObject({ ok: false, changed: false, code: "invalid_certainty" });

    const inheritedDisclosure = Object.assign(Object.create({ disclosure: "public" }), {
      factId: FACT_1, certainty: "known", source: ACTION_SOURCE,
    });
    expect(createNpcKnowledgeEntry(inheritedDisclosure as never))
      .toEqual({ ok: false, code: "invalid_disclosure" });
  });

  it("setNpcKnowledgeDisclosure 的 disclosure / actionId / turnNumber 只认自有属性", () => {
    // 被测字段在 own 属性上**完全缺席**，只留在原型链上：今天的裸读会把它当作已提供，
    // 于是「一份只挂在原型链上的 evidence」就足以推动一次真实的披露写入。
    const subject = {
      npcId: NPC_A, knowledge: { entries: [entryOf({ factId: FACT_1 })] }, factId: FACT_1,
      references: REFERENCES,
    };
    expect(setNpcKnowledgeDisclosure(Object.assign(Object.create({ disclosure: "secret" }), {
      ...subject, actionId: EVIDENCE.actionId, turnNumber: EVIDENCE.turnNumber,
    }) as never)).toMatchObject({ ok: false, changed: false, code: "invalid_disclosure" });
    expect(setNpcKnowledgeDisclosure(Object.assign(Object.create({ actionId: EVIDENCE.actionId }), {
      ...subject, disclosure: "secret", turnNumber: EVIDENCE.turnNumber,
    }) as never)).toMatchObject({ ok: false, changed: false, code: "invalid_action_source" });
    expect(setNpcKnowledgeDisclosure(Object.assign(Object.create({ turnNumber: EVIDENCE.turnNumber }), {
      ...subject, disclosure: "secret", actionId: EVIDENCE.actionId,
    }) as never)).toMatchObject({ ok: false, changed: false, code: "invalid_turn_number" });
  });

  it("广播请求继承来的证据被拒，继承来的缺省值不得左右写入", () => {
    const change = factChange({ audience: [NPC_A] });
    const inheritedAction = Object.assign(Object.create({ actionId: "act_7" }), { turnNumber: 3 });
    expect(knowledgeWritesFromFactChange(change, inheritedAction as never, REFERENCES))
      .toMatchObject({ ok: false, code: "invalid_action_source" });
    const inheritedTurn = Object.assign(Object.create({ turnNumber: 3 }), { actionId: "act_7" });
    expect(knowledgeWritesFromFactChange(change, inheritedTurn as never, REFERENCES))
      .toMatchObject({ ok: false, code: "invalid_turn_number" });

    // 表外值挂在原型链上时**不是**「非法 certainty」，而是「没有声明」：走自己的缺省。
    const inheritedDefaults = Object.assign(Object.create({ certainty: "absolute", disclosure: "secret" }), {
      actionId: "act_7", turnNumber: 3,
    });
    const result = knowledgeWritesFromFactChange(change, inheritedDefaults as never, REFERENCES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.writes[0]).toMatchObject({ certainty: "known", disclosure: "public" });
  });

  it("引用上下文也只在自有属性上成立", () => {
    const inheritedReferences = Object.create({ factIds: REFERENCES.factIds, npcIds: REFERENCES.npcIds });
    expect(write({ references: inheritedReferences as never }))
      .toMatchObject({ ok: false, changed: false, code: "invalid_reference_context" });
    // 半继承（只把 npcIds 挂上原型）同样整体拒绝：不存在「一半上下文可信」。
    const halfOwn = Object.assign(Object.create({ npcIds: REFERENCES.npcIds }), { factIds: REFERENCES.factIds });
    expect(write({ references: halfOwn as never }))
      .toMatchObject({ ok: false, changed: false, code: "invalid_reference_context" });
  });
});
