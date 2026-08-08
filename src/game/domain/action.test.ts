import { describe, it, expect } from "vitest";
import type { Action, Interaction, DialogueAct } from "./action";
import { DIALOGUE_ACTS } from "./action";
import { asNpcId, asFactId, asQuestId } from "./scenarioBlueprint";
import type { ThreadId } from "./storyState";

describe("Action types", () => {
  it("talk action can carry utterance", () => {
    const a: Action = { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask", utterance: "你知道什么？" };
    expect(a.type).toBe("talk");
    expect(a.utterance).toBe("你知道什么？");
  });

  it("talk requires a dialogueAct", () => {
    // 编译期契约（@ts-expect-error = 无 dialogueAct 的 talk 不能通过类型检查）
    // @ts-expect-error dialogueAct 必填
    const bad: Action = { type: "talk", npcId: asNpcId("npc_1") };
    expect(() => bad).toBeTruthy();
  });

  it("DIALOGUE_ACTS covers the 8 spec acts without duplicates", () => {
    const specActs = ["ask", "support", "challenge", "threaten", "deceive", "offer", "refuse", "reassure"];
    expect([...DIALOGUE_ACTS]).toEqual(specActs);
    expect(new Set(DIALOGUE_ACTS).size).toBe(8);
    const all: readonly DialogueAct[] = DIALOGUE_ACTS;
    expect(all.length).toBe(8);
  });

  it("talk accepts every dialogueAct", () => {
    for (const act of DIALOGUE_ACTS) {
      const a: Action = { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: act };
      expect(a.type).toBe("talk");
      expect(a.dialogueAct).toBe(act);
    }
  });

  it("talk topic supports fact, quest, thread and general kinds", () => {
    const factTopic: Action = { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask", topic: { kind: "fact", factId: asFactId("fact_1") } };
    const questTopic: Action = { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask", topic: { kind: "quest", questId: asQuestId("quest_1") } };
    const threadTopic: Action = { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask", topic: { kind: "thread", threadId: "main_thread" as ThreadId } };
    const generalTopic: Action = { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask", topic: { kind: "general" } };
    expect(factTopic.topic).toEqual({ kind: "fact", factId: asFactId("fact_1") });
    expect(questTopic.topic).toEqual({ kind: "quest", questId: asQuestId("quest_1") });
    expect(threadTopic.topic).toEqual({ kind: "thread", threadId: "main_thread" });
    expect(generalTopic.topic).toEqual({ kind: "general" });
  });

  it("talk utterance is optional and does not affect type validity", () => {
    const withUtterance: Action = { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support", utterance: "说得好" };
    const withoutUtterance: Action = { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support" };
    expect(withUtterance.utterance).toBe("说得好");
    expect(withoutUtterance.utterance).toBeUndefined();
  });

  it("freeform action carries intent and rawText", () => {
    const a: Action = { type: "freeform", intent: "claim_power", rawText: "我的武功升到一百级" };
    expect(a.type).toBe("freeform");
  });

  it("fixed_choice interaction has choiceToken", () => {
    const i: Interaction = { kind: "fixed_choice", choiceToken: "tok_1" };
    expect(i.kind).toBe("fixed_choice");
  });
});
