import { describe, it, expect } from "vitest";
import { asEventId, asTurnId } from "@/game/domain/events";
import { propagateKnownFacts, propagateKnownFactsWithDrafts } from "./propagateKnownFacts";
import {
  createInitialWorldState,
  type WorldState,
  type NpcEntry,
} from "@/game/domain/worldState";
import type { FactChange, FactChangeSource } from "@/game/domain/resolvedEvent";
import {
  entitiesOfKind,
  projectEntityStore,
  type EntityLifecycle,
  type EntityRecord,
  type NpcEntityRecord,
} from "@/game/domain/entity";
import {
  applyEntityMutations,
  knowledgeReferences,
  type EntityMutation,
} from "@/game/gameplay/rpg/entityWorld";
import { createWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import {
  asNpcId,
  asLocationId,
  asFactId,
  asGenerationId,
  type FactId,
  type GenerationMetadata,
} from "@/game/domain/worldEntity";

const generation: GenerationMetadata = {
  generationId: asGenerationId("g1"),
  seed: "s",
  templateVersion: "v2",
  inputDigest: "",
  gameType: "wuxia",
};

/** 知识写入必须挂在一次真实行动上：测试固定这份证据。 */
const EVIDENCE = { actionId: "act_propagate", turnNumber: 4, eventId: asEventId("evt:propagate:4") } as const;

function makeNpc(id: string, locationId = "loc_1", met = true): NpcEntry {
  return {
    id: asNpcId(id),
    name: `NPC${id}`,
    role: "路人",
    description: "",
    locationId: asLocationId(locationId),
    isCompanion: false,
    tags: [],
    met,
    memory: {
      npcId: asNpcId(id),
      knownFactIds: [],
      hiddenFactIds: [],
      interactionHistory: [],
      relationship: { affinity: 0 },
      emotion: "neutral",
      goals: [],
    },
  };
}

function makeWs(overrides?: Partial<WorldState>): WorldState {
  const base = createInitialWorldState({
    generation,
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
  const ws = createWorldStateFixture({
    generation: base.generation,
    projection: {
      ...projectEntityStore(base.entityStore),
    npcs: [makeNpc("npc_1"), makeNpc("npc_2"), makeNpc("npc_3")],
    worldFacts: [
      { factId: asFactId("f_1"), text: "线索", source: "generated", discovered: false },
    ],
    },
    battle: base.battle,
    endings: base.endings,
    ending: base.ending,
    eventLedger: base.eventLedger,
  });
  if (overrides === undefined) return ws;
  return createWorldStateFixture({
    generation: ws.generation,
    projection: { ...projectEntityStore(ws.entityStore), ...overrides },
    battle: overrides.battle ?? ws.battle,
    endings: overrides.endings ?? ws.endings,
    ending: overrides.ending ?? ws.ending,
    eventLedger: overrides.eventLedger ?? ws.eventLedger,
  });
}

/** 夹具批次：成功即返回 WorldState，失败把结构化结果原样抛出，免得用例里静默拿到 undefined。 */
function okApply(ws: WorldState, mutations: readonly EntityMutation[]): WorldState {
  const applied = applyEntityMutations(ws, mutations);
  if (!applied.ok) throw new Error(`夹具批次被拒：${applied.code}/${applied.entityId ?? "-"}`);
  return applied.worldState;
}

/** 引用上下文只认 canonical Fact Entity，所以「在 worldFacts 里但不是活跃实体」必须自己造出来。 */
function factEntityRecord(id: FactId, lifecycle: EntityLifecycle = "active"): EntityRecord {
  return {
    core: { id, kind: "fact", name: `fact:${id}`, createdAtTurn: 0, lifecycle },
    fact: { text: "古井下有密道", source: "generated", discovered: false },
  };
}

/** 组件级断言一律读 record：兼容 memory 是投影出来的读模型，不是写入面。 */
function npcRecord(ws: WorldState, npcId: string) {
  const record = entitiesOfKind(ws.entityStore, "npc").find((candidate) => String(candidate.core.id) === npcId);
  if (record === undefined) throw new Error(`夹具缺 NPC：${npcId}`);
  return record;
}

describe("propagateKnownFacts", () => {
  it("returns a matching knowledge event draft for every newly written entry", () => {
    const result = propagateKnownFactsWithDrafts(makeWs(), [{
      factId: asFactId("f_1"),
      change: "discovered",
      source: "player_told",
      audience: [asNpcId("npc_1")],
    }], {
      ...EVIDENCE,
      turnId: asTurnId("turn:knowledge"),
    });

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.eventKey).toBe("npc_knowledge_changed:npc_1:f_1:act_propagate");
    expect(result.drafts[0]?.payload).toEqual({
      type: "npc_knowledge_changed",
      npcId: asNpcId("npc_1"),
      factId: asFactId("f_1"),
      change: "learned",
    });
    expect(result.worldState.entityStore.records.find((record) => record.core.id === asNpcId("npc_1"))?.core.kind)
      .toBe("npc");
  });

  it("player_told：只传播给显式 audience，不自动传播给同地点所有 met NPC", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1")] },
    ];
    const result = propagateKnownFacts(ws, changes, EVIDENCE);
    const npc1 = result.npcs.find((n) => String(n.id) === "npc_1")!;
    const npc2 = result.npcs.find((n) => String(n.id) === "npc_2")!;
    expect(npc1.memory.knownFactIds.map(String)).toContain("f_1");
    expect(npc2.memory.knownFactIds.map(String)).not.toContain("f_1");
  });

  it("npc_revealed：不自动传播给其他已 met NPC", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "revealed", source: "npc_revealed", audience: [asNpcId("npc_1")] },
    ];
    // 输入侧补说话人：npc_revealed 在规则层必须有一位透露者（npcKnowledge 的 mode 策略表）。
    // npc_2 就是那位透露者，于是本例同时钉住「说话人不因透露而自动知道」。
    const result = propagateKnownFacts(ws, changes, { ...EVIDENCE, speakerNpcId: asNpcId("npc_2") });
    const npc1 = result.npcs.find((n) => String(n.id) === "npc_1")!;
    const npc2 = result.npcs.find((n) => String(n.id) === "npc_2")!;
    expect(npc1.memory.knownFactIds.map(String)).toContain("f_1");
    expect(npc2.memory.knownFactIds.map(String)).not.toContain("f_1");
  });

  it("非法 source 被拒绝（不传播）", () => {
    const ws = makeWs();
    const changes = [
      { factId: asFactId("f_1"), change: "discovered", source: "everyone_auto" as never, audience: [asNpcId("npc_1")] },
    ];
    const result = propagateKnownFacts(ws, changes as readonly FactChange[], EVIDENCE);
    const npc1 = result.npcs.find((n) => String(n.id) === "npc_1")!;
    expect(npc1.memory.knownFactIds.map(String)).not.toContain("f_1");
    // 非法来源连组件层都不留痕：不存在「先写再过滤」。
    const record1 = entitiesOfKind(result.entityStore, "npc").find((record) => String(record.core.id) === "npc_1")!;
    expect(record1.knowledge.entries).toEqual([]);
  });

  it("不存在的 factId 被拒绝（不传播）", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_missing"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1")] },
    ];
    const result = propagateKnownFacts(ws, changes, EVIDENCE);
    const npc1 = result.npcs.find((n) => String(n.id) === "npc_1")!;
    expect(npc1.memory.knownFactIds.map(String)).not.toContain("f_missing");
  });

  it("audience 中出现不在场的 NPC 被忽略（不传播）", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_ghost")] },
    ];
    const result = propagateKnownFacts(ws, changes, EVIDENCE);
    expect(result.npcs.every((n) => !n.memory.knownFactIds.map(String).includes("f_1"))).toBe(true);
  });

  it("无 audience（未指定对象）不传播给任何 NPC", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "discovered", source: "scene_witness" },
    ];
    const result = propagateKnownFacts(ws, changes, EVIDENCE);
    expect(result.npcs.every((n) => n.memory.knownFactIds.length === 0)).toBe(true);
  });

  it("knownFactIds 去重且不裁剪（多次传播同一 fact 不重复）", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1")] },
      { factId: asFactId("f_1"), change: "discovered", source: "public_broadcast", audience: [asNpcId("npc_1")] },
    ];
    const result = propagateKnownFacts(ws, changes, EVIDENCE);
    const npc1 = result.npcs.find((n) => String(n.id) === "npc_1")!;
    expect(npc1.memory.knownFactIds.filter((f) => String(f) === "f_1").length).toBe(1);
  });

  it("同 ledger replay 得到相同知识分布（纯函数）", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1"), asNpcId("npc_2")] },
    ];
    const a = propagateKnownFacts(ws, changes, EVIDENCE);
    const b = propagateKnownFacts(ws, changes, EVIDENCE);
    expect(a.npcs).toEqual(b.npcs);
  });

  it("传播出的知识条目带着本轮真实 provenance", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "discovered", source: "scene_witness", audience: [asNpcId("npc_1")] },
    ];
    const result = propagateKnownFacts(ws, changes, EVIDENCE);
    const record1 = entitiesOfKind(result.entityStore, "npc").find((record) => String(record.core.id) === "npc_1")!;
    expect(record1.knowledge.entries).toEqual([{
      factId: asFactId("f_1"),
      certainty: "known",
      disclosure: "public",
      source: { kind: "action", mode: "scene_witness", actionId: EVIDENCE.actionId, learnedAtTurn: EVIDENCE.turnNumber , eventId: EVIDENCE.eventId },
    }]);
  });

  it("已经知道该事实的 NPC 重放后没有任何 record 被重建，provenance 不被重铸", () => {
    const seeded = propagateKnownFacts(makeWs(), [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1")] },
    ], EVIDENCE);
    const before = entitiesOfKind(seeded.entityStore, "npc").find((record) => String(record.core.id) === "npc_1")!;
    const replayed = propagateKnownFacts(seeded, [
      { factId: asFactId("f_1"), change: "discovered", source: "public_broadcast", audience: [asNpcId("npc_1")] },
    ], { actionId: "act_other", turnNumber: 99, eventId: asEventId("evt:other:99") });
    const after = entitiesOfKind(replayed.entityStore, "npc").find((record) => String(record.core.id) === "npc_1")!;
    expect(after.knowledge).toEqual(before.knowledge);
    // 改线后重放不再走「零 mutation 早退」：写入照样提交，只是被权威幂等掉。
    // applyEntityMutations 对任何非空批次都会换一层 store 包装（createEntityStore 复制 records 数组），
    // 所以「确实什么都没写」的见证只能是逐条 record 与知识组件的引用同一性，而不是 store 对象本身。
    expect(replayed.entityStore.records).toHaveLength(seeded.entityStore.records.length);
    seeded.entityStore.records.forEach((record, index) => {
      expect(replayed.entityStore.records[index]).toBe(record);
    });
    expect(after.knowledge).toBe(before.knowledge);
  });

  it("事实存在性只认 canonical Fact Entity：worldFacts 列着但未活跃 ⇒ 零写入且不抛", () => {
    // 会因何生产改动而失败：一旦存在性判定回到 ws.worldFacts（改线前就是），本例会写出条目或直接抛。
    const withOrphan = okApply(makeWs(), [{
      kind: "create_entities",
      records: [factEntityRecord(asFactId("f_orphan"), "inactive")],
    }]);
    // 前置条件本身要先钉住：兼容数组逐条投影、完全不看 lifecycle。
    expect(withOrphan.worldFacts.some((fact) => String(fact.factId) === "f_orphan")).toBe(true);
    expect(knowledgeReferences(withOrphan.entityStore.records).factIds.has("f_orphan")).toBe(false);

    const changes: readonly FactChange[] = [
      { factId: asFactId("f_orphan"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1")] },
    ];
    expect(() => propagateKnownFacts(withOrphan, changes, EVIDENCE)).not.toThrow();
    const result = propagateKnownFacts(withOrphan, changes, EVIDENCE);
    // 零写入的唯一证据是「原样带回调用方那个对象」。
    expect(result).toBe(withOrphan);
    expect(npcRecord(result, "npc_1").knowledge.entries).toEqual([]);
  });

  it("非活跃 NPC 被跳过而非写死：同一 audience 里的活跃 NPC 照常学到", () => {
    // 会因何生产改动而失败：一旦 NPC 存在性又退回 entitiesOfKind（它不看 lifecycle），
    // 本例就会把知识写进已停用的 record；一旦改成「整批拒绝」，本例会直接抛。
    const withInactive = okApply(makeWs(), [{
      kind: "set_npc_lifecycle", npcId: asNpcId("npc_2"), lifecycle: "inactive",
    }]);
    // 前置条件：兼容投影仍列着这条已停用的 NPC——它不是「不存在」，而是「不可写入」。
    expect(entitiesOfKind(withInactive.entityStore, "npc").some((record) => String(record.core.id) === "npc_2")).toBe(true);
    expect(knowledgeReferences(withInactive.entityStore.records).npcIds.has("npc_2")).toBe(false);

    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_2"), asNpcId("npc_1")] },
    ];
    expect(() => propagateKnownFacts(withInactive, changes, EVIDENCE)).not.toThrow();
    const result = propagateKnownFacts(withInactive, changes, EVIDENCE);
    expect(npcRecord(result, "npc_2").knowledge.entries).toEqual([]);
    expect(npcRecord(result, "npc_1").knowledge.entries.map((entry) => String(entry.factId))).toEqual(["f_1"]);
  });

  it("npc_revealed：说话人只进 provenance，绝不因透露而自动知道", () => {
    // 会因何生产改动而失败：省略 speaker 会让 provenance 变成「没有来源 NPC 的 npc_revealed」；
    // 反过来把说话人顺手塞进 audience，则 npc_3 那半断言立刻红。
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "revealed", source: "npc_revealed", audience: [asNpcId("npc_1"), asNpcId("npc_2")] },
    ];
    const result = propagateKnownFacts(ws, changes, { ...EVIDENCE, speakerNpcId: asNpcId("npc_3") });
    for (const listenerId of ["npc_1", "npc_2"]) {
      const entries = npcRecord(result, listenerId).knowledge.entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]?.source).toEqual({
        kind: "action", mode: "npc_revealed", actionId: EVIDENCE.actionId,
        learnedAtTurn: EVIDENCE.turnNumber, sourceNpcId: asNpcId("npc_3"),
        eventId: EVIDENCE.eventId,
      });
    }
    expect(npcRecord(result, "npc_3").knowledge.entries).toEqual([]);
  });

  it("npc_revealed 缺说话人：整条 change 零写入且不抛", () => {
    // 会因何生产改动而失败：过渡桥改线前就在写这条（同文件「npc_revealed：不自动传播给其他
    // 已 met NPC」那条可证）；一旦本层重新自己判「没有说话人也行」，
    // 就会写出一条来源里查不到透露者的 entry。
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "revealed", source: "npc_revealed", audience: [asNpcId("npc_1")] },
    ];
    const result = propagateKnownFacts(ws, changes, EVIDENCE);
    expect(result).toBe(ws);
    expect(npcRecord(result, "npc_1").knowledge.entries).toEqual([]);
  });

  it("幽灵说话人：连同本条 change 的合法听众一起零写入（全有或全无，不在本地软化）", () => {
    // 会因何生产改动而失败：只要传播层敢把说话人非法的 change 拆成「只写合法听众」，
    // 就等于在规则层之外立第二条说话人策略，npc_1 那半断言会红。
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "revealed", source: "npc_revealed", audience: [asNpcId("npc_1")] },
    ];
    const result = propagateKnownFacts(ws, changes, { ...EVIDENCE, speakerNpcId: asNpcId("npc_ghost") });
    expect(result).toBe(ws);
    expect(npcRecord(result, "npc_1").knowledge.entries).toEqual([]);
  });

  it("窄通道写入：一次传播只替换 knowledge，其余组件按引用原样", () => {
    // 会因何生产改动而失败：回到整体 NPC 组件替换路径就会把四层一起重建。
    // 值级断言看不出来（重建出来的值本就相同），只有引用同一性才是过渡桥已摘掉的见证。
    const ws = makeWs();
    const before = npcRecord(ws, "npc_1");
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1")] },
    ];
    const result = propagateKnownFacts(ws, changes, EVIDENCE);
    const after = npcRecord(result, "npc_1");
    expect(after.knowledge).not.toBe(before.knowledge);
    expect(after.knowledge.entries).toHaveLength(1);
    expect(after.dynamicState).toBe(before.dynamicState);
    expect(after.history).toBe(before.history);
    expect(after.relationships).toBe(before.relationships);
    expect(after.identity).toBe(before.identity);
    expect(after.position).toBe(before.position);
  });

  it("去重来自权威的幂等：两种 mode 只留第一次到达的来源，重放不重建任何 record", () => {
    // 会因何生产改动而失败：「后到者覆盖」会让 entries[0].source.mode 变成 public_broadcast；
    // 「本地把已知道的预筛掉」会让重放不再提交批次，下面那句 not.toBe 立刻红。
    // 反过来要说清边界：一个纯本地 first-wins 的 Set 在**值上**与权威幂等不可分辨，所以本例钉的
    // 是「本层不再预筛、批次照样提交」，去重这件事由 writeNpcKnowledge 的 changed:false 独自承担。
    const pair = (source: FactChangeSource): FactChange => ({
      factId: asFactId("f_1"), change: "discovered", source, audience: [asNpcId("npc_1")],
    });
    const seeded = propagateKnownFacts(makeWs(), [pair("player_told"), pair("public_broadcast")], EVIDENCE);
    const entries = npcRecord(seeded, "npc_1").knowledge.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toEqual({
      kind: "action", mode: "player_told", actionId: EVIDENCE.actionId, learnedAtTurn: EVIDENCE.turnNumber,
      eventId: EVIDENCE.eventId,
    });
    // 整次调用重放：两条写入都落到同一条已有 entry 上，权威返回 changed:false，
    // 于是没有任何一条 record 被重建（applyEntityMutations 必然换一个新的 store 包装对象，
    // 但 record 与组件的引用才是「确实没写进去」的见证）。
    const replayed = propagateKnownFacts(seeded, [pair("player_told"), pair("public_broadcast")], { actionId: "act_other", turnNumber: 99, eventId: asEventId("evt:other:99b") });
    // 本例真正的分岔点：重放照样提交了一次批次（所以拿到的不是同一个 WorldState 对象），
    // 却没有任何一条 record 被重建。改线前的兼容过滤器会在这里直接把写入预筛掉，两者才分得开。
    expect(replayed).not.toBe(seeded);
    expect(replayed.entityStore.records).toHaveLength(seeded.entityStore.records.length);
    seeded.entityStore.records.forEach((record, index) => {
      expect(replayed.entityStore.records[index]).toBe(record);
    });
    expect(npcRecord(replayed, "npc_1").knowledge).toBe(npcRecord(seeded, "npc_1").knowledge);
  });

  it("suspected 被传播升级为 known，source 逐字不动（R5-4b 行为变化）", () => {
    // 会因何生产改动而失败：兼容 memory.knownFactIds 是「所有」entry（含 suspected），
    // 改线前那份过滤器就靠它把这条写入整个拦掉——过滤器一回来，certainty 就还是 suspected。
    // 生产不可达：唯一的 FactChange 生产者不带 audience（resolveByType.ts:280-282），
    // 所以本变化今天不改变任何已发布行为。
    const seeded = okApply(makeWs(), [{
      kind: "record_npc_knowledge", npcId: asNpcId("npc_1"), factId: asFactId("f_1"),
      certainty: "suspected", disclosure: "public",
      source: { kind: "action", mode: "player_told", actionId: "act_seed", turnNumber: 2 , eventId: asEventId("evt:seed:2") },
    }]);
    const seededEntry = npcRecord(seeded, "npc_1").knowledge.entries[0]!;
    expect(seededEntry.certainty).toBe("suspected");
    const result = propagateKnownFacts(seeded, [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1")] },
    ], { actionId: "act_told_again", turnNumber: 7, eventId: asEventId("evt:told_again:7") });
    const entry = npcRecord(result, "npc_1").knowledge.entries[0]!;
    expect(entry.certainty).toBe("known");
    // 首次来源是历史：升级只改 certainty，连 source 对象都是同一个引用。
    expect(entry.source).toBe(seededEntry.source);
  });

  it("secret 条目不因传播被降级，而同一批的其他听众照常学到（R5-4b 关掉 4A 分叉）", () => {
    // 会因何生产改动而失败：domain 那份拷贝能在事实离开 hiddenFactIds 时顺手降级 disclosure；
    // 传播层一旦自己去「对齐」披露（走 set_npc_knowledge_disclosure），secret 那半断言就红。
    // npc_2 那半负责排除假绿：本批确实写进了权威，只是动不了既有条目的披露。
    // 生产不可达：唯一的 FactChange 生产者不带 audience（resolveByType.ts:280-282），
    // 所以本变化今天不改变任何已发布行为。
    const seeded = okApply(makeWs(), [{
      kind: "record_npc_knowledge", npcId: asNpcId("npc_1"), factId: asFactId("f_1"),
      certainty: "known", disclosure: "secret",
      source: { kind: "action", mode: "player_told", actionId: "act_seed", turnNumber: 2 , eventId: asEventId("evt:seed:2") },
    }]);
    const seededEntry = npcRecord(seeded, "npc_1").knowledge.entries[0]!;
    const result = propagateKnownFacts(seeded, [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1"), asNpcId("npc_2")] },
    ], EVIDENCE);
    const entry = npcRecord(result, "npc_1").knowledge.entries[0]!;
    expect(entry.disclosure).toBe("secret");
    expect(entry.source).toBe(seededEntry.source);
    expect(npcRecord(result, "npc_2").knowledge.entries.map((current) => String(current.factId))).toEqual(["f_1"]);
  });

  it("好坏引用混排：结果只依赖输入，坏引用不拦后面的合法 change", () => {
    // 会因何生产改动而失败：把「整条 change 被拒」写成中断整轮传播（return/break），
    // npc_2 与 npc_3 就都学不到；把 skipped 当致命错误则本例直接抛。
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_missing"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1")] },
      { factId: asFactId("f_1"), change: "discovered", source: "scene_witness", audience: [asNpcId("npc_ghost"), asNpcId("npc_3")] },
      { factId: asFactId("f_1"), change: "hidden", source: "public_broadcast", audience: [asNpcId("npc_2")] },
      { factId: asFactId("f_1"), change: "discovered", source: "faction_shared", audience: [asNpcId("npc_2"), asNpcId("npc_3")] },
    ];
    const a = propagateKnownFacts(ws, changes, EVIDENCE);
    const b = propagateKnownFacts(ws, changes, EVIDENCE);
    expect(a.entityStore.records).toEqual(b.entityStore.records);
    expect(npcRecord(a, "npc_1").knowledge.entries).toEqual([]);
    expect(sourceModes(npcRecord(a, "npc_2"))).toEqual(["faction_shared"]);
    // 同一 NPC 同一 Fact：第一次到达的来源才是历史，后面的 mode 只能被幂等掉。
    expect(sourceModes(npcRecord(a, "npc_3"))).toEqual(["scene_witness"]);
  });
});

/** entry 的 provenance mode：initial_world 一支在传播里永不出现，这里只为读得类型安全。 */
function sourceModes(record: NpcEntityRecord): readonly string[] {
  return record.knowledge.entries.map((entry) => (entry.source.kind === "action" ? entry.source.mode : entry.source.kind));
}
