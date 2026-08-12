import { describe, expect, it } from "vitest";
import { createInitialWorldState, appendEnemy, type WorldState } from "@/game/domain/worldState";
import { ENEMY_COMBAT_STATS, PLAYER_COMBAT_STATS, toStatBlock } from "@/game/domain/combat";
import { asEnemyId, asGenerationId, asLocationId } from "@/game/domain/worldEntity";
import { buildEncounter } from "@/game/gameplay/rpg/ruleEngine/buildEncounter";
import { createTurnOrder } from "@/game/gameplay/rpg/ruleEngine/combatMath";
import { projectCombatView } from "./combatView";

function world(): WorldState {
  const location = {
    id: asLocationId("loc_1"), name: "荒野", description: "d", kind: "main" as const,
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const base = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "旅人", stats: toStatBlock(PLAYER_COMBAT_STATS) },
    startingLocation: location, startingItemIds: [],
  });
  return appendEnemy(base, {
    id: asEnemyId("enemy_1"), name: "灰狼", tier: "normal", stats: toStatBlock(ENEMY_COMBAT_STATS.normal), locationId: location.id, tags: [],
  });
}

describe("projectCombatView", () => {
  it("projects variable units and target-bound controls without leaking domain IDs", () => {
    const ws = world();
    const encounter = buildEncounter(ws, asEnemyId("enemy_1"));
    const active = {
      status: "active" as const,
      enemyId: asEnemyId("enemy_1"),
      playerHp: 100,
      enemyHp: 55,
      round: 1,
      combatants: encounter,
      turnOrder: createTurnOrder(encounter),
      turnIndex: 0,
      enemyIntents: [],
      downedEnemyIds: [],
      lastAdvance: [],
    };
    const view = projectCombatView(ws, active, 3);
    expect(view.units?.map((unit) => unit.slot)).toEqual(["ally-0", "enemy-0"]);
    expect(view.controls.map((control) => control.label)).toEqual(["攻击灰狼", "技能·灰狼", "防御", "撤退"]);
    expect(view.controls.every((control) => control.choiceToken === null || /^c_[0-9a-f]{16}$/.test(control.choiceToken))).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/combatantId|actorId|targetId|enemyId/);
  });

  it("keeps an insufficient-energy skill visible but disabled and tokenless", () => {
    const ws = world();
    const encounter = buildEncounter(ws, asEnemyId("enemy_1")).map((unit) => unit.side === "allies" ? { ...unit, energy: 0 } : unit);
    const active = {
      status: "active" as const,
      enemyId: asEnemyId("enemy_1"), playerHp: 100, enemyHp: 55, round: 1,
      combatants: encounter, turnOrder: createTurnOrder(encounter), turnIndex: 0,
      enemyIntents: [], downedEnemyIds: [], lastAdvance: [],
    };
    const skill = projectCombatView(ws, active, 3).disabledControls?.find((control) => control.label.startsWith("技能"));
    expect(skill).toMatchObject({ enabled: false, choiceToken: null, disabledReason: "需要 20 能量" });
  });
});
