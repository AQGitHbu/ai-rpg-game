import { describe, it, expect } from "vitest";
import { propagateKnownFacts } from "./propagateKnownFacts";
import {
  createInitialWorldState,
  type WorldState,
  type NpcEntry,
} from "@/game/domain/worldState";
import type { FactChange } from "@/game/domain/resolvedEvent";
import { entitiesOfKind, projectEntityStore } from "@/game/domain/entity";
import { createWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import {
  asNpcId,
  asLocationId,
  asFactId,
  asGenerationId,
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
const EVIDENCE = { actionId: "act_propagate", turnNumber: 4 } as const;

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

describe("propagateKnownFacts", () => {
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
    const result = propagateKnownFacts(ws, changes, EVIDENCE);
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
      source: { kind: "action", mode: "scene_witness", actionId: EVIDENCE.actionId, learnedAtTurn: EVIDENCE.turnNumber },
    }]);
  });

  it("已经知道该事实的 NPC 零写入，provenance 不被重铸", () => {
    const seeded = propagateKnownFacts(makeWs(), [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1")] },
    ], EVIDENCE);
    const before = entitiesOfKind(seeded.entityStore, "npc").find((record) => String(record.core.id) === "npc_1")!;
    const replayed = propagateKnownFacts(seeded, [
      { factId: asFactId("f_1"), change: "discovered", source: "public_broadcast", audience: [asNpcId("npc_1")] },
    ], { actionId: "act_other", turnNumber: 99 });
    const after = entitiesOfKind(replayed.entityStore, "npc").find((record) => String(record.core.id) === "npc_1")!;
    expect(after.knowledge).toEqual(before.knowledge);
    expect(replayed.entityStore).toBe(seeded.entityStore);
  });
});
