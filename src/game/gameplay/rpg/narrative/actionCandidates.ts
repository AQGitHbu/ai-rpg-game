import type { AvailableAction } from "../actions";
import type { NarrativeActionCandidate } from "./types";

/**
 * Stable action key — maps each AvailableAction variant to a deterministic,
 * unique key that AI proposals can reference.
 */
export function actionKeyOf(action: AvailableAction): string {
  switch (action.type) {
    case "observe": return `observe:${action.locationId}`;
    case "talk": return `talk:${action.npcId}`;
    case "investigate": return `investigate:${action.factId}`;
    case "move": return `move:${action.locationId}`;
    case "take_item": return `take_item:${action.itemId}`;
    case "start_battle": return `start_battle:${action.enemyId}`;
    case "battle_action": return `battle_action:${action.action}`;
  }
}

/**
 * Projects available actions to a list of candidates that AI proposals
 * can reference by stable actionKey.
 */
export function toNarrativeActionCandidates(
  actions: readonly AvailableAction[]
): readonly NarrativeActionCandidate[] {
  return actions.map((action) => ({
    actionKey: actionKeyOf(action),
    kind: action.type,
    publicLabel: action.label,
  }));
}

/**
 * Resolves an actionKey back to the matching AvailableAction from the
 * current candidate list. Returns null if not found.
 */
export function findAvailableActionByKey(
  actions: readonly AvailableAction[],
  actionKey: string
): AvailableAction | null {
  return actions.find((action) => actionKeyOf(action) === actionKey) ?? null;
}
