import { describe, it, expect } from "vitest";
import { convertInteraction, type ActionChoiceMap } from "./actionConverter";
import type { Action } from "@/game/domain/action";
import { asNpcId } from "@/game/domain/scenarioBlueprint";

describe("convertInteraction", () => {
  const choiceMap: ActionChoiceMap = new Map<string, Action>([
    ["tok_talk", { type: "talk", npcId: asNpcId("npc_1") }],
  ]);

  it("maps known fixed_choice token to action", () => {
    const r = convertInteraction({ kind: "fixed_choice", choiceToken: "tok_talk" }, choiceMap);
    expect(r.ok).toBe(true);
  });

  it("rejects unknown token", () => {
    const r = convertInteraction({ kind: "fixed_choice", choiceToken: "nope" }, choiceMap);
    expect(r).toEqual({ ok: false, reason: "unknown_choice" });
  });

  it("rejects free_text in P1", () => {
    const r = convertInteraction({ kind: "free_text", text: "你好" }, choiceMap);
    expect(r).toEqual({ ok: false, reason: "free_text_not_supported" });
  });
});
