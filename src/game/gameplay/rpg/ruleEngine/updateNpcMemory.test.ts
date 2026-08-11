import { describe, it, expect } from "vitest";
import {
  updateNpcMemory,
  trimInteractionHistory,
  hasInteractionForAction,
  NPC_INTERACTION_HISTORY_LIMIT,
} from "./updateNpcMemory";
import type { NpcEntry, NpcInteraction } from "@/game/domain/worldState";
import { asNpcId, asLocationId } from "@/game/domain/worldEntity";

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

function makeInteraction(overrides?: Partial<NpcInteraction>): NpcInteraction {
  return {
    turnNumber: 1,
    actionId: "act_1",
    locationId: asLocationId("loc_1"),
    dialogueAct: "support",
    topicSummary: "闲谈",
    outcome: "positive",
    relationshipDelta: 5,
    learnedFactIds: [],
    summary: "首次见面，support，气氛融洽，关系+5",
    ...overrides,
  };
}

describe("updateNpcMemory", () => {
  it("appends interaction to history", () => {
    const npc = makeNpc();
    const interaction = makeInteraction();
    const updated = updateNpcMemory(npc, interaction);
    expect(updated.memory.interactionHistory.length).toBe(1);
    expect(updated.memory.interactionHistory[0]?.summary).toBe("首次见面，support，气氛融洽，关系+5");
  });

  it("updates relationship based on delta", () => {
    const npc = makeNpc();
    const updated = updateNpcMemory(npc, makeInteraction());
    expect(updated.memory.relationship.affinity).toBe(5);
  });

  it("updates emotion based on outcome", () => {
    const npc = makeNpc();
    const updated = updateNpcMemory(npc, makeInteraction({ outcome: "negative", relationshipDelta: -3 }));
    expect(updated.memory.emotion).toBe("guarded");
  });

  it("mixed outcome 不会把情绪推离中性（guarded/angry 时回落 neutral）", () => {
    const npc = makeNpc({
      memory: {
        npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
        relationship: { affinity: 0 }, emotion: "angry", goals: [],
      },
    });
    const updated = updateNpcMemory(npc, makeInteraction({ outcome: "mixed", relationshipDelta: 0 }));
    expect(updated.memory.emotion).toBe("neutral");
  });

  it("clamps relationship to [-100, 100]", () => {
    const npc = makeNpc({
      memory: {
        npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
        relationship: { affinity: 98 }, emotion: "neutral", goals: [],
      },
    });
    const updated = updateNpcMemory(npc, makeInteraction());
    expect(updated.memory.relationship.affinity).toBe(100);
  });

  it("trims history to limit (10)", () => {
    const interactions: NpcInteraction[] = Array.from({ length: 15 }, (_, i) =>
      makeInteraction({ actionId: `act_${i}`, summary: `交互${i}` }));
    const trimmed = trimInteractionHistory(interactions);
    expect(trimmed.length).toBe(NPC_INTERACTION_HISTORY_LIMIT);
    expect(trimmed[0]?.summary).toBe("交互5"); // 保留最近10条
  });

  it("同 actionId 不因错误重试追加两次（零写入）", () => {
    const npc = makeNpc();
    const first = updateNpcMemory(npc, makeInteraction({ actionId: "act_retry" }));
    const retried = updateNpcMemory(first, makeInteraction({ actionId: "act_retry" }));
    expect(retried.memory.interactionHistory.length).toBe(1);
    expect(hasInteractionForAction(retried.memory.interactionHistory, "act_retry")).toBe(true);
  });

  it("不同 actionId 正常追加", () => {
    const npc = makeNpc();
    const a = updateNpcMemory(npc, makeInteraction({ actionId: "act_1" }));
    const b = updateNpcMemory(a, makeInteraction({ actionId: "act_2" }));
    expect(b.memory.interactionHistory.length).toBe(2);
  });

  it("does not mutate original npc", () => {
    const npc = makeNpc();
    updateNpcMemory(npc, makeInteraction());
    expect(npc.memory.interactionHistory.length).toBe(0); // 原始不变
  });
});
