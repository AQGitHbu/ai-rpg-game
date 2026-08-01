/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId } from "@/game/domain";
import type { GameRecord } from "../server/persistence/gameRepository"; // GameRecord 在 gameRepository 定义，domain 不导出
import type { ScenarioBlueprint } from "@/game/domain";
import type { GameState } from "@/game/domain";
import { buildStoryEvalInput, hashStringToSeed, isExploratory, mulberry32, pickNarrativeChoice } from "./storyEvalStrategy";

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
});

describe("pickNarrativeChoice", () => {
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

describe("buildStoryEvalInput", () => {
  it("产出合法 long 输入（满足 domain 校验下限）", () => {
    const { input } = buildStoryEvalInput("long", 1);
    expect(input.gameLength).toBe("long");
    expect(input.worldPremise.length).toBeGreaterThanOrEqual(20);
    expect(input.storyOpening.length).toBeGreaterThanOrEqual(20);
    expect(input.personalityTags.length).toBeLessThanOrEqual(3);
  });
});
