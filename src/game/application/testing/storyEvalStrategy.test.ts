/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId } from "@/game/domain";
import type { GameRecord } from "../server/persistence/gameRepository"; // GameRecord 在 gameRepository 定义，domain 不导出
import type { ScenarioBlueprint } from "@/game/domain";
import type { GameState } from "@/game/domain";
import { hashStringToSeed, isExploratory, mulberry32, pickNarrativeChoice, pickObjectiveChoice } from "./storyEvalStrategy";

describe("mulberry32", () => {
  it("同种子产出同一序列，不同种子序列不同", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    const seqC = [c(), c(), c()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const value of seqA) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("hashStringToSeed", () => {
  it("稳定且区分输入", () => {
    expect(hashStringToSeed("abc")).toBe(hashStringToSeed("abc"));
    expect(hashStringToSeed("abc")).not.toBe(hashStringToSeed("abd"));
  });
});

function makeRecord(overrides: Partial<GameState> = {}): GameRecord {
  const blueprint = {
    schemaVersion: 1,
    generationId: "g",
    seed: "seed-x",
    templateVersion: "tpl",
    inputDigest: "d",
    gameType: "wuxia",
    world: { name: "W", summary: "S", tone: "dark", themes: [], facts: [] },
    locations: [{ id: asLocationId("loc_a"), name: "A", description: "", kind: "public", connectedLocationIds: [] }],
    npcs: [],
    quests: [],
    enemies: [],
    items: [],
    endings: [],
    player: { name: "P", identity: "I", startingItemIds: [], baseStats: { hp: 10, attack: 1, defense: 1 } },
    openingScene: { locationId: asLocationId("loc_a"), narration: "n", suggestedActions: [], presentNpcIds: [], investigableFactIds: [] },
  } as unknown as ScenarioBlueprint;
  const state = {
    stateVersion: 1,
    generation: { generationId: "g", seed: "seed-x", templateVersion: "tpl", inputDigest: "d", gameType: "wuxia" },
    player: { name: "P", identity: "I", stats: { hp: 10, attack: 1, defense: 1 } },
    currentLocationId: asLocationId("loc_a"),
    unlockedLocationIds: [asLocationId("loc_a")],
    visitedLocationIds: [asLocationId("loc_a")],
    npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_a"), met: false }],
    quests: [],
    inventory: [],
    worldFacts: [{ factId: asFactId("fact_1"), discovered: false }],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: {
      currentScene: {
        sceneId: "s1",
        turn: 1,
        narration: "n",
        usedFactIds: [],
        npcLine: null,
        choices: [
          { choiceToken: "c1", label: "探索新地点", actionKey: "move:loc_b" },
          { choiceToken: "c2", label: "留在原地", actionKey: "observe:loc_a" },
        ],
        source: "generated",
      },
      generation: { status: "idle" },
      mode: "ai",
    },
    eventLedger: [],
    ...overrides,
  } as unknown as GameState;
  return { gameId: "game-1" as never, blueprint, state, revision: 0, createdAt: "2026-07-31T00:00:00.000Z" };
}

describe("isExploratory", () => {
  it("move 到未访问地点、talk 未见 NPC、investigate 未发现事实、take_item 均为探索", () => {
    const record = makeRecord();
    expect(isExploratory("move:loc_b", record)).toBe(true);
    expect(isExploratory("talk:npc_1", record)).toBe(true);
    expect(isExploratory("investigate:fact_1", record)).toBe(true);
    expect(isExploratory("take_item:item_1", record)).toBe(true);
    expect(isExploratory("observe:loc_a", record)).toBe(false);
    expect(isExploratory("start_battle:enemy_1", record)).toBe(false);
  });

  it("已访问地点/已见 NPC/已发现事实不算探索", () => {
    const record = makeRecord({
      visitedLocationIds: [asLocationId("loc_a"), asLocationId("loc_b")],
      npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_a"), met: true }],
      worldFacts: [{ factId: asFactId("fact_1"), discovered: true }],
    });
    expect(isExploratory("move:loc_b", record)).toBe(false);
    expect(isExploratory("talk:npc_1", record)).toBe(false);
    expect(isExploratory("investigate:fact_1", record)).toBe(false);
  });

  it("不会把尚未解锁的主线目标当作探索动作提前完成", () => {
    const record = makeRecord({
      quests: [{ questId: "main-1", status: "active" } as never, { questId: "main-2", status: "locked" } as never],
    });
    const blueprint = {
      ...record.blueprint,
      quests: [{
        id: "main-1", kind: "main", objectives: [{ kind: "visit_location", locationId: "loc_a" }],
      }, {
        id: "main-2", kind: "main", objectives: [{ kind: "obtain_item", itemId: "item_key" }],
      }],
    } as never;
    const futureObjectiveRecord = { ...record, blueprint } as never;
    expect(isExploratory("take_item:item_key", futureObjectiveRecord)).toBe(false);
  });
});

describe("pickNarrativeChoice", () => {
  it("两个选项都非探索时仍避开尚未解锁的主线目标", () => {
    const base = makeRecord({
      quests: [{ questId: "main-1", status: "active" } as never, { questId: "main-2", status: "locked" } as never],
      narrative: {
        currentScene: {
          sceneId: "s-safe",
          turn: 1,
          narration: "n",
          usedFactIds: [],
          npcLine: null,
          choices: [
            { choiceToken: "c1", label: "提前拿取", actionKey: "take_item:item_key" },
            { choiceToken: "c2", label: "观察", actionKey: "observe:loc_a" },
          ],
          source: "generated",
        },
        generation: { status: "idle" },
        mode: "ai",
      },
    });
    const record = {
      ...base,
      blueprint: {
        ...base.blueprint,
        quests: [{ id: "main-1", kind: "main", objectives: [] }, { id: "main-2", kind: "main", objectives: [{ kind: "obtain_item", itemId: "item_key" }] }],
      },
    } as never;
    expect(pickNarrativeChoice(record, () => 0)).toEqual({ index: 1, reason: "random" });
  });

  it("恰好一个探索选项时必选它", () => {
    const record = makeRecord();
    const pick = pickNarrativeChoice(record, () => 0.99);
    expect(pick).toEqual({ index: 0, reason: "explore" });
  });

  it("两个都是探索选项时用 PRNG 掷硬币", () => {
    const record = makeRecord({
      narrative: {
        currentScene: {
          sceneId: "s2",
          turn: 1,
          narration: "n",
          usedFactIds: [],
          npcLine: null,
          choices: [
            { choiceToken: "c1", label: "A", actionKey: "move:loc_b" },
            { choiceToken: "c2", label: "B", actionKey: "take_item:item_1" },
          ],
          source: "generated",
        },
        generation: { status: "idle" },
        mode: "ai",
      },
    } as never);
    expect(pickNarrativeChoice(record, () => 0.2).index).toBe(0);
    expect(pickNarrativeChoice(record, () => 0.8).index).toBe(1);
    expect(pickNarrativeChoice(record, () => 0.5).reason).toBe("explore");
  });

  it("无探索选项时随机，reason=random", () => {
    const record = makeRecord({
      narrative: {
        currentScene: {
          sceneId: "s3",
          turn: 1,
          narration: "n",
          usedFactIds: [],
          npcLine: null,
          choices: [
            { choiceToken: "c1", label: "A", actionKey: "observe:loc_a" },
            { choiceToken: "c2", label: "B", actionKey: "start_battle:enemy_1" },
          ],
          source: "generated",
        },
        generation: { status: "idle" },
        mode: "ai",
      },
    } as never);
    expect(pickNarrativeChoice(record, () => 0.2)).toEqual({ index: 0, reason: "random" });
  });
});

describe("pickObjectiveChoice", () => {
  function objectiveRecord(overrides: Partial<GameState> = {}): GameRecord {
    const base = makeRecord();
    const record = {
      ...base,
      blueprint: {
        ...base.blueprint,
        quests: [
          {
            id: "q_main" as never,
            kind: "main",
            stage: 1,
            name: "主线",
            description: "",
            objectives: [
              { kind: "take_item", itemId: "item_key", label: "取得钥匙" },
              { kind: "talk_to_npc", npcId: "npc_1", label: "询问" },
            ],
          },
          {
            id: "q_side" as never,
            kind: "side",
            name: "支线",
            description: "",
            objectives: [{ kind: "visit_location", locationId: "loc_b", label: "造访" }],
          },
        ],
      } as unknown as ScenarioBlueprint,
      state: {
        ...base.state,
        quests: [
          { questId: "q_main" as never, status: "active", objectives: [{ kind: "take_item", itemId: "item_key", satisfied: false }] },
          { questId: "q_side" as never, status: "active", objectives: [{ kind: "visit_location", locationId: "loc_b", satisfied: false }] },
        ],
        ...overrides,
      } as unknown as GameState,
    };
    return record;
  }

  it("active 主线任务目标对应的选项最高优先（objective:main_*）", () => {
    const record = objectiveRecord({
      narrative: {
        ...makeRecord().state.narrative,
        currentScene: {
          sceneId: "s4",
          turn: 1,
          narration: "n",
          usedFactIds: [],
          npcLine: null,
          choices: [
            { choiceToken: "c1", label: "翻找", actionKey: "observe:loc_a" },
            { choiceToken: "c2", label: "拿走钥匙", actionKey: "take_item:item_key" },
          ],
          source: "generated",
        },
      },
    });
    expect(pickObjectiveChoice(record, () => 0.99)).toEqual({ index: 1, reason: "objective:main_item" });
  });

  it("无任务目标命中时降级到探索 talk（objective:talk）", () => {
    const record = objectiveRecord({
      quests: [],
      narrative: {
        ...makeRecord().state.narrative,
        currentScene: {
          sceneId: "s5",
          turn: 1,
          narration: "n",
          usedFactIds: [],
          npcLine: null,
          choices: [
            { choiceToken: "c1", label: "搭话", actionKey: "talk:npc_1" },
            { choiceToken: "c2", label: "观察", actionKey: "observe:loc_a" },
          ],
          source: "generated",
        },
      },
    });
    expect(pickObjectiveChoice(record, () => 0.99)).toEqual({ index: 0, reason: "objective:talk" });
  });
});
