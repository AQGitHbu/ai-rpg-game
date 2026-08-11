import { describe, it, expect } from "vitest";
import { createFixtureIntentParserSource } from "./intentParserSource";
import type { IntentContext } from "@/game/gameplay/rpg/intentParser/intentContext";

describe("FixtureIntentParserSource", () => {
  const ctx: IntentContext = {
    currentLocationName: "客栈",
    connectedLocations: [{ id: "loc_2", name: "街道" }],
    presentNpcs: [{ id: "npc_1", name: "老板" }],
    availableItems: [{ id: "item_1", name: "钥匙" }],
    undiscoveredFacts: [],
    activeQuests: [],
    topicRefs: [],
  };
  const source = createFixtureIntentParserSource();

  it("classifies text mentioning npc name as talk", async () => {
    const result = await source.parseIntent("老板你好", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("talk");
    }
  });

  it("classifies text mentioning location name as move", async () => {
    const result = await source.parseIntent("我想去街道", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("move");
    }
  });

  it("returns unclassifiable for unrelated text", async () => {
    const result = await source.parseIntent("今天天气真好", ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unclassifiable");
    }
  });
});
