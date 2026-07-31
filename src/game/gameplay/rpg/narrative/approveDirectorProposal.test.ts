import { describe, expect, it } from "vitest";
import { asEndingId, asFactId, asLocationId, asNpcId, asQuestId, type ScenarioBlueprint, type GameState } from "@/game/domain";
import type { NarrativeActionCandidate } from "./types";
import { approveDirectorProposal } from "./approveDirectorProposal";

// Minimal blueprint and state for testing
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
        { id: asFactId("fact_3"), text: "不存在的", source: "generated" },
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
      narration: "开始", suggestedActions: [],
      presentNpcIds: [asNpcId("npc_1")],
      investigableFactIds: [],
    },
  } as unknown as ScenarioBlueprint;
}

function buildTestState(): GameState {
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
    npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_a"), met: false }],
    quests: [],
    inventory: [],
    worldFacts: [
      { factId: asFactId("fact_1"), discovered: true },
      { factId: asFactId("fact_2"), discovered: false },
    ],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null },
    eventLedger: [{ type: "game_initialized", generation: {
      generationId: "gen-test" as GameState["generation"]["generationId"],
      seed: "test-seed",
      templateVersion: "tpl-1",
      inputDigest: "digest-test",
      gameType: "wuxia",
    }}],
  } as unknown as GameState;
}

const candidates: readonly NarrativeActionCandidate[] = [
  { actionKey: "talk:npc_1", kind: "talk", publicLabel: "与NPC1交谈" },
  { actionKey: "investigate:fact_1", kind: "investigate", publicLabel: "调查线索" },
];

describe("approveDirectorProposal", () => {
  const blueprint = buildTestBlueprint();
  const state = buildTestState();

  it("accepts a valid proposal", () => {
    const result = approveDirectorProposal({
      proposal: {
        sceneGoal: "让玩家注意到掌柜的回避",
        tensionLevel: 2,
        focusNpcId: "npc_1",
        relevantFactIds: ["fact_1"],
        allowedRevealFactIds: ["fact_1"],
        suggestedActionKeys: ["talk:npc_1", "investigate:fact_1"],
        introducedEntities: [{ kind: "npc", id: "npc_1" }],
        pacing: "develop",
      },
      blueprint,
      state,
      candidates,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sceneGoal).toBe("让玩家注意到掌柜的回避");
      expect(result.value.suggestedActionKeys).toEqual(["talk:npc_1", "investigate:fact_1"]);
    }
  });

  it("rejects focusNpcId not present at current location", () => {
    const result = approveDirectorProposal({
      proposal: {
        sceneGoal: "test",
        tensionLevel: 2,
        focusNpcId: "npc_not_present",
        relevantFactIds: ["fact_1"],
        allowedRevealFactIds: ["fact_1"],
        suggestedActionKeys: ["talk:npc_1", "investigate:fact_1"],
        introducedEntities: [],
        pacing: "develop",
      },
      blueprint,
      state,
      candidates,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects allowedRevealFactIds that are not discovered", () => {
    const result = approveDirectorProposal({
      proposal: {
        sceneGoal: "test",
        tensionLevel: 2,
        focusNpcId: "npc_1",
        relevantFactIds: ["fact_1"],
        allowedRevealFactIds: ["fact_2"],
        suggestedActionKeys: ["talk:npc_1", "investigate:fact_1"],
        introducedEntities: [],
        pacing: "develop",
      },
      blueprint,
      state,
      candidates,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects duplicate suggestedActionKeys", () => {
    const result = approveDirectorProposal({
      proposal: {
        sceneGoal: "test",
        tensionLevel: 2,
        focusNpcId: "npc_1",
        relevantFactIds: ["fact_1"],
        allowedRevealFactIds: ["fact_1"],
        suggestedActionKeys: ["talk:npc_1", "talk:npc_1"],
        introducedEntities: [],
        pacing: "develop",
      },
      blueprint,
      state,
      candidates,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects suggestedActionKeys not in candidates", () => {
    const result = approveDirectorProposal({
      proposal: {
        sceneGoal: "test",
        tensionLevel: 2,
        focusNpcId: "npc_1",
        relevantFactIds: ["fact_1"],
        allowedRevealFactIds: ["fact_1"],
        suggestedActionKeys: ["talk:npc_1", "move:loc_hidden"],
        introducedEntities: [],
        pacing: "develop",
      },
      blueprint,
      state,
      candidates,
    });
    expect(result).toMatchObject({ ok: false });
  });
});

// Phase 11 Task 5：用内容推进约束 director pacing。allowedPacing 由
// deriveContentProgression 按当前主线阶段派生（见 contentProgression.test.ts 契约）。
describe("approveDirectorProposal：Phase 11 pacing continuity", () => {
  type QuestStatus = GameState["quests"][number]["status"];

  function buildMainQuestBlueprint(): ScenarioBlueprint {
    return {
      schemaVersion: 1 as const,
      generationId: "gen-main" as ScenarioBlueprint["generationId"],
      seed: "seed-main", templateVersion: "tpl-1", inputDigest: "digest-main", gameType: "wuxia",
      world: {
        name: "W", summary: "", tone: "dark", themes: [],
        facts: [{ id: asFactId("fact_1"), text: "公开事实1", source: "player_input" }]
      },
      locations: [{ id: asLocationId("loc_a"), name: "A", description: "", kind: "public", connectedLocationIds: [] }],
      npcs: [{ id: asNpcId("npc_1"), name: "NPC1", role: "村民", locationId: asLocationId("loc_a"), knownFactIds: [asFactId("fact_1")] }],
      quests: [
        { id: asQuestId("m1"), name: "主线一", description: "", objectives: [], onSuccess: { kind: "unlock_quests", questIds: [asQuestId("m2")] }, onFailure: { kind: "closed" }, kind: "main", stage: 1 },
        { id: asQuestId("m2"), name: "主线二", description: "", objectives: [], onSuccess: { kind: "unlock_quests", questIds: [asQuestId("m3")] }, onFailure: { kind: "closed" }, kind: "main", stage: 2 },
        { id: asQuestId("m3"), name: "主线三", description: "", objectives: [], onSuccess: { kind: "reach_ending", endingId: asEndingId("e1") }, onFailure: { kind: "closed" }, kind: "main", stage: 3 }
      ],
      enemies: [], items: [], endings: [],
      player: { name: "P", identity: "H", startingItemIds: [], baseStats: { hp: 20, attack: 5, defense: 3 } },
      openingScene: { locationId: asLocationId("loc_a"), narration: "", suggestedActions: [], presentNpcIds: [asNpcId("npc_1")], investigableFactIds: [] }
    } as unknown as ScenarioBlueprint;
  }

  function stateWith(questStatuses: ReadonlyArray<readonly [string, QuestStatus]>): GameState {
    return {
      stateVersion: 1 as const,
      generation: { generationId: "gen-main" as GameState["generation"]["generationId"], seed: "seed-main", templateVersion: "tpl-1", inputDigest: "digest-main", gameType: "wuxia" },
      player: { name: "P", identity: "H", stats: { hp: 20, attack: 5, defense: 3 } },
      currentLocationId: asLocationId("loc_a"),
      unlockedLocationIds: [asLocationId("loc_a")],
      visitedLocationIds: [asLocationId("loc_a")],
      npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_a"), met: true }],
      quests: questStatuses.map(([questId, status]) => ({ questId: asQuestId(questId), status })),
      inventory: [],
      worldFacts: [{ factId: asFactId("fact_1"), discovered: true }],
      defeatedEnemyIds: [],
      battle: { status: "idle" },
      ending: null,
      narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
      towns: [],
      townGeneration: { status: "idle" },
      storyMemory: { version: 1, reducedThroughEventCount: 0, recent: [], npcContacts: [] },
      eventLedger: [{ type: "game_initialized", generation: { generationId: "gen-main" as GameState["generation"]["generationId"], seed: "seed-main", templateVersion: "tpl-1", inputDigest: "digest-main", gameType: "wuxia" } }]
    } as unknown as GameState;
  }

  const M1 = asQuestId("m1");
  const M2 = asQuestId("m2");
  const M3 = asQuestId("m3");
  const blueprint = buildMainQuestBlueprint();
  const candidates: readonly NarrativeActionCandidate[] = [
    { actionKey: "talk:npc_1", kind: "talk", publicLabel: "与NPC1交谈" },
    { actionKey: "investigate:fact_1", kind: "investigate", publicLabel: "调查线索" },
  ];

  function proposal(pacing: DirectorProposalPacing) {
    return {
      sceneGoal: "推进剧情", tensionLevel: 2, focusNpcId: "npc_1",
      relevantFactIds: ["fact_1"], allowedRevealFactIds: ["fact_1"],
      suggestedActionKeys: ["talk:npc_1", "investigate:fact_1"],
      introducedEntities: [], pacing
    };
  }
  type DirectorProposalPacing = "setup" | "develop" | "turn" | "climax" | "resolution";

  const states = {
    stage1: stateWith([[M1, "active"], [M2, "locked"], [M3, "locked"]]),
    stage2: stateWith([[M1, "completed"], [M2, "active"], [M3, "locked"]]),
    stage3: stateWith([[M1, "completed"], [M2, "completed"], [M3, "active"]]),
    resolved: stateWith([[M1, "completed"], [M2, "completed"], [M3, "completed"]])
  } as const;

  // allowedPacing 契约（contentProgression）：stage1=[setup,develop]、stage2=[develop,turn]、
  // stage3=[climax]、resolved=[resolution]。非当前阶段允许集合的 pacing → continuity_violation。
  it.each([
    ["setup", "stage1", true],
    ["develop", "stage1", true],
    ["turn", "stage1", false],
    ["climax", "stage1", false],
    ["resolution", "stage1", false],
    ["develop", "stage2", true],
    ["turn", "stage2", true],
    ["setup", "stage2", false],
    ["climax", "stage3", true],
    ["develop", "stage3", false],
    ["resolution", "resolved", true],
    ["climax", "resolved", false]
  ] as ReadonlyArray<[DirectorProposalPacing, keyof typeof states, boolean]>)(
    "director pacing %s at %s → continuity_violation=%s",
    (pacing, stageKey, accepted) => {
      const result = approveDirectorProposal({
        proposal: proposal(pacing) as never,
        blueprint,
        state: states[stageKey],
        candidates
      });
      expect(result.ok).toBe(accepted);
      if (!accepted) {
        expect(result).toMatchObject({ ok: false, category: "continuity_violation" });
      }
    }
  );

  it("out-of-stage pacing 不泄漏到日志、不替代为受控行为", () => {
    // 仅验证 approval 返回 continuity_violation；提案内容不进入返回值。
    const result = approveDirectorProposal({
      proposal: proposal("climax") as never,
      blueprint,
      state: states.stage1,
      candidates
    });
    expect(result).toMatchObject({ ok: false, category: "continuity_violation" });
    if (!result.ok) {
      expect(JSON.stringify(result)).not.toContain("climax");
    }
  });
});
