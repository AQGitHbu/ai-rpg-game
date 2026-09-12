import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import {
  approveWorldDelta,
  actObjectiveShape,
  deriveActObjectives,
  REJECT_REASON_NPC_NOT_AT_NEW_LOCATION,
  REJECT_REASON_LOCATION_NOT_FROM_CURRENT,
} from "./approveWorldDelta";
import type { WorldState, LocationEntry, NpcEntry, InvestigationApproach } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { CommittedNarrativeEvent } from "@/game/domain/events";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import {
  createWorldStateFixtureWith,
  type WorldStateFixtureOverrides,
} from "@/game/domain/testing/worldStateFixture.testutil";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import { asLocationId, asNpcId, asEnemyId, asFactId, asGenerationId, asQuestId, type GenerationMetadata } from "@/game/domain/worldEntity";
import { bindNpcToTownSlot, createTownRuntime } from "@/game/gameplay/rpg/town";
import { TRUST_ENDING_MIN_AFFINITY, DOUBT_ENDING_MAX_AFFINITY } from "@/game/application/deterministicEvolutionSource";

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
    selfConcept: "守信的传讯人",
    values: ["守信"],
    speechStyle: "谨慎而直接",
    capabilityBoundaries: ["不超出自身所知"],
    taboos: [],
  },
  goals: [{ horizon: "short" as const, description: "送达密信", priority: 3 as const, reason: "必须完成传递" }],
  relationshipSeeds: [],
};

const ENTITY_CONTEXT_CLOSURE = {
  mandatoryEntityIds: ["npc_0"],
  directReferenceEntityIds: [],
  currentLocationActiveNpcIds: [],
};

function proposalWithSeed(stance: string, reason = "旧日经历，仅供诊断"): WorldDeltaProposal {
  const base = nextActProposal();
  return {
    ...base,
    newNpc: {
      ...base.newNpc!,
      relationshipSeeds: [{ targetNpcId: "npc_0", stance, reason }],
    },
  } as WorldDeltaProposal;
}

// 结局要求由 stage 最大的主线任务的 talk_to_npc 目标派生：该目标 NPC 必须是世界里
// 真实存在的实体（当前投影不变量下 quest 目标引用未知 NPC 直接非法），所以把它
// 补进投影；断言仍只关心派生出的 npcId 是否为 npc_9。
const KEY_ENDING_NPC: NpcEntry = {
  id: asNpcId("npc_9"), name: "密信送信人", role: "信使", description: "掌握盟约裂痕证据的信使。",
  locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: true,
  memory: { npcId: asNpcId("npc_9"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
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

function makeWorld(overrides: WorldStateFixtureOverrides = {}, seed = "seed-a"): WorldState {
  const generation: GenerationMetadata = {
    generationId: asGenerationId("g1"), seed, templateVersion: "v2", inputDigest: "", gameType: "wuxia",
  };
  // 与 createInitialWorldState 一致：账本首条为 game_initialized。
  const eventLedger: readonly CommittedNarrativeEvent[] = [{ type: "game_initialized", generation } as unknown as CommittedNarrativeEvent];
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

function nextActProposal(): WorldDeltaProposal {
  return {
    beatSummary: "新的人物与地点浮现",
    newLocation: {
      name: "青山别院",
      description: "山腰上一座独立的别院，与世隔绝。",
      scale: "scene",
      placement: "world",
      connectFromLocationId: "loc_0",
    },
    newNpc: {
      ...NPC_CREATION,
      name: "新出现的信使",
      role: "传话人",
      description: "风尘仆仆的赶路人，怀里揣着密信。",
      locationRef: { kind: "new_location" },
    },
    newItem: null,
    newEnemy: null,
    newFact: { text: "盟约已有裂痕。", visibility: "public" },
    nextMainQuest: { name: "追查密信", description: "找到密信的下落。", objectiveText: "与信使交谈" },
    endingPair: null,
  };
}

function makeWorldWithFinalMainQuestTalk(): WorldState {
  return makeWorld({
    quests: [{
      id: asQuestId("quest_final"), name: "终局", description: "d",
      objectives: [{ kind: "talk_to_npc", npcId: KEY_ENDING_NPC.id }],
      onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
      tags: [], kind: "main", stage: 9, status: "active",
    }],
    npcs: [NPC_0, KEY_ENDING_NPC],
  });
}

describe("approveWorldDelta", () => {
  it("keeps an npc_private fact in the new NPC's initial knowledge only", () => {
    const result = approveWorldDelta({
      proposal: {
        ...nextActProposal(),
        newFact: { text: "信使受命隐瞒渡口位置。", visibility: "npc_private" },
      },
      need: { kind: "next_act", act: 2 },
      ws: makeWorld(),
      ss: makeStory({ currentAct: 2 }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const factId = asFactId("fact_dyn_0");
    const layers = result.approved.npcCreationComponentsById.get(asNpcId("npc_dyn_1"));
    expect(layers?.knowledge.entries).toEqual([expect.objectContaining({
      factId,
      disclosure: "secret",
      source: { kind: "initial_world", learnedAtTurn: 0 },
    })]);
    expect(result.approved.newFacts[0]).toEqual(expect.objectContaining({ factId, discovered: false }));
    expect(result.approved.newNpcs[0]?.memory.knownFactIds).toEqual([]);
    expect(result.approved.newNpcs[0]?.memory.hiddenFactIds).toEqual([factId]);
  });

  it("requires an explicit entity-context closure for relationship seeds", () => {
    const result = approveWorldDelta({
      proposal: proposalWithSeed("ally"),
      need: { kind: "next_act", act: 2 },
      ws: makeWorld(),
      ss: makeStory({ currentAct: 2 }),
    } as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_npc_relationship_seeds");
    expect(result.reason).toBe("entity_context_closure_required");
  });

  it.each([
    ["ally", "cooperative"],
    ["protective_of", "cooperative"],
    ["indebted_to", "cooperative"],
    ["rival", "wary"],
    ["wary", "wary"],
  ] as const)("maps %s to the bounded directed seed edge", (stance, stage) => {
    const result = approveWorldDelta({
      proposal: proposalWithSeed(stance),
      need: { kind: "next_act", act: 2 },
      ws: makeWorld(),
      ss: makeStory({ currentAct: 2 }),
      entityContextClosure: ENTITY_CONTEXT_CLOSURE,
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const layers = result.approved.npcCreationComponentsById.get(asNpcId("npc_dyn_1"));
    const edge = layers?.relationships.outgoing.find((candidate) => candidate.targetId === asNpcId("npc_0"));
    expect(edge?.stage).toBe(stage);
    expect(edge?.origin).toEqual(expect.objectContaining({ kind: "initial_world", reasonKey: expect.any(String) }));
    if (stance === "rival" || stance === "wary") {
      expect(edge?.dimensions.affinity).toBeLessThan(0);
    } else {
      expect(edge?.dimensions.affinity).toBeGreaterThan(0);
    }
    if (stance === "indebted_to") {
      expect(edge?.commitments).toHaveLength(1);
      expect(edge?.commitments[0]).toEqual(expect.objectContaining({
        kind: "debt", direction: "source_owes_target", status: "open",
      }));
    } else {
      expect(edge?.commitments).toEqual([]);
    }
    expect(JSON.stringify(edge)).not.toContain("旧日经历");
    expect(layers?.relationships.outgoing.some((candidate) => candidate.targetId === asNpcId("npc_dyn_1"))).toBe(false);
  });

  it("rejects seed targets outside the supplied active-NPC closure", () => {
    for (const closure of [
      ENTITY_CONTEXT_CLOSURE,
      { ...ENTITY_CONTEXT_CLOSURE, mandatoryEntityIds: [] },
      { ...ENTITY_CONTEXT_CLOSURE, currentLocationActiveNpcIds: ["npc_0"], mandatoryEntityIds: [] },
    ] as const) {
      const result = approveWorldDelta({
        proposal: proposalWithSeed("ally"),
        need: { kind: "next_act", act: 2 },
        ws: makeWorld(),
        ss: makeStory({ currentAct: 2 }),
        entityContextClosure: closure,
      } as never);
      if (closure.mandatoryEntityIds.some((id) => id === "npc_0") || closure.currentLocationActiveNpcIds.some((id) => id === "npc_0")) {
        expect(result.ok).toBe(true);
      } else {
        expect(result.ok).toBe(false);
      }
    }
  });

  it.each([
    ["self", "npc_dyn_1", "self_target"],
    ["unknown", "npc_unknown", "target_outside_entity_context"],
  ] as const)("rejects %s seed target", (_label, targetNpcId, reason) => {
    const base = nextActProposal();
    const result = approveWorldDelta({
      proposal: {
        ...base,
        newNpc: { ...base.newNpc!, relationshipSeeds: [{ targetNpcId, stance: "ally", reason: "诊断" }] },
      },
      need: { kind: "next_act", act: 2 },
      ws: makeWorld(),
      ss: makeStory({ currentAct: 2 }),
      entityContextClosure: {
        mandatoryEntityIds: ["npc_0", "npc_dyn_1"],
        directReferenceEntityIds: [],
        currentLocationActiveNpcIds: [],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_npc_relationship_seeds");
    expect(result.reason).toBe(reason);
  });

  it("rejects inactive and duplicate seed targets", () => {
    const base = nextActProposal();
    const inactive = makeWorld();
    const inactiveStore = {
      ...inactive.entityStore,
      records: inactive.entityStore.records.map((record) => record.core.kind === "npc"
        ? { ...record, core: { ...record.core, lifecycle: "inactive" as const } }
        : record),
    } as typeof inactive.entityStore;
    const inactiveResult = approveWorldDelta({
      proposal: { ...base, newNpc: { ...base.newNpc!, relationshipSeeds: [{ targetNpcId: "npc_0", stance: "ally", reason: "诊断" }] } },
      need: { kind: "next_act", act: 2 },
      ws: { ...inactive, entityStore: inactiveStore },
      ss: makeStory({ currentAct: 2 }),
      entityContextClosure: ENTITY_CONTEXT_CLOSURE,
    });
    expect(inactiveResult.ok).toBe(false);
    if (!inactiveResult.ok) expect(inactiveResult.reason).toBe("target_inactive");

    const duplicateResult = approveWorldDelta({
      proposal: {
        ...base,
        newNpc: {
          ...base.newNpc!,
          relationshipSeeds: [
            { targetNpcId: "npc_0", stance: "ally", reason: "诊断一" },
            { targetNpcId: "npc_0", stance: "wary", reason: "诊断二" },
          ],
        },
      } as never,
      need: { kind: "next_act", act: 2 },
      ws: makeWorld(),
      ss: makeStory({ currentAct: 2 }),
      entityContextClosure: ENTITY_CONTEXT_CLOSURE,
    });
    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok) expect(duplicateResult.code).toBe("invalid_npc_relationship_seeds");
  });
  it("approves a valid next_act proposal and mints sequential server ids", () => {
    const ws = makeWorld();
    const ss = makeStory({
      currentAct: 2,
      targetActs: 3,
      evolution: { ...makeStory().evolution, status: "needs_next_act" },
    });
    const result = approveWorldDelta({ proposal: nextActProposal(), need: { kind: "next_act", act: 2 }, ws, ss });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.mintedLocationIds[0]).toBe("loc_dyn_1");
    expect(result.approved.mintedNpcIds[0]).toBe("npc_dyn_1");
    expect(result.approved.mintedFactIds[0]).toBe("fact_dyn_0");
    expect(result.approved.mintedQuestIds[0]).toBe("quest_dyn_1");
    expect(result.approved.newQuests[0]!.stage).toBe(2);
    expect(result.approved.newQuests[0]!.kind).toBe("main");
    expect(result.approved.newQuests[0]!.objectives).toEqual([
      { kind: "visit_location", locationId: "loc_dyn_1" },
      { kind: "discover_fact", factId: "fact_dyn_0" },
      { kind: "talk_to_npc", npcId: "npc_dyn_1" },
    ]);
    expect(result.approved.nextEvolution.status).toBe("needs_next_act");
    expect(result.approved.nextEvolution.nextNpcOrdinal).toBe(2);
  });

  it("目标链先抵达新地点时，将同幕调查事实挂载到新地点", () => {
    const result = approveWorldDelta({
      proposal: nextActProposal(),
      need: { kind: "next_act", act: 2 },
      ws: makeWorld({}, "seed-f"),
      ss: makeStory({ currentAct: 2 }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.newQuests[0]?.objectives[0]).toEqual({
      kind: "visit_location",
      locationId: "loc_dyn_1",
    });
    expect(result.approved.newFacts[0]?.locationId).toBe("loc_dyn_1");
  });

  it("rejects when the need is none (no materialization)", () => {
    const result = approveWorldDelta({ proposal: nextActProposal(), need: { kind: "none" }, ws: makeWorld(), ss: makeStory() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_need");
  });

  it("rejects a next_act proposal that omits the next main quest", () => {
    const proposal = { ...nextActProposal(), nextMainQuest: null };
    const result = approveWorldDelta({ proposal, need: { kind: "next_act", act: 2 }, ws: makeWorld(), ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("main_quest_conflict");
  });

  it("accepts a roaming story NPC when every town building slot is occupied", () => {
    let town = createTownRuntime({ locationId: asLocationId("loc_0"), seed: "s#town#loc_0" });
    for (let i = 0; i < town.slots.length; i += 1) {
      // 容量测试只关心 slot 是否为空；绑定 ID 仍必须指向 store 中真实 NPC。
      town = bindNpcToTownSlot(town, NPC_0.id).town;
    }
    const ws = makeWorld({
      locations: [{ ...LOC_0, scale: "town", town }],
    });
    const result = approveWorldDelta({
      proposal: {
        beatSummary: "满槽小镇仍试图塞入新人物",
        newLocation: null,
        newNpc: {
          ...NPC_CREATION,
          name: "无处落脚者", role: "旅人", description: "找不到空闲建筑的旅人。",
          locationRef: { kind: "existing", id: "loc_0" },
        },
        newItem: null, newEnemy: null, newFact: null, nextMainQuest: null, endingPair: null,
      },
      need: { kind: "pacing", pacingNeed: "complicate" },
      ws,
      ss: makeStory({ currentAct: 2, targetActs: 3, tension: 10 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.newNpcs[0]?.locationId).toBe(asLocationId("loc_0"));
  });

  it("keeps a town building out of the world map and binds its NPC to the current town", () => {
    let town = createTownRuntime({ locationId: asLocationId("loc_0"), seed: "s#town#loc_0" });
    town = bindNpcToTownSlot(town, asNpcId("npc_0")).town;
    const ws = makeWorld({
      locations: [{ ...LOC_0, name: "青石镇", scale: "town", town }],
    });
    const result = approveWorldDelta({
      proposal: {
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
      },
      need: { kind: "pacing", pacingNeed: "complicate" },
      ws,
      ss: makeStory({ currentAct: 2, targetActs: 3, tension: 10 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.mintedLocationIds).toEqual([]);
    expect(result.approved.newLocations).toEqual([]);
    expect(result.approved.newNpcs[0]?.locationId).toBe(asLocationId("loc_0"));
    expect(result.approved.townBuildingBindings).toEqual([{
      locationId: asLocationId("loc_0"), npcId: asNpcId("npc_dyn_1"), displayName: "青石镇茶馆",
    }]);
    expect(result.approved.nextEvolution.nextLocationOrdinal).toBe(1);
  });

  it("rejects a second main quest for the same act", () => {
    const ws = makeWorld({
      quests: [{
        id: asQuestId("quest_existing"), name: "已有主线", description: "t", objectives: [],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 2, status: "active",
      }],
    });
    const result = approveWorldDelta({ proposal: nextActProposal(), need: { kind: "next_act", act: 2 }, ws, ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("main_quest_conflict");
  });

  it("rejects an unknown existing location ref for a new NPC", () => {
    const proposal: WorldDeltaProposal = {
      ...nextActProposal(),
      newNpc: {
        ...NPC_CREATION,
        name: "新出现的信使", role: "传话人", description: "风尘仆仆的赶路人。",
        locationRef: { kind: "existing", id: "loc_does_not_exist" },
      },
    };
    const result = approveWorldDelta({ proposal, need: { kind: "next_act", act: 2 }, ws: makeWorld(), ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_location_ref");
  });

  it("rejects a new_location ref for a NPC when no location is being created", () => {
    const proposal: WorldDeltaProposal = {
      ...nextActProposal(),
      newLocation: null,
      newNpc: {
        ...NPC_CREATION,
        name: "新出现的信使", role: "传话人", description: "风尘仆仆的赶路人。",
        locationRef: { kind: "new_location" },
      },
    };
    const result = approveWorldDelta({ proposal, need: { kind: "next_act", act: 2 }, ws: makeWorld(), ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_location_ref");
  });

  it("rejects a next_act world location whose target NPC is parked at the old location", () => {
    const base = nextActProposal();
    const proposal: WorldDeltaProposal = {
      ...base,
      newNpc: {
        ...base.newNpc!,
        locationRef: { kind: "existing" as const, id: "loc_0" },
      },
    };
    const result = approveWorldDelta({
      proposal,
      need: { kind: "next_act", act: 2 },
      ws: makeWorld(),
      ss: makeStory({ currentAct: 2 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unreachable_objective");
    expect(result.reason).toBe(REJECT_REASON_NPC_NOT_AT_NEW_LOCATION);
  });

  it("rejects a next_act main location that is not connected from the current location", () => {
    const locOther: LocationEntry = {
      id: asLocationId("loc_other"),
      name: "旧驿道",
      description: "一条通往远方的旧路。",
      kind: "main",
      connectedLocationIds: [],
      npcIds: [],
      availableItemIds: [],
      tags: [],
      scale: "scene",
    };
    const ws = makeWorld({
      locations: [LOC_0, locOther],
      currentLocationId: asLocationId("loc_other"),
    });
    const result = approveWorldDelta({
      proposal: nextActProposal(),
      need: { kind: "next_act", act: 2 },
      ws,
      ss: makeStory({ currentAct: 2 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unreachable_objective");
    expect(result.reason).toBe(REJECT_REASON_LOCATION_NOT_FROM_CURRENT);
  });

  it("rejects a next_act main item parked at the old location", () => {
    const base = nextActProposal();
    const result = approveWorldDelta({
      proposal: {
        ...base,
        newItem: { name: "密册残页", description: "夹在信物中的残页。", locationRef: "current" },
      },
      need: { kind: "next_act", act: 2 },
      ws: makeWorld(),
      ss: makeStory({ currentAct: 2 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unreachable_objective");
    expect(result.reason).toBe("item_not_at_new_location");
  });

  it("mints the NPC into the new world location and indexes it there when locationRef is new_location", () => {
    const ws = makeWorld();
    const ss = makeStory({ currentAct: 2, targetActs: 3, evolution: { ...makeStory().evolution, status: "needs_next_act" } });
    const result = approveWorldDelta({ proposal: nextActProposal(), need: { kind: "next_act", act: 2 }, ws, ss });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.newNpcs[0]?.locationId).toBe("loc_dyn_1");
    expect(result.approved.newLocations[0]?.npcIds).toEqual(["npc_dyn_1"]);
  });

  it("rejects a duplicate name against an existing NPC", () => {
    const proposal: WorldDeltaProposal = {
      ...nextActProposal(),
      newNpc: {
        ...NPC_CREATION,
        name: "韩征", role: "掌柜", description: "一个名叫韩征的人。",
        locationRef: { kind: "new_location" },
      },
    };
    const result = approveWorldDelta({ proposal, need: { kind: "next_act", act: 2 }, ws: makeWorld(), ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("duplicate_name");
  });

  it("rejects a duplicate name against an existing enemy", () => {
    const ws = makeWorld({
      enemies: [{
        id: asEnemyId("enemy_0"), name: "拦路山贼", tier: "normal", stats: { hp: 60, attack: 8, defense: 3 },
        locationId: asLocationId("loc_0"), tags: [],
      }],
    });
    const proposal: WorldDeltaProposal = {
      ...nextActProposal(),
      newEnemy: {
        name: "拦路山贼", tier: "normal",
        locationRef: "current",
      },
    };
    const result = approveWorldDelta({ proposal, need: { kind: "next_act", act: 2 }, ws, ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("duplicate_name");
  });

  it("rejects a next main quest whose name collides with a quest from another act", () => {
    const ws = makeWorld({
      quests: [{
        id: asQuestId("quest_other_act"), name: "追查密信", description: "旧剧本里的同名线索。", objectives: [],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 3, status: "active",
      }],
    });
    const result = approveWorldDelta({ proposal: nextActProposal(), need: { kind: "next_act", act: 2 }, ws, ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("duplicate_name");
  });

  it("rejects proposals that collide with each other on a name", () => {
    const proposal: WorldDeltaProposal = {
      ...nextActProposal(),
      newNpc: {
        ...NPC_CREATION,
        name: "青山别院", role: "掌柜", description: "一个跟同批新地点撞名的人。",
        locationRef: { kind: "existing", id: "loc_0" },
      },
    };
    const result = approveWorldDelta({ proposal, need: { kind: "next_act", act: 2 }, ws: makeWorld(), ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("duplicate_name");
  });

  it("rejects an unreachable objective when no anchor entity exists in the delta nor the world", () => {
    const proposal: WorldDeltaProposal = {
      beatSummary: "只有任务没有可落地的实体",
      newLocation: null,
      newNpc: null,
      newItem: null,
      newEnemy: null,
      newFact: null,
      nextMainQuest: { name: "无处可去", description: "t", objectiveText: "前往虚空" },
      endingPair: null,
    };
    const result = approveWorldDelta({ proposal, need: { kind: "next_act", act: 2 }, ws: makeWorld(), ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unreachable_objective");
  });

  it("rejects an ending pair when the need is not ending_pair", () => {
    const proposal: WorldDeltaProposal = {
      ...nextActProposal(),
      endingPair: [
        { name: "共担真相", description: "公开一切。", themeKey: "trust" as const },
        { name: "独自揭露", description: "独自承担。", themeKey: "doubt" as const },
      ],
      nextMainQuest: null,
    };
    const result = approveWorldDelta({ proposal, need: { kind: "pacing", pacingNeed: "complicate" }, ws: makeWorld(), ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ending_pair_invalid");
  });

  it("accepts two disjoint ending directions at the final act", () => {
    const ws = makeWorld();
    const ss = makeStory({ currentAct: 3, targetActs: 3, evolution: { ...makeStory().evolution, status: "needs_ending_pair" } });
    const proposal: WorldDeltaProposal = {
      beatSummary: "最终决战拉开帷幕",
      newLocation: null,
      newNpc: null,
      newItem: null,
      newEnemy: null,
      newFact: null,
      nextMainQuest: null,
      endingPair: [
        { name: "共担真相", description: "公开一切。", themeKey: "trust" },
        { name: "独自揭露", description: "独自承担。", themeKey: "doubt" },
      ],
    };
    const result = approveWorldDelta({ proposal, need: { kind: "ending_pair", finalAct: 3 }, ws, ss });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.mintedEndingIds).toHaveLength(2);
    expect(new Set(result.approved.newEndings.map((e) => e.name)).size).toBe(2);
  });

  it("derives rule-owned ending requirements instead of trusting proposal values", () => {
    const ws = makeWorldWithFinalMainQuestTalk();
    const ss = makeStory({ currentAct: 3, targetActs: 3, evolution: { ...makeStory().evolution, status: "needs_ending_pair" } });
    const proposal: WorldDeltaProposal = {
      beatSummary: "终幕两种走向",
      newLocation: null,
      newNpc: null,
      newItem: null,
      newEnemy: null,
      newFact: null,
      nextMainQuest: null,
      endingPair: [
        { name: "共担真相", description: "公开一切。", themeKey: "trust", requirements: [{ kind: "npc_affinity_at_least", npcId: asNpcId("npc_0"), value: 10 }] },
        { name: "独自揭露", description: "独自承担。", themeKey: "doubt", requirements: [{ kind: "npc_affinity_at_most", npcId: asNpcId("npc_0"), value: 9 }] },
      ],
    };
    const result = approveWorldDelta({ proposal, need: { kind: "ending_pair", finalAct: 3 }, ws, ss });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [trust, doubt] = result.approved.newEndings;
    expect(trust!.requirements).toEqual([{ kind: "npc_affinity_at_least", npcId: asNpcId("npc_9"), value: TRUST_ENDING_MIN_AFFINITY }]);
    expect(doubt!.requirements).toEqual([{ kind: "npc_affinity_at_most", npcId: asNpcId("npc_9"), value: DOUBT_ENDING_MAX_AFFINITY }]);
  });

  it("still derives requirements when proposal omits them", () => {
    const ws = makeWorldWithFinalMainQuestTalk();
    const ss = makeStory({ currentAct: 3, targetActs: 3, evolution: { ...makeStory().evolution, status: "needs_ending_pair" } });
    const proposal: WorldDeltaProposal = {
      beatSummary: "终幕两种走向",
      newLocation: null,
      newNpc: null,
      newItem: null,
      newEnemy: null,
      newFact: null,
      nextMainQuest: null,
      endingPair: [
        { name: "共担真相", description: "公开一切。", themeKey: "trust" },
        { name: "独自揭露", description: "独自承担。", themeKey: "doubt" },
      ],
    };
    const result = approveWorldDelta({ proposal, need: { kind: "ending_pair", finalAct: 3 }, ws, ss });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.newEndings[0]!.requirements).toEqual([
      { kind: "npc_affinity_at_least", npcId: asNpcId("npc_9"), value: TRUST_ENDING_MIN_AFFINITY },
    ]);
    expect(result.approved.newEndings[1]!.requirements).toEqual([
      { kind: "npc_affinity_at_most", npcId: asNpcId("npc_9"), value: DOUBT_ENDING_MAX_AFFINITY },
    ]);
  });

  it("rejects an ending pair with duplicated theme keys", () => {
    const ss = makeStory({ currentAct: 3, targetActs: 3, evolution: { ...makeStory().evolution, status: "needs_ending_pair" } });
    const proposal: WorldDeltaProposal = {
      beatSummary: "结局歧义",
      newLocation: null, newNpc: null, newItem: null, newEnemy: null, newFact: null,
      nextMainQuest: null,
      endingPair: [
        { name: "共担真相", description: "公开一切。", themeKey: "trust" },
        { name: "独自揭示", description: "独自承担但同样公开。", themeKey: "trust" },
      ],
    };
    const result = approveWorldDelta({ proposal, need: { kind: "ending_pair", finalAct: 3 }, ws: makeWorld(), ss });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ending_pair_invalid");
  });

  it("rejects soft budget overrun for locations", () => {
    const base = makeStory({ currentAct: 2 });
    const ss: StoryState = {
      ...base,
      budget: {
        locations: { opening: 1, expanded: 8, max: 8 },
        npcs: { opening: 1, expanded: 0, max: 10 },
        quests: { opening: 1, expanded: 0, max: 4 },
        events: { opening: 0, expanded: 0, max: 6 },
        hardLimit: { locations: 40, npcs: 30 },
      },
    };
    const result = approveWorldDelta({ proposal: nextActProposal(), need: { kind: "next_act", act: 2 }, ws: makeWorld(), ss });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("budget_exceeded");
  });

  it("rejects hard limit overrun for npcs", () => {
    const base = makeStory({ currentAct: 2 });
    const ss: StoryState = {
      ...base,
      budget: {
        locations: { opening: 1, expanded: 0, max: 8 },
        npcs: { opening: 30, expanded: 0, max: 40 },
        quests: { opening: 1, expanded: 0, max: 4 },
        events: { opening: 0, expanded: 0, max: 6 },
        hardLimit: { locations: 40, npcs: 30 },
      },
    };
    const result = approveWorldDelta({ proposal: nextActProposal(), need: { kind: "next_act", act: 2 }, ws: makeWorld(), ss });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("hard_limit_exceeded");
  });

  it("rejects structurally invalid names on new entities", () => {
    const proposal: WorldDeltaProposal = {
      ...nextActProposal(),
      newNpc: {
        ...NPC_CREATION,
        name: "如", role: "掌柜", description: "风尘仆仆的赶路人。",
        locationRef: { kind: "new_location" },
      },
    };
    const result = approveWorldDelta({ proposal, need: { kind: "next_act", act: 2 }, ws: makeWorld(), ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("genre_constraint");
  });

  it("rejects cross-genre supernatural terms in a wuxia world", () => {
    const proposal: WorldDeltaProposal = {
      ...nextActProposal(),
      endingPair: null,
      newNpc: {
        ...nextActProposal().newNpc!,
        name: "破碎骑士的灵魂",
        role: "远古守护者",
        description: "守在远古祭坛前的幽灵。",
      },
    };
    const result = approveWorldDelta({
      proposal,
      need: { kind: "next_act", act: 2 },
      ws: makeWorld(),
      ss: makeStory({ currentAct: 2 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("genre_constraint");
  });

  it("rejects an entirely empty proposal", () => {
    const proposal: WorldDeltaProposal = {
      beatSummary: "平静的一轮",
      newLocation: null, newNpc: null, newItem: null, newEnemy: null, newFact: null,
      nextMainQuest: null, endingPair: null,
    };
    const result = approveWorldDelta({ proposal, need: { kind: "pacing", pacingNeed: "complicate" }, ws: makeWorld(), ss: makeStory({ currentAct: 2, tension: 10 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("empty_proposal");
  });
});

function proposalWithApproaches(approaches: readonly InvestigationApproach[]): WorldDeltaProposal {
  return {
    ...nextActProposal(),
    newFact: { text: "盟约已有裂痕。", visibility: "public", investigationApproaches: approaches },
  };
}

describe("approveWorldDelta · investigationApproaches", () => {
  it("2 条合法调查方式通过审批并保留在铸造事实里，无多余日志", () => {
    const approaches: readonly InvestigationApproach[] = [
      { approachId: "a", label: "检查酒坛", evidenceQuality: "clean", tensionDelta: 2 },
      { approachId: "b", label: "询问掌柜", evidenceQuality: "noisy", tensionDelta: 4 },
    ];
    const result = approveWorldDelta({
      proposal: proposalWithApproaches(approaches),
      need: { kind: "next_act", act: 2 },
      ws: makeWorld(),
      ss: makeStory({ currentAct: 2 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.newFacts[0]?.investigationApproaches).toEqual(approaches);
    expect(result.approved.logCategories).toBeUndefined();
  });

  it("调查方式可以复用事实关键词并保留原文", () => {
    const approaches: readonly InvestigationApproach[] = [
      { approachId: "a", label: "检查裂痕", hint: "确认盟约裂痕是否由近期冲突造成。", evidenceQuality: "clean", tensionDelta: 2 },
      { approachId: "b", label: "询问掌柜", evidenceQuality: "noisy", tensionDelta: 4 },
    ];
    const result = approveWorldDelta({
      proposal: proposalWithApproaches(approaches),
      need: { kind: "next_act", act: 2 },
      ws: makeWorld(),
      ss: makeStory({ currentAct: 2 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.approved.newFacts[0]?.investigationApproaches).toEqual(approaches);
    expect(result.approved.logCategories).toBeUndefined();
  });

  it("非法列表（数量/重复 id/越界张力/正文泄漏）降级为空并记录 investigation_approach_invalid，不拒绝本轮", () => {
    const invalidLists: readonly (readonly InvestigationApproach[])[] = [
      [{ approachId: "a", label: "检查酒坛", evidenceQuality: "clean", tensionDelta: 2 }],
      [
        { approachId: "a", label: "检查酒坛", evidenceQuality: "clean", tensionDelta: 2 },
        { approachId: "a", label: "询问掌柜", evidenceQuality: "noisy", tensionDelta: 4 },
      ],
      [
        { approachId: "a", label: "检查酒坛", evidenceQuality: "clean", tensionDelta: 40 },
        { approachId: "b", label: "询问掌柜", evidenceQuality: "noisy", tensionDelta: 4 },
      ],
      [
        { approachId: "a", label: "盟约已有裂痕。", evidenceQuality: "clean", tensionDelta: 2 },
        { approachId: "b", label: "询问掌柜", evidenceQuality: "noisy", tensionDelta: 4 },
      ],
    ];
    for (const approaches of invalidLists) {
      const result = approveWorldDelta({
        proposal: proposalWithApproaches(approaches),
        need: { kind: "next_act", act: 2 },
        ws: makeWorld(),
        ss: makeStory({ currentAct: 2 }),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.approved.newFacts[0]?.investigationApproaches).toBeUndefined();
      expect(result.approved.logCategories).toContain("investigation_approach_invalid");
    }
  });

  it("缺省或空列表保持自动揭示，不产生多余日志", () => {
    for (const approaches of [undefined, [] as readonly InvestigationApproach[]]) {
      const result = approveWorldDelta({
        proposal: approaches === undefined ? nextActProposal() : proposalWithApproaches(approaches),
        need: { kind: "next_act", act: 2 },
        ws: makeWorld(),
        ss: makeStory({ currentAct: 2 }),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.approved.newFacts[0]?.investigationApproaches).toBeUndefined();
      expect(result.approved.logCategories).toBeUndefined();
    }
  });
});

describe("act objective shape variants", () => {
  it("同 seed 同 act 结果稳定，四种变体均可达", () => {
    expect(actObjectiveShape("seed-a", 2)).toBe(actObjectiveShape("seed-a", 2));
    const shapes = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      shapes.add(actObjectiveShape(`seed-${i}`, i % 5 + 2));
    }
    expect(shapes).toEqual(new Set(["full_chain", "investigation_focus", "confrontation_focus", "errand_focus"]));
  });

  // 五类实体齐全的最小提案与铸 ID（deriveActObjectives 只读其存在性）
  const FULL_PROPOSAL = {
    newFact: { text: "t" }, newLocation: { name: "l", placement: "world" }, newNpc: { name: "n" },
    newItem: { name: "i" }, newEnemy: { name: "e" },
  } as never;
  const FULL_IDS = {
    factId: "f", locationId: "l", npcId: "n", itemId: "i", enemyId: "e",
  } as never;

  it("full_chain 保留全部五类目标且先抵达新地点", () => {
    const kinds = deriveActObjectives(FULL_PROPOSAL, FULL_IDS, "full_chain")!.map((objective) => objective.kind);
    expect(kinds).toEqual(["visit_location", "discover_fact", "talk_to_npc", "obtain_item", "defeat_enemy", "talk_to_npc"]);
  });

  it("investigation_focus 去掉移动与战斗，取证后接正式对话；物化新地点时链首强制保留抵达", () => {
    const kinds = deriveActObjectives(FULL_PROPOSAL, FULL_IDS, "investigation_focus")!.map((objective) => objective.kind);
    expect(kinds).toEqual(["visit_location", "discover_fact", "talk_to_npc", "obtain_item", "talk_to_npc"]);
  });

  it("confrontation_focus 保留调查-交谈-对峙；errand_focus 保留移动-交谈-取证", () => {
    expect(deriveActObjectives(FULL_PROPOSAL, FULL_IDS, "confrontation_focus")!.map((o) => o.kind))
      .toEqual(["visit_location", "discover_fact", "talk_to_npc", "defeat_enemy", "talk_to_npc"]);
    expect(deriveActObjectives(FULL_PROPOSAL, FULL_IDS, "errand_focus")!.map((o) => o.kind))
      .toEqual(["visit_location", "talk_to_npc", "obtain_item", "talk_to_npc"]);
  });

  it("变体过滤后为空时回退全程链（提案只有 newLocation+newItem 时 confrontation_focus 无可保留项）", () => {
    const proposal = { newLocation: { name: "l", placement: "world" }, newItem: { name: "i" } } as never;
    const ids = { locationId: "l", itemId: "i" } as never;
    const kinds = deriveActObjectives(proposal, ids, "confrontation_focus")!.map((o) => o.kind);
    expect(kinds).toEqual(["visit_location", "obtain_item"]);
  });

  it("提案完全为空时回落 deriveAnchorObjective（可返回 null）", () => {
    const empty = {} as never;
    expect(deriveActObjectives(empty, {} as never, "full_chain")).toBeNull();
  });

  it("含 newLocation 的提案在四种形状下都强制保留 visit_location（可完成性不变）", () => {
    for (const shape of ["full_chain", "investigation_focus", "confrontation_focus", "errand_focus"] as const) {
      const kinds = deriveActObjectives(FULL_PROPOSAL, FULL_IDS, shape)!.map((o) => o.kind);
      expect(kinds).toContain("visit_location");
    }
  });
});

describe("NPC 赠予契约审批", () => {
  it.each(["full_chain", "investigation_focus", "confrontation_focus", "errand_focus"] as const)("%s 保留赠予者对话及随后的赠物目标", shape => {
    const proposal = { ...nextActProposal(), newItem: { name: "托付信物", description: "一块玉佩", locationRef: "new_location" as const, acquisition: "npc_gift" as const } };
    const objectives = deriveActObjectives(proposal, { locationId: asLocationId("new_location"), npcId: asNpcId("giver"), itemId: "gift" as never, factId: "new_fact" as never, enemyId: asEnemyId("guard"), questId: asQuestId("new_quest"), endingIds: [] }, shape)!;
    const index = objectives.findIndex(objective => objective.kind === "obtain_item");
    expect(objectives[index]).toMatchObject({ giftFromNpcId: "giver" });
    expect(objectives[index - 1]).toEqual({ kind: "talk_to_npc", npcId: "giver" });
  });
  it.each(["missing_npc", "remote_npc", "invalid_acquisition"])("拒绝没有合法赠予链的 %s 提案", reason => {
    const base = nextActProposal();
    const proposal = { ...base, newItem: { name: "托付信物", description: "一块玉佩", locationRef: "new_location", acquisition: reason === "invalid_acquisition" ? "automatic" : "npc_gift" },
      newNpc: reason === "missing_npc" ? null : reason === "remote_npc" ? { ...base.newNpc!, locationRef: { kind: "current" } } : base.newNpc } as unknown as WorldDeltaProposal;
    const result = approveWorldDelta({ proposal, need: { kind: "next_act", act: 2 }, ws: makeWorld(), ss: makeStory({ currentAct: 2 }) });
    expect(result).toMatchObject({ ok: false, code: "unreachable_objective" });
  });
});
