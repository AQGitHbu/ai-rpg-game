import { describe, expect, it } from "vitest";
import { buildChoiceMap } from "./buildChoiceMap";
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
import { asEnemyId, asGenerationId, asItemId, asLocationId, asNpcId } from "@/game/domain/scenarioBlueprint";
import type { Action } from "@/game/domain/action";

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
  it("世界行动候选直接构建：talk/move/attack/take/explore/rest", () => {
    const map = buildChoiceMap(buildWorldState(), buildStoryState({}), 0);
    expect(map.get("talk:npc_smith")).toEqual(talkSmith);
    expect(map.get("move:loc_2")).toEqual(moveStreet);
    expect(map.get("attack:enemy_wolf")).toEqual(attackWolf);
    expect(map.get("take_item:item_well_key")).toEqual(takeKey);
    expect(map.get("explore")).toEqual({ type: "explore" });
    expect(map.get("rest")).toEqual({ type: "rest" });
    expect(map.has("talk:npc_maiden")).toBe(false);
    expect(map.has("move:loc_99")).toBe(false);
  });

  it("talk 候选包含 dialogueAct: 默认 ask（Task 7 类型兼容）", () => {
    const map = buildChoiceMap(buildWorldState(), buildStoryState({}), 0);
    expect(map.get("talk:npc_smith")).toEqual({ type: "talk", npcId: asNpcId("npc_smith"), dialogueAct: "ask" });
  });

  it("战斗激活时只允许 battle_action", () => {
    const ws: WorldState = {
      ...buildWorldState(),
      battle: { status: "active", enemyId: asEnemyId("enemy_wolf"), playerHp: 90, enemyHp: 20, round: 1 },
    };
    const map = buildChoiceMap(ws, buildStoryState({}), 0);
    expect([...map.keys()]).toEqual(["battle_action:attack", "battle_action:guard", "battle_action:flee"]);
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
      choices: [{ choiceToken: "legacy-a", label: "探索" }, { choiceToken: "legacy-b", label: "休息" }],
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

function buildStoryState(opts: {
  readonly sceneId?: string;
  readonly choices?: readonly [NarrativeChoiceState, NarrativeChoiceState];
  readonly registry?: readonly ApprovedChoice[];
}): StoryState {
  const base = createInitialStoryState({
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
    ...base.narrative,
    currentScene: scene,
    ...(opts.registry !== undefined ? { choiceRegistry: opts.registry } : {}),
  };
  return { ...base, narrative };
}
