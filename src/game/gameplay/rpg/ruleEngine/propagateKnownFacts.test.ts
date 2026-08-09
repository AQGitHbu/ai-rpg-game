import { describe, it, expect } from "vitest";
import { propagateKnownFacts } from "./propagateKnownFacts";
import {
  createInitialWorldState,
  appendNpc,
  type WorldState,
  type NpcEntry,
} from "@/game/domain/worldState";
import type { FactChange } from "@/game/domain/resolvedEvent";
import {
  asNpcId,
  asLocationId,
  asFactId,
  asGenerationId,
  type GenerationMetadata,
} from "@/game/domain/scenarioBlueprint";

const generation: GenerationMetadata = {
  generationId: asGenerationId("g1"),
  seed: "s",
  templateVersion: "v2",
  inputDigest: "",
  gameType: "wuxia",
};

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
  let ws: WorldState = {
    ...base,
    npcs: [makeNpc("npc_1"), makeNpc("npc_2"), makeNpc("npc_3")],
    worldFacts: [
      { factId: asFactId("f_1"), text: "线索", source: "generated", discovered: false },
    ],
  };
  return { ...ws, ...overrides };
}

describe("propagateKnownFacts", () => {
  it("player_told：只传播给显式 audience，不自动传播给同地点所有 met NPC", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1")] },
    ];
    const result = propagateKnownFacts(ws, changes);
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
    const result = propagateKnownFacts(ws, changes);
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
    const result = propagateKnownFacts(ws, changes as readonly FactChange[]);
    const npc1 = result.npcs.find((n) => String(n.id) === "npc_1")!;
    expect(npc1.memory.knownFactIds.map(String)).not.toContain("f_1");
  });

  it("不存在的 factId 被拒绝（不传播）", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_missing"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1")] },
    ];
    const result = propagateKnownFacts(ws, changes);
    const npc1 = result.npcs.find((n) => String(n.id) === "npc_1")!;
    expect(npc1.memory.knownFactIds.map(String)).not.toContain("f_missing");
  });

  it("audience 中出现不在场的 NPC 被忽略（不传播）", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_ghost")] },
    ];
    const result = propagateKnownFacts(ws, changes);
    expect(result.npcs.every((n) => !n.memory.knownFactIds.map(String).includes("f_1"))).toBe(true);
  });

  it("无 audience（未指定对象）不传播给任何 NPC", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "discovered", source: "scene_witness" },
    ];
    const result = propagateKnownFacts(ws, changes);
    expect(result.npcs.every((n) => n.memory.knownFactIds.length === 0)).toBe(true);
  });

  it("knownFactIds 去重且不裁剪（多次传播同一 fact 不重复）", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1")] },
      { factId: asFactId("f_1"), change: "discovered", source: "public_broadcast", audience: [asNpcId("npc_1")] },
    ];
    const result = propagateKnownFacts(ws, changes);
    const npc1 = result.npcs.find((n) => String(n.id) === "npc_1")!;
    expect(npc1.memory.knownFactIds.filter((f) => String(f) === "f_1").length).toBe(1);
  });

  it("同 ledger replay 得到相同知识分布（纯函数）", () => {
    const ws = makeWs();
    const changes: readonly FactChange[] = [
      { factId: asFactId("f_1"), change: "discovered", source: "player_told", audience: [asNpcId("npc_1"), asNpcId("npc_2")] },
    ];
    const a = propagateKnownFacts(ws, changes);
    const b = propagateKnownFacts(ws, changes);
    expect(a.npcs).toEqual(b.npcs);
  });
});
