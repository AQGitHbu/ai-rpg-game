import { describe, expect, it } from "vitest";
import {
  asEnemyId,
  asFactId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
  createEmptyStoryMemory,
  STORY_MEMORY_RECENT_LIMIT,
  STORY_MEMORY_VERSION,
  storyMemoryOf,
  type GameEvent,
  type GameState
} from "@/game/domain";
import { reconcileStoryMemory } from "./reconcileStoryMemory";

// Phase 11 gameplay 纯 reducer：从 eventLedger cursor 之后归约结构化剧情记忆。
// 见 docs/superpowers/specs/2026-07-31-phase-11-story-continuity-structured-memory.md §5。
// 纯函数：不读 IO/Date/process.env/随机；不保存 AI 文案/token；不变异输入。

const FIXED_TIME = "2026-07-31T00:00:00.000Z";

function baseState(overrides: Partial<GameState> = {}): GameState {
  return {
    stateVersion: 1,
    generation: {
      generationId: "gen-test" as GameState["generation"]["generationId"],
      seed: "test-seed",
      templateVersion: "tpl-1",
      inputDigest: "digest-test",
      gameType: "wuxia"
    },
    player: { name: "P", identity: "H", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: asLocationId("loc_1"),
    unlockedLocationIds: [asLocationId("loc_1")],
    visitedLocationIds: [asLocationId("loc_1")],
    npcs: [
      { npcId: asNpcId("npc_a"), locationId: asLocationId("loc_1"), met: false },
      { npcId: asNpcId("npc_b"), locationId: asLocationId("loc_2"), met: false }
    ],
    quests: [],
    inventory: [],
    worldFacts: [],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
    towns: [],
    townGeneration: { status: "idle" },
    storyMemory: createEmptyStoryMemory(),
    eventLedger: [{ type: "game_initialized", generation: {
      generationId: "gen-test" as GameState["generation"]["generationId"],
      seed: "test-seed", templateVersion: "tpl-1", inputDigest: "digest-test", gameType: "wuxia"
    } }],
    ...overrides
  } as GameState;
}

describe("reconcileStoryMemory：有界归约与不变性", () => {
  it("只归约 cursor 之后的事件、有界保留最后 12 条且不变异输入", () => {
    // 13 个 location_visited 事件 → 13 条 location 里程碑，截断为最后 12。
    const ledger = baseState().eventLedger.slice();
    for (let i = 0; i < 13; i++) {
      ledger.push({ type: "location_visited", locationId: asLocationId(`loc_${i}`), occurredAt: FIXED_TIME });
    }
    const state = baseState({ eventLedger: ledger });
    const before = structuredClone(state);

    const memory = reconcileStoryMemory({ state });

    expect(memory.reducedThroughEventCount).toBe(state.eventLedger.length);
    expect(memory.recent).toHaveLength(STORY_MEMORY_RECENT_LIMIT);
    expect(memory.version).toBe(STORY_MEMORY_VERSION);
    // 输入未被变异
    expect(state).toEqual(before);
    // 截断后保留的是最后 12 条（丢弃最早的 loc_0）
    expect(memory.recent.every((entry) => entry.kind === "location")).toBe(true);
    expect(memory.recent.some((entry) => entry.kind === "location" && entry.locationId === asLocationId("loc_0"))).toBe(false);
    expect(memory.recent.some((entry) => entry.kind === "location" && entry.locationId === asLocationId("loc_12"))).toBe(true);
  });

  it("cursor 已追齐 ledger 时幂等：返回同构记忆、不再追加条目", () => {
    const ledger: GameEvent[] = [
      ...baseState().eventLedger,
      { type: "location_visited", locationId: asLocationId("loc_2"), occurredAt: FIXED_TIME },
      { type: "fact_discovered", factId: asFactId("fact_1"), occurredAt: FIXED_TIME }
    ];
    const state = baseState({ eventLedger: ledger });
    const first = reconcileStoryMemory({ state });
    // 已归约到末尾的 state 再归约一次：深度相等、recent 不重复
    const reducedState = baseState({ eventLedger: ledger, storyMemory: first });
    const second = reconcileStoryMemory({ state: reducedState });
    expect(second).toEqual(first);
    expect(second.recent).toHaveLength(first.recent.length);
  });

  it("NPC contact 只更新对应角色的最后接触（npc_met）", () => {
    const ledger: GameEvent[] = [
      ...baseState().eventLedger,
      { type: "location_visited", locationId: asLocationId("loc_1"), occurredAt: FIXED_TIME }, // idx1
      { type: "npc_met", npcId: asNpcId("npc_a"), occurredAt: FIXED_TIME }, // idx2 → turn 2
      { type: "location_visited", locationId: asLocationId("loc_2"), occurredAt: FIXED_TIME }, // idx3
      { type: "npc_met", npcId: asNpcId("npc_b"), occurredAt: FIXED_TIME } // idx4 → turn 4
    ];
    const state = baseState({ eventLedger: ledger });
    const memory = reconcileStoryMemory({ state });
    expect(memory.npcContacts).toContainEqual({
      npcId: asNpcId("npc_a"),
      lastContactTurn: 2,
      lastLocationId: asLocationId("loc_1")
    });
    expect(memory.npcContacts.find((c) => c.npcId === asNpcId("npc_b"))?.lastContactTurn).toBe(4);
    expect(memory.npcContacts.find((c) => c.npcId === asNpcId("npc_b"))?.lastLocationId).toBe(asLocationId("loc_2"));
  });

  it("narrative_scene_presented 的 focusNpcId 更新对应 NPC 接触且产出 scene 里程碑", () => {
    const ledger: GameEvent[] = [
      ...baseState().eventLedger,
      {
        type: "narrative_scene_presented",
        sceneId: "scene-1",
        locationId: asLocationId("loc_2"),
        focusNpcId: asNpcId("npc_a"),
        revealedFactIds: [],
        pacing: "develop",
        occurredAt: FIXED_TIME
      } // idx1 → turn 1
    ];
    const state = baseState({ eventLedger: ledger });
    const memory = reconcileStoryMemory({ state });
    expect(memory.recent.at(-1)).toMatchObject({ kind: "scene", sceneId: "scene-1", pacing: "develop", turn: 1 });
    expect(memory.npcContacts.find((c) => c.npcId === asNpcId("npc_a"))).toMatchObject({
      lastContactTurn: 1,
      lastLocationId: asLocationId("loc_2")
    });
  });

  it("映射全部事件种类：location/npc/fact/quest/item/battle/scene", () => {
    const ledger: GameEvent[] = [
      ...baseState().eventLedger,
      { type: "location_visited", locationId: asLocationId("loc_1"), occurredAt: FIXED_TIME }, // location
      { type: "npc_met", npcId: asNpcId("npc_a"), occurredAt: FIXED_TIME }, // npc
      { type: "fact_discovered", factId: asFactId("fact_1"), occurredAt: FIXED_TIME }, // fact
      { type: "quest_unlocked", questId: asQuestId("m1"), occurredAt: FIXED_TIME }, // quest unlocked
      { type: "item_obtained", itemId: asItemId("item_1"), locationId: asLocationId("loc_1"), occurredAt: FIXED_TIME }, // item
      { type: "battle_resolved", enemyId: asEnemyId("enemy_a"), outcome: "victory", occurredAt: FIXED_TIME }, // battle
      { type: "quest_completed", questId: asQuestId("m1"), occurredAt: FIXED_TIME }, // quest completed
      { type: "quest_failed", questId: asQuestId("s1"), occurredAt: FIXED_TIME }, // quest failed
      {
        type: "narrative_scene_presented", sceneId: "scene-1", locationId: asLocationId("loc_1"),
        focusNpcId: null, revealedFactIds: [], pacing: "setup", occurredAt: FIXED_TIME
      } // scene
    ];
    const state = baseState({ eventLedger: ledger });
    const memory = reconcileStoryMemory({ state });
    const kinds = memory.recent.map((e) => e.kind);
    expect(kinds).toContain("location");
    expect(kinds).toContain("npc");
    expect(kinds).toContain("fact");
    expect(kinds).toContain("quest");
    expect(kinds).toContain("item");
    expect(kinds).toContain("battle");
    expect(kinds).toContain("scene");
    // quest 三种 status 都映射
    const questEntries = memory.recent.filter((e) => e.kind === "quest");
    expect(questEntries.some((e) => e.kind === "quest" && e.status === "unlocked")).toBe(true);
    expect(questEntries.some((e) => e.kind === "quest" && e.status === "completed")).toBe(true);
    expect(questEntries.some((e) => e.kind === "quest" && e.status === "failed")).toBe(true);
    // battle outcome 映射
    expect(memory.recent.some((e) => e.kind === "battle" && e.outcome === "victory")).toBe(true);
    // 里程碑绝不携带 AI 文案/token
    for (const entry of memory.recent) {
      const keys = Object.keys(entry);
      expect(keys).not.toContain("narration");
      expect(keys).not.toContain("choiceToken");
      expect(keys).not.toContain("actionKey");
    }
  });

  it("未知/不映射的事件只推进 cursor，不伪造条目（location_observed/battle_started 等）", () => {
    const ledger: GameEvent[] = [
      ...baseState().eventLedger,
      { type: "location_observed", locationId: asLocationId("loc_1"), occurredAt: FIXED_TIME },
      { type: "battle_started", enemyId: asEnemyId("enemy_a"), occurredAt: FIXED_TIME },
      { type: "battle_round_resolved", enemyId: asEnemyId("enemy_a"), round: 1, playerHp: 10, enemyHp: 5, action: "attack", occurredAt: FIXED_TIME },
      { type: "enemy_defeated", enemyId: asEnemyId("enemy_a"), occurredAt: FIXED_TIME },
      { type: "narrative_choice", choiceToken: "tok", actionKey: "act", sceneId: "s", occurredAt: FIXED_TIME },
      { type: "town_plan_generated", locationId: asLocationId("loc_2"), planSource: "offline", occurredAt: FIXED_TIME },
      { type: "ending_reached", endingId: "e1" as never, outcome: "success", occurredAt: FIXED_TIME }
    ];
    const state = baseState({ eventLedger: ledger });
    const memory = reconcileStoryMemory({ state });
    expect(memory.reducedThroughEventCount).toBe(state.eventLedger.length);
    expect(memory.recent).toEqual([]);
  });

  it("npc_met 事件无 interactionKind 时不生成摘要（旧存档兼容）", () => {
    const ledger: GameEvent[] = [
      ...baseState().eventLedger,
      { type: "npc_met", npcId: asNpcId("npc_a"), occurredAt: FIXED_TIME }
    ];
    const state = baseState({ eventLedger: ledger });
    const memory = reconcileStoryMemory({ state });
    const contact = memory.npcContacts.find((c) => c.npcId === asNpcId("npc_a"));
    expect(contact?.lastInteractionSummary).toBeUndefined();
  });

  it("缺省 storyMemory 的旧存档安全归约（cursor 视为 0）", () => {
    const ledger: GameEvent[] = [
      ...baseState().eventLedger,
      { type: "location_visited", locationId: asLocationId("loc_2"), occurredAt: FIXED_TIME }
    ];
    const legacy = baseState({ eventLedger: ledger });
    // 旧存档没有 storyMemory 字段
    const { storyMemory: _omit, ...legacyWithoutMemory } = legacy;
    void _omit;
    const memory = reconcileStoryMemory({ state: legacyWithoutMemory as GameState });
    expect(memory.reducedThroughEventCount).toBe(ledger.length);
    expect(memory.recent).toHaveLength(1);
    expect(storyMemoryOf({ storyMemory: memory })).toBe(memory);
  });
});

describe("reconcileStoryMemory npc_met interactionKind", () => {
  it("greet 事件生成 lastInteractionSummary", () => {
    const ledger: GameEvent[] = [
      ...baseState().eventLedger,
      { type: "npc_met", npcId: asNpcId("npc_a"), occurredAt: FIXED_TIME, interactionKind: "greet" },
    ];
    const state = baseState({ eventLedger: ledger });
    const memory = reconcileStoryMemory({ state });
    const contact = memory.npcContacts.find((c) => c.npcId === asNpcId("npc_a"));
    expect(contact?.lastInteractionSummary).toBe("你初次结识了这位NPC。");
  });

  it("ask_main_quest 事件生成对应摘要", () => {
    const ledger: GameEvent[] = [
      ...baseState().eventLedger,
      { type: "npc_met", npcId: asNpcId("npc_a"), occurredAt: FIXED_TIME, interactionKind: "ask_main_quest" },
    ];
    const state = baseState({ eventLedger: ledger });
    const memory = reconcileStoryMemory({ state });
    const contact = memory.npcContacts.find((c) => c.npcId === asNpcId("npc_a"));
    expect(contact?.lastInteractionSummary).toBe("你向NPC询问了重要线索。");
  });

  it("后续场景接触更新保留既有互动摘要", () => {
    const ledger: GameEvent[] = [
      ...baseState().eventLedger,
      { type: "npc_met", npcId: asNpcId("npc_a"), occurredAt: FIXED_TIME, interactionKind: "greet" },
      {
        type: "narrative_scene_presented",
        sceneId: "scene-1",
        locationId: asLocationId("loc_2"),
        focusNpcId: asNpcId("npc_a"),
        revealedFactIds: [],
        pacing: "develop",
        occurredAt: FIXED_TIME,
      },
    ];
    const memory = reconcileStoryMemory({ state: baseState({ eventLedger: ledger }) });
    expect(memory.npcContacts.find((entry) => entry.npcId === asNpcId("npc_a"))).toMatchObject({
      lastContactTurn: 2,
      lastLocationId: asLocationId("loc_2"),
      lastInteractionSummary: "你初次结识了这位NPC。",
    });
  });

  it("旧存档无 interactionKind 时不生成摘要", () => {
    const ledger: GameEvent[] = [
      ...baseState().eventLedger,
      { type: "npc_met", npcId: asNpcId("npc_a"), occurredAt: FIXED_TIME },
    ];
    const state = baseState({ eventLedger: ledger });
    const memory = reconcileStoryMemory({ state });
    const contact = memory.npcContacts.find((c) => c.npcId === asNpcId("npc_a"));
    expect(contact?.lastInteractionSummary).toBeUndefined();
  });
});
