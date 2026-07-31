import { describe, expect, it } from "vitest";
import {
  asEnemyId,
  asFactId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId
} from "./scenarioBlueprint";
import {
  STORY_MEMORY_RECENT_LIMIT,
  STORY_MEMORY_VERSION,
  createEmptyStoryMemory,
  storyMemoryOf,
  type NpcContinuityMemory,
  type StoryMemoryEntry,
  type StoryMemoryState,
  type StoryPacing
} from "./storyMemory";

// Phase 11 领域契约：版本化、有界的结构化剧情记忆。domain 纯函数，不读 IO/时钟/随机。
// 见 docs/superpowers/specs/2026-07-31-phase-11-story-continuity-structured-memory.md §4。

describe("createEmptyStoryMemory / storyMemoryOf (Phase 11 domain)", () => {
  it("新局空 memory 为 v1、cursor=0、recent 与 npcContacts 均空", () => {
    const memory = createEmptyStoryMemory();
    expect(memory.version).toBe(STORY_MEMORY_VERSION);
    expect(memory.reducedThroughEventCount).toBe(0);
    expect(memory.recent).toEqual([]);
    expect(memory.npcContacts).toEqual([]);
  });

  it("STORY_MEMORY_VERSION 为 1、STORY_MEMORY_RECENT_LIMIT 为 12（有界记忆契约）", () => {
    expect(STORY_MEMORY_VERSION).toBe(1);
    expect(STORY_MEMORY_RECENT_LIMIT).toBe(12);
  });

  it("storyMemoryOf 对缺省 storyMemory 返回同构空 memory（旧存档兼容）", () => {
    expect(storyMemoryOf({ storyMemory: undefined })).toEqual(createEmptyStoryMemory());
  });

  it("storyMemoryOf 对已存在 memory 原样返回", () => {
    const memory: StoryMemoryState = {
      ...createEmptyStoryMemory(),
      reducedThroughEventCount: 3
    };
    expect(storyMemoryOf({ storyMemory: memory })).toBe(memory);
  });
});

describe("StoryMemoryEntry variants match Spec §4 (structural indexes only)", () => {
  it("每个 kind 都可由结构索引构造、且不携带 AI 文案或 token", () => {
    const entries: StoryMemoryEntry[] = [
      { kind: "location", locationId: asLocationId("loc_1"), turn: 1 },
      { kind: "npc", npcId: asNpcId("npc_a"), locationId: asLocationId("loc_1"), turn: 2 },
      { kind: "fact", factId: asFactId("fact_a"), turn: 3 },
      { kind: "quest", questId: asQuestId("m1"), status: "unlocked", turn: 4 },
      { kind: "quest", questId: asQuestId("m1"), status: "completed", turn: 5 },
      { kind: "quest", questId: asQuestId("m1"), status: "failed", turn: 6 },
      { kind: "item", itemId: asItemId("item_a"), locationId: asLocationId("loc_1"), turn: 7 },
      { kind: "battle", enemyId: asEnemyId("enemy_a"), outcome: "victory", turn: 8 },
      { kind: "battle", enemyId: asEnemyId("enemy_a"), outcome: "defeat", turn: 9 },
      { kind: "battle", enemyId: asEnemyId("enemy_a"), outcome: "withdraw", turn: 10 },
      {
        kind: "scene",
        sceneId: "scene-1",
        locationId: asLocationId("loc_1"),
        focusNpcId: asNpcId("npc_a"),
        pacing: "develop" as StoryPacing,
        turn: 11
      },
      {
        kind: "scene",
        sceneId: "scene-2",
        locationId: asLocationId("loc_1"),
        focusNpcId: null,
        pacing: "climax" as StoryPacing,
        turn: 12
      }
    ];

    // 仅结构索引；任一条目都不含叙事文本、choiceToken、actionKey 或 provider 字段。
    for (const entry of entries) {
      const keys = Object.keys(entry);
      expect(keys).not.toContain("narration");
      expect(keys).not.toContain("prose");
      expect(keys).not.toContain("choiceToken");
      expect(keys).not.toContain("actionKey");
    }

    expect(entries.map((entry) => entry.kind)).toEqual([
      "location",
      "npc",
      "fact",
      "quest",
      "quest",
      "quest",
      "item",
      "battle",
      "battle",
      "battle",
      "scene",
      "scene"
    ]);
  });

  it("NpcContinuityMemory 只记录 npcId、最后接触回合与地点", () => {
    const contact: NpcContinuityMemory = {
      npcId: asNpcId("npc_a"),
      lastContactTurn: 3,
      lastLocationId: asLocationId("loc_1")
    };
    expect(Object.keys(contact).sort()).toEqual(["lastContactTurn", "lastLocationId", "npcId"]);
  });
});
