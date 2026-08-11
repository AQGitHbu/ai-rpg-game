import { describe, it, expect } from "vitest";
import { preClassifyFreeText } from "./preClassify";
import type { IntentContext } from "./intentContext";

describe("preClassifyFreeText", () => {
  const ctx: IntentContext = {
    currentLocationName: "客栈",
    connectedLocations: [{ id: "loc_2", name: "街道" }],
    presentNpcs: [{ id: "npc_1", name: "老板" }],
    availableItems: [{ id: "item_1", name: "钥匙" }],
    undiscoveredFacts: [{ id: "fact_1", name: "墙上刻字" }],
    activeQuests: [{ id: "quest_1", name: "寻找失物" }],
    topicRefs: [],
  };

  it("matches move by connected location name", () => {
    const action = preClassifyFreeText("去街道看看", ctx);
    expect(action?.type).toBe("move");
    if (action?.type === "move") {
      expect(String(action.locationId)).toBe("loc_2");
    }
  });

  it("matches talk by present npc name", () => {
    const action = preClassifyFreeText("和老板聊聊", ctx);
    expect(action?.type).toBe("talk");
    if (action?.type === "talk") {
      expect(String(action.npcId)).toBe("npc_1");
      expect(action.utterance).toBe("和老板聊聊");
    }
  });

  it("matches take_item by available item name", () => {
    const action = preClassifyFreeText("拿走钥匙", ctx);
    expect(action?.type).toBe("take_item");
    if (action?.type === "take_item") {
      expect(String(action.itemId)).toBe("item_1");
    }
  });

  it("matches investigate by fact keyword", () => {
    const action = preClassifyFreeText("调查墙上刻字", ctx);
    expect(action?.type).toBe("investigate");
  });

  it("returns null for unclassifiable text", () => {
    const action = preClassifyFreeText("今天天气真好", ctx);
    expect(action).toBeNull();
  });

  it("returns null for empty text", () => {
    const action = preClassifyFreeText("", ctx);
    expect(action).toBeNull();
  });

  it("matches explore intent", () => {
    const action = preClassifyFreeText("四处探索一下", ctx);
    expect(action?.type).toBe("explore");
  });

  it("does not route removed rest intent", () => {
    const action = preClassifyFreeText("休息一会儿", ctx);
    expect(action).toBeNull();
  });
});
