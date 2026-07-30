import type { GameState, ScenarioBlueprint } from "@/game/domain";
import { projectAvailableActions } from "@/game/gameplay/rpg/actions";

/**
 * A normal runtime scene always needs two distinct, rule-approved actions.
 * Keep this decision outside AI code so neither a provider nor a fallback can
 * fabricate a duplicate/invalid choice when the deterministic game is over or
 * has no longer enough legal actions.
 */
export function canQueueRuntimeNarrativeScene(
  blueprint: ScenarioBlueprint,
  state: GameState,
): boolean {
  return state.ending === null &&
    state.battle.status !== "active" &&
    projectAvailableActions(blueprint, state).length >= 2;
}
