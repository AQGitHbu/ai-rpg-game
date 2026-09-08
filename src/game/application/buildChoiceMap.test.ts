import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, expect, it } from "vitest";
import { buildChoiceMap } from "./buildChoiceMap";
import { deriveRuntimeChoiceToken } from "./runtimeChoiceToken";
import type { WorldState, LocationEntry, NpcEntry, EnemyEntry, ItemEntry } from "@/game/domain/worldState";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import {
  createWorldStateFixtureWith,
  type WorldStateFixtureOverrides,
} from "@/game/domain/testing/worldStateFixture.testutil";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { NarrativeSceneState, NarrativeChoiceState, NarrativeRuntimeState } from "@/game/domain/narrative";
import type { ApprovedChoice } from "@/game/domain/approvedChoice";
import { createApprovedChoice } from "@/game/domain/approvedChoice";
import { asEndingId, asEnemyId, asFactId, asGenerationId, asItemId, asLocationId, asNpcId, asQuestId } from "@/game/domain/worldEntity";
import type { Action } from "@/game/domain/action";
import { ENEMY_COMBAT_STATS, PLAYER_COMBAT_STATS, toStatBlock } from "@/game/domain/combat";
import { buildEncounter } from "@/game/gameplay/rpg/ruleEngine/buildEncounter";
import { createTurnOrder } from "@/game/gameplay/rpg/ruleEngine/combatMath";

// ---------------------------------------------------------------------------
// Fixture：客栈？(loc_1) 有铁匠，街道(loc_2) 连通且解锁，雾谷村(loc_3) 锁定；
// 井边钥匙在 loc_1 可拾取，灰狼在 loc_1。
// ---------------------------------------------------------------------------

const loc1: LocationEntry = {
  id: asLocationId("loc_1"), name: "雾谷村", description: "d", kind: "main",
  connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [asItemId("item_well_key")], tags: [],
};
const loc2: LocationEntry = {
  id: asLocationId("loc_2"), name: "街道", description: "d", kind: "main",
  connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
};
const smith: NpcEntry = {
  id: asNpcId("npc_smith"), name: "铁匠老王", role: "铁匠", description: "d",
  locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
  memory: {
    npcId: asNpcId("npc_smith"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
    relationship: { affinity: 0 }, emotion: "neutral", goals: [],
  },
};
const wolf: EnemyEntry = {
  id: asEnemyId("enemy_wolf"), name: "灰狼", tier: "normal",
  stats: { hp: 30, attack: 8, defense: 2 }, locationId: asLocationId("loc_1"), tags: [],
};
const wellKey: ItemEntry = {
  id: asItemId("item_well_key"), name: "井边钥匙", description: "d", kind: "key", tags: [],
};

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia",
};

const BASE_PROJECTION: EntityCompatibilityProjection = {
  player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [loc1, loc2],
  currentLocationId: loc1.id,
  unlockedLocationIds: [loc1.id, loc2.id],
  visitedLocationIds: [loc1.id],
  npcs: [smith],
  items: [wellKey],
  inventory: [],
  worldFacts: [],
  quests: [],
  enemies: [wolf],
  defeatedEnemyIds: [],
  factions: [],
};

function buildWorldState(overrides: WorldStateFixtureOverrides = {}): WorldState {
  return createWorldStateFixtureWith({ generation: GENERATION, base: BASE_PROJECTION }, overrides);
}

const talkSmith: Action = { type: "talk", npcId: asNpcId("npc_smith"), dialogueAct: "ask" };
const moveStreet: Action = { type: "move", locationId: asLocationId("loc_2") };
const attackWolf: Action = { type: "attack", enemyId: asEnemyId("enemy_wolf") };
const takeKey: Action = { type: "take_item", itemId: asItemId("item_well_key") };

function approvedFor(choice: {
  readonly sceneId: string;
  readonly basedOnRevision: number;
  readonly label: string;
  readonly action: Action;
}): ApprovedChoice {
  const result = createApprovedChoice({
    sceneId: choice.sceneId,
    basedOnRevision: choice.basedOnRevision,
    label: choice.label,
    action: choice.action,
  });
  if (!result.ok) throw new Error("bad fixture");
  return result.choice;
}

describe("buildChoiceMap", () => {
  it("世界行动候选只以 opaque token 构建：talk/move/attack/take", () => {
    // 即使有未发现线索，也不铸造泛化探索 token。
    const hookedWorld = buildWorldState({
      worldFacts: [{ factId: asFactId("fact_trace"), text: "残月密函的线索", source: "generated", discovered: false, locationId: asLocationId("loc_1") }],
    });
    const map = buildChoiceMap(hookedWorld, buildStoryState({}), 0);
    for (const action of [
      talkSmith,
      moveStreet,
      attackWolf,
      takeKey,
    ]) {
      const token = deriveRuntimeChoiceToken(action, 0);
      expect(token).toMatch(/^c_[0-9a-f]{16}$/);
      expect(map.get(token)).toEqual(action);
    }
    for (const semantic of ["talk:npc_smith", "move:loc_2", "attack:enemy_wolf", "take_item:item_well_key", "explore"]) {
      expect(map.has(semantic)).toBe(false);
    }
  });

  it("talk 候选包含 dialogueAct: 默认 ask（Task 7 类型兼容）", () => {
    const map = buildChoiceMap(buildWorldState(), buildStoryState({}), 0);
    expect(map.get(deriveRuntimeChoiceToken(talkSmith, 0))).toEqual({ type: "talk", npcId: asNpcId("npc_smith"), dialogueAct: "ask" });
  });

  it("已到访地点即使不与当前地点直接相邻也可回访", () => {
    const loc2WithDock: LocationEntry = {
      ...loc2, connectedLocationIds: [loc1.id, asLocationId("loc_3")],
    };
    const loc3: LocationEntry = {
      id: asLocationId("loc_3"), name: "旧码头", description: "d", kind: "main",
      connectedLocationIds: [loc2.id], npcIds: [], availableItemIds: [], tags: [],
    };
    const world = buildWorldState({
      locations: [loc1, loc2WithDock, loc3],
      visitedLocationIds: [loc1.id, loc3.id],
      unlockedLocationIds: [loc1.id, loc2.id, loc3.id],
    });
    const map = buildChoiceMap(world, buildStoryState({}), 0);
    expect(map.get(deriveRuntimeChoiceToken({ type: "move", locationId: loc3.id }, 0))).toEqual({ type: "move", locationId: loc3.id });
  });

  it("有物品或敌人的地点直接提供物品和战斗，不增加探索步骤", () => {
    const map = buildChoiceMap(buildWorldState(), buildStoryState({}), 0);
    expect(map.has(deriveRuntimeChoiceToken({ type: "explore" }, 0))).toBe(false);
    expect(map.has(deriveRuntimeChoiceToken(takeKey, 0))).toBe(true);
    expect(map.has(deriveRuntimeChoiceToken(attackWolf, 0))).toBe(true);
  });

  it("战斗激活时只允许 battle_action", () => {
    const ws = buildWorldState({
      battle: { status: "active", enemyId: asEnemyId("enemy_wolf"), playerHp: 90, enemyHp: 20, round: 1 },
    });
    const map = buildChoiceMap(ws, buildStoryState({}), 0);
    const actions = [
      { type: "battle_action", action: "attack" },
      { type: "battle_action", action: "guard" },
    ] as const;
    expect([...map.keys()]).toEqual(actions.map((action) => deriveRuntimeChoiceToken(action, 0)));
  });

  it("现代多单位战斗的 token 绑定当前行动者与具体目标", () => {
    const modernWorld = buildWorldState({
      player: { name: "p", identity: "i", stats: toStatBlock(PLAYER_COMBAT_STATS) },
      enemies: [{ ...wolf, stats: toStatBlock(ENEMY_COMBAT_STATS.normal) }],
    });
    const encounter = buildEncounter(modernWorld, wolf.id);
    const active = {
      status: "active" as const,
      enemyId: wolf.id,
      enemyIds: [wolf.id],
      playerHp: 100,
      enemyHp: 55,
      round: 1,
      combatants: encounter,
      turnOrder: createTurnOrder(encounter),
      turnIndex: 0,
      enemyIntents: [],
      downedEnemyIds: [],
      lastAdvance: [],
    };
    const map = buildChoiceMap({ ...modernWorld, battle: active }, buildStoryState({}), 0);
    const actions = [...map.values()].filter((action): action is Extract<Action, { type: "battle_action" }> => action.type === "battle_action");
    expect(actions.some((action) => action.action === "skill" && action.command?.targetId === "enemy:enemy_wolf")).toBe(true);
    expect(actions.every((action) => action.command?.actorId === "ally:protagonist")).toBe(true);
    expect(actions.some((action) => action.command?.targetId === "enemy_wolf")).toBe(false);
  });

  it("active battle 仍解析当前 revision 的两个 opaque registry token；stale/tampered 不解析", () => {
    const ws: WorldState = {
      ...buildWorldState(),
      battle: { status: "active", enemyId: asEnemyId("enemy_wolf"), playerHp: 90, enemyHp: 20, round: 1 },
    };
    const registry = [
      approvedFor({ sceneId: "scene-current", basedOnRevision: 3, label: "猛攻", action: { type: "battle_action", action: "attack" } }),
      approvedFor({ sceneId: "scene-current", basedOnRevision: 3, label: "防守", action: { type: "battle_action", action: "guard" } }),
    ];
    const story = buildStoryState({ registry });
    const current = buildChoiceMap(ws, story, 3);
    expect(current.get(registry[0]!.choiceToken)).toEqual({ type: "battle_action", action: "attack" });
    expect(current.get(registry[1]!.choiceToken)).toEqual({ type: "battle_action", action: "guard" });
    expect(current.has("c_tampered")).toBe(false);
    const stale = buildChoiceMap(ws, story, 4);
    expect(stale.has(registry[0]!.choiceToken)).toBe(false);
    expect(stale.has(registry[1]!.choiceToken)).toBe(false);
  });

  it("场景选项只从 choiceRegistry token 映射，不再解析 actionKey", () => {
    const registry = [
      approvedFor({ sceneId: "scene-current", basedOnRevision: 3, label: "问铁匠", action: talkSmith }),
      approvedFor({ sceneId: "scene-current", basedOnRevision: 3, label: "前往街道", action: moveStreet }),
    ];
    const story = buildStoryState({
      registry,
      choices: [
        { choiceToken: registry[0].choiceToken, label: "问铁匠" },
        { choiceToken: registry[1].choiceToken, label: "前往街道" },
      ],
    });
    const map = buildChoiceMap(buildWorldState(), story, 3);
    expect(map.get(registry[0].choiceToken)).toEqual(talkSmith);
    expect(map.get(registry[1].choiceToken)).toEqual(moveStreet);
  });

  it("未知/过期 token（不在 registry）不产生映射，即旧 actionKey 不再作为选择入口", () => {
    const map = buildChoiceMap(buildWorldState(), buildStoryState({
      choices: [{ choiceToken: "legacy-a", label: "探索" }, { choiceToken: "legacy-b", label: "旧选项" }],
    }), 0);
    expect(map.has("legacy-a")).toBe(false);
    expect(map.has("legacy-b")).toBe(false);
  });

  it("其他场景的 registry 条目不映射（token 只在当前 scene 有效）", () => {
    const registry = [
      approvedFor({ sceneId: "scene-old", basedOnRevision: 2, label: "问铁匠", action: talkSmith }),
    ];
    const story = buildStoryState({ registry });
    const map = buildChoiceMap(buildWorldState(), story, 2);
    expect(map.has(registry[0].choiceToken)).toBe(false);
  });

  it("过期 revision 的 registry 条目不映射（传入当前 revision 时）", () => {
    const registry = [
      approvedFor({ sceneId: "scene-current", basedOnRevision: 2, label: "问铁匠", action: talkSmith }),
    ];
    const story = buildStoryState({
      registry,
      choices: [{ choiceToken: registry[0].choiceToken, label: "问铁匠" }, { choiceToken: "t_b", label: "B" }],
    });
    const map = buildChoiceMap(buildWorldState(), story, 7);
    expect(map.has(registry[0].choiceToken)).toBe(false);
    const fresh = buildChoiceMap(buildWorldState(), story, 2);
    expect(fresh.get(registry[0].choiceToken)).toEqual(talkSmith);
  });

  it("registry JSON 往返后仍按 token 解析相同 Action（持久化契约）", () => {
    const registry = [
      approvedFor({ sceneId: "scene-current", basedOnRevision: 3, label: "攻击灰狼", action: attackWolf }),
    ];
    const revived = JSON.parse(JSON.stringify(registry)) as readonly ApprovedChoice[];
    const story = buildStoryState({ registry: revived });
    const map = buildChoiceMap(buildWorldState(), story, 3);
    expect(map.get(revived[0].choiceToken)).toEqual(attackWolf);
  });

  it("registry action 已不再是当前合法行动时不映射", () => {
    const registry = [approvedFor({
      sceneId: "scene-current",
      basedOnRevision: 3,
      label: "前往锁定地点",
      action: { type: "move", locationId: asLocationId("loc_3") },
    })];
    const map = buildChoiceMap(buildWorldState(), buildStoryState({ registry }), 3);
    expect(map.has(registry[0]!.choiceToken)).toBe(false);
  });
});

describe("泛化探索不再是玩家选择", () => {
  it("旧 AI 提案的探索选项不因现场有线索而恢复执行", () => {
    const exploreChoice = approvedFor({
      sceneId: "scene-current", basedOnRevision: 3,
      label: "探索客栈", action: { type: "explore" },
    });
    const storyWithChoice = buildStoryState({
      registry: [exploreChoice],
      choices: [
        { choiceToken: exploreChoice.choiceToken, label: "探索客栈" },
        { choiceToken: "t_old", label: "旧选项" },
      ],
    });
    // 旧场景中保留的探索候选不能再被提交。
    const hooked = buildChoiceMap(buildWorldState({
      worldFacts: [{ factId: asFactId("fact_trace"), text: "残月密函的线索", source: "generated", discovered: false, locationId: asLocationId("loc_1") }],
    }), storyWithChoice, 3);
    expect(hooked.has(exploreChoice.choiceToken)).toBe(false);
    // 干净地点：探索选项不映射
    const bare = buildChoiceMap(buildWorldState(), storyWithChoice, 3);
    expect(bare.has(exploreChoice.choiceToken)).toBe(false);
  });
});

describe("investigate：调查动作保留规则兼容，但不再进入当前玩家 choice map", () => {
  const approachFact = {
    factId: asFactId("fact_trace"),
    text: "泥地上有两行车辙",
    source: "generated" as const,
    discovered: false,
    locationId: asLocationId("loc_1"),
    investigationLabel: "泥地上的异常痕迹",
    investigationApproaches: [
      { approachId: "follow", label: "沿痕迹追查", evidenceQuality: "clean" as const, tensionDelta: 4 },
      { approachId: "search", label: "翻查附近杂物", evidenceQuality: "noisy" as const, tensionDelta: 12 },
    ],
  };
  const approachlessFact = {
    factId: asFactId("fact_trace_plain"),
    text: "墙角的暗记",
    source: "generated" as const,
    discovered: false,
    locationId: asLocationId("loc_1"),
    investigationLabel: "墙角的暗记",
  };

  function makeDiscoverQuest(fact: typeof approachFact | typeof approachlessFact): WorldState["quests"][number] {
    return {
      id: asQuestId("q_discover"),
      name: "查明真相",
      description: "d",
      objectives: [{ kind: "discover_fact", factId: fact.factId }],
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: [],
      kind: "main",
      stage: 1,
      status: "active",
    };
  }

  function worldWithApproaches(): WorldState {
    return buildWorldState({ worldFacts: [approachFact], quests: [makeDiscoverQuest(approachFact)] });
  }

  function worldWithApproachlessFact(): WorldState {
    return buildWorldState({ worldFacts: [approachlessFact], quests: [makeDiscoverQuest(approachlessFact)] });
  }

  function storyWithDiscoverFact(): StoryState {
    return buildStoryState({});
  }

  it("即使事实有多个已审批方式，也不铸造调查 token", () => {
    const map = buildChoiceMap(worldWithApproaches(), storyWithDiscoverFact(), 0);
    const investigate = [...map.values()].filter((action): action is Extract<Action, { type: "investigate" }> => action.type === "investigate");
    expect(investigate).toHaveLength(0);
    expect(map.has(deriveRuntimeChoiceToken({ type: "investigate", factId: asFactId("fact_trace"), approachId: "follow" }, 0))).toBe(false);
  });

  it("approach-less 事实不铸造任何 investigate token（规则层自动揭示路径）", () => {
    const map = buildChoiceMap(worldWithApproachlessFact(), storyWithDiscoverFact(), 0);
    expect([...map.values()].some((action) => action.type === "investigate")).toBe(false);
  });

  it("registry 中遗留的 investigate choice 也不再映射", () => {
    const approvedFollow = approvedFor({
      sceneId: "scene-current", basedOnRevision: 0,
      label: "沿痕迹追查", action: { type: "investigate", factId: asFactId("fact_trace"), approachId: "follow" },
    });
    const story = buildStoryState({
      registry: [approvedFollow],
      choices: [{ choiceToken: approvedFollow.choiceToken, label: "沿痕迹追查" }, { choiceToken: "t_b", label: "B" }],
    });
    const map = buildChoiceMap(worldWithApproaches(), story, 0);
    expect(map.has(approvedFollow.choiceToken)).toBe(false);
  });
});

function buildStoryState(opts: {
  readonly sceneId?: string;
  readonly choices?: readonly [NarrativeChoiceState, NarrativeChoiceState];
  readonly registry?: readonly ApprovedChoice[];
}): StoryState {
  const base = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 5, npcs: 5, events: 2, quests: 2 },
    mainThreadId: "main_thread",
  });
  const scene: NarrativeSceneState = {
    sceneId: opts.sceneId ?? "scene-current",
    turn: 0,
    narration: "n",
    usedFactIds: [],
    source: "generated",
    npcLine: null,
    choices: opts.choices ?? [
      {
        choiceToken: opts.registry?.[0]?.choiceToken ?? "t_a",
        label: opts.registry?.[0]?.label ?? "A",
      },
      {
        choiceToken: opts.registry?.[1]?.choiceToken ?? "t_b",
        label: opts.registry?.[1]?.label ?? "B",
      },
    ],
  };
  const narrative: NarrativeRuntimeState = {
    status: "ready",
    mode: "offline",
    currentScene: scene,
    choiceRegistry: opts.registry ?? [],
  };
  return { ...base, narrative };
}

// ---------------------------------------------------------------------------
// 终幕结局立场：结局包内没有可消费步骤，探索回合必然零写入失败。
// ---------------------------------------------------------------------------

const endingPair: WorldState["endings"] = [
  { id: asEndingId("ending_trust"), name: "共担真相", description: "d", requirements: [] },
  { id: asEndingId("ending_doubt"), name: "独自揭露", description: "d", requirements: [] },
];

function endingWorldState(overrides: WorldStateFixtureOverrides = {}): WorldState {
  return buildWorldState({
    // 现场物品已取走、敌人已击败：本地点不再有任何探索钩子。
    locations: [{ ...loc1, availableItemIds: [] }, loc2],
    inventory: [asItemId("item_well_key")],
    defeatedEnemyIds: [asEnemyId("enemy_wolf")],
    ...overrides,
  });
}

function endingStoryState(endingAllowed: boolean): StoryState {
  return {
    ...buildStoryState({}),
    currentAct: 3,
    targetActs: 3,
    storyProgress: 100,
    endingAllowed,
  };
}

describe("buildChoiceMap 终幕结局立场", () => {
  it("结局对已具象化时铸造两种立场，并撤下不可消费的探索回合", () => {
    const ws = endingWorldState({ endings: endingPair });
    const map = buildChoiceMap(ws, endingStoryState(true), 7);

    expect(map.get(deriveRuntimeChoiceToken(
      { type: "talk", npcId: asNpcId("npc_smith"), dialogueAct: "support" }, 7,
    ))).toEqual({ type: "talk", npcId: asNpcId("npc_smith"), dialogueAct: "support" });
    expect(map.get(deriveRuntimeChoiceToken(
      { type: "talk", npcId: asNpcId("npc_smith"), dialogueAct: "challenge" }, 7,
    ))).toEqual({ type: "talk", npcId: asNpcId("npc_smith"), dialogueAct: "challenge" });
    expect(map.has(deriveRuntimeChoiceToken({ type: "explore" }, 7))).toBe(false);
  });

  it("结局 NPC 不在场时不提供无法消费的探索兜底", () => {
    const ws = endingWorldState({
      endings: endingPair,
      npcs: [{ ...smith, locationId: asLocationId("loc_2") }],
    });
    const map = buildChoiceMap(ws, endingStoryState(true), 7);

    expect(map.has(deriveRuntimeChoiceToken(
      { type: "talk", npcId: asNpcId("npc_smith"), dialogueAct: "support" }, 7,
    ))).toBe(false);
    expect(map.has(deriveRuntimeChoiceToken({ type: "explore" }, 7))).toBe(false);
  });

  it("结局对尚未具象化时既不铸造立场也不开放结局探索", () => {
    const ws = endingWorldState();
    const map = buildChoiceMap(ws, endingStoryState(true), 7);

    expect(map.has(deriveRuntimeChoiceToken(
      { type: "talk", npcId: asNpcId("npc_smith"), dialogueAct: "support" }, 7,
    ))).toBe(false);
    expect(map.has(deriveRuntimeChoiceToken({ type: "explore" }, 7))).toBe(false);
  });
});
