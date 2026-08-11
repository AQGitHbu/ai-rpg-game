import { describe, it, expect } from "vitest";
import { buildIntentContext } from "./intentContext";
import { createInitialWorldState, appendLocation, appendNpc, appendItem, type LocationEntry, type NpcEntry, type ItemEntry } from "@/game/domain/worldState";
import { asLocationId, asNpcId, asItemId, asGenerationId, asFactId, asQuestId } from "@/game/domain/worldEntity";
import { createInitialStoryState } from "@/game/domain/storyState";

describe("buildIntentContext", () => {
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
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });

  it("includes current location name and connected locations", () => {
    const ctx = buildIntentContext(ws);
    expect(ctx.currentLocationName).toBe("客栈");
    expect(ctx.connectedLocations).toHaveLength(1);
    expect(ctx.connectedLocations[0]?.name).toBe("街道");
  });

  it("includes NPCs at current location", () => {
    const ctx = buildIntentContext(ws);
    expect(ctx.presentNpcs).toHaveLength(1);
    expect(ctx.presentNpcs[0]?.name).toBe("老板");
  });

  it("includes available items at current location", () => {
    const ctx = buildIntentContext(ws);
    expect(ctx.availableItems).toHaveLength(1);
    expect(ctx.availableItems[0]?.name).toBe("钥匙");
  });

  it("includes undiscovered facts", () => {
    const ctx = buildIntentContext(ws);
    expect(Array.isArray(ctx.undiscoveredFacts)).toBe(true);
  });

  it("includes active quests", () => {
    const ctx = buildIntentContext(ws);
    expect(Array.isArray(ctx.activeQuests)).toBe(true);
  });

  // ── Task 5 Step 3：topicRefs ──────────────────────────────────────────────

  it("topicRefs 包含已发现事实 / 活跃任务 / 未解决线程（仅 ID 列表）", () => {
    const wsWithFacts = {
      ...ws,
      worldFacts: [
        { factId: asFactId("fact_0"), text: "矿坑密道", source: "generated" as const, discovered: true },
        { factId: asFactId("fact_1"), text: "隐藏的宝藏", source: "generated" as const, discovered: false },
      ],
      quests: [{
        id: asQuestId("quest_0"), name: "查明真相", description: "d", objectives: [],
        onSuccess: { kind: "advance_story" } as const,
        onFailure: { kind: "closed" } as const,
        tags: [], kind: "main" as const, stage: 1, status: "active" as const,
      }],
    };
    const ssWithThreads = { ...ss, unresolvedThreads: ["thread_1"] };
    const ctx = buildIntentContext(wsWithFacts, ssWithThreads);
    expect(ctx.topicRefs).toContainEqual({ kind: "fact", id: "fact_0" });
    expect(ctx.topicRefs).not.toContainEqual({ kind: "fact", id: "fact_1" }); // 未发现的不在 refs 内
    expect(ctx.topicRefs).toContainEqual({ kind: "quest", id: "quest_0" });
    expect(ctx.topicRefs).toContainEqual({ kind: "thread", id: "thread_1" });
  });

  it("无 storyState 时 topicRefs 不含 thread 引用（兼容旧调用）", () => {
    const ctx = buildIntentContext(ws);
    expect(ctx.topicRefs.some((r) => r.kind === "thread")).toBe(false);
  });
});
