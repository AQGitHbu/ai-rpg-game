import { describe, it, expect } from "vitest";
import { resolveDialogue, emotionForOutcome } from "./dialogueResolution";
import type { WorldState, NpcEntry } from "@/game/domain/worldState";
import { createInitialWorldState } from "@/game/domain/worldState";
import { asNpcId, asLocationId, asFactId, asGenerationId } from "@/game/domain/worldEntity";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { asTurnId } from "@/game/domain/events";
import type { DialogueAct, TalkAction } from "@/game/domain/action";

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

function deps(actionId = "act_1") {
  return { now: () => "2026-01-01", actionId, turnNumber: 7, turnId: asTurnId("test:turn:7") };
}

function mutationKinds(resolution: ReturnType<typeof resolveDialogue>): readonly string[] {
  return resolution.mutations.map((mutation) => mutation.kind);
}

describe("resolveDialogue — qualitative signal 与原子批次", () => {
  it("八种 dialogue act 映射到固定关系 signal，并写 NPC→player 边", () => {
    const expected: Readonly<Record<DialogueAct, string>> = {
      ask: "shared_fact",
      support: "supported",
      challenge: "challenged",
      threaten: "threatened",
      deceive: "deceived",
      offer: "offered_help",
      refuse: "refused",
      reassure: "reassured",
    };
    for (const [act, signal] of Object.entries(expected) as [DialogueAct, string][]) {
      const topic = act === "ask" ? { kind: "fact" as const, factId: FACT_KNOWN } : undefined;
      const resolution = resolveDialogue(makeWs(), makeNpc(), talkOf({ act, topic }), deps(act));
      expect(resolution.mutations[0]).toMatchObject({
        kind: "apply_relationship_signal",
        fromNpcId: asNpcId("npc_1"),
        targetId: PLAYER_ENTITY_ID,
        signal,
        source: { kind: "action", actionId: act, turnNumber: 7 },
      });
    }
  });

  it("ask 披露事实时使用 shared_fact，不披露时没有 signal 且 outcome 为 neutral", () => {
    const disclosed = resolveDialogue(makeWs(), makeNpc(), talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_KNOWN } }), deps("disclosed"));
    const withheld = resolveDialogue(makeWs(), makeNpc(), talkOf({ act: "ask" }), deps("withheld"));
    expect(disclosed.signal).toBe("shared_fact");
    expect(disclosed.outcome).toBe("positive");
    expect(withheld.signal).toBeNull();
    expect(withheld.outcome).toBe("neutral");
    expect(mutationKinds(withheld)).not.toContain("apply_relationship_signal");
  });

  it("对话解析不再暴露任何自算数字", () => {
    const resolution = resolveDialogue(makeWs(), makeNpc(), talkOf({ act: "support" }), deps());
    // @ts-expect-error relationshipDelta 已由对话契约删除，真实数字只由实体层盖章
    expect(resolution.relationshipDelta).toBeUndefined();
    expect(resolution).not.toHaveProperty("relationshipDelta");
    expect(resolution.interaction).not.toHaveProperty("relationshipDelta");
    expect(resolution.interaction).not.toHaveProperty("summary");
    // 维护闸门：旧对话数值常量的 rg 检查必须为空。
  });

  it("首次见面只由 set_npc_met 标记，已 met 的 NPC 不再提交该写入", () => {
    const first = resolveDialogue(makeWs(), makeNpc(), talkOf({ act: "support" }), deps());
    const repeated = resolveDialogue(makeWs(), makeNpc({ met: true }), talkOf({ act: "support" }), deps("repeat"));
    expect(mutationKinds(first)).toContain("set_npc_met");
    expect(mutationKinds(first).filter((kind) => kind === "set_npc_met")).toHaveLength(1);
    expect(mutationKinds(repeated)).not.toContain("set_npc_met");
  });

  it("批次顺序固定为 signal、interaction、emotion、met", () => {
    const resolution = resolveDialogue(makeWs(), makeNpc(), talkOf({ act: "support" }), deps());
    expect(resolution.mutations[0]?.kind).toBe("apply_relationship_signal");
    expect(resolution.mutations.findIndex(({ kind }) => kind === "record_npc_interaction"))
      .toBeLessThan(resolution.mutations.findIndex(({ kind }) => kind === "set_npc_met"));
    // met 必须最后：interaction 的摘要在 append 时读取 met，才能记录「首次见面」。
    expect(resolution.mutations.at(-1)?.kind).toBe("set_npc_met");
  });

  it("interaction 与 record mutation 只保留锁定字段，不携带 delta 或 summary", () => {
    const resolution = resolveDialogue(makeWs(), makeNpc(), talkOf({ act: "support" }), deps());
    const interaction = resolution.interaction;
    expect(Object.keys(interaction).sort()).toEqual([
      "actionId", "dialogueAct", "eventId", "learnedFactIds", "locationId", "outcome", "topic", "topicSummary", "turnNumber",
    ]);
    expect(Object.keys(resolution.mutations[1]!).sort()).toEqual([
      "actionId", "dialogueAct", "eventId", "kind", "learnedFactIds", "locationId", "npcId", "outcome", "topic", "topicSummary", "turnNumber",
    ]);
    expect(interaction).not.toHaveProperty("relationshipDelta");
    expect(interaction).not.toHaveProperty("summary");
  });

  it("为 interaction 与 relationship mutation 同时产出同语义 key 的事件草稿", () => {
    const resolution = resolveDialogue(makeWs(), makeNpc(), talkOf({ act: "support" }), deps("dialogue_1"));
    expect(resolution.drafts.map((draft) => draft.eventKey)).toEqual([
      "npc_interaction_recorded:npc_1:dialogue_1",
      "npc_relationship_changed:npc_1:player_0:supported",
      "npc_met:npc_1",
    ]);
    expect(resolution.drafts[1]?.causeKeys).toEqual([{
      kind: "same_batch",
      eventKey: "npc_interaction_recorded:npc_1:dialogue_1",
    }]);
    expect(resolution.drafts[0]?.payload).toEqual({
      type: "npc_interaction_recorded",
      npcId: asNpcId("npc_1"),
      dialogueAct: "support",
    });
    expect(resolution.drafts[1]?.payload).toEqual({
      type: "npc_relationship_changed",
      fromNpcId: asNpcId("npc_1"),
      targetId: PLAYER_ENTITY_ID,
      signal: "supported",
    });
  });

  it("emotionForOutcome 负责 positive/negative/mixed，重复情绪不提交写入", () => {
    expect(emotionForOutcome("positive", "neutral")).toBe("warm");
    expect(emotionForOutcome("negative", "neutral")).toBe("guarded");
    expect(emotionForOutcome("mixed", "angry")).toBe("neutral");
    expect(emotionForOutcome("mixed", "warm")).toBe("warm");
    const unchanged = resolveDialogue(makeWs(), makeNpc(), talkOf({ act: "ask" }), deps("unchanged"));
    expect(unchanged.outcome).toBe("neutral");
    expect(mutationKinds(unchanged)).not.toContain("set_npc_emotion");
  });

  it("utterance 不参与规则：不同原文生成完全相同的 mutations", () => {
    const npc = makeNpc({ met: true });
    const a = resolveDialogue(makeWs(), npc, talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_KNOWN }, utterance: "你知道什么吗？" }), deps());
    const b = resolveDialogue(makeWs(), npc, talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_KNOWN }, utterance: "快告诉我！" }), deps());
    expect(a.mutations).toEqual(b.mutations);
  });

  it("未知或隐藏事实 withheld，ask 不产生 signal 或 knowledge mutation", () => {
    const unknown = resolveDialogue(makeWs(), makeNpc(), talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_UNKNOWN } }), deps("unknown"));
    const hidden = resolveDialogue(makeWs(), makeNpc({ memory: { ...makeNpc().memory, hiddenFactIds: [FACT_KNOWN] } }), talkOf({ act: "ask", topic: { kind: "fact", factId: FACT_KNOWN } }), deps("hidden"));
    for (const resolution of [unknown, hidden]) {
      expect(resolution.disclosure.kind).toBe("withheld");
      expect(resolution.signal).toBeNull();
      expect(resolution.mutations.some(({ kind }) => kind.includes("knowledge"))).toBe(false);
    }
  });

  it("hostile NPC 的 threaten/deceive 即使 failure 仍提交关系 signal", () => {
    const hostile = makeNpc({ met: true, memory: { ...makeNpc().memory, relationship: { affinity: -70 } } });
    for (const act of ["threaten", "deceive"] as const) {
      const resolution = resolveDialogue(makeWs(), hostile, talkOf({ act }), deps(act));
      expect(resolution.status).toBe("failure");
      expect(resolution.signal).not.toBeNull();
      expect(resolution.mutations[0]?.kind).toBe("apply_relationship_signal");
    }
  });

  it("hostile NPC 的 offer 由 improving signal 判为 positive", () => {
    const hostile = makeNpc({ met: true, memory: { ...makeNpc().memory, relationship: { affinity: -70 } } });
    const resolution = resolveDialogue(makeWs(), hostile, talkOf({ act: "offer" }), deps("offer"));
    expect(resolution.outcome).toBe("positive");
    expect(resolution.status).toBe("success");
  });
});
