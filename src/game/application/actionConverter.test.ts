import { describe, it, expect } from "vitest";
import { convertInteraction, type ActionChoiceMap } from "./actionConverter";
import type { Action } from "@/game/domain/action";
import { asNpcId } from "@/game/domain/worldEntity";

describe("convertInteraction fixed_choice", () => {
  const choiceMap: ActionChoiceMap = new Map<string, Action>([
    ["tok_talk", { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" }],
  ]);

  it("maps known fixed_choice token to action", async () => {
    const r = await convertInteraction({ kind: "fixed_choice", choiceToken: "tok_talk" }, choiceMap);
    expect(r.ok).toBe(true);
  });

  it("rejects unknown token", async () => {
    const r = await convertInteraction({ kind: "fixed_choice", choiceToken: "nope" }, choiceMap);
    expect(r).toEqual({ ok: false, reason: "unknown_choice" });
  });
});

describe("convertInteraction free_text", () => {
  it("rejects free text without an already-authorized focused NPC", async () => {
    const result = await convertInteraction(
      { kind: "free_text", text: "去街道看看" },
      new Map(),
      { intentContext: { legacy: true }, intentParserSource: { generate: () => { throw new Error("must not run"); } } },
    );
    expect(result).toEqual({ ok: false, reason: "unknown_choice" });
  });

  it("converts focused NPC custom text to neutral ask without an intent provider", async () => {
    const result = await convertInteraction(
      { kind: "free_text", text: "去街道看看", targetNpcId: asNpcId("npc_1") },
      new Map(),
      { targetNpcId: asNpcId("npc_1") },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.type).toBe("talk");
    if (result.action.type === "talk") {
      expect(result.action.npcId).toBe(asNpcId("npc_1"));
      expect(result.action.utterance).toBe("去街道看看");
    }
  });

  it("keeps every focused NPC text as dialogue, never a rule action", async () => {
    const result = await convertInteraction(
      { kind: "free_text", text: "把钥匙交给老板", targetNpcId: asNpcId("npc_1") },
      new Map(),
      { targetNpcId: asNpcId("npc_1") },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.type).toBe("talk");
    if (result.action.type === "talk") {
      expect(result.action.npcId).toBe(asNpcId("npc_1"));
      expect(result.action.utterance).toBe("把钥匙交给老板");
    }
  });

  it("rejects free text when no focused NPC proof is supplied", async () => {
    const result = await convertInteraction(
      { kind: "free_text", text: "你好" },
      new Map(),
    );
    expect(result).toEqual({ ok: false, reason: "unknown_choice" });
  });
});
