import { describe, expect, it } from "vitest";
import {
  asLocationId,
  asNpcId,
  asFactId,
  createBudgetPolicy,
  type ScenarioBlueprint,
  type GameState,
  type LocationId
} from "@/game/domain";
import type { ApprovedBlueprintExpansion } from "./types";
import { compileBlueprintExpansion } from "./compileBlueprintExpansion";

// ---------------------------------------------------------------------------
// compileBlueprintExpansion 测试（spec §4.5）。
// 新地点 ID 铸造 loc_dyn_<n>，新 NPC ID 铸造 npc_dyn_<n>。
// ---------------------------------------------------------------------------

function buildBlueprint(opts?: {
  existingDynLocIds?: string[];
  existingDynNpcIds?: string[];
}): ScenarioBlueprint {
  const locations = [
    {
      id: asLocationId("loc_1"),
      name: "地点1",
      description: "描述1",
      kind: "main" as const,
      connectedLocationIds: [asLocationId("loc_2")],
      npcIds: [],
      availableItemIds: [],
      tags: []
    },
    {
      id: asLocationId("loc_2"),
      name: "地点2",
      description: "描述2",
      kind: "main" as const,
      connectedLocationIds: [asLocationId("loc_1")],
      npcIds: [],
      availableItemIds: [],
      tags: []
    },
    ...(opts?.existingDynLocIds ?? []).map((id) => ({
      id: asLocationId(id),
      name: "已有动态地点",
      description: "描述",
      kind: "main" as const,
      connectedLocationIds: [],
      npcIds: [],
      availableItemIds: [],
      tags: []
    }))
  ];

  const npcs = [
    {
      id: asNpcId("npc_1"),
      name: "NPC1",
      role: "角色",
      description: "描述",
      locationId: asLocationId("loc_1"),
      isCompanion: false,
      knownFactIds: [],
      tags: []
    },
    ...(opts?.existingDynNpcIds ?? []).map((id) => ({
      id: asNpcId(id),
      name: "已有动态NPC",
      role: "角色",
      description: "描述",
      locationId: asLocationId("loc_1"),
      isCompanion: false,
      knownFactIds: [],
      tags: []
    }))
  ];

  return {
    schemaVersion: 1,
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
      tags: []
    },
    player: {
      name: "Player",
      identity: "Hero",
      backgroundSummary: "背景",
      startingLocationId: asLocationId("loc_1"),
      startingItemIds: [],
      baseStats: { hp: 20, attack: 5, defense: 3 }
    },
    locations,
    npcs,
    quests: [],
    enemies: [],
    items: [],
    endings: [],
    openingScene: {
      id: "scene_opening" as ScenarioBlueprint["openingScene"]["id"],
      locationId: asLocationId("loc_1"),
      narration: "开始",
      presentNpcIds: [],
      suggestedActions: [],
      investigableFactIds: []
    },
    budgetPolicy: createBudgetPolicy("short")
  } as unknown as ScenarioBlueprint;
}

function buildState(): GameState {
  return {
    stateVersion: 1,
    generation: {
      generationId: "gen-test" as GameState["generation"]["generationId"],
      seed: "test-seed",
      templateVersion: "tpl-1",
      inputDigest: "digest-test",
      gameType: "wuxia"
    },
    player: { name: "Player", identity: "Hero", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: asLocationId("loc_1"),
    unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")],
    visitedLocationIds: [asLocationId("loc_1")],
    npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_1"), met: false }],
    quests: [],
    inventory: [],
    worldFacts: [],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null },
    eventLedger: [],
    revision: 0
  } as unknown as GameState;
}

const OCCURRED_AT = "2026-07-31T12:00:00.000Z";

describe("compileBlueprintExpansion", () => {
  it("新地点：ID 为 loc_dyn_1，kind main，双向连通，scale 按提案", () => {
    const expansion: ApprovedBlueprintExpansion = {
      newLocation: {
        name: "废弃货栈",
        description: "码头边长期无人问津的旧货栈。",
        scale: "scene",
        connectFromLocationId: "loc_1",
        reason: "线人约定在此交接密信。"
      },
      newNpc: null
    };
    const blueprint = buildBlueprint();
    const state = buildState();
    const { nextBlueprint, nextState } = compileBlueprintExpansion({
      blueprint, state, expansion, occurredAt: OCCURRED_AT
    });

    const newLoc = nextBlueprint.locations.find((l) => String(l.id) === "loc_dyn_1");
    expect(newLoc).toBeDefined();
    expect(newLoc!.kind).toBe("main");
    expect(newLoc!.availableItemIds).toEqual([]);
    expect(newLoc!.connectedLocationIds).toEqual([asLocationId("loc_1")]);
    expect(newLoc!.scale).toBe("scene");

    // connectFrom 的 connectedLocationIds 追加新 ID
    const connectFrom = nextBlueprint.locations.find((l) => String(l.id) === "loc_1");
    expect(connectFrom!.connectedLocationIds).toContain(asLocationId("loc_dyn_1"));

    // 其余地点引用不变
    const loc2 = nextBlueprint.locations.find((l) => String(l.id) === "loc_2");
    expect(loc2!.connectedLocationIds).toEqual([asLocationId("loc_1")]);

    // state 解锁新地点
    expect(nextState.unlockedLocationIds).toContain(asLocationId("loc_dyn_1"));

    // eventLedger 追加 blueprint_expanded
    const event = nextState.eventLedger[nextState.eventLedger.length - 1];
    expect(event).toEqual({
      type: "blueprint_expanded",
      newLocationIds: [asLocationId("loc_dyn_1")],
      newNpcIds: [],
      occurredAt: OCCURRED_AT
    });
  });

  it("蓝图已含 loc_dyn_1 时铸 loc_dyn_2", () => {
    const expansion: ApprovedBlueprintExpansion = {
      newLocation: {
        name: "新地点",
        description: "描述足够长的新地点。",
        scale: "scene",
        connectFromLocationId: "loc_1",
        reason: "剧情需要这个新地点。"
      },
      newNpc: null
    };
    const blueprint = buildBlueprint({ existingDynLocIds: ["loc_dyn_1"] });
    const { nextBlueprint } = compileBlueprintExpansion({
      blueprint, state: buildState(), expansion, occurredAt: OCCURRED_AT
    });
    expect(nextBlueprint.locations.some((l) => String(l.id) === "loc_dyn_2")).toBe(true);
  });

  it("新 NPC：ID npc_dyn_1，isCompanion false，knownFactIds []", () => {
    const expansion: ApprovedBlueprintExpansion = {
      newLocation: null,
      newNpc: {
        name: "神秘线人",
        role: "情报贩子",
        description: "一个戴着斗笠的神秘人物。",
        locationId: "loc_1"
      }
    };
    const blueprint = buildBlueprint();
    const state = buildState();
    const { nextBlueprint, nextState } = compileBlueprintExpansion({
      blueprint, state, expansion, occurredAt: OCCURRED_AT
    });

    const newNpc = nextBlueprint.npcs.find((n) => String(n.id) === "npc_dyn_1");
    expect(newNpc).toBeDefined();
    expect(newNpc!.isCompanion).toBe(false);
    expect(newNpc!.knownFactIds).toEqual([]);
    expect(newNpc!.locationId).toBe(asLocationId("loc_1"));

    // state.npcs 追加 runtime 条目
    const runtime = nextState.npcs.find((n) => String(n.npcId) === "npc_dyn_1");
    expect(runtime).toEqual({ npcId: asNpcId("npc_dyn_1"), locationId: asLocationId("loc_1"), met: false });

    // 事件
    const event = nextState.eventLedger[nextState.eventLedger.length - 1];
    expect(event).toEqual({
      type: "blueprint_expanded",
      newLocationIds: [],
      newNpcIds: [asNpcId("npc_dyn_1")],
      occurredAt: OCCURRED_AT
    });
  });

  it("NPC locationId 哨兵 new:0 解析为本次新地点实 ID", () => {
    const expansion: ApprovedBlueprintExpansion = {
      newLocation: {
        name: "废弃货栈",
        description: "码头边长期无人问津的旧货栈。",
        scale: "scene",
        connectFromLocationId: "loc_1",
        reason: "线人约定在此交接密信。"
      },
      newNpc: {
        name: "神秘线人",
        role: "情报贩子",
        description: "一个戴着斗笠的神秘人物。",
        locationId: "new:0"
      }
    };
    const { nextBlueprint } = compileBlueprintExpansion({
      blueprint: buildBlueprint(), state: buildState(), expansion, occurredAt: OCCURRED_AT
    });
    const newNpc = nextBlueprint.npcs.find((n) => String(n.id) === "npc_dyn_1");
    expect(newNpc!.locationId).toBe(asLocationId("loc_dyn_1"));
  });

  it("纯度：同输入两次调用 deep-equal；输入未被变异", () => {
    const expansion: ApprovedBlueprintExpansion = {
      newLocation: {
        name: "废弃货栈",
        description: "码头边长期无人问津的旧货栈。",
        scale: "scene",
        connectFromLocationId: "loc_1",
        reason: "线人约定在此交接密信。"
      },
      newNpc: null
    };
    const blueprint = buildBlueprint();
    const state = buildState();
    const blueprintBefore = JSON.parse(JSON.stringify(blueprint));
    const stateBefore = JSON.parse(JSON.stringify(state));

    const result1 = compileBlueprintExpansion({ blueprint, state, expansion, occurredAt: OCCURRED_AT });
    const result2 = compileBlueprintExpansion({ blueprint, state, expansion, occurredAt: OCCURRED_AT });

    expect(result1).toEqual(result2);
    expect(JSON.parse(JSON.stringify(blueprint))).toEqual(blueprintBefore);
    expect(JSON.parse(JSON.stringify(state))).toEqual(stateBefore);
  });

  it("仅 NPC 无地点的提案：不产生新地点、事件 newLocationIds []", () => {
    const expansion: ApprovedBlueprintExpansion = {
      newLocation: null,
      newNpc: {
        name: "神秘线人",
        role: "情报贩子",
        description: "一个戴着斗笠的神秘人物。",
        locationId: "loc_1"
      }
    };
    const { nextBlueprint, nextState } = compileBlueprintExpansion({
      blueprint: buildBlueprint(), state: buildState(), expansion, occurredAt: OCCURRED_AT
    });
    expect(nextBlueprint.locations.every((l) => !String(l.id).startsWith("loc_dyn_"))).toBe(true);
    const event = nextState.eventLedger[nextState.eventLedger.length - 1] as unknown as { newLocationIds: readonly LocationId[] };
    expect(event.newLocationIds).toEqual([]);
  });
});
