import { describe, it, expect } from "vitest";
import { convertInteraction, type ActionChoiceMap } from "./actionConverter";
import { createFixtureIntentParserSource } from "./server/ai/intentParserSource";
import { buildIntentContext } from "@/game/gameplay/rpg/intentParser/intentContext";
import type { Action } from "@/game/domain/action";
import { asNpcId, asLocationId, asItemId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import { createInitialWorldState, appendLocation, appendNpc, appendItem, type LocationEntry, type NpcEntry, type ItemEntry } from "@/game/domain/worldState";

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
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")],
    availableItemIds: [asItemId("item_1")], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const item1: ItemEntry = {
    id: asItemId("item_1"), name: "钥匙", description: "t", kind: "key", tags: [],
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const npc1: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  const ws = appendItem(appendLocation(appendNpc(baseWs, npc1), loc2), item1);
  const ctx = buildIntentContext(ws);
  const source = createFixtureIntentParserSource();

  it("pre-classifies text with location name → move (zero AI)", async () => {
    const result = await convertInteraction(
      { kind: "free_text", text: "去街道看看" },
      new Map(),
      { intentContext: ctx, intentParserSource: source },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("move");
    }
  });

  it("AI classifies text mentioning npc name → talk", async () => {
    const result = await convertInteraction(
      { kind: "free_text", text: "老板你好" },
      new Map(),
      { intentContext: ctx, intentParserSource: source },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("talk");
      if (result.action.type === "talk") {
        expect(result.action.utterance).toBe("老板你好");
      }
    }
  });

  it("falls back to freeform when neither pre-classify nor AI can classify", async () => {
    const result = await convertInteraction(
      { kind: "free_text", text: "我的武功升到一百级" },
      new Map(),
      { intentContext: ctx, intentParserSource: source },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("freeform");
      if (result.action.type === "freeform") {
        expect(result.action.rawText).toBe("我的武功升到一百级");
      }
    }
  });

  it("falls back to freeform when no AI source provided (offline)", async () => {
    const result = await convertInteraction(
      { kind: "free_text", text: "随便说点什么不相关的话" },
      new Map(),
      { intentContext: ctx },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("freeform");
    }
  });

  it("falls back to freeform when no context provided", async () => {
    const result = await convertInteraction(
      { kind: "free_text", text: "你好" },
      new Map(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("freeform");
    }
  });
});
