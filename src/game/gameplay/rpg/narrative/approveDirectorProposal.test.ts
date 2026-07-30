import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId, type ScenarioBlueprint, type GameState } from "@/game/domain";
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
