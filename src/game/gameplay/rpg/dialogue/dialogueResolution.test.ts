import { describe, it, expect } from "vitest";
import { resolveDialogue } from "./dialogueResolution";
import type { WorldState, NpcEntry } from "@/game/domain/worldState";
import { createInitialWorldState } from "@/game/domain/worldState";
import { asNpcId, asLocationId, asFactId, asGenerationId, asQuestId } from "@/game/domain/worldEntity";
import type { TalkAction } from "@/game/domain/action";

const FACT_KNOWN = asFactId("fact_known");
const FACT_UNKNOWN = asFactId("fact_unknown");

function makeWs(): WorldState {
  const loc = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main" as const,
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  return createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc,
    startingItemIds: [],
  });
}

function makeNpc(overrides?: Partial<NpcEntry>): NpcEntry {
  return {
    id: asNpcId("npc_1"),
    name: "老板",
    role: "路人",
    description: "测试",
    locationId: asLocationId("loc_1"),
    isCompanion: false,
    tags: [],
    met: false,
    memory: {
      npcId: asNpcId("npc_1"),
      knownFactIds: [FACT_KNOWN],
      hiddenFactIds: [],
      interactionHistory: [],
      relationship: { affinity: 0 },
      emotion: "neutral",
      goals: [],
    },
    ...overrides,
  };
}

function talkOf(action: {
  act: TalkAction["dialogueAct"];
  topic?: TalkAction["topic"];
  utterance?: string;
}): TalkAction {
  return { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: action.act, topic: action.topic, utterance: action.utterance };
}

const deps = { now: () => "2026-01-01", actionId: "act_1", turnNumber: 7 };

describe("resolveDialogue — 行为语义", () => {
  it("首次 ask 与重复 ask 的关系变化不同", () => {
    const npc = makeNpc();
    const first = resolveDialogue(makeWs(), npc, talkOf({ act: "ask" }), deps);
    const repeat = resolveDialogue(makeWs(), first.npcAfter, talkOf({ act: "ask" }), deps);
    expect(first.relationshipDelta).not.toBe(repeat.relationshipDelta);
    expect(repeat.relationshipDelta).toBeLessThan(first.relationshipDelta);
    expect(repeat.interaction.summary).not.toBe(first.interaction.summary);
  });

  it("同一固定选择重复点击不重复获得首次见面奖励", () => {
    const npc = makeNpc();
    const first = resolveDialogue(makeWs(), npc, talkOf({ act: "ask" }), deps);
    expect(first.relationshipDelta).toBe(6); // GREET_FIRST_MEET(5) + ask(1)
    const repeated = resolveDialogue(makeWs(), first.npcAfter, talkOf({ act: "ask" }), deps);
    expect(repeated.relationshipDelta).toBe(1); // 仅 ask(1)，无首次奖励
    expect(first.npcAfter.memory.interactionHistory).toHaveLength(1);
  });

  it("support/challenge/threaten 对同一 NPC 产生不同结构化结果", () => {
    const npc = makeNpc({ met: true });
    const support = resolveDialogue(makeWs(), npc, talkOf({ act: "support" }), deps);
    const challenge = resolveDialogue(makeWs(), npc, talkOf({ act: "challenge" }), deps);
    const threaten = resolveDialogue(makeWs(), npc, talkOf({ act: "threaten" }), deps);

    expect(new Set([support.relationshipDelta, challenge.relationshipDelta, threaten.relationshipDelta]).size).toBe(3);
    expect(support.relationshipDelta).toBeGreaterThan(0);
    expect(challenge.relationshipDelta).toBeLessThan(0);
    expect(threaten.relationshipDelta).toBeLessThan(challenge.relationshipDelta);
    expect(support.outcome).toBe("positive");
    expect(challenge.outcome).toBe("negative");
    expect(threaten.outcome).toBe("negative");
  });

  it("hostile/trusted 档位影响 willingness 与关系变化", () => {
    const trusted = makeNpc({
      met: true,
      memory: {
        npcId: asNpcId("npc_1"), knownFactIds: [FACT_KNOWN], hiddenFactIds: [],
        interactionHistory: [], relationship: { affinity: 80 }, emotion: "neutral", goals: [],
      },
    });
    const hostile = makeNpc({
      met: true,
      memory: {
        npcId: asNpcId("npc_1"), knownFactIds: [FACT_KNOWN], hiddenFactIds: [],
        interactionHistory: [], relationship: { affinity: -70 }, emotion: "neutral", goals: [],
      },
    });
    const trustedRes = resolveDialogue(makeWs(), trusted, talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_KNOWN } }), deps);
    const hostileRes = resolveDialogue(makeWs(), hostile, talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_KNOWN } }), deps);
    expect(trustedRes.disclosure.kind).toBe("revealed");
    expect(hostileRes.disclosure.kind).toBe("withheld");
    expect(trustedRes.relationshipDelta).toBeGreaterThan(hostileRes.relationshipDelta);
    expect(hostileRes.status).toBe("partial_success");
  });

  it("NPC 不知道 topic fact 时不能直接透露（含最大威压）", () => {
    const npc = makeNpc({
      met: true,
      memory: {
        npcId: asNpcId("npc_1"), knownFactIds: [FACT_KNOWN], hiddenFactIds: [],
        interactionHistory: [], relationship: { affinity: 90 }, emotion: "neutral", goals: [],
      },
    });
    const asked = resolveDialogue(makeWs(), npc, talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_UNKNOWN } }), deps);
    const threatened = resolveDialogue(makeWs(), npc, talkOf({ act: "threaten", topic: { kind: "fact", factId: FACT_UNKNOWN } }), deps);
    expect(asked.disclosure.kind).toBe("withheld");
    expect(threatened.disclosure.kind).toBe("withheld");
    expect(asked.npcAfter.memory.knownFactIds).not.toContain(FACT_UNKNOWN);
  });

  it("对敌意 NPC 威胁 → failure；敌意 NPC 交谈 → partial_success", () => {
    const hostile = makeNpc({
      met: true,
      memory: {
        npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [],
        interactionHistory: [], relationship: { affinity: -70 }, emotion: "angry", goals: [],
      },
    });
    const threatened = resolveDialogue(makeWs(), hostile, talkOf({ act: "threaten" }), deps);
    expect(threatened.status).toBe("failure");
    const asked = resolveDialogue(makeWs(), hostile, talkOf({ act: "ask" }), deps);
    expect(asked.status).toBe("partial_success");
  });

  it("utterance 不参与规则：不同 utterance 产出完全相同的结构化结果", () => {
    const npc = makeNpc({ met: true });
    const a = resolveDialogue(makeWs(), npc, talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_KNOWN }, utterance: "你知道什么吗？" }), deps);
    const b = resolveDialogue(makeWs(), npc, talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_KNOWN }, utterance: "快告诉我！" }), deps);
    expect(a.relationshipDelta).toBe(b.relationshipDelta);
    expect(a.disclosure).toEqual(b.disclosure);
    expect(a.interaction).toEqual(b.interaction);
    expect(a.status).toBe(b.status);
  });

  it("规则生成稳定 NpcInteraction 摘要（确定性、不含原文）", () => {
    const npc = makeNpc();
    const r1 = resolveDialogue(makeWs(), npc, talkOf({ act: "support", utterance: "说的在理" }), deps);
    const r2 = resolveDialogue(makeWs(), npc, talkOf({ act: "support", utterance: "说的在理" }), deps);
    expect(r2.interaction).toEqual(r1.interaction);
    expect(r1.interaction.dialogueAct).toBe("support");
    expect(r1.interaction.turnNumber).toBe(7);
    expect(r1.interaction.actionId).toBe("act_1");
    expect(r1.interaction.locationId).toBe(asLocationId("loc_1"));
    expect(r1.interaction.topicSummary).toBe("闲谈");
    expect(r1.interaction.learnedFactIds).toEqual([]);
    expect(r1.interaction.outcome).toBe("positive");
    expect(r1.interaction.relationshipDelta).toBe(r1.relationshipDelta);
    expect(r1.interaction.summary).toContain("首次见面");
    expect(r1.interaction.summary).not.toContain("说的在理");
    const repeated = resolveDialogue(makeWs(), r1.npcAfter, talkOf({ act: "support" }), deps);
    expect(repeated.interaction.summary).toContain("再次交谈");
  });

  it("NPC 披露 fact 时 learnedFactIds 记录该 fact，且同 actionId 不重复追加", () => {
    const npc = makeNpc({ met: true });
    const res = resolveDialogue(makeWs(), npc, talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_KNOWN } }), deps);
    expect(res.disclosure.kind).toBe("revealed");
    expect(res.interaction.learnedFactIds).toContain(FACT_KNOWN);
    expect(res.npcAfter.memory.interactionHistory).toHaveLength(1);
    // 同 actionId 重试：CAS 失败路径零写入
    const retry = resolveDialogue(makeWs(), res.npcAfter, talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_KNOWN } }), deps);
    expect(retry.npcAfter.memory.interactionHistory).toHaveLength(1);
  });

  it("support/challenge/threaten/freeform 产生稳定不同的 topicSummary/summary 语义", () => {
    const npc = makeNpc({ met: true });
    const support = resolveDialogue(makeWs(), npc, talkOf({ act: "support" }), deps);
    const threaten = resolveDialogue(makeWs(), npc, talkOf({ act: "threaten" }), deps);
    expect(support.interaction.summary).toContain("support");
    expect(threaten.interaction.summary).toContain("threaten");
    expect(support.interaction.summary).not.toBe(threaten.interaction.summary);
  });

  it("NPC 披露已知 topic fact 时返回结构化 disclosure", () => {
    const npc = makeNpc({ met: true });
    const res = resolveDialogue(makeWs(), npc, talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_KNOWN } }), deps);
    expect(res.disclosure).toEqual({ kind: "revealed", factId: FACT_KNOWN });
  });

  it("结构化 topic 持久化进 NpcInteraction（fact/quest/thread/general 与规则裁决同源）", () => {
    const npc = makeNpc({ met: true });
    const fact = resolveDialogue(makeWs(), npc, talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_KNOWN } }), deps);
    expect(fact.interaction.topic).toEqual({ kind: "fact", factId: FACT_KNOWN });
    expect(fact.interaction.topicSummary).toBe("询问线索");

    const quest = resolveDialogue(makeWs(), npc, talkOf({ act: "ask", topic: { kind: "quest", questId: asQuestId("quest_0") } }), deps);
    expect(quest.interaction.topic).toEqual({ kind: "quest", questId: asQuestId("quest_0") });
    expect(quest.interaction.topicSummary).toBe("谈论任务");

    const thread = resolveDialogue(makeWs(), npc, talkOf({ act: "support", topic: { kind: "thread", threadId: "main_thread" } }), deps);
    expect(thread.interaction.topic).toEqual({ kind: "thread", threadId: "main_thread" });
    expect(thread.interaction.topicSummary).toBe("延续话题");

    const general = resolveDialogue(makeWs(), npc, talkOf({ act: "ask" }), deps);
    expect(general.interaction.topic).toEqual({ kind: "general" });
    expect(general.interaction.topicSummary).toBe("闲谈");
  });

  it("持久化的 interaction 只含结构化 topic 与摘要，绝不包含玩家原话", () => {
    const npc = makeNpc({ met: true });
    const res = resolveDialogue(makeWs(), npc, talkOf({
      act: "ask",
      topic: { kind: "fact", factId: FACT_KNOWN },
      utterance: "你能告诉我矿坑的秘密吗？",
    }), deps);
    expect(res.interaction.topic).toEqual({ kind: "fact", factId: FACT_KNOWN });
    expect(res.interaction.topicSummary).toBe("询问线索");
    expect(res.interaction).not.toMatchObject({ utterance: expect.anything() });
  });
});