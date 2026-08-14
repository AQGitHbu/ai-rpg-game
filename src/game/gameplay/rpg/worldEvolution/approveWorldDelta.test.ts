import { describe, it, expect } from "vitest";
import { approveWorldDelta } from "./approveWorldDelta";
import type { WorldState, NpcEntry } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createInitialWorldState } from "@/game/domain/worldState";
import type { EvolutionNeed, WorldDeltaProposal } from "@/game/domain/worldDelta";
import { asLocationId, asNpcId, asEnemyId, asGenerationId } from "@/game/domain/worldEntity";
import { bindNpcToTownSlot, createTownRuntime } from "@/game/gameplay/rpg/town";
import { TRUST_ENDING_MIN_AFFINITY, DOUBT_ENDING_MAX_AFFINITY } from "@/game/application/deterministicEvolutionSource";

function makeWorld(): WorldState {
  const base = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "林惊羽", identity: "外门弟子", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_0"), name: "听雨客栈", description: "山脚小镇的客栈。", kind: "main",
      connectedLocationIds: [], npcIds: [asNpcId("npc_0")], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
  const npc: NpcEntry = {
    id: asNpcId("npc_0"), name: "韩征", role: "掌柜", description: "听雨客栈的掌柜。",
    locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_0"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  return { ...base, npcs: [npc] };
}

function makeStory(overrides?: Partial<StoryState>): StoryState {
  const base = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 1, events: 0 } });
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
      connectFromLocationId: "loc_0",
    },
    newNpc: {
      name: "新出现的信使",
      role: "传话人",
      description: "风尘仆仆的赶路人，怀里揣着密信。",
      locationRef: { kind: "new_location" },
      goals: ["送达密信"],
    },
    newItem: null,
    newEnemy: null,
    newFact: { text: "盟约已有裂痕。", visibility: "public" },
    nextMainQuest: { name: "追查密信", description: "找到密信的下落。", objectiveText: "与信使交谈" },
    endingPair: null,
  };
}

describe("approveWorldDelta", () => {
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
    expect(result.approved.newQuests[0]!.objectives[0]).toEqual({ kind: "talk_to_npc", npcId: "npc_dyn_1" });
    expect(result.approved.nextEvolution.status).toBe("needs_next_act");
    expect(result.approved.nextEvolution.nextNpcOrdinal).toBe(2);
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
      town = bindNpcToTownSlot(town, asNpcId(`npc_slot_${i}`)).town;
    }
    const ws = {
      ...makeWorld(),
      locations: makeWorld().locations.map((location) =>
        location.id === asLocationId("loc_0") ? { ...location, scale: "town" as const, town } : location,
      ),
    };
    const result = approveWorldDelta({
      proposal: {
        beatSummary: "满槽小镇仍试图塞入新人物",
        newLocation: null,
        newNpc: {
          name: "无处落脚者", role: "旅人", description: "找不到空闲建筑的旅人。",
          locationRef: { kind: "existing", id: "loc_0" }, goals: [],
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

  it("rejects a second main quest for the same act", () => {
    const ws: WorldState = {
      ...makeWorld(),
      quests: [{
        id: "quest_existing" as never, name: "已有主线", description: "t", objectives: [],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 2, status: "active",
      }],
    };
    const result = approveWorldDelta({ proposal: nextActProposal(), need: { kind: "next_act", act: 2 }, ws, ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("main_quest_conflict");
  });

  it("rejects an unknown existing location ref for a new NPC", () => {
    const proposal: WorldDeltaProposal = {
      ...nextActProposal(),
      newNpc: {
        name: "新出现的信使", role: "传话人", description: "风尘仆仆的赶路人。",
        locationRef: { kind: "existing", id: "loc_does_not_exist" }, goals: [],
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
        name: "新出现的信使", role: "传话人", description: "风尘仆仆的赶路人。",
        locationRef: { kind: "new_location" }, goals: [],
      },
    };
    const result = approveWorldDelta({ proposal, need: { kind: "next_act", act: 2 }, ws: makeWorld(), ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_location_ref");
  });

  it("rejects a duplicate name against an existing NPC", () => {
    const proposal: WorldDeltaProposal = {
      ...nextActProposal(),
      newNpc: {
        name: "韩征", role: "掌柜", description: "一个名叫韩征的人。",
        locationRef: { kind: "new_location" }, goals: [],
      },
    };
    const result = approveWorldDelta({ proposal, need: { kind: "next_act", act: 2 }, ws: makeWorld(), ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("duplicate_name");
  });

  it("rejects a duplicate name against an existing enemy", () => {
    const ws: WorldState = {
      ...makeWorld(),
      enemies: [{
        id: asEnemyId("enemy_0"), name: "拦路山贼", tier: "normal", stats: { hp: 60, attack: 8, defense: 3 },
        locationId: asLocationId("loc_0"), tags: [],
      }],
    };
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
    const ws: WorldState = {
      ...makeWorld(),
      quests: [{
        id: "quest_other_act" as never, name: "追查密信", description: "旧剧本里的同名线索。", objectives: [],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 3, status: "active",
      }],
    };
    const result = approveWorldDelta({ proposal: nextActProposal(), need: { kind: "next_act", act: 2 }, ws, ss: makeStory({ currentAct: 2 }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("duplicate_name");
  });

  it("rejects proposals that collide with each other on a name", () => {
    const proposal: WorldDeltaProposal = {
      ...nextActProposal(),
      newNpc: {
        name: "青山别院", role: "掌柜", description: "一个跟同批新地点撞名的人。",
        locationRef: { kind: "existing", id: "loc_0" }, goals: [],
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
    const ws = makeWorld();
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
    expect(trust!.requirements).toEqual([{ kind: "npc_affinity_at_least", npcId: asNpcId("npc_0"), value: TRUST_ENDING_MIN_AFFINITY }]);
    expect(doubt!.requirements).toEqual([{ kind: "npc_affinity_at_most", npcId: asNpcId("npc_0"), value: DOUBT_ENDING_MAX_AFFINITY }]);
  });

  it("still derives requirements when proposal omits them", () => {
    const ws = makeWorld();
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
      { kind: "npc_affinity_at_least", npcId: asNpcId("npc_0"), value: TRUST_ENDING_MIN_AFFINITY },
    ]);
    expect(result.approved.newEndings[1]!.requirements).toEqual([
      { kind: "npc_affinity_at_most", npcId: asNpcId("npc_0"), value: DOUBT_ENDING_MAX_AFFINITY },
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
        name: "如", role: "掌柜", description: "风尘仆仆的赶路人。",
        locationRef: { kind: "new_location" }, goals: [],
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
