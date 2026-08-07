import { describe, it, expect } from "vitest";
import {
  updateNpcMemory,
  appendInteraction,
  trimInteractionHistory,
  NPC_INTERACTION_HISTORY_LIMIT,
} from "./updateNpcMemory";
import type { NpcEntry, NpcInteraction } from "@/game/domain/worldState";
import { asNpcId, asLocationId } from "@/game/domain/scenarioBlueprint";

function makeNpc(overrides?: Partial<NpcEntry>): NpcEntry {
  return {
    id: asNpcId("npc_1"),
    name: "测试NPC",
    role: "路人",
    description: "测试",
    locationId: asLocationId("loc_1"),
    isCompanion: false,
    tags: [],
    met: false,
    memory: {
      npcId: asNpcId("npc_1"),
      knownFactIds: [],
      hiddenFactIds: [],
      interactionHistory: [],
      relationship: { affinity: 0 },
      emotion: "neutral",
      goals: [],
    },
    ...overrides,
  };
}

describe("updateNpcMemory", () => {
  it("appends interaction to history", () => {
    const npc = makeNpc();
    const interaction: NpcInteraction = {
      turn: 1,
      locationId: asLocationId("loc_1"),
      actionType: "talk",
      outcome: "positive",
      relationshipDelta: 5,
      summary: "首次见面，好感+5",
    };
    const updated = updateNpcMemory(npc, interaction);
    expect(updated.memory.interactionHistory.length).toBe(1);
    expect(updated.memory.interactionHistory[0]?.summary).toBe("首次见面，好感+5");
  });

  it("updates relationship based on delta", () => {
    const npc = makeNpc();
    const interaction: NpcInteraction = {
      turn: 1,
      locationId: asLocationId("loc_1"),
      actionType: "talk",
      outcome: "positive",
      relationshipDelta: 5,
      summary: "首次见面",
    };
    const updated = updateNpcMemory(npc, interaction);
    expect(updated.memory.relationship.affinity).toBe(5);
  });

  it("updates emotion based on outcome", () => {
    const npc = makeNpc();
    const interaction: NpcInteraction = {
      turn: 1,
      locationId: asLocationId("loc_1"),
      actionType: "talk",
      outcome: "negative",
      relationshipDelta: -3,
      summary: "不愉快",
    };
    const updated = updateNpcMemory(npc, interaction);
    expect(updated.memory.emotion).toBe("guarded");
  });

  it("clamps relationship to [-100, 100]", () => {
    const npc = makeNpc({
      memory: {
        npcId: asNpcId("npc_1"),
        knownFactIds: [],
        hiddenFactIds: [],
        interactionHistory: [],
        relationship: { affinity: 98 },
        emotion: "neutral",
        goals: [],
      },
    });
    const interaction: NpcInteraction = {
      turn: 1,
      locationId: asLocationId("loc_1"),
      actionType: "talk",
      outcome: "positive",
      relationshipDelta: 5,
      summary: "好感已满",
    };
    const updated = updateNpcMemory(npc, interaction);
    expect(updated.memory.relationship.affinity).toBe(100);
  });

  it("trims history to limit (10)", () => {
    const interactions: NpcInteraction[] = Array.from({ length: 15 }, (_, i) => ({
      turn: i,
      locationId: asLocationId("loc_1"),
      actionType: "talk",
      outcome: "neutral" as const,
      relationshipDelta: 0,
      summary: `交互${i}`,
    }));
    const trimmed = trimInteractionHistory(interactions);
    expect(trimmed.length).toBe(NPC_INTERACTION_HISTORY_LIMIT);
    expect(trimmed[0]?.summary).toBe("交互5"); // 保留最近10条
  });

  it("does not mutate original npc", () => {
    const npc = makeNpc();
    const interaction: NpcInteraction = {
      turn: 1,
      locationId: asLocationId("loc_1"),
      actionType: "talk",
      outcome: "positive",
      relationshipDelta: 5,
      summary: "测试",
    };
    updateNpcMemory(npc, interaction);
    expect(npc.memory.interactionHistory.length).toBe(0); // 原始不变
  });
});
