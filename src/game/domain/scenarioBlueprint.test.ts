import { describe, expect, it } from "vitest";
import {
  CONTENT_BUDGET,
  asEndingId,
  asEnemyId,
  asFactId,
  asGenerationId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
  asSceneId,
  type LocationId,
  type ScenarioBlueprint,
  type ScenarioBlueprintCandidate
} from "./scenarioBlueprint";

/** 最小但结构完整的候选蓝图：全部使用普通字符串 ID。 */
function buildCandidate(): ScenarioBlueprintCandidate {
  return {
    schemaVersion: 1,
    generationId: "gen-0001",
    seed: "seed-1",
    templateVersion: "tpl-1",
    gameType: "wuxia",
    inputDigest: "digest-abc",
    world: {
      summary: "江湖动荡，门派纷争。",
      tone: "沉稳",
      themes: ["复仇", "抉择"],
      facts: [
        { id: "fact_master_missing", text: "师父失踪于雨夜。", source: "player_input" },
        { id: "fact_sword_stolen", text: "镇派宝剑被盗。", source: "generated" }
      ],
      tags: ["武侠"]
    },
    player: {
      name: "林惊羽",
      identity: "青云门外门弟子",
      backgroundSummary: "自幼习剑，性情坚毅。",
      startingLocationId: "loc_village",
      startingItemIds: ["item_sword"],
      baseStats: { hp: 20, attack: 5, defense: 3 }
    },
    locations: [
      {
        id: "loc_village",
        name: "青石村",
        description: "山脚下的小村。",
        kind: "main",
        connectedLocationIds: ["loc_forest"],
        npcIds: ["npc_elder"],
        tags: []
      },
      {
        id: "loc_forest",
        name: "迷雾林",
        description: "常年被雾气笼罩。",
        kind: "hidden",
        connectedLocationIds: ["loc_village"],
        npcIds: [],
        tags: []
      }
    ],
    npcs: [
      {
        id: "npc_elder",
        name: "村长",
        role: "引路人",
        description: "见多识广的老人。",
        locationId: "loc_village",
        isCompanion: false,
        knownFactIds: ["fact_master_missing"],
        tags: []
      }
    ],
    quests: [
      {
        id: "quest_main_1",
        name: "寻访村长",
        kind: "main",
        stage: 1,
        description: "打听师父的下落。",
        objectives: [
          { kind: "visit_location", locationId: "loc_village" },
          { kind: "talk_to_npc", npcId: "npc_elder" },
          { kind: "obtain_item", itemId: "item_sword" },
          { kind: "discover_fact", factId: "fact_master_missing" },
          { kind: "defeat_enemy", enemyId: "enemy_bandit" }
        ],
        onSuccess: { kind: "reach_ending", endingId: "ending_light" },
        onFailure: { kind: "reach_ending", endingId: "ending_dark" },
        tags: []
      },
      {
        id: "quest_side_1",
        name: "护送商队",
        kind: "side",
        description: "顺路帮个小忙。",
        objectives: [{ kind: "visit_location", locationId: "loc_forest" }],
        onSuccess: { kind: "closed" },
        onFailure: { kind: "closed" },
        tags: []
      }
    ],
    enemies: [
      {
        id: "enemy_bandit",
        name: "山贼",
        tier: "normal",
        stats: { hp: 10, attack: 3, defense: 1 },
        tags: []
      }
    ],
    items: [
      {
        id: "item_sword",
        name: "铁剑",
        description: "一把普通的铁剑。",
        kind: "weapon",
        tags: []
      }
    ],
    endings: [
      {
        id: "ending_light",
        name: "真相大白",
        description: "找回师父。",
        requirements: [{ kind: "quest_completed", questId: "quest_main_1" }]
      },
      {
        id: "ending_dark",
        name: "湮没江湖",
        description: "线索断绝。",
        requirements: [{ kind: "fact_discovered", factId: "fact_sword_stolen" }]
      }
    ],
    openingScene: {
      id: "scene_opening",
      locationId: "loc_village",
      narration: "雨后的青石村格外安静。",
      presentNpcIds: ["npc_elder"],
      suggestedActions: ["去找村长", "查看铁剑"],
      investigableFactIds: ["fact_sword_stolen"]
    },
    contentBudget: CONTENT_BUDGET
  };
}

describe("CONTENT_BUDGET", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(CONTENT_BUDGET)).toBe(true);
  });

  it("carries the fixed Phase 1 values", () => {
    expect(CONTENT_BUDGET).toEqual({
      mainLocations: 4,
      hiddenLocationsMax: 1,
      coreNpcsMin: 4,
      coreNpcsMax: 6,
      companionsMax: 1,
      sideQuestsMax: 2,
      endings: 2
    });
  });
});

describe("branded id helpers", () => {
  it("return the raw string value unchanged", () => {
    expect(asGenerationId("gen-1")).toBe("gen-1");
    expect(asLocationId("loc_village")).toBe("loc_village");
    expect(asNpcId("npc_elder")).toBe("npc_elder");
    expect(asQuestId("quest_main_1")).toBe("quest_main_1");
    expect(asItemId("item_sword")).toBe("item_sword");
    expect(asEnemyId("enemy_bandit")).toBe("enemy_bandit");
    expect(asEndingId("ending_light")).toBe("ending_light");
    expect(asFactId("fact_master_missing")).toBe("fact_master_missing");
    expect(asSceneId("scene_opening")).toBe("scene_opening");
  });

  it("reject raw strings as branded ids at compile time", () => {
// @ts-expect-error raw string is not assignable to LocationId
    const fromRaw: LocationId = "loc_village";
    expect(fromRaw).toBe("loc_village");
  });

  it("keep different brands non-interchangeable at compile time", () => {
// @ts-expect-error NpcId is not assignable to LocationId
    const crossBrand: LocationId = asNpcId("npc_elder");
    expect(crossBrand).toBe("npc_elder");
  });
});

describe("candidate vs compiled blueprint", () => {
  it("accepts plain string ids in a candidate", () => {
    const candidate = buildCandidate();
    expect(candidate.schemaVersion).toBe(1);
    expect(candidate.openingScene.locationId).toBe("loc_village");
  });

  it("rejects a candidate where a compiled blueprint is required", () => {
    const candidate = buildCandidate();
// @ts-expect-error candidate must pass validate/compile before becoming ScenarioBlueprint
    const compiled: ScenarioBlueprint = candidate;
    expect(compiled).toBe(candidate);
  });
});
