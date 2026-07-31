import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId, type GameState, type NewGameInput, type ScenarioBlueprint, type StoryMemoryEntry } from "@/game/domain";
import { ensureTownRuntime } from "@/game/gameplay/rpg/town";
import { reconcileStoryMemory, type ApprovedDirectorPlan } from "@/game/gameplay/rpg/narrative";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { toDirectorContext, toNpcLineContext, toSceneScriptContext, toTownSpatialContext } from "./runtimeNarrativeContexts";
import { runScenarioPipeline } from "./applicationFixture.testutil";

function buildTestBlueprint(): ScenarioBlueprint {
  return {
    schemaVersion: 1 as const,
    generationId: "gen-test" as ScenarioBlueprint["generationId"],
    seed: "test-seed",
    templateVersion: "tpl-1",
    inputDigest: "digest-test",
    gameType: "wuxia",
    world: {
      name: "Test World",
      summary: "A test world",
      tone: "dark",
      themes: ["justice"],
      facts: [
        { id: asFactId("fact_1"), text: "公开事实1", source: "player_input" },
        { id: asFactId("fact_2"), text: "未发现事实", source: "generated" },
        { id: asFactId("fact_3"), text: "秘密事实", source: "generated" },
      ]
    },
    locations: [
      { id: asLocationId("loc_a"), name: "地点A", description: "", kind: "public", connectedLocationIds: [] },
    ],
    npcs: [
      { id: asNpcId("npc_1"), name: "NPC1", role: "村民", locationId: asLocationId("loc_a"), knownFactIds: [asFactId("fact_1")] },
    ],
    quests: [],
    enemies: [],
    items: [],
    endings: [],
    player: {
      name: "Player", identity: "Hero",
      startingItemIds: [],
      baseStats: { hp: 20, attack: 5, defense: 3 }
    },
    openingScene: {
      locationId: asLocationId("loc_a"),
      narration: "开始",
      suggestedActions: [],
      presentNpcIds: [asNpcId("npc_1")],
      investigableFactIds: [],
    },
  } as unknown as ScenarioBlueprint;
}

function buildTestGameState(): GameState {
  return {
    stateVersion: 1 as const,
    generation: {
      generationId: "gen-test" as GameState["generation"]["generationId"],
      seed: "test-seed",
      templateVersion: "tpl-1",
      inputDigest: "digest-test",
      gameType: "wuxia",
    },
    player: { name: "Player", identity: "Hero", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: asLocationId("loc_a"),
    unlockedLocationIds: [asLocationId("loc_a")],
    visitedLocationIds: [asLocationId("loc_a")],
    npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_a"), met: true }],
    quests: [],
    inventory: [],
    worldFacts: [
      { factId: asFactId("fact_1"), discovered: true },
      { factId: asFactId("fact_2"), discovered: false },
      { factId: asFactId("fact_3"), discovered: false },
    ],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null },
    eventLedger: [{
      type: "game_initialized",
      generation: {
        generationId: "gen-test" as GameState["generation"]["generationId"],
        seed: "test-seed",
        templateVersion: "tpl-1",
        inputDigest: "digest-test",
        gameType: "wuxia",
      },
    }],
  } as unknown as GameState;
}

describe("runtimeNarrativeContexts 导演", () => {
  const blueprint = buildTestBlueprint();
  const state = buildTestGameState();

  it("toDirectorContext 包含 narrative state", () => {
    const context = toDirectorContext({ blueprint, state });
    expect(context.narrative.currentScene).toBeNull();
  });

  it("toDirectorContext 包含 current location", () => {
    const context = toDirectorContext({ blueprint, state });
    expect(context.currentLocationId).toBe("loc_a");
  });

  it("toDirectorContext 有 discovered facts ids", () => {
    const context = toDirectorContext({ blueprint, state });
    expect(context.discoveredFactIds).toContain("fact_1");
  });

  it("toDirectorContext 的 event ledger 不含 AI prompt 原文", () => {
    const context = toDirectorContext({ blueprint, state });
    const line = JSON.stringify(context);
    expect(line).not.toMatch(/\bprompt\b/i);
    expect(line).not.toMatch(/\bkey\b/i);
  });

  it("toDirectorContext 的 recentEvents 排除 narrative_scene_presented（Phase 11 场景审计不污染导演上下文指纹）", () => {
    const stateWithScene = {
      ...state,
      eventLedger: [
        ...state.eventLedger,
        { type: "location_visited", locationId: asLocationId("loc_a"), occurredAt: "2026-07-31T00:00:00.000Z" },
        {
          type: "narrative_scene_presented",
          sceneId: "scene-1",
          locationId: asLocationId("loc_a"),
          focusNpcId: null,
          revealedFactIds: [],
          pacing: "develop",
          occurredAt: "2026-07-31T00:00:00.000Z"
        },
        { type: "npc_met", npcId: asNpcId("npc_1"), occurredAt: "2026-07-31T00:00:00.000Z" }
      ]
    } as unknown as GameState;
    const context = toDirectorContext({ blueprint, state: stateWithScene });
    expect(context.recentEvents).not.toContain("narrative_scene_presented");
    expect(context.recentEvents).toContain("npc_met");
    expect(context.recentEvents).toContain("location_visited");
  });
});

describe("runtimeNarrativeContexts 编剧", () => {
  const blueprint = buildTestBlueprint();
  const state = buildTestGameState();

  it("toSceneScriptContext 包含 plan", () => {
    const context = toSceneScriptContext({
      blueprint,
      state,
      plan: {
        sceneGoal: "test",
        tensionLevel: 2,
        focusNpcId: "npc_1",
        relevantFactIds: ["fact_1"],
        allowedRevealFactIds: ["fact_1"],
        suggestedActionKeys: ["talk:npc_1", "observe:loc_a"],
        introducedEntities: [],
        pacing: "develop",
        proposedNewLocations: [],
        proposedNewNpcs: [],
      },
    });
    expect(context.plan.sceneGoal).toBe("test");
  });

  it("toSceneScriptContext 不含 AI prompt 原文", () => {
    const context = toSceneScriptContext({
      blueprint,
      state,
      plan: {
        sceneGoal: "test",
        tensionLevel: 2,
        focusNpcId: "npc_1",
        relevantFactIds: ["fact_1"],
        allowedRevealFactIds: ["fact_1"],
        suggestedActionKeys: ["talk:npc_1", "observe:loc_a"],
        introducedEntities: [],
        pacing: "develop",
        proposedNewLocations: [],
        proposedNewNpcs: [],
      },
    });
    const line = JSON.stringify(context);
    expect(line).not.toMatch(/\bprompt\b/i);
    expect(line).not.toMatch(/\bkey\b/i);
  });
});

describe("runtimeNarrativeContexts 演员", () => {
  const blueprint = buildTestBlueprint();
  const state = buildTestGameState();

  it("toNpcLineContext 包含 NPC 定义", () => {
    const context = toNpcLineContext({
      blueprint,
      state,
      npcId: "npc_1",
      speechAct: "inform",
      allowedFactIds: ["fact_1"],
      mayLie: false,
    });
    const npcDef = context.npcDefinition as Record<string, unknown>;
    expect(npcDef.id).toBe("npc_1");
    expect(npcDef.name).toBe("NPC1");
  });

  it("toNpcLineContext 包含事实卡片", () => {
    const context = toNpcLineContext({
      blueprint,
      state,
      npcId: "npc_1",
      speechAct: "inform",
      allowedFactIds: ["fact_1"],
      mayLie: false,
    });
    expect(context.factCards).toHaveLength(1);
    const card = context.factCards[0] as Record<string, unknown>;
    expect(card.id).toBe("fact_1");
  });

  it("toNpcLineContext 不含 AI prompt 原文", () => {
    const context = toNpcLineContext({
      blueprint,
      state,
      npcId: "npc_1",
      speechAct: "inform",
      allowedFactIds: ["fact_1"],
      mayLie: false,
    });
    const line = JSON.stringify(context);
    expect(line).not.toMatch(/\bprompt\b/i);
    expect(line).not.toMatch(/\bkey\b/i);
  });
});

// ---------------------------------------------------------------------------
// Town 主循环 S8：小镇空间语义注入（当前地点为就绪 town 时才注入）。
// fallback 蓝图的 loc_2 固定为 town 地点（createFallbackBlueprint 约定）。
// ---------------------------------------------------------------------------

describe("runtimeNarrativeContexts 小镇空间语义", () => {
  const FIXTURE = wuxiaFixture as unknown as { input: NewGameInput; seed: string };
  const PIPELINE = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);
  const TOWN_ID = "loc_2";
  const FIXED_TIME = "2026-07-27T12:00:00.000Z";

  function readyTownState(): GameState {
    const base: GameState = { ...PIPELINE.state, currentLocationId: asLocationId(TOWN_ID) };
    const entry = ensureTownRuntime(PIPELINE.blueprint, base, TOWN_ID, "offline", FIXED_TIME);
    if (entry.kind !== "generated") throw new Error("loc_2 应为 town 地点");
    return { ...base, towns: [entry.town] };
  }

  const scenePlan: ApprovedDirectorPlan = {
    sceneGoal: "探查",
    tensionLevel: 2,
    focusNpcId: null,
    relevantFactIds: [],
    allowedRevealFactIds: [],
    suggestedActionKeys: ["observe:loc_2", "observe:loc_2"],
    introducedEntities: [],
    pacing: "develop",
        proposedNewLocations: [],
        proposedNewNpcs: [],
  };

  it("非 town 地点：toTownSpatialContext 返回 undefined，两个上下文均不注入", () => {
    const state: GameState = { ...PIPELINE.state, currentLocationId: asLocationId("loc_1") };
    expect(toTownSpatialContext(PIPELINE.blueprint, state)).toBeUndefined();
    expect(toDirectorContext({ blueprint: PIPELINE.blueprint, state }).townSpatial).toBeUndefined();
    expect(
      toSceneScriptContext({ blueprint: PIPELINE.blueprint, state, plan: scenePlan }).townSpatial
    ).toBeUndefined();
  });

  it("就绪 town：导演上下文注入镇名与非空语义句子", () => {
    const state = readyTownState();
    const context = toDirectorContext({ blueprint: PIPELINE.blueprint, state });
    expect(context.townSpatial).toBeDefined();
    expect(context.townSpatial?.townName.length).toBeGreaterThan(0);
    expect(context.townSpatial?.sentences.length).toBeGreaterThan(0);
  });

  it("就绪 town：编剧上下文注入建筑方位语义且不含坐标", () => {
    const state = readyTownState();
    const context = toSceneScriptContext({ blueprint: PIPELINE.blueprint, state, plan: scenePlan });
    expect(context.townSpatial).toBeDefined();
    for (const building of context.townSpatial?.buildings ?? []) {
      expect(typeof building.displayName).toBe("string");
      expect(typeof building.area).toBe("string");
      expect(typeof building.buildingType).toBe("string");
    }
    // 坐标无关：投影不得泄露 seed 或几何坐标字段。
    const line = JSON.stringify(context.townSpatial);
    expect(line).not.toMatch(/\bseed\b/i);
    expect(line).not.toMatch(/footprint|entrance|\bx\b|\by\b/i);
  });
});

// ---------------------------------------------------------------------------
// Phase 11：最小连续性 context（progression、recentContinuity、activeQuestCards、ownContinuity）。
// ---------------------------------------------------------------------------

describe("runtimeNarrativeContexts Phase 11 连续性", () => {
  const FIXTURE = wuxiaFixture as unknown as { input: NewGameInput; seed: string };
  const PIPELINE = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);
  const FIXED_TIME = "2026-07-31T00:00:00.000Z";

  it("director 保留完整 12 条连续性，而 writer 只接收最近 6 条", () => {
    const recent: readonly StoryMemoryEntry[] = Array.from({ length: 13 }, (_, turn) => ({
      kind: "location" as const,
      locationId: PIPELINE.state.currentLocationId,
      turn,
    }));
    const state = {
      ...PIPELINE.state,
      storyMemory: { version: 1 as const, reducedThroughEventCount: 13, recent, npcContacts: [] },
    } as GameState;
    const plan: ApprovedDirectorPlan = {
      sceneGoal: "承接",
      tensionLevel: 2,
      focusNpcId: null,
      relevantFactIds: [],
      allowedRevealFactIds: [],
      suggestedActionKeys: ["observe:loc_1", "move:loc_2"],
      introducedEntities: [],
      pacing: "develop",
    };
    expect(toDirectorContext({ blueprint: PIPELINE.blueprint, state }).recentContinuity).toHaveLength(12);
    expect(toSceneScriptContext({ blueprint: PIPELINE.blueprint, state, plan }).recentContinuity).toHaveLength(6);
  });

  it("writer 的 NPC profile 不泄漏其未发现的已知事实", () => {
    const hiddenFact = PIPELINE.blueprint.world.facts.find((entry) =>
      !PIPELINE.state.worldFacts.some((stateFact) => stateFact.factId === entry.id && stateFact.discovered),
    );
    const npc = PIPELINE.blueprint.npcs.find((entry) =>
      hiddenFact !== undefined && entry.knownFactIds.includes(hiddenFact.id),
    );
    if (hiddenFact === undefined || npc === undefined) throw new Error("fixture must provide an NPC-private hidden fact");
    const context = toSceneScriptContext({
      blueprint: PIPELINE.blueprint,
      state: PIPELINE.state,
      plan: {
        sceneGoal: "承接",
        tensionLevel: 2,
        focusNpcId: String(npc.id),
        relevantFactIds: [],
        allowedRevealFactIds: [],
        suggestedActionKeys: ["observe:loc_1", "move:loc_2"],
        introducedEntities: [],
        pacing: "develop",
      },
    });
    expect(JSON.stringify(context)).not.toContain(hiddenFact.text);
    expect(JSON.stringify(context.npcProfile)).not.toContain("knownFact");
  });

  it("已发现线索以文本承接，未发现线索绝不投影", () => {
    const discovered = PIPELINE.state.worldFacts.find((entry) => entry.discovered);
    const hidden = PIPELINE.state.worldFacts.find((entry) => !entry.discovered);
    if (discovered === undefined || hidden === undefined) throw new Error("fixture must contain discovered and hidden facts");
    const state = {
      ...PIPELINE.state,
      storyMemory: {
        version: 1 as const,
        reducedThroughEventCount: 2,
        recent: [
          { kind: "fact" as const, factId: discovered.factId, turn: 0 },
          { kind: "fact" as const, factId: hidden.factId, turn: 1 },
        ],
        npcContacts: [],
      },
    } as GameState;
    const contextJson = JSON.stringify(toDirectorContext({ blueprint: PIPELINE.blueprint, state }));
    const discoveredText = PIPELINE.blueprint.world.facts.find((entry) => entry.id === discovered.factId)?.text;
    const hiddenText = PIPELINE.blueprint.world.facts.find((entry) => entry.id === hidden.factId)?.text;
    expect(contextJson).toContain(discoveredText);
    expect(contextJson).not.toContain(hiddenText);
  });

  it("director 得到具名里程碑与 active 任务卡，且不含完整 ledger 或原始 ID", () => {
    const openingLocation = PIPELINE.blueprint.locations[0];
    const stateWithVisit = {
      ...PIPELINE.state,
      eventLedger: [...PIPELINE.state.eventLedger, { type: "location_visited", locationId: PIPELINE.state.currentLocationId, occurredAt: FIXED_TIME }],
    } as unknown as GameState;
    const state = { ...stateWithVisit, storyMemory: reconcileStoryMemory({ state: stateWithVisit }) } as GameState;
    const context = toDirectorContext({ blueprint: PIPELINE.blueprint, state });
    expect(context.recentContinuity.some((m) => m.text.includes(openingLocation.name))).toBe(true);
    expect(context.activeQuestCards.length).toBeGreaterThan(0);
    expect(context.progression.mainStage).toBe(1);
    expect(context.progression.allowedPacing).toContain("develop");
    // 不泄漏原始 ledger、原始 ID、对白或事实原文
    expect(JSON.stringify(context)).not.toContain("eventLedger");
    expect(JSON.stringify(context.recentContinuity)).not.toContain(String(PIPELINE.state.currentLocationId));
  });

  it("NPC B 请求排除 NPC A 接触与未公开事实原文", () => {
    const npcs = PIPELINE.blueprint.npcs;
    const npcA = npcs[0];
    const npcB = npcs[1] ?? npcs[0];
    const stateWithContact = {
      ...PIPELINE.state,
      eventLedger: [...PIPELINE.state.eventLedger, { type: "npc_met", npcId: String(npcA.id), occurredAt: FIXED_TIME }],
    } as unknown as GameState;
    const state = { ...stateWithContact, storyMemory: reconcileStoryMemory({ state: stateWithContact }) } as GameState;
    const context = toNpcLineContext({
      blueprint: PIPELINE.blueprint,
      state,
      npcId: String(npcB.id),
      speechAct: "warn",
      allowedFactIds: [],
      mayLie: false,
    });
    // ownContinuity 只含该 NPC 自身；npcB 未接触 → null（不泄漏 npcA 的接触）
    expect(context.ownContinuity).toBeNull();
    expect(JSON.stringify(context)).not.toContain(npcA.name);
    expect("recentEvents" in context).toBe(false);
    expect(JSON.stringify(context)).not.toContain("npc_met");
    // allowedFactIds 为空 → 不含任何事实原文
    for (const fact of PIPELINE.blueprint.world.facts) {
      expect(JSON.stringify(context)).not.toContain(fact.text);
    }
  });
});
