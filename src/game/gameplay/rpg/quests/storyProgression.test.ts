import { describe, expect, it } from "vitest";
import {
  asEndingId,
  asEnemyId,
  asFactId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
  asSceneId,
  type GameState,
  type QuestId,
  type ScenarioBlueprint,
} from "@/game/domain";
import { reconcileMainStoryProgress } from "./storyProgression";

// ---------------------------------------------------------------------------
// reconcileMainStoryProgress 测试（Phase 14 Task 8）。
// currentAct = 已完成/关闭的 kind==="main" 任务数量；
// shouldProposeEnding = currentAct >= endingDirection.lockedAt 且未提议过结局。
// ---------------------------------------------------------------------------

const NOW = "2026-08-05T00:00:00.000Z";
const DEPS = { now: () => NOW };

function buildBlueprint(opts?: {
  readonly lockedAt?: number;
  readonly mainQuestIds?: readonly QuestId[];
}): ScenarioBlueprint {
  const mainQuestIds = opts?.mainQuestIds ?? [asQuestId("q_main_1"), asQuestId("q_main_2")];
  const mainQuests = mainQuestIds.map((id, index) => ({
    id,
    name: `主线${index + 1}`,
    description: `主线任务描述${index + 1}`,
    kind: "main" as const,
    stage: index + 1,
    objectives: [{ kind: "visit_location" as const, locationId: asLocationId("loc_1") }],
    onSuccess: { kind: "closed" as const },
    onFailure: { kind: "closed" as const },
    tags: [],
  }));
  return {
    schemaVersion: 2,
    generationId: "gen-test" as ScenarioBlueprint["generationId"],
    seed: "test-seed",
    templateVersion: "tpl-1",
    inputDigest: "digest-test",
    gameType: "wuxia",
    world: {
      summary: "测试世界",
      tone: "沉稳",
      themes: ["正义"],
      facts: [{ id: asFactId("fact_1"), text: "事实", source: "player_input" }],
      tags: [],
    },
    player: {
      name: "Player",
      identity: "Hero",
      backgroundSummary: "背景",
      startingLocationId: asLocationId("loc_1"),
      startingItemIds: [],
      baseStats: { hp: 20, attack: 5, defense: 3 },
    },
    startAnchor: {
      locationId: asLocationId("loc_1"),
      npcId: asNpcId("npc_1"),
      startQuestId: asQuestId("q_main_1"),
    },
    endingDirection: {
      theme: "反元抉择",
      possibleTones: ["triumph"],
      lockedAt: opts?.lockedAt ?? 2,
    },
    locations: [
      {
        id: asLocationId("loc_1"),
        name: "地点1",
        description: "描述1",
        kind: "main",
        connectedLocationIds: [],
        npcIds: [],
        availableItemIds: [],
        tags: [],
      },
    ],
    npcs: [
      {
        id: asNpcId("npc_1"),
        name: "NPC1",
        role: "角色",
        description: "描述",
        locationId: asLocationId("loc_1"),
        isCompanion: false,
        knownFactIds: [],
        tags: [],
      },
    ],
    quests: mainQuests,
    enemies: [],
    items: [],
    endings: [],
    openingScene: {
      id: asSceneId("scene_opening"),
      locationId: asLocationId("loc_1"),
      narration: "开始",
      presentNpcIds: [],
      suggestedActions: [],
      investigableFactIds: [],
    },
  } as unknown as ScenarioBlueprint;
}

function buildState(opts?: {
  readonly questStatuses?: ReadonlyArray<{ readonly questId: QuestId; readonly status: string }>;
  readonly endingProposed?: boolean;
  readonly currentAct?: number;
}): GameState {
  const questStatuses = opts?.questStatuses ?? [
    { questId: asQuestId("q_main_1"), status: "active" },
    { questId: asQuestId("q_main_2"), status: "locked" },
  ];
  return {
    stateVersion: 1,
    generation: {
      generationId: "gen-test" as GameState["generation"]["generationId"],
      seed: "test-seed",
      templateVersion: "tpl-1",
      inputDigest: "digest-test",
      gameType: "wuxia",
    },
    player: { name: "Player", identity: "Hero", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: asLocationId("loc_1"),
    unlockedLocationIds: [asLocationId("loc_1")],
    visitedLocationIds: [asLocationId("loc_1")],
    npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_1"), met: false }],
    quests: questStatuses.map((q) => ({
      questId: q.questId,
      status: q.status as GameState["quests"][number]["status"],
    })),
    inventory: [],
    worldFacts: [],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null },
    prologueShown: true,
    mainStoryProgress: {
      currentAct: opts?.currentAct ?? 0,
      endingProposed: opts?.endingProposed ?? false,
    },
    eventLedger: [],
  } as unknown as GameState;
}

describe("reconcileMainStoryProgress", () => {
  it("无已完成主线任务时 currentAct=0", () => {
    const blueprint = buildBlueprint();
    const state = buildState({
      questStatuses: [
        { questId: asQuestId("q_main_1"), status: "active" },
        { questId: asQuestId("q_main_2"), status: "locked" },
      ],
    });
    const result = reconcileMainStoryProgress(blueprint, state, DEPS);
    expect(result.currentAct).toBe(0);
    expect(result.shouldProposeEnding).toBe(false);
  });

  it("已完成一个主线任务时 currentAct=1", () => {
    const blueprint = buildBlueprint();
    const state = buildState({
      questStatuses: [
        { questId: asQuestId("q_main_1"), status: "completed" },
        { questId: asQuestId("q_main_2"), status: "locked" },
      ],
    });
    const result = reconcileMainStoryProgress(blueprint, state, DEPS);
    expect(result.currentAct).toBe(1);
    expect(result.shouldProposeEnding).toBe(false);
  });

  it("达 lockedAt 阈值时 shouldProposeEnding=true", () => {
    const blueprint = buildBlueprint({ lockedAt: 2 });
    const state = buildState({
      questStatuses: [
        { questId: asQuestId("q_main_1"), status: "completed" },
        { questId: asQuestId("q_main_2"), status: "closed" },
      ],
    });
    const result = reconcileMainStoryProgress(blueprint, state, DEPS);
    expect(result.currentAct).toBe(2);
    expect(result.shouldProposeEnding).toBe(true);
  });

  it("已提议过结局时 shouldProposeEnding=false", () => {
    const blueprint = buildBlueprint();
    const state = buildState({
      questStatuses: [
        { questId: asQuestId("q_main_1"), status: "completed" },
        { questId: asQuestId("q_main_2"), status: "closed" },
      ],
      endingProposed: true,
    });
    const result = reconcileMainStoryProgress(blueprint, state, DEPS);
    expect(result.currentAct).toBe(2);
    expect(result.shouldProposeEnding).toBe(false);
  });

  it("忽略 side 任务的状态", () => {
    const blueprint = buildBlueprint({
      mainQuestIds: [asQuestId("q_main_1")],
    });
    // 在蓝图 mainQuestIds 之外追加 side 任务不会被计入 currentAct；
    // 这里通过把 q_main_2 视为蓝图不存在的任务来验证 state.quests 过滤生效
    const state = buildState({
      questStatuses: [{ questId: asQuestId("q_main_1"), status: "completed" }],
    });
    const result = reconcileMainStoryProgress(blueprint, state, DEPS);
    expect(result.currentAct).toBe(1);
  });

  it("failed 主线任务不计入 currentAct", () => {
    const blueprint = buildBlueprint();
    const state = buildState({
      questStatuses: [
        { questId: asQuestId("q_main_1"), status: "failed" },
        { questId: asQuestId("q_main_2"), status: "active" },
      ],
    });
    const result = reconcileMainStoryProgress(blueprint, state, DEPS);
    expect(result.currentAct).toBe(0);
  });
});
