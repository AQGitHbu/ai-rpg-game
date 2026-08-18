import { describe, expect, it } from "vitest";
import { buildChoiceMap } from "@/game/application/buildChoiceMap";
import { projectGameSessionView } from "@/game/application/gameSessionView";
import { createInitialStoryState } from "@/game/domain/storyState";
import {
  createInitialWorldState,
  type WorldState,
} from "@/game/domain/worldState";
import {
  asEnemyId,
  asFactId,
  asGenerationId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
} from "@/game/domain/worldEntity";
import {
  advanceStoryReveal,
  isActionReleased,
} from "./storyReveal";

function stagedState(): { worldState: WorldState; storyState: ReturnType<typeof createInitialStoryState> } {
  const loc0 = asLocationId("loc_0");
  const loc1 = asLocationId("loc_dyn_1");
  const npcId = asNpcId("npc_dyn_1");
  const factId = asFactId("fact_dyn_0");
  const itemId = asItemId("item_dyn_0");
  const enemyId = asEnemyId("enemy_dyn_0");
  const questId = asQuestId("quest_dyn_1");
  const base = createInitialWorldState({
    generation: {
      generationId: asGenerationId("g1"),
      seed: "staged-release",
      templateVersion: "v2",
      inputDigest: "",
      gameType: "wuxia",
    },
    player: {
      name: "沈青崖",
      identity: "查案人",
      stats: { hp: 100, attack: 10, defense: 5 },
    },
    startingLocation: {
      id: loc0,
      name: "青石镇",
      description: "临街的酒楼与北巷相连。",
      kind: "main",
      connectedLocationIds: [],
      npcIds: [],
      availableItemIds: [],
      tags: [],
      scale: "town",
    },
    startingItemIds: [],
  });
  const worldState: WorldState = {
    ...base,
    locations: [
      { ...base.locations[0]!, connectedLocationIds: [loc1] },
      {
        id: loc1,
        name: "北巷旧道",
        description: "酒楼后巷通往旧镖局的石道。",
        kind: "main",
        connectedLocationIds: [loc0],
        npcIds: [npcId],
        availableItemIds: [itemId],
        tags: ["dynamic"],
        scale: "scene",
      },
    ],
    npcs: [{
      id: npcId,
      name: "顾砚",
      role: "旧案传讯人",
      description: "受托带着线索赶来的人。",
      locationId: loc1,
      isCompanion: false,
      tags: ["dynamic"],
      met: false,
      memory: {
        npcId,
        knownFactIds: [],
        hiddenFactIds: [],
        interactionHistory: [],
        relationship: { affinity: 0 },
        emotion: "neutral",
        goals: ["交出线索"],
      },
    }],
    items: [{
      id: itemId,
      name: "染血腰牌",
      description: "刻着暗纹的旧腰牌。",
      kind: "misc",
      tags: ["dynamic"],
      category: "quest",
      rarity: "common",
    }],
    worldFacts: [{
      factId,
      text: "腰牌暗纹与旧案告示相同。",
      source: "generated",
      discovered: false,
      locationId: loc0,
      investigationLabel: "酒楼后巷的车轮印",
    }],
    enemies: [{
      id: enemyId,
      name: "黑衣追兵",
      tier: "normal",
      stats: { hp: 20, attack: 4, defense: 1 },
      locationId: loc1,
      tags: ["dynamic"],
    }],
    quests: [{
      id: questId,
      name: "追查镇外脚印",
      description: "沿着现场线索继续追查。",
      objectives: [
        { kind: "discover_fact", factId },
        { kind: "visit_location", locationId: loc1 },
        { kind: "talk_to_npc", npcId },
        { kind: "obtain_item", itemId },
        { kind: "defeat_enemy", enemyId },
      ],
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: ["dynamic"],
      kind: "main",
      stage: 2,
      status: "active",
    }],
    unlockedLocationIds: [loc0],
  };
  const storyState = {
    ...createInitialStoryState({
      gameLength: "medium",
      initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 },
    }),
    currentAct: 2,
    reveal: { questId, visibleObjectiveIndex: 0 },
  };
  return { worldState, storyState };
}

describe("story reveal cursor", () => {
  it("releases exactly one investigation → travel → NPC → item → enemy step", () => {
    let { worldState, storyState } = stagedState();
    const revision = 7;

    let view = projectGameSessionView(worldState, storyState, revision, "ending-session");
    expect(view.story.currentObjectiveLabel).toBe("调查酒楼后巷的车轮印");
    expect(view.worldMap.locations.map((location) => location.name)).toEqual(["青石镇"]);
    expect(view.currentLocation.npcs).toEqual([]);
    expect(view.obtainableItems).toEqual([]);
    expect([...buildChoiceMap(worldState, storyState, revision).values()].some((action) => action.type === "attack")).toBe(false);

    worldState = {
      ...worldState,
      worldFacts: worldState.worldFacts.map((fact) => ({ ...fact, discovered: fact.factId === "fact_dyn_0" })),
    };
    ({ worldState, storyState } = advanceStoryReveal({ worldState, storyState }));
    expect(worldState.unlockedLocationIds).toContain("loc_dyn_1");
    expect(storyState.reveal?.visibleObjectiveIndex).toBe(1);
    view = projectGameSessionView(worldState, storyState, revision, "ending-session");
    expect(view.story.currentObjectiveLabel).toBe("前往北巷旧道");
    expect(view.worldMap.locations.map((location) => location.name)).toEqual(["青石镇", "北巷旧道"]);
    expect(view.currentLocation.npcs).toEqual([]);

    worldState = {
      ...worldState,
      currentLocationId: asLocationId("loc_dyn_1"),
      visitedLocationIds: [...worldState.visitedLocationIds, asLocationId("loc_dyn_1")],
    };
    ({ worldState, storyState } = advanceStoryReveal({ worldState, storyState }));
    view = projectGameSessionView(worldState, storyState, revision, "ending-session");
    expect(view.story.currentObjectiveLabel).toBe("与顾砚交谈");
    expect(view.currentLocation.npcs.map((npc) => npc.name)).toEqual(["顾砚"]);
    expect(view.obtainableItems).toEqual([]);
    expect(view.currentLocation.actions.some((action) => action.label.includes("黑衣追兵"))).toBe(false);
    expect(isActionReleased(worldState, storyState, { type: "take_item", itemId: asItemId("item_dyn_0") })).toBe(false);

    worldState = {
      ...worldState,
      npcs: worldState.npcs.map((npc) => ({ ...npc, met: true })),
    };
    ({ worldState, storyState } = advanceStoryReveal({ worldState, storyState }));
    expect(storyState.reveal?.visibleObjectiveIndex).toBe(3);
    view = projectGameSessionView(worldState, storyState, revision, "ending-session");
    expect(view.story.currentObjectiveLabel).toBe("获取染血腰牌");
    expect(view.obtainableItems.map((item) => item.name)).toEqual(["染血腰牌"]);
    expect(view.currentLocation.actions.some((action) => action.label.includes("黑衣追兵"))).toBe(false);

    worldState = {
      ...worldState,
      inventory: [asItemId("item_dyn_0")],
    };
    ({ worldState, storyState } = advanceStoryReveal({ worldState, storyState }));
    expect(storyState.reveal?.visibleObjectiveIndex).toBe(4);
    view = projectGameSessionView(worldState, storyState, revision, "ending-session");
    expect(view.story.currentObjectiveLabel).toBe("击败黑衣追兵");
    expect(view.currentLocation.actions.some((action) => action.label.includes("黑衣追兵"))).toBe(true);
    expect(isActionReleased(worldState, storyState, { type: "attack", enemyId: asEnemyId("enemy_dyn_0") })).toBe(true);

    worldState = { ...worldState, defeatedEnemyIds: [asEnemyId("enemy_dyn_0")] };
    ({ storyState } = advanceStoryReveal({ worldState, storyState }));
    expect(storyState.reveal).toBeNull();
  });
});
