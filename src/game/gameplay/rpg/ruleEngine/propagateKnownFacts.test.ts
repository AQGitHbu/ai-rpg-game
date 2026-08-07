import { describe, it, expect } from "vitest";
import { propagateKnownFacts } from "./propagateKnownFacts";
import type { WorldState, NpcEntry } from "@/game/domain/worldState";
import type { FactChange } from "@/game/domain/resolvedEvent";
import { asNpcId, asLocationId, asFactId } from "@/game/domain/scenarioBlueprint";

function makeWorld(npcs: NpcEntry[]): WorldState {
  return {
    version: 2,
    generation: { generationId: "" as any, seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "剑客", stats: { hp: 100, attack: 10, defense: 5 } },
    locations: [],
    currentLocationId: asLocationId("loc_1"),
    unlockedLocationIds: [],
    visitedLocationIds: [],
    npcs,
    items: [],
    inventory: [],
    worldFacts: [],
    quests: [],
    enemies: [],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    endings: [],
    ending: null,
    factions: [],
    towns: [],
    eventLedger: [],
  };
}

function makeNpc(id: string, knownFacts: string[] = []): NpcEntry {
  return {
    id: asNpcId(id),
    name: id,
    role: "路人",
    description: "测试",
    locationId: asLocationId("loc_1"),
    isCompanion: false,
    tags: [],
    met: false,
    memory: {
      npcId: asNpcId(id),
      knownFactIds: knownFacts.map(asFactId),
      hiddenFactIds: [],
      interactionHistory: [],
      relationship: { affinity: 0 },
      emotion: "neutral",
      goals: [],
    },
  };
}

describe("propagateKnownFacts", () => {
  it("appends discovered fact to audience NPC knownFactIds", () => {
    const ws = makeWorld([makeNpc("npc_a")]);
    const changes: FactChange[] = [
      { factId: asFactId("fact_1"), change: "discovered", audience: [asNpcId("npc_a")] },
    ];
    const result = propagateKnownFacts(ws, changes);
    const npc = result.npcs.find((n) => n.id === asNpcId("npc_a"))!;
    expect(npc.memory.knownFactIds).toContain(asFactId("fact_1"));
  });

  it("does not add duplicate facts", () => {
    const ws = makeWorld([makeNpc("npc_a", ["fact_1"])]);
    const changes: FactChange[] = [
      { factId: asFactId("fact_1"), change: "discovered", audience: [asNpcId("npc_a")] },
    ];
    const result = propagateKnownFacts(ws, changes);
    const npc = result.npcs.find((n) => n.id === asNpcId("npc_a"))!;
    expect(npc.memory.knownFactIds.length).toBe(1);
  });

  it("ignores facts without audience", () => {
    const ws = makeWorld([makeNpc("npc_a")]);
    const changes: FactChange[] = [
      { factId: asFactId("fact_1"), change: "discovered" },
    ];
    const result = propagateKnownFacts(ws, changes);
    const npc = result.npcs.find((n) => n.id === asNpcId("npc_a"))!;
    expect(npc.memory.knownFactIds.length).toBe(0);
  });

  it("only appends to specified audience NPCs", () => {
    const ws = makeWorld([makeNpc("npc_a"), makeNpc("npc_b")]);
    const changes: FactChange[] = [
      { factId: asFactId("fact_1"), change: "discovered", audience: [asNpcId("npc_a")] },
    ];
    const result = propagateKnownFacts(ws, changes);
    const npcA = result.npcs.find((n) => n.id === asNpcId("npc_a"))!;
    const npcB = result.npcs.find((n) => n.id === asNpcId("npc_b"))!;
    expect(npcA.memory.knownFactIds).toContain(asFactId("fact_1"));
    expect(npcB.memory.knownFactIds.length).toBe(0);
  });

  it("returns same worldState when no changes", () => {
    const ws = makeWorld([makeNpc("npc_a")]);
    const result = propagateKnownFacts(ws, []);
    expect(result).toBe(ws);
  });
});
