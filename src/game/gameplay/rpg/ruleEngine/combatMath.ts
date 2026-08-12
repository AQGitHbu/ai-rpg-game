import type {
  BattleCombatant,
  CombatActionKind,
  CombatStats,
  EnemyActionKind,
} from "@/game/domain/combat";

import { GUARD_MULTIPLIER, SKILL_MULTIPLIER } from "@/game/domain/combat";

export function calculateDamage(
  attacker: CombatStats,
  defender: CombatStats,
  multiplier: number,
  guarded: boolean,
): number {
  const denominator = attacker.attack + defender.defense;
  if (denominator <= 0) return 1;
  const raw = Math.floor((attacker.attack * attacker.attack * multiplier) / denominator);
  return Math.max(1, guarded ? Math.floor(raw * GUARD_MULTIPLIER) : raw);
}

export function multiplierForAction(action: CombatActionKind): number {
  return action === "skill" ? SKILL_MULTIPLIER : 1;
}

export function createTurnOrder(combatants: readonly BattleCombatant[]): readonly BattleCombatant["combatantId"][] {
  return combatants
    .filter((unit) => unit.hp > 0)
    .sort((a, b) => {
      if (b.stats.speed !== a.stats.speed) return b.stats.speed - a.stats.speed;
      if (a.side !== b.side) return a.side === "allies" ? -1 : 1;
      return String(a.combatantId).localeCompare(String(b.combatantId));
    })
    .map((unit) => unit.combatantId);
}

export function chooseEnemyAction(unit: BattleCombatant, round: number): EnemyActionKind {
  // Boss 档位由其规则 profile 的 maxHp 标识；具体名称/题材不参与 AI 或规则。
  const boss = unit.stats.maxHp >= 100;
  const cycle = (round - 1) % 3;
  if (!boss) return cycle === 2 ? "skill" : "attack";
  return cycle === 0 ? "attack" : cycle === 1 ? "skill" : "guard";
}

export function chooseEnemyTarget(
  actor: BattleCombatant,
  combatants: readonly BattleCombatant[],
): BattleCombatant["combatantId"] | undefined {
  return combatants
    .filter((unit) => unit.side !== actor.side && unit.hp > 0)
    .sort((a, b) => {
      const aRatio = a.hp / Math.max(1, a.stats.maxHp);
      const bRatio = b.hp / Math.max(1, b.stats.maxHp);
      if (aRatio !== bRatio) return aRatio - bRatio;
      return String(a.combatantId).localeCompare(String(b.combatantId));
    })[0]?.combatantId;
}
