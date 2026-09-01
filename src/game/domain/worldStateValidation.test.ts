import { describe, expect, it } from "vitest";
import {
  asEndingId, asEnemyId, asFactId, asGenerationId, asItemId, asLocationId, asNpcId, asQuestId,
} from "./worldEntity";
import type { EndingEntry, LocationEntry } from "./worldEntries";
import { asCombatantId, type BattleCombatant } from "./combat";
import type { GenerationMetadata } from "./worldEntity";
import type { BattleState } from "./worldState";
import { validateWorldStateEntityReferences } from "./worldStateValidation";
import { createWorldStateFixture } from "./testing/worldStateFixture.testutil";
import type { EntityCompatibilityProjection } from "./entity/entityProjection";

// ---------------------------------------------------------------------------
// battle / endings 的 Entity 引用不在 store 内，必须由 WorldState 层补齐校验。
// 全部 fixture 先经 createWorldStateFixture 编译，损坏只通过合法 store 深改写构造。
// ---------------------------------------------------------------------------

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("gen_test"),
  seed: "test-seed",
  templateVersion: "v2",
  inputDigest: "",
  gameType: "wuxia",
};

const LOC_0 = asLocationId("loc_0");
const NPC_0 = asNpcId("npc_0");
const ENEMY_0 = asEnemyId("enemy_0");
const FACT_0 = asFactId("fact_0");
const QUEST_0 = asQuestId("quest_0");

function location(id: string, overrides: Partial<LocationEntry> = {}): LocationEntry {
  return {
    id: asLocationId(id),
    name: `地点-${id}`,
    description: "测试地点",
    kind: "main",
    connectedLocationIds: [],
    npcIds: [],
    availableItemIds: [],
    tags: [],
    ...overrides,
  };
}

function projection(overrides: Partial<EntityCompatibilityProjection> = {}): EntityCompatibilityProjection {
  return {
    player: { name: "沈希", identity: "走镖人", stats: { hp: 20, attack: 5, defense: 3 } },
    locations: [location("loc_0"), location("loc_1")],
    currentLocationId: LOC_0,
    unlockedLocationIds: [LOC_0, asLocationId("loc_1")],
    visitedLocationIds: [LOC_0],
    npcs: [{
      id: NPC_0,
      name: "掌柜",
      role: "掌柜",
      description: "客栈掌柜",
      locationId: LOC_0,
      isCompanion: false,
      tags: [],
      met: true,
      memory: {
        npcId: NPC_0,
        knownFactIds: [FACT_0],
        hiddenFactIds: [],
        interactionHistory: [],
        relationship: { affinity: 0 },
        emotion: "neutral",
        goals: [],
      },
    }],
    items: [{ id: asItemId("item_0"), name: "铜钥", description: "生锈", kind: "key", tags: [] }],
    inventory: [],
    worldFacts: [{ factId: FACT_0, text: "井中有声", source: "generated", discovered: true }],
    quests: [{
      id: QUEST_0,
      name: "查明井事",
      description: "去客栈查井",
      objectives: [{ kind: "visit_location", locationId: LOC_0 }],
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: [],
      kind: "main",
      status: "active",
    }],
    enemies: [{
      id: ENEMY_0,
      name: "夜巡",
      tier: "normal",
      stats: { hp: 10, attack: 3, defense: 1 },
      locationId: LOC_0,
      tags: [],
    }],
    defeatedEnemyIds: [],
    factions: [],
    ...overrides,
  };
}

function ending(requirements: EndingEntry["requirements"]): readonly EndingEntry[] {
  return [{ id: asEndingId("ending_0"), name: "镖行天下", description: "结局", requirements }];
}

function enemyCombatant(enemyId: string): BattleCombatant {
  return {
    combatantId: asCombatantId("c_0"),
    side: "enemies",
    controller: "rule",
    source: { kind: "enemy", enemyId: asEnemyId(enemyId) },
    name: "夜巡",
    stats: { maxHp: 10, maxEnergy: 0, attack: 3, defense: 1, speed: 5 },
    hp: 10,
    energy: 0,
    guarding: false,
  };
}

function activeBattle(overrides: Partial<Extract<BattleState, { status: "active" }>> = {}): BattleState {
  return {
    status: "active",
    enemyId: ENEMY_0,
    playerHp: 20,
    enemyHp: 10,
    round: 1,
    preBattleSnapshot: { entityStore: fixture({ battle: { status: "idle" } }).entityStore, eventLedger: [] },
    ...overrides,
  };
}

function fixture(input: {
  battle?: BattleState;
  endings?: readonly EndingEntry[];
  ending?: Parameters<typeof createWorldStateFixture>[0]["ending"];
  projection?: EntityCompatibilityProjection;
}) {
  return createWorldStateFixture({
    generation: GENERATION,
    projection: input.projection ?? projection(),
    battle: input.battle,
    endings: input.endings,
    ending: input.ending,
  });
}

describe("WorldState 层 Entity 引用校验", () => {
  it("合法 fixture 不报任何 issue", () => {
    expect(validateWorldStateEntityReferences(fixture({ battle: activeBattle() }))).toEqual([]);
    expect(validateWorldStateEntityReferences(fixture({}))).toEqual([]);
  });

  it("active battle 的 enemyId 与 enemyIds 必须落在 store 内", () => {
    const issues = validateWorldStateEntityReferences(fixture({
      battle: activeBattle({ enemyId: asEnemyId("enemy_404") }),
    }));
    expect(issues.map((issue) => issue.code)).toEqual(["unknown_battle_enemy_ref"]);
    expect(issues[0]?.referencedId).toBe("enemy_404");

    expect(validateWorldStateEntityReferences(fixture({
      battle: activeBattle({ enemyIds: [ENEMY_0, asEnemyId("enemy_404")] }),
    })).map((issue) => issue.code)).toEqual(["unknown_battle_enemy_ref"]);
  });

  it("resolved battle 同样要能解析 enemy 引用", () => {
    const issues = validateWorldStateEntityReferences(fixture({
      battle: { status: "resolved", enemyId: asEnemyId("enemy_404"), outcome: "victory" },
    }));
    expect(issues.map((issue) => issue.code)).toEqual(["unknown_battle_enemy_ref"]);
  });

  it("modern combatant 的 enemy source 也必须可解析", () => {
    const issues = validateWorldStateEntityReferences(fixture({
      battle: activeBattle({
        enemyIds: [ENEMY_0],
        combatants: [enemyCombatant("enemy_0"), enemyCombatant("enemy_404")],
        turnOrder: [],
        turnIndex: 0,
        enemyIntents: [],
        downedEnemyIds: [],
        lastAdvance: [],
      }),
    }));
    expect(issues.map((issue) => issue.code)).toEqual(["unknown_battle_combatant_enemy_ref"]);
    expect(issues[0]?.referencedId).toBe("enemy_404");
  });

  it("战败恢复用的快照不得引用未知 enemy", () => {
    const issues = validateWorldStateEntityReferences(fixture({
      battle: activeBattle({
        preBattleSnapshot: { entityStore: { version: 1, records: [] }, eventLedger: [] },
      }),
    }));
    expect(issues.map((issue) => issue.code)).toEqual(["invalid_battle_snapshot"]);
  });

  it("结局条件对 quest/fact/npc 的引用必须在 store 内", () => {
    const codes = (requirements: EndingEntry["requirements"]): string[] =>
      validateWorldStateEntityReferences(fixture({ endings: ending(requirements) })).map((issue) => issue.code);

    expect(codes([{ kind: "quest_completed", questId: QUEST_0 }])).toEqual([]);
    expect(codes([
      { kind: "fact_discovered", factId: asFactId("fact_404") },
      { kind: "npc_affinity_at_least", npcId: asNpcId("npc_404"), value: 10 },
    ])).toEqual(["unknown_ending_requirement_ref", "unknown_ending_requirement_ref"]);
    expect(codes([{ kind: "quest_failed", questId: asQuestId("quest_404") }])).toEqual(["unknown_ending_requirement_ref"]);
  });

  it("已达成结局必须指向 endings 表内已有的结局", () => {
    const issues = validateWorldStateEntityReferences(fixture({
      endings: ending([{ kind: "quest_completed", questId: QUEST_0 }]),
      ending: { endingId: asEndingId("ending_404"), outcome: "success" },
    }));
    expect(issues.map((issue) => issue.code)).toEqual(["unknown_resolved_ending_ref"]);
    expect(issues[0]?.entityId).toBe("ending_404");

    expect(validateWorldStateEntityReferences(fixture({
      endings: ending([]),
      ending: { endingId: asEndingId("ending_0"), outcome: "success" },
    }))).toEqual([]);
  });
});
