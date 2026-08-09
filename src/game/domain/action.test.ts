import { describe, it, expect } from "vitest";
import type { Action, Interaction, DialogueAct, ActionType } from "./action";
import { DIALOGUE_ACTS, SUPPORTED_ACTION_TYPES } from "./action";
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

describe("Action support matrix (Task 29)", () => {
  it("declares the canonical set of fully-supported production action types", () => {
    const expected = [
      "talk", "move", "explore", "investigate", "take_item", "give_item",
      "attack", "battle_action", "rest", "ack_prologue", "freeform",
    ];
    expect([...SUPPORTED_ACTION_TYPES]).toEqual(expected);
  });

  it("does NOT include unimplemented action types in the supported set", () => {
    // use_item/interact/accept_quest/narrative_choice 无规则实现，
    // 不得作为永远 INTENT_NOT_ROUTED 的公开候选保留。
    // give_item 于 2026-08-09 补齐规则实现，已移出未实现清单。
    const unimplemented = ["use_item", "interact", "accept_quest", "narrative_choice"];
    for (const t of unimplemented) {
      expect(SUPPORTED_ACTION_TYPES).not.toContain(t);
    }
  });

  it("every supported action type is assignable to the production Action union", () => {
    // 编译期守卫：SUPPORTED_ACTION_TYPES 的元素必须是合法 Action type。
    const asType = (t: ActionType) => t;
    for (const t of SUPPORTED_ACTION_TYPES) {
      expect(asType(t)).toBe(t);
    }
  });

  it("ack_prologue is the only supported type allowed to produce no primary event", () => {
    const expected = new Set(SUPPORTED_ACTION_TYPES);
    // explore/rest/freeform 必须产生主事件；仅 ack_prologue 允许空事件（幂等标记）。
    for (const t of ["explore", "rest", "freeform"] as const) {
      expect(expected.has(t)).toBe(true);
    }
  });
});
