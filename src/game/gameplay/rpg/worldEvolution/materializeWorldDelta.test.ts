import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { materializeWorldDelta } from "./materializeWorldDelta";
import type { WorldState, NpcEntry } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createInitialWorldState } from "@/game/domain/worldState";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/worldEntity";
import { approveWorldDelta, type ApprovedWorldDeltaCore } from "./approveWorldDelta";
import { createTownRuntime, bindNpcToTownSlot } from "@/game/gameplay/rpg/town";

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
      name: "新出现的信使", role: "传话人", description: "风尘仆仆的赶路人，怀里揣着密信。",
      locationRef: { kind: "new_location" }, goals: ["送达密信"],
    },
    newItem: null,
    newEnemy: null,
    newFact: { text: "盟约已有裂痕。", visibility: "public" },
    nextMainQuest: { name: "追查密信", description: "找到密信的下落。", objectiveText: "与信使交谈" },
    endingPair: null,
  };
}

describe("materializeWorldDelta", () => {
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
        name: "神秘镖师", role: "镖师", description: "护送商队的镖师。",
        locationRef: { kind: "existing", id: "loc_0" }, goals: [],
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
        name: "集市管事", role: "管事", description: "打理集市秩序的管事。",
        locationRef: { kind: "new_location" }, goals: [],
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
    const base = makeWorld();
    let town = createTownRuntime({ locationId: asLocationId("loc_0"), seed: "s#town#loc_0" });
    town = bindNpcToTownSlot(town, asNpcId("npc_0")).town;
    const ws: WorldState = {
      ...base,
      currentLocationId: asLocationId("loc_0"),
      locations: base.locations.map((location) =>
        location.id === asLocationId("loc_0")
          ? { ...location, name: "青石镇", scale: "town" as const, town }
          : location,
      ),
    };
    const ss = makeStory({ currentAct: 2, targetActs: 3 });
    const proposal: WorldDeltaProposal = {
      beatSummary: "城镇里出现新的茶馆线人",
      newLocation: {
        name: "青石镇茶馆", description: "临街茶馆里藏着一名带来密信的线人。", scale: "scene",
        placement: "town_building", connectFromLocationId: "loc_0",
      },
      newNpc: {
        name: "茶馆线人", role: "旧案传讯人", description: "在茶馆等候交出密信的线人。",
        locationRef: { kind: "new_location" }, goals: ["交出密信"],
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
    const base = makeWorld();
    const town = bindNpcToTownSlot(
      createTownRuntime({ locationId: asLocationId("loc_0"), seed: "s#town#loc_0" }),
      asNpcId("npc_0"),
    ).town;
    const ws: WorldState = {
      ...base,
      locations: base.locations.map((loc) =>
        loc.id === asLocationId("loc_0") ? { ...loc, scale: "town" as const, town } : loc,
      ),
    };
    const ss = makeStory({ currentAct: 2, targetActs: 3, tension: 10 });
    const proposal: WorldDeltaProposal = {
      beatSummary: "小镇里的新来客",
      newLocation: null,
      newNpc: {
        name: "新来客", role: "旅人", description: "在小镇落脚的外乡人。",
        locationRef: { kind: "existing", id: "loc_0" }, goals: [],
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
