import { describe, it, expect } from "vitest";
import type { Action, Interaction } from "./action";
import { asNpcId } from "./scenarioBlueprint";

describe("Action types", () => {
  it("talk action can carry utterance", () => {
    const a: Action = { type: "talk", npcId: asNpcId("npc_1"), utterance: "你知道什么？" };
    expect(a.type).toBe("talk");
    expect(a.utterance).toBe("你知道什么？");
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
