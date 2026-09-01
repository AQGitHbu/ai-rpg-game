import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { materializeWorldDelta } from "./materializeWorldDelta";
import type { WorldState, LocationEntry, NpcEntry } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { GameEvent } from "@/game/domain/events";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import {
  createWorldStateFixtureWith,
  type WorldStateFixtureOverrides,
} from "@/game/domain/testing/worldStateFixture.testutil";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import { asLocationId, asNpcId, asGenerationId, type GenerationMetadata } from "@/game/domain/worldEntity";
import { entitiesOfKind } from "@/game/domain/entity";
import { approveWorldDelta, type ApprovedWorldDeltaCore } from "./approveWorldDelta";
import { createTownRuntime, bindNpcToTownSlot } from "@/game/gameplay/rpg/town";

// ---------------------------------------------------------------------------
// Fixture：起始地点听雨客栈(loc_0) 与其名册内的掌柜韩征(npc_0) 一次给出完整合法
// 兼容投影；当前版本 NPC 必须由 entityStore 派生，不能再 spread 单条 legacy 数组。
// ---------------------------------------------------------------------------

const LOC_0: LocationEntry = {
  id: asLocationId("loc_0"), name: "听雨客栈", description: "山脚小镇的客栈。", kind: "main",
  connectedLocationIds: [], npcIds: [asNpcId("npc_0")], availableItemIds: [], tags: [],
};

const NPC_0: NpcEntry = {
  id: asNpcId("npc_0"), name: "韩征", role: "掌柜", description: "听雨客栈的掌柜。",
  locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: false,
  memory: { npcId: asNpcId("npc_0"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
};

const NPC_CREATION = {
  anchors: {
    selfConcept: "信使的自我认知",
    values: ["守信"],
    speechStyle: "谨慎而直接",
    capabilityBoundaries: ["不超出自身所知"],
    taboos: [],
  },
  goals: [{ horizon: "short" as const, description: "送达密信", priority: 3 as const, reason: "必须完成传递" }],
  relationshipSeeds: [],
};

const BASE_PROJECTION: EntityCompatibilityProjection = {
  player: { name: "林惊羽", identity: "外门弟子", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [LOC_0],
  currentLocationId: asLocationId("loc_0"),
  unlockedLocationIds: [asLocationId("loc_0")],
  visitedLocationIds: [asLocationId("loc_0")],
  npcs: [NPC_0],
  items: [],
  inventory: [],
  worldFacts: [],
  quests: [],
  enemies: [],
  defeatedEnemyIds: [],
  factions: [],
};

function makeWorld(overrides: WorldStateFixtureOverrides = {}): WorldState {
  const generation: GenerationMetadata = {
    generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia",
  };
  // 与 createInitialWorldState 一致：账本首条为 game_initialized。
  const eventLedger: readonly GameEvent[] = [{ type: "game_initialized", generation }];
  return createWorldStateFixtureWith({ generation, base: BASE_PROJECTION }, { eventLedger, ...overrides });
}

function makeStory(overrides?: Partial<StoryState>): StoryState {
  const base = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 } });
  return {
    ...base,
    evolution: {
      nextLocationOrdinal: 1,
      nextNpcOrdinal: 1,
      nextItemOrdinal: 0,
      nextEnemyOrdinal: 0,
      nextFactOrdinal: 0,
      nextQuestOrdinal: 1,
      nextEndingOrdinal: 0,
      status: "stable",
    } as StoryState["evolution"],
    ...overrides,
  };
}

function approve(input: {
  proposal: WorldDeltaProposal;
  need: Parameters<typeof approveWorldDelta>[0]["need"];
  ws: WorldState;
  ss: StoryState;
  entityContextClosure?: Parameters<typeof approveWorldDelta>[0]["entityContextClosure"];
}): ApprovedWorldDeltaCore {
  const result = approveWorldDelta(input);
  if (!result.ok) throw new Error(`fixture approval failed: ${result.code}`);
  return result.approved;
}

function nextActProposal(): WorldDeltaProposal {
  return {
    beatSummary: "新的人物与地点浮现",
    newLocation: { name: "青山别院", description: "山腰上一座独立的别院，与世隔绝。", scale: "scene", placement: "world", connectFromLocationId: "loc_0" },
    newNpc: {
      ...NPC_CREATION,
      name: "新出现的信使", role: "传话人", description: "风尘仆仆的赶路人，怀里揣着密信。",
      locationRef: { kind: "new_location" },
    },
    newItem: null,
    newEnemy: null,
    newFact: { text: "盟约已有裂痕。", visibility: "public" },
    nextMainQuest: { name: "追查密信", description: "找到密信的下落。", objectiveText: "与信使交谈" },
    endingPair: null,
  };
}

describe("materializeWorldDelta", () => {
  it("materializes only the new NPC outgoing seed edge and preserves the target components", () => {
    const ws = makeWorld();
    const ss = makeStory({ currentAct: 2 });
    const beforeTarget = entitiesOfKind(ws.entityStore, "npc").find((record) => record.core.id === asNpcId("npc_0"));
    const approved = approve({
      proposal: {
        ...nextActProposal(),
        newNpc: {
          ...nextActProposal().newNpc!,
          relationshipSeeds: [{ targetNpcId: "npc_0", stance: "ally", reason: "曾共同守护一封密信" }],
        },
      },
      need: { kind: "next_act", act: 2 },
      ws,
      ss,
      entityContextClosure: {
        mandatoryEntityIds: ["npc_0"],
        directReferenceEntityIds: [],
        currentLocationActiveNpcIds: [],
      },
    });
    const delta = materializeWorldDelta({ approved, need: { kind: "next_act", act: 2 }, ws, ss, now: () => "2026-09-01T00:00:00.000Z" });
    const createdNpc = entitiesOfKind(delta.previewWorldState.entityStore, "npc").find((record) => record.core.id === asNpcId("npc_dyn_1"));
    const targetAfter = entitiesOfKind(delta.previewWorldState.entityStore, "npc").find((record) => record.core.id === asNpcId("npc_0"));
    expect(targetAfter).toEqual(beforeTarget);
    expect(createdNpc?.relationships.outgoing.find((edge) => edge.targetId === asNpcId("npc_0"))).toEqual(expect.objectContaining({
      stage: "cooperative",
      dimensions: expect.objectContaining({ affinity: expect.any(Number) }),
    }));
    expect(createdNpc?.relationships.outgoing.some((edge) => edge.targetId === asNpcId("npc_dyn_1"))).toBe(false);
  });

  it("materializes npc/location/quest/fact into preview world+story, consumes budget, resets status", () => {
    const ws = makeWorld();
    const ss = makeStory({ currentAct: 2, targetActs: 3, evolution: { ...makeStory().evolution, status: "needs_next_act" } });
    const approved = approve({ proposal: nextActProposal(), need: { kind: "next_act", act: 2 }, ws, ss });
    const delta = materializeWorldDelta({ approved, need: { kind: "next_act", act: 2 }, ws, ss, now: () => "2026-01-02" });

    expect(delta.mintedNpcIds[0]).toBe("npc_dyn_1");
    expect(delta.previewWorldState.npcs).toContainEqual(expect.objectContaining({ name: "新出现的信使" }));
    expect(delta.previewWorldState.locations.some((l) => l.name === "青山别院")).toBe(true);
    expect(delta.previewWorldState.quests.some((q) => q.name === "追查密信" && q.stage === 2)).toBe(true);
    expect(delta.previewWorldState.worldFacts.some((f) => f.factId === "fact_dyn_0")).toBe(true);

    const previewSs = delta.previewStoryState;
    expect(previewSs.evolution.status).toBe("stable");
    expect(previewSs.evolution.nextNpcOrdinal).toBe(2);
    expect(previewSs.evolution.nextLocationOrdinal).toBe(2);
    expect(previewSs.evolution.nextFactOrdinal).toBe(1);
    expect(previewSs.budget.npcs.expanded).toBe(1);
    expect(previewSs.budget.locations.expanded).toBe(1);
    expect(previewSs.budget.quests.expanded).toBe(1);
    expect(previewSs.budget.events.expanded).toBe(1);

    const event = delta.previewWorldState.eventLedger.at(-1)!;
    expect(event.type).toBe("blueprint_expanded");
    if (event.type === "blueprint_expanded") {
      expect(event.newNpcIds).toEqual(["npc_dyn_1"]);
      expect(event.newLocationIds).toEqual(["loc_dyn_1"]);
      expect(event.newQuestIds).toEqual(["quest_dyn_1"]);
    }
    // 物化新地点的幕，目标链首必为 visit_location（可完成性不变约束），因此新地点
    // 随装配立即释放；NPC 挂载到其地点索引。
    const locOut = delta.previewWorldState.locations.find((l) => l.id === "loc_0")!;
    expect(locOut.connectedLocationIds).toContain("loc_dyn_1");
    const locNew = delta.previewWorldState.locations.find((l) => l.id === "loc_dyn_1")!;
    expect(locNew.connectedLocationIds).toContain("loc_0");
    expect(locNew.connectedLocationIds).not.toContain("loc_dyn_1");
    expect(locNew.npcIds).toContain("npc_dyn_1");
    expect(delta.previewWorldState.unlockedLocationIds).toContain("loc_dyn_1");
    expect(delta.previewStoryState.reveal).toEqual({ questId: "quest_dyn_1", visibleObjectiveIndex: 0 });
  });

  it("materializes NPC layers from the approved explicit creation map", () => {
    const ws = makeWorld();
    const ss = makeStory({ currentAct: 2, targetActs: 3, evolution: { ...makeStory().evolution, status: "needs_next_act" } });
    const approved = approve({ proposal: nextActProposal(), need: { kind: "next_act", act: 2 }, ws, ss });
    const layers = approved.npcCreationComponentsById.get(asNpcId("npc_dyn_1"));
    expect(layers?.anchors.selfConcept).toBe("信使的自我认知");
    expect(layers?.dynamicState.goals).toEqual([expect.objectContaining({
      goalId: "npc_dyn_1_goal_1", description: "送达密信", status: "active",
    })]);

    const delta = materializeWorldDelta({ approved, need: { kind: "next_act", act: 2 }, ws, ss, now: () => "2026-01-02" });
    const npc = entitiesOfKind(delta.previewWorldState.entityStore, "npc").find((record) => record.core.id === "npc_dyn_1");
    expect(npc?.core.kind).toBe("npc");
    if (npc?.core.kind === "npc") {
      expect(npc.identity.anchors.selfConcept).toBe("信使的自我认知");
      expect(npc.dynamicState.goals[0]?.goalId).toBe("npc_dyn_1_goal_1");
    }
  });

  it("rejects materialization when the approved NPC creation map is missing", () => {
    const ws = makeWorld();
    const ss = makeStory({ currentAct: 2, targetActs: 3, evolution: { ...makeStory().evolution, status: "needs_next_act" } });
    const approved = approve({ proposal: nextActProposal(), need: { kind: "next_act", act: 2 }, ws, ss });

    expect(() => materializeWorldDelta({
      approved: { ...approved, npcCreationComponentsById: new Map() },
      need: { kind: "next_act", act: 2 },
      ws,
      ss,
      now: () => "2026-01-02",
    })).toThrowError(expect.objectContaining({ code: "npc_creation_components_required" }));
  });

  it("keeps new location npcIds, the npc locationId and the talk_to_npc objective mutually consistent", () => {
    const ws = makeWorld();
    const ss = makeStory({ currentAct: 2, targetActs: 3, evolution: { ...makeStory().evolution, status: "needs_next_act" } });
    const approved = approve({ proposal: nextActProposal(), need: { kind: "next_act", act: 2 }, ws, ss });
    const delta = materializeWorldDelta({ approved, need: { kind: "next_act", act: 2 }, ws, ss, now: () => "2026-01-02" });
    const npc = delta.previewWorldState.npcs.find((n) => n.id === "npc_dyn_1")!;
    const locNew = delta.previewWorldState.locations.find((l) => l.id === "loc_dyn_1")!;
    expect(npc.locationId).toBe("loc_dyn_1");
    expect(locNew.npcIds).toContain("npc_dyn_1");
    const quest = delta.previewWorldState.quests.find((q) => q.id === "quest_dyn_1")!;
    expect(quest.objectives.find((o) => o.kind === "talk_to_npc"))
      .toEqual({ kind: "talk_to_npc", npcId: "npc_dyn_1" });
  });

  it("materializes two disjoint endings at the final act and resets status stable", () => {
    const ws = makeWorld();
    const ss = makeStory({ currentAct: 3, targetActs: 3, evolution: { ...makeStory().evolution, status: "needs_ending_pair" } });
    const proposal: WorldDeltaProposal = {
      beatSummary: "最终决战拉开帷幕",
      newLocation: null, newNpc: null, newItem: null, newEnemy: null, newFact: null,
      nextMainQuest: null,
      endingPair: [
        { name: "共担真相", description: "公开一切。", themeKey: "trust" },
        { name: "独自揭露", description: "独自承担。", themeKey: "doubt" },
      ],
    };
    const approved = approve({ proposal, need: { kind: "ending_pair", finalAct: 3 }, ws, ss });
    const delta = materializeWorldDelta({ approved, need: { kind: "ending_pair", finalAct: 3 }, ws, ss, now: () => "2026-01-02" });
    expect(delta.previewWorldState.endings.map((e) => e.name)).toEqual(["共担真相", "独自揭露"]);
    expect(delta.previewStoryState.evolution.status).toBe("stable");
    const event = delta.previewWorldState.eventLedger.at(-1)!;
    if (event.type === "blueprint_expanded") {
      expect(event.newEndingIds).toHaveLength(2);
    }
  });

  it("derives a completable pacing objective tied to the minted entity", () => {
    const ws = makeWorld();
    const ss = makeStory({ currentAct: 2, targetActs: 3, tension: 10 });
    const proposal: WorldDeltaProposal = {
      beatSummary: "低张力下的新面孔",
      newLocation: null,
      newNpc: {
        ...NPC_CREATION,
        name: "神秘镖师", role: "镖师", description: "护送商队的镖师。",
        locationRef: { kind: "existing", id: "loc_0" },
      },
      newItem: null, newEnemy: null, newFact: null, nextMainQuest: null, endingPair: null,
    };
    const approved = approve({ proposal, need: { kind: "pacing", pacingNeed: "complicate" }, ws, ss });
    const delta = materializeWorldDelta({ approved, need: { kind: "pacing", pacingNeed: "complicate" }, ws, ss, now: () => "2026-01-02" });
    const npc = delta.previewWorldState.npcs.find((n) => n.id === "npc_dyn_1")!;
    expect(npc.name).toBe("神秘镖师");
    expect(npc.locationId).toBe("loc_0");
    expect(delta.previewWorldState.locations.find((l) => l.id === "loc_0")!.npcIds).toContain("npc_dyn_1");
    expect(delta.previewStoryState.evolution.status).toBe("stable");
  });

  it("materializes a new town-scale location with its town runtime and binds its NPC to slot 0", () => {
    const ws = makeWorld();
    const ss = makeStory({ currentAct: 2, targetActs: 3, evolution: { ...makeStory().evolution, status: "needs_next_act" } });
    const proposal: WorldDeltaProposal = {
      beatSummary: "新的小镇浮现",
      newLocation: { name: "青山集", description: "山脚下的集贸小镇。", scale: "town", placement: "world", connectFromLocationId: "loc_0" },
      newNpc: {
        ...NPC_CREATION,
        name: "集市管事", role: "管事", description: "打理集市秩序的管事。",
        locationRef: { kind: "new_location" },
      },
      newItem: null, newEnemy: null, newFact: null, nextMainQuest: null, endingPair: null,
    };
    const approved = approve({ proposal, need: { kind: "pacing", pacingNeed: "complicate" }, ws, ss });
    const delta = materializeWorldDelta({ approved, need: { kind: "pacing", pacingNeed: "complicate" }, ws, ss, now: () => "2026-01-02" });
    const locNew = delta.previewWorldState.locations.find((l) => l.id === "loc_dyn_1")!;
    expect(locNew.scale).toBe("town");
    expect(locNew.town).toBeDefined();
    expect(locNew.town?.locationId).toBe(asLocationId("loc_dyn_1"));
    expect(locNew.town?.seed).toBe("s#town#loc_dyn_1");
    expect(locNew.town?.slots[0]?.boundNpcId).toBe(asNpcId("npc_dyn_1"));
  });

  it("materializes a town building without creating a world-map location", () => {
    let town = createTownRuntime({ locationId: asLocationId("loc_0"), seed: "s#town#loc_0" });
    town = bindNpcToTownSlot(town, asNpcId("npc_0")).town;
    const ws = makeWorld({
      currentLocationId: asLocationId("loc_0"),
      locations: [{ ...LOC_0, name: "青石镇", scale: "town", town }],
    });
    const ss = makeStory({ currentAct: 2, targetActs: 3 });
    const proposal: WorldDeltaProposal = {
      beatSummary: "城镇里出现新的茶馆线人",
      newLocation: {
        name: "青石镇茶馆", description: "临街茶馆里藏着一名带来密信的线人。", scale: "scene",
        placement: "town_building", connectFromLocationId: "loc_0",
      },
      newNpc: {
        ...NPC_CREATION,
        name: "茶馆线人", role: "旧案传讯人", description: "在茶馆等候交出密信的线人。",
        locationRef: { kind: "new_location" },
      },
      newItem: null, newEnemy: null, newFact: null, nextMainQuest: null, endingPair: null,
    };
    const approved = approveWorldDelta({ proposal, need: { kind: "pacing", pacingNeed: "complicate" }, ws, ss });
    if (!approved.ok) throw new Error(`fixture approval failed: ${approved.code}`);
    const delta = materializeWorldDelta({ approved: approved.approved, need: { kind: "pacing", pacingNeed: "complicate" }, ws, ss, now: () => "2026-01-02" });
    const townLocation = delta.previewWorldState.locations.find((location) => location.id === asLocationId("loc_0"))!;
    expect(delta.previewWorldState.locations).toHaveLength(ws.locations.length);
    expect(delta.previewWorldState.locations.some((location) => location.name === "青石镇茶馆")).toBe(false);
    expect(townLocation.npcIds).toContain(asNpcId("npc_dyn_1"));
    expect(townLocation.town?.slots.find((slot) => slot.boundNpcId === asNpcId("npc_dyn_1"))?.displayName)
      .toBe("青石镇茶馆");
  });

  it("binds an NPC materialized into an existing town to the FIRST FREE slot (slot_0 stays bound)", () => {
    const town = bindNpcToTownSlot(
      createTownRuntime({ locationId: asLocationId("loc_0"), seed: "s#town#loc_0" }),
      asNpcId("npc_0"),
    ).town;
    const ws = makeWorld({
      locations: [{ ...LOC_0, scale: "town", town }],
    });
    const ss = makeStory({ currentAct: 2, targetActs: 3, tension: 10 });
    const proposal: WorldDeltaProposal = {
      beatSummary: "小镇里的新来客",
      newLocation: null,
      newNpc: {
        ...NPC_CREATION,
        name: "新来客", role: "旅人", description: "在小镇落脚的外乡人。",
        locationRef: { kind: "existing", id: "loc_0" },
      },
      newItem: null, newEnemy: null, newFact: null, nextMainQuest: null, endingPair: null,
    };
    const approved = approve({ proposal, need: { kind: "pacing", pacingNeed: "complicate" }, ws, ss });
    const delta = materializeWorldDelta({ approved, need: { kind: "pacing", pacingNeed: "complicate" }, ws, ss, now: () => "2026-01-02" });
    const locOut = delta.previewWorldState.locations.find((l) => l.id === "loc_0")!;
    expect(locOut.town?.slots[0]?.boundNpcId).toBe(asNpcId("npc_0"));
    const boundIndex = locOut.town?.slots.findIndex((slot) => slot.boundNpcId === asNpcId("npc_dyn_1"));
    expect(boundIndex).toBe(1);
    expect(locOut.town?.slots[1]?.boundNpcId).toBe(asNpcId("npc_dyn_1"));
    // 几何/既有绑定不变
    expect(locOut.town?.slots.map((slot) => slot.buildingId)).toEqual(town.slots.map((slot) => slot.buildingId));
  });
});
