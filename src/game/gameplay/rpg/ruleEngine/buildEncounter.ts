import type { WorldState } from "@/game/domain/worldState";
import type { EnemyId } from "@/game/domain/worldEntity";
import { entitiesOfKind } from "@/game/domain/entity";
import {
  COMPANION_COMBAT_STATS,
  ENEMY_COMBAT_STATS,
  PLAYER_COMBAT_STATS,
  asCombatantId,
  initialCombatResources,
  type BattleCombatant,
} from "@/game/domain/combat";

/**
 * 根据玩家挑战的敌人组装本场战斗单位。
 * 当前内容政策：Boss 单体；普通敌人最多同场两只。
 * resolver 只消费返回的数组，不依赖长度为 1 的假设。
 */
export function buildEncounter(worldState: WorldState, challengedEnemyId: EnemyId): readonly BattleCombatant[] {
  const challenged = worldState.enemies.find((enemy) => enemy.id === challengedEnemyId);
  if (challenged === undefined) return [];

  const enemyEntries = challenged.tier === "boss"
    ? [challenged]
    : worldState.enemies
      .filter((enemy) =>
        enemy.locationId === worldState.currentLocationId
        && enemy.tier === "normal"
        && !worldState.defeatedEnemyIds.includes(enemy.id),
      )
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .slice(0, 2);

  const protagonist: BattleCombatant = {
    combatantId: asCombatantId("ally:protagonist"),
    side: "allies",
    controller: "player",
    source: { kind: "protagonist" },
    name: worldState.player.name,
    stats: PLAYER_COMBAT_STATS,
    ...initialCombatResources(PLAYER_COMBAT_STATS),
  };

  const companion = entitiesOfKind(worldState.entityStore, "npc")
    .filter((npc) =>
      npc.core.lifecycle === "active"
      && npc.dynamicState.isCompanion
      && npc.position.locationId === worldState.currentLocationId,
    )
    .sort((a, b) => String(a.core.id).localeCompare(String(b.core.id)))
    .slice(0, 1)
    .map((npc): BattleCombatant => ({
      combatantId: asCombatantId(`companion:${String(npc.core.id)}`),
      side: "allies",
      controller: "rule",
      source: { kind: "companion", npcId: npc.core.id },
      name: npc.core.name,
      stats: COMPANION_COMBAT_STATS,
      ...initialCombatResources(COMPANION_COMBAT_STATS),
    }));

  const enemies = enemyEntries.map((enemy): BattleCombatant => {
    const stats = ENEMY_COMBAT_STATS[enemy.tier];
    return {
      combatantId: asCombatantId(`enemy:${String(enemy.id)}`),
      side: "enemies",
      controller: "rule",
      source: { kind: "enemy", enemyId: enemy.id },
      name: enemy.name,
      stats,
      ...initialCombatResources(stats),
    };
  });

  return [protagonist, ...companion, ...enemies];
}
