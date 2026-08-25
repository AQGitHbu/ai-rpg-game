import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, expect, it } from "vitest";
import { buildChoiceMap, hasExplorableContent } from "./buildChoiceMap";
import { deriveRuntimeChoiceToken } from "./runtimeChoiceToken";
import type { WorldState, LocationEntry, NpcEntry, EnemyEntry, ItemEntry } from "@/game/domain/worldState";
import {
  createInitialWorldState,
  appendLocation,
  appendNpc,
  appendEnemy,
  appendItem,
} from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { NarrativeSceneState, NarrativeChoiceState, NarrativeRuntimeState } from "@/game/domain/narrative";
import type { ApprovedChoice } from "@/game/domain/approvedChoice";
import { createApprovedChoice } from "@/game/domain/approvedChoice";
import { asEnemyId, asFactId, asGenerationId, asItemId, asLocationId, asNpcId, asQuestId } from "@/game/domain/worldEntity";
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

function buildWorldState(): WorldState {
  let ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  ws = appendLocation(ws, loc2);
  ws = appendNpc(ws, smith);
  ws = appendItem(ws, wellKey);
  ws = appendEnemy(ws, wolf);
  return { ...ws, unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
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
  it("世界行动候选只以 opaque token 构建：talk/move/attack/take/explore", () => {
    // 本地点有未发现线索事实 → explore 为合法世界行动（有剧情钩子）。
    const hookedWorld = {
      ...buildWorldState(),
      worldFacts: [{ factId: asFactId("fact_trace"), text: "残月密函的线索", source: "generated" as const, discovered: false, locationId: asLocationId("loc_1") }],
    };
    const map = buildChoiceMap(hookedWorld, buildStoryState({}), 0);
    for (const action of [
      talkSmith,
      moveStreet,
      attackWolf,
      takeKey,
      { type: "explore" } as const,
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
    const loc3: LocationEntry = {
      id: asLocationId("loc_3"), name: "旧码头", description: "d", kind: "main",
      connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
    };
    const world = {
      ...buildWorldState(),
      locations: [...buildWorldState().locations, loc3],
      currentLocationId: asLocationId("loc_1"),
      visitedLocationIds: [asLocationId("loc_1"), asLocationId("loc_3")],
      unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2"), asLocationId("loc_3")],
    };
    const map = buildChoiceMap(world, buildStoryState({}), 0);
    expect(map.get(deriveRuntimeChoiceToken({ type: "move", locationId: loc3.id }, 0))).toEqual({ type: "move", locationId: loc3.id });
  });

  it("有物品或敌人的地点允许先探索再处理实体", () => {
    expect(hasExplorableContent(buildWorldState(), buildStoryState({}))).toBe(true);
  });

  it("战斗激活时只允许 battle_action", () => {
    const ws: WorldState = {
      ...buildWorldState(),
      battle: { status: "active", enemyId: asEnemyId("enemy_wolf"), playerHp: 90, enemyHp: 20, round: 1 },
    };
    const map = buildChoiceMap(ws, buildStoryState({}), 0);
    const actions = [
      { type: "battle_action", action: "attack" },
      { type: "battle_action", action: "guard" },
    ] as const;
    expect([...map.keys()]).toEqual(actions.map((action) => deriveRuntimeChoiceToken(action, 0)));
  });

  it("现代多单位战斗的 token 绑定当前行动者与具体目标", () => {
    const base = buildWorldState();
    const modernWorld: WorldState = {
      ...base,
      player: { ...base.player, stats: toStatBlock(PLAYER_COMBAT_STATS) },
      enemies: [{ ...wolf, stats: toStatBlock(ENEMY_COMBAT_STATS.normal) }],
    };
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

describe("hasExplorableContent（方案 1：有剧情钩子才允许探索）", () => {
  // 干净地点：无物品、无敌人、无事实、无任务、无候选事件。
  function bareWorld(): WorldState {
    const ws = buildWorldState();
    return {
      ...ws,
      locations: ws.locations.map((l) =>
        l.id === asLocationId("loc_1") ? { ...l, availableItemIds: [] } : l,
      ),
      enemies: [],
    };
  }

  it("无任何钩子的地点不可探索", () => {
    expect(hasExplorableContent(bareWorld(), buildStoryState({}))).toBe(false);
    const map = buildChoiceMap(bareWorld(), buildStoryState({}), 0);
    expect(map.has(deriveRuntimeChoiceToken({ type: "explore" }, 0))).toBe(false);
  });

  it("本地点仅有未拾取物品（无线索/目标/候选事件）→ 可先探索再拾取", () => {
    const itemOnlyWorld = {
      ...bareWorld(),
      locations: bareWorld().locations.map((location) =>
        location.id === asLocationId("loc_1")
          ? { ...location, availableItemIds: [asItemId("item_well_key")] }
          : location,
      ),
    };
    expect(hasExplorableContent(itemOnlyWorld, buildStoryState({}))).toBe(true);
  });

  it("本地点有未发现的线索事实 → 可探索；事实已发现 → 不可探索", () => {
    const fact = { factId: asFactId("fact_trace"), text: "残月密函的线索", source: "generated" as const, discovered: false, locationId: asLocationId("loc_1") };
    const withFact = { ...bareWorld(), worldFacts: [fact] };
    expect(hasExplorableContent(withFact, buildStoryState({}))).toBe(true);
    const withDiscovered = { ...withFact, worldFacts: [{ ...fact, discovered: true }] };
    expect(hasExplorableContent(withDiscovered, buildStoryState({}))).toBe(false);
  });

  it("active 任务有指向本地点的未满足 visit_location 目标 → 可探索", () => {
    const quest = {
      id: asQuestId("q_1"), name: "探查客栈", description: "d", kind: "main" as const,
      status: "active" as const,
      objectives: [{ kind: "visit_location" as const, locationId: asLocationId("loc_1") }],
      onSuccess: { kind: "closed" as const }, onFailure: { kind: "closed" as const }, tags: [],
    };
    const ws = {
      ...bareWorld(),
      quests: [quest],
      visitedLocationIds: [],
    };
    expect(hasExplorableContent(ws, buildStoryState({}))).toBe(true);
    // 已访问后不再因该目标可探索
    expect(hasExplorableContent({ ...ws, visitedLocationIds: [asLocationId("loc_1")] }, buildStoryState({}))).toBe(false);
  });

  it("候选事件涉及当前地点（未过期）→ 可探索", () => {
    const candidate = {
      id: "cand_1", kind: "enemy_appears" as const,
      involvedEntityIds: [asEnemyId("enemy_wolf"), asLocationId("loc_1")],
      prerequisiteFactIds: [],
      proposedEffects: [{ kind: "enemy_appears" as const, enemyId: asEnemyId("enemy_wolf"), locationId: asLocationId("loc_1") }],
      intendedPacing: "escalate" as const, reason: "探子回报", proposedAtTurn: 1, expiresAtTurn: 5,
    };
    const story = { ...buildStoryState({}), candidateEventPool: [candidate] };
    expect(hasExplorableContent(bareWorld(), story)).toBe(true);
  });

  it("候选事件只涉及其他地点 → 当前地点不可探索", () => {
    const candidate = {
      id: "cand_2", kind: "enemy_appears" as const,
      involvedEntityIds: [asEnemyId("enemy_wolf"), asLocationId("loc_2")],
      prerequisiteFactIds: [],
      proposedEffects: [{ kind: "enemy_appears" as const, enemyId: asEnemyId("enemy_wolf"), locationId: asLocationId("loc_2") }],
      intendedPacing: "escalate" as const, reason: "别处动静", proposedAtTurn: 1, expiresAtTurn: 5,
    };
    const story = { ...buildStoryState({}), candidateEventPool: [candidate] };
    expect(hasExplorableContent(bareWorld(), story)).toBe(false);
  });

  it("过期候选事件不再构成可探索钩子", () => {
    const candidate = {
      id: "cand_3", kind: "enemy_appears" as const,
      involvedEntityIds: [asEnemyId("enemy_wolf"), asLocationId("loc_1")],
      prerequisiteFactIds: [],
      proposedEffects: [{ kind: "enemy_appears" as const, enemyId: asEnemyId("enemy_wolf"), locationId: asLocationId("loc_1") }],
      intendedPacing: "escalate" as const, reason: "早先探报", proposedAtTurn: 1, expiresAtTurn: 3,
    };
    const story = { ...buildStoryState({}), candidateEventPool: [candidate], turnNumber: 4 };
    expect(hasExplorableContent(bareWorld(), story)).toBe(false);
  });

  it("有钩子时 AI 提案的探索场景选项经 registry 映射（无钩子时不映射）", () => {
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
    // 有未发现线索事实钩子的世界：探索选项可解析
    const hooked = buildChoiceMap({
      ...buildWorldState(),
      worldFacts: [{ factId: asFactId("fact_trace"), text: "残月密函的线索", source: "generated" as const, discovered: false, locationId: asLocationId("loc_1") }],
    }, storyWithChoice, 3);
    expect(hooked.get(exploreChoice.choiceToken)).toEqual({ type: "explore" });
    // 干净地点：探索选项不映射
    const bare = buildChoiceMap(bareWorld(), storyWithChoice, 3);
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
    return { ...buildWorldState(), worldFacts: [approachFact], quests: [makeDiscoverQuest(approachFact)] };
  }

  function worldWithApproachlessFact(): WorldState {
    return { ...buildWorldState(), worldFacts: [approachlessFact], quests: [makeDiscoverQuest(approachlessFact)] };
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
