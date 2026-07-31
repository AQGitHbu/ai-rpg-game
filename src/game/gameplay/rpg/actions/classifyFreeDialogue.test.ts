import { describe, expect, it } from "vitest";
import { classifyFreeDialogue } from "./classifyFreeDialogue";
import type { ScenarioBlueprint, GameState } from "@/game/domain";

function buildMinimalBlueprint(overrides?: Partial<ScenarioBlueprint>): ScenarioBlueprint {
  return {
    schemaVersion: 1 as const,
    generationId: "gen-test" as never,
    seed: "test",
    templateVersion: "tpl-1",
    inputDigest: "digest",
    gameType: "wuxia",
    world: { name: "世界", summary: "", tone: "dark", themes: [], facts: [] },
    locations: [
      { id: "loc_1" as never, name: "废弃矿坑", description: "", kind: "main", connectedLocationIds: [] },
      { id: "loc_2" as never, name: "大石镇", description: "", kind: "main", connectedLocationIds: [] },
    ],
    npcs: [
      { id: "npc_1" as never, name: "铁匠", role: "铁匠", locationId: "loc_1" as never, knownFactIds: [] },
    ],
    quests: [
      { id: "q_main_1" as never, kind: "main" as const, stage: 1, name: "锈蚀的线索", description: "调查废弃矿坑", objectives: [], onSuccess: "unlock_next" as const, outcomes: [], endingCondition: null },
    ],
    enemies: [], items: [], endings: [],
    player: { name: "Player", identity: "Hero", startingItemIds: [], baseStats: { hp: 20, attack: 5, defense: 3 } },
    openingScene: { locationId: "loc_1" as never, narration: "", suggestedActions: [], presentNpcIds: [], investigableFactIds: [] },
    ...overrides,
  } as unknown as ScenarioBlueprint;
}

function buildState(overrides?: Partial<GameState>): GameState {
  return {
    stateVersion: 1 as const,
    generation: {} as never,
    player: { name: "Player", identity: "Hero", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: "loc_1" as never,
    unlockedLocationIds: ["loc_1" as never],
    visitedLocationIds: ["loc_1" as never],
    npcs: [{ npcId: "npc_1" as never, locationId: "loc_1" as never, met: true }],
    quests: [{ questId: "q_main_1" as never, status: "active" }],
    inventory: [], worldFacts: [], defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
    eventLedger: [{ type: "game_initialized", generation: {} as never, occurredAt: "" }],
    ...overrides,
  } as unknown as GameState;
}

describe("classifyFreeDialogue", () => {
  const blueprint = buildMinimalBlueprint();
  const state = buildState();

  it("空文本/短文本 → chat", () => {
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "")).toBe("chat");
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "  ")).toBe("chat");
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "嗨")).toBe("chat");
  });

  it("命中任务关键词 → narrative", () => {
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "我想去废弃矿坑")).toBe("narrative");
  });

  it("命中地点名称 → narrative", () => {
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "去大石镇看看")).toBe("narrative");
  });

  it("命中 NPC 名称 → narrative", () => {
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "铁匠在哪里")).toBe("narrative");
  });

  it("探索意图动词 → narrative", () => {
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "去调查一下")).toBe("narrative");
  });

  it("闲聊内容 → chat", () => {
    expect(classifyFreeDialogue(blueprint, state, "npc_1" as never, "今天天气真好")).toBe("chat");
  });

  it("NPC 不在当前地点 → chat", () => {
    const otherState = buildState({ npcs: [{ npcId: "npc_1" as never, locationId: "loc_2" as never, met: true }] });
    expect(classifyFreeDialogue(blueprint, otherState, "npc_1" as never, "我想去废弃矿坑")).toBe("chat");
  });

  it("无 active 任务时地点关键词仍触发 narrative", () => {
    const noQuestState = buildState({ quests: [] });
    expect(classifyFreeDialogue(blueprint, noQuestState, "npc_1" as never, "废弃矿坑")).toBe("narrative");
  });
});
