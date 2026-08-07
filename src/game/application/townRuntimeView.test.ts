import { describe, expect, it } from "vitest";
import {
  asLocationId,
  asNpcId,
  asQuestId,
  type GameState,
  type NewGameInput,
  type ScenarioBlueprint,
  type TownRuntimeState
} from "@/game/domain";
import { ensureTownRuntime, generateTown } from "@/game/gameplay/rpg/town";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { projectTownLayerView } from "./townRuntimeView";
import { runScenarioPipeline } from "./applicationFixture.testutil";

// ---------------------------------------------------------------------------
// Town 主循环 S4：towns 条目 → 小镇层 read model 的纯投影契约测试。
// 覆盖：确定性重建（同条目深度相等、快照与 generateTown 直连一致）、剧情
// 建筑 ↔ NPC 反查全覆盖、stats 与快照对账、语义投影接线、未知 planKey 跳过、
// 地点引用缺失抛错。Phase 14 起额外覆盖小镇入口过滤（已结识 / talk 目标）。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;
const PIPELINE = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);

const TOWN_LOCATION_ID = "loc_2";
const TOWN_NPC_ID = "npc_2";
const FIXED_TIME = "2026-07-27T12:00:00.000Z";

/**
 * Phase 14 fallback 蓝图（fallback-8）仅生成起始 loc_1；为小镇层测试在此附加一个
 * town 地点 loc_2 与驻留 NPC npc_2，使 ensureTownRuntime 可以为 loc_2 派生小镇规划。
 * npc_2 默认 met=true 以满足既有"每个 NPC 都有可交互建筑"契约（Phase 14 入口过滤）。
 */
const blueprint: ScenarioBlueprint = {
  ...PIPELINE.blueprint,
  locations: [
    ...PIPELINE.blueprint.locations,
    {
      id: asLocationId(TOWN_LOCATION_ID),
      name: "青石镇",
      description: "镇中镖局旧址犹在，江湖人来人往。",
      kind: "main",
      connectedLocationIds: [PIPELINE.blueprint.locations[0]!.id],
      npcIds: [asNpcId(TOWN_NPC_ID)],
      availableItemIds: [],
      tags: [],
      scale: "town"
    }
  ],
  npcs: [
    ...PIPELINE.blueprint.npcs,
    {
      id: asNpcId(TOWN_NPC_ID),
      name: "张铁匠",
      role: "铁匠铺老板",
      description: "镇上唯一的铁匠，见识广。",
      locationId: asLocationId(TOWN_LOCATION_ID),
      isCompanion: false,
      knownFactIds: [],
      tags: []
    }
  ]
};

/** 测试用 state：npc_2 已结识（满足入口过滤），loc_2 已解锁并到访。 */
const state: GameState = {
  ...PIPELINE.state,
  unlockedLocationIds: [...PIPELINE.state.unlockedLocationIds, asLocationId(TOWN_LOCATION_ID)],
  visitedLocationIds: [...PIPELINE.state.visitedLocationIds, asLocationId(TOWN_LOCATION_ID)],
  npcs: [
    ...PIPELINE.state.npcs,
    { npcId: asNpcId(TOWN_NPC_ID), locationId: asLocationId(TOWN_LOCATION_ID), met: true }
  ]
};

/** 经 ensureTownRuntime 离线路径派生 towns 条目（与 performAction 写入一致）。 */
function buildTownEntry(): TownRuntimeState {
  const entry = ensureTownRuntime(
    blueprint,
    state,
    TOWN_LOCATION_ID,
    "offline",
    FIXED_TIME
  );
  if (entry.kind !== "generated") {
    throw new Error(`fallback 蓝图的 ${TOWN_LOCATION_ID} 应为 town 地点`);
  }
  return entry.town;
}

const TOWN_ENTRY = buildTownEntry();

function townName(): string {
  const location = blueprint.locations.find((entry) => entry.id === asLocationId(TOWN_LOCATION_ID));
  if (location === undefined) throw new Error("fixture 应含 loc_2");
  return location.name;
}

describe("projectTownLayerView：确定性重建", () => {
  it("同条目两次投影深度相等", () => {
    const first = projectTownLayerView(blueprint, TOWN_ENTRY, state);
    const second = projectTownLayerView(blueprint, TOWN_ENTRY, state);
    expect(second).toEqual(first);
  });

  it("快照与 generateTown({ seed, plan }) 直连结果一致（剔除 seed 字段后）", () => {
    const view = projectTownLayerView(blueprint, TOWN_ENTRY, state);
    const { seed: _seed, ...expected } = generateTown({ seed: TOWN_ENTRY.seed, plan: TOWN_ENTRY.plan });
    expect(view.snapshot).toEqual(expected);
  });

  it("渲染快照已脱敏：不携带镇 seed（镇 seed 派生自蓝图 seed）", () => {
    const view = projectTownLayerView(blueprint, TOWN_ENTRY, state);
    expect("seed" in view.snapshot).toBe(false);
    expect(JSON.stringify(view)).not.toContain(blueprint.seed);
  });

  it("透出地点/名称/规划来源", () => {
    const view = projectTownLayerView(blueprint, TOWN_ENTRY, state);
    expect(view.locationId).toBe(TOWN_LOCATION_ID);
    expect(view.townName).toBe(townName());
    expect(view.planSource).toBe("offline");
  });
});

describe("projectTownLayerView：剧情建筑 ↔ NPC 反查", () => {
  it("该地点每个 NPC 都有对应可交互建筑（key = story_npc_<npcId>）", () => {
    const view = projectTownLayerView(blueprint, TOWN_ENTRY, state);
    const location = blueprint.locations.find((entry) => entry.id === asLocationId(TOWN_LOCATION_ID));
    if (location === undefined) throw new Error("fixture 应含 loc_2");
    expect(location.npcIds.length).toBeGreaterThan(0);
    for (const npcId of location.npcIds) {
      const bound = view.interactiveBuildings.find(
        (building) => building.buildingKey === `story_npc_${String(npcId)}`
      );
      expect(bound).toBeDefined();
      expect(bound?.npcIds).toEqual([String(npcId)]);
    }
  });

  it("可交互建筑均回指快照中的 storyRequired 建筑", () => {
    const view = projectTownLayerView(blueprint, TOWN_ENTRY, state);
    for (const building of view.interactiveBuildings) {
      const snapshotBuilding = view.snapshot.buildings.find(
        (entry) => entry.buildingId === building.buildingId
      );
      expect(snapshotBuilding).toBeDefined();
      expect(snapshotBuilding?.storyRequired).toBe(true);
      expect(snapshotBuilding?.planKey).toBe(building.buildingKey);
      expect(building.displayName).toBe(snapshotBuilding?.displayName);
    }
  });

  it("planKey 指向蓝图外 NPC 的建筑不投影为可交互建筑", () => {
    const entryWithBogus: TownRuntimeState = {
      ...TOWN_ENTRY,
      plan: {
        ...TOWN_ENTRY.plan,
        requiredBuildings: [
          ...TOWN_ENTRY.plan.requiredBuildings,
          {
            key: "story_npc_bogus",
            buildingType: "house",
            preferredDistrict: "residential",
            importance: "story_required"
          }
        ]
      }
    };
    const view = projectTownLayerView(blueprint, entryWithBogus, state);
    // 建筑本身仍在快照里（AI 允许附加自创剧情建筑），但不进入可交互列表。
    expect(view.snapshot.buildings.some((b) => b.planKey === "story_npc_bogus")).toBe(true);
    expect(view.interactiveBuildings.some((b) => b.buildingKey === "story_npc_bogus")).toBe(false);
  });
});

describe("projectTownLayerView：stats 与语义投影", () => {
  it("stats 逐项与快照对账", () => {
    const view = projectTownLayerView(blueprint, TOWN_ENTRY, state);
    expect(view.stats).toEqual({
      buildingCount: view.snapshot.buildings.length,
      storyBuildingCount: view.snapshot.buildings.filter((b) => b.storyRequired).length,
      plotCount: view.snapshot.plots.length
    });
  });

  it("语义投影以地点名为镇名，且句子非空", () => {
    const view = projectTownLayerView(blueprint, TOWN_ENTRY, state);
    expect(view.semanticView.townName).toBe(townName());
    expect(view.semanticView.sentences.length).toBeGreaterThan(0);
    expect(view.semanticView.sentences[0]).toContain(townName());
  });
});

describe("projectTownLayerView：损坏引用", () => {
  it("地点引用在蓝图中不存在时抛错", () => {
    const orphan: TownRuntimeState = { ...TOWN_ENTRY, locationId: asLocationId("loc_999") };
    expect(() => projectTownLayerView(blueprint, orphan, state)).toThrow(
      "小镇视图投影失败：地点引用在蓝图中不存在"
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 14 小镇入口过滤：只有「已结识 NPC」或「active 任务的 talk_to_npc 目标」
// 对应的剧情建筑可进入；其余剧情建筑不进入 interactiveBuildings（UI 渲染占位）。
// ---------------------------------------------------------------------------

describe("Phase 14 小镇入口过滤", () => {
  it("未结识且非 talk 目标的 NPC 建筑不在 interactiveBuildings 中", () => {
    const unmetState: GameState = {
      ...state,
      npcs: [
        { npcId: asNpcId(TOWN_NPC_ID), locationId: asLocationId(TOWN_LOCATION_ID), met: false }
      ],
      quests: []
    };
    const view = projectTownLayerView(blueprint, TOWN_ENTRY, unmetState);
    expect(view.interactiveBuildings).toEqual([]);
  });

  it("已结识的 NPC 建筑在 interactiveBuildings 中", () => {
    const metState: GameState = {
      ...state,
      npcs: [
        { npcId: asNpcId(TOWN_NPC_ID), locationId: asLocationId(TOWN_LOCATION_ID), met: true }
      ],
      quests: []
    };
    const view = projectTownLayerView(blueprint, TOWN_ENTRY, metState);
    expect(view.interactiveBuildings).toHaveLength(1);
  });

  it("talk_to_npc objective 指向的 NPC 建筑在 interactiveBuildings 中", () => {
    const blueprintWithTalkQuest: ScenarioBlueprint = {
      ...blueprint,
      quests: [
        ...blueprint.quests,
        {
          id: asQuestId("quest_talk_target"),
          kind: "main",
          stage: 1,
          name: "拜访铁匠",
          description: "与张铁匠交谈。",
          objectives: [{ kind: "talk_to_npc", npcId: asNpcId(TOWN_NPC_ID) }],
          onSuccess: { kind: "closed" },
          onFailure: { kind: "closed" },
          tags: []
        }
      ]
    };
    const talkTargetState: GameState = {
      ...state,
      npcs: [
        { npcId: asNpcId(TOWN_NPC_ID), locationId: asLocationId(TOWN_LOCATION_ID), met: false }
      ],
      quests: [{ questId: asQuestId("quest_talk_target"), status: "active" }]
    };
    const view = projectTownLayerView(blueprintWithTalkQuest, TOWN_ENTRY, talkTargetState);
    expect(view.interactiveBuildings).toHaveLength(1);
  });
});
